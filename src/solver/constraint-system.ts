/**
 * Phase A — hard constraint propagation (Constraint Model T2.2 §5–6).
 *
 * Exact, prior-free. Determines what spreads are *possible*; the tags
 * locked/bounded/guessed derive from here, never from the prior (§1). Builds one
 * coupled system across all mons (§E2): each clean hit is a binary relation
 * between the attacker's offensive stat and the defender's defensive stat; each
 * mon's five non-HP stats are tied by the budget equality (66 − SP_hp). HP is
 * read, never solved (§B5).
 *
 * Propagation is generalized arc consistency (the "arc-consistency style" of §5):
 * iteratively drop any SP value with no support in a constraint, to a fixpoint.
 * GAC is SOUND — it never removes a genuinely possible value — so everything it
 * rules out is truly impossible, and an emptied domain is a real contradiction
 * (U4.3.8). Where GAC is incomplete it errs toward *less* certainty, which is the
 * safe direction (never reports bounded/guessed as locked, §E4).
 *
 * The per-hit damage relation captures coupling exactly, giving the required
 * "fused until separated" behavior (§6): one attacker vs one defender leaves the
 * pair fused (wide marginals); a second matchup sharing a variable separates them.
 */

import { baseStatOf, championsExceptions, primaryAbilityOf, roleOf, type ExceptionRegistry, type Gen, type MonSpec } from '../engine';
import { maxHpToSpHp, spToFinal, SP_BUDGET, SP_MAX, SP_MIN, type StatKey } from '../conversion';
import { damageFactor } from './damage-factor';
import { structuralPrior, type SpreadPrior } from './prior';

export type NonHpStat = Exclude<StatKey, 'hp'>;
export const NON_HP_STATS: readonly NonHpStat[] = ['atk', 'def', 'spa', 'spd', 'spe'];

export interface SolverMon {
  id: string;
  spec: MonSpec;
  /** observed max HP → SP_hp (read, never solved) */
  observedMaxHp: number;
}

export interface SolverHit {
  attackerId: string;
  defenderId: string;
  move: string;
  /** exact integer damage = hp_before − hp_after */
  observedDamage: number;
  crit?: boolean | undefined;
  /** forme in play at hit time, if different from the sheet (e.g. a Mega) — uses
   *  that forme's base stats + ability for THIS hit; the SP variable is unchanged. */
  attackerSpecies?: string | undefined;
  defenderSpecies?: string | undefined;
  /** opaque provenance label for the drill-down (e.g. "R7 G2 · T3"); UI-formatted upstream. */
  source?: string | undefined;
}

/** A multiplicative speed-control modifier, applied as floor(speed × num / den). */
export interface SpeedControl {
  num: number;
  den: number;
}

/**
 * One observed move-order fact (Constraint §4). `firstId` acted before `secondId`
 * THIS turn. Only meaningful within the SAME priority bracket — set
 * `samePriorityBracket: false` for a cross-bracket order (a priority move going
 * first) and it contributes NO speed constraint (the mandatory §4 guard).
 */
export interface SpeedFact {
  firstId: string;
  secondId: string;
  samePriorityBracket: boolean;
  /** Trick Room reverses the comparison (slower acts first). */
  trickRoom?: boolean | undefined;
  /** observed speed-control state on each side (Tailwind, paralysis, Choice Scarf…). */
  firstControl?: SpeedControl | undefined;
  secondControl?: SpeedControl | undefined;
  /** a known speed tie → equality rather than inequality. */
  tie?: boolean | undefined;
  /** forme in play at the time (e.g. a Mega) — uses that forme's Speed base. */
  firstSpecies?: string | undefined;
  secondSpecies?: string | undefined;
}

export interface PhaseAResult {
  /** monId → stat → sorted feasible SP values (the pruned domains) */
  domains: Map<string, Map<NonHpStat, number[]>>;
  /** monId → read SP_hp */
  spHp: Map<string, number>;
  /** non-empty when clean constraints are unsatisfiable; never a force-fit */
  contradictions: string[];
}

// ── Phase B output (a first cut of the Solver Output Contract, T1.2) ──────────

export type StatTag = 'read' | 'locked' | 'bounded' | 'guessed';
export type AllStat = NonHpStat | 'hp';

export interface StatReport {
  stat: AllStat;
  tag: StatTag;
  /** most likely SP (HP: the read value) */
  best: number;
  /** marginal posterior over SP, descending by probability */
  distribution: Array<{ sp: number; p: number }>;
  /** for `bounded`/`locked`: the feasible SP span */
  range?: [number, number];
}

export interface SpreadCandidate {
  spread: Record<NonHpStat, number>;
  /** raw posterior mass (kept exact for coherence/sorting) */
  confidence: number;
  /** confidence rounded to the nearest 5% for honest display (resolved decision, Output Contract §14) */
  confidencePct: number;
}

/** One contributing clean hit, for the evidence drill-down (exactly what's used). */
export interface EvidenceHit {
  /** 'dealt' constrains this mon's offense; 'taken' constrains its defense */
  role: 'dealt' | 'taken';
  /** which of THIS mon's stats the hit touches */
  stat: NonHpStat;
  move: string;
  observedDamage: number;
  /** the opposing mon (display species) */
  opponentSpecies: string;
  /** provenance label, e.g. "R7 G2 · T3" (undefined for ad-hoc hits) */
  source?: string;
}

/** Provenance: how much evidence informed this mon's result (Output Contract §7). */
export interface EvidenceSummary {
  /** clean hits this mon TOOK (constrain its defenses) */
  cleanHitsIn: number;
  /** clean hits this mon DEALT (constrain its offenses) */
  cleanHitsOut: number;
  /** same-bracket move-order facts touching this mon's Speed */
  speedFacts: number;
  /** the actual contributing hits — what exactly is being used (drill-down) */
  hits: EvidenceHit[];
}

/** A loose stat plus what footage would tighten it (Output Contract §8). */
export interface MissingNote {
  stat: NonHpStat;
  tag: StatTag;
  reason: string;
  resolve: string;
}

/** How a mon's posterior was computed (Constraint Model §10 — recorded for transparency). */
export type SolveMethod = 'exact' | 'sampled' | 'phaseA-ranges';

export interface MonReport {
  monId: string;
  species: string;
  spHp: number;
  perStat: StatReport[];
  headline?: SpreadCandidate;
  candidates: SpreadCandidate[];
  /** posterior mass not covered by the listed candidates */
  remainingMass: number;
  /** remainingMass rounded to the nearest 5% for display */
  remainingMassPct: number;
  /** provenance — how much evidence informed this result */
  evidence: EvidenceSummary;
  /** missing-evidence notes for every loose (guessed/bounded) stat */
  missing: MissingNote[];
  /** which method produced this posterior */
  method?: SolveMethod;
  /** set when this mon's clean constraints are unsatisfiable (no force-fit) */
  contradiction?: string;
  /** set when the feasible space was too large to weight exactly (Phase A still shown) */
  note?: string;
}

export interface SolveResult {
  mons: MonReport[];
  contradictions: string[];
}

export interface SampleConfig {
  iterations: number;
  burnIn: number;
  thin: number;
  seed: number;
  /** attempts to find a feasible starting joint before degrading */
  initTries: number;
}

export const DEFAULT_SAMPLE_CONFIG: SampleConfig = {
  iterations: 6000,
  burnIn: 1000,
  thin: 4,
  seed: 0x9e3779b9,
  initTries: 200,
};

export interface SolveOptions {
  prior?: SpreadPrior;
  /** how many ranked full spreads per mon (default 5) */
  maxCandidates?: number;
  /** enumeration ceiling per mon / per component before falling back to sampling */
  enumCap?: number;
  /**
   * 'auto' (default): exact enumeration when a component fits under enumCap, else
   * Gibbs sampling. 'exact'/'sample' force a method (Constraint Model §10).
   */
  method?: 'auto' | 'exact' | 'sample';
  sampleConfig?: Partial<SampleConfig>;
}

interface HitFactor {
  attackerId: string;
  defenderId: string;
  offStat: NonHpStat;
  defStat: NonHpStat;
  weights: Map<string, number>;
  move: string;
  observedDamage: number;
  source?: string | undefined;
}

interface SpeedRelation {
  firstId: string;
  secondId: string;
  allowed: Set<string>;
}

type VarKey = string; // `${monId}|${stat}`
const vkey = (monId: string, stat: string): VarKey => `${monId}|${stat}`;
const fullDomain = (): Set<number> => new Set(Array.from({ length: SP_MAX - SP_MIN + 1 }, (_, i) => SP_MIN + i));

interface Constraint {
  readonly vars: VarKey[];
  /** prune the target variable's domain using this constraint; true if it changed */
  revise(target: VarKey, domains: Map<VarKey, Set<number>>): boolean;
  describe(): string;
}

/**
 * Generic binary relation over two SP variables: an allowed set of "a,b" pairs.
 * Both the damage factor (offensive SP × defensive SP) and the speed factor
 * (Spe SP × Spe SP) are this shape.
 */
class BinaryRelation implements Constraint {
  readonly vars: VarKey[];
  constructor(
    private readonly aVar: VarKey,
    private readonly bVar: VarKey,
    private readonly allowed: Set<string>,
    private readonly label: string,
  ) {
    this.vars = [aVar, bVar];
  }

  revise(target: VarKey, domains: Map<VarKey, Set<number>>): boolean {
    const dom = domains.get(target)!;
    const isA = target === this.aVar;
    const otherDom = domains.get(isA ? this.bVar : this.aVar)!;
    let changed = false;
    for (const value of [...dom]) {
      let supported = false;
      for (const other of otherDom) {
        const key = isA ? `${value},${other}` : `${other},${value}`;
        if (this.allowed.has(key)) {
          supported = true;
          break;
        }
      }
      if (!supported) {
        dom.delete(value);
        changed = true;
      }
    }
    return changed;
  }

  describe(): string {
    return this.label;
  }
}

/** N-ary budget equality: the mon's five non-HP SP sum to exactly `target`. */
class BudgetConstraint implements Constraint {
  readonly vars: VarKey[];
  constructor(
    vars: VarKey[],
    private readonly target: number,
    private readonly label: string,
  ) {
    this.vars = vars;
  }

  revise(target: VarKey, domains: Map<VarKey, Set<number>>): boolean {
    const otherDoms = this.vars.filter((v) => v !== target).map((v) => domains.get(v)!);
    const reachable = reachableSums(otherDoms, this.target);
    const dom = domains.get(target)!;
    let changed = false;
    for (const value of [...dom]) {
      const need = this.target - value;
      if (need < 0 || !reachable.has(need)) {
        dom.delete(value);
        changed = true;
      }
    }
    return changed;
  }

  describe(): string {
    return this.label;
  }
}

/** Effective (modified) speed for a candidate Spe SP: floor(final Spe × control). */
function effectiveSpeed(base: number, sp: number, role: ReturnType<typeof roleOf>, control?: SpeedControl): number {
  const final = spToFinal(base, sp, role);
  const num = control?.num ?? 1;
  const den = control?.den ?? 1;
  return Math.floor((final * num) / den);
}

/** Exact set of sums obtainable by choosing one value from each domain (capped at `cap`). */
function reachableSums(domains: Set<number>[], cap: number): Set<number> {
  let current = new Set<number>([0]);
  for (const domain of domains) {
    const next = new Set<number>();
    for (const sum of current) {
      for (const value of domain) {
        const total = sum + value;
        if (total <= cap) next.add(total);
      }
    }
    current = next;
  }
  return current;
}

export class ConstraintSystem {
  private readonly domains = new Map<VarKey, Set<number>>();
  private readonly constraints: Constraint[] = [];
  private readonly byVar = new Map<VarKey, Constraint[]>();
  private readonly spHp = new Map<string, number>();
  private readonly monIds: string[] = [];
  private readonly specs = new Map<string, MonSpec>();
  // Phase-B inputs: per-hit likelihood weights, speed feasibility, and which
  // stats a hard factor actually touched (drives guessed-vs-bounded tagging).
  private readonly hitFactors: HitFactor[] = [];
  private readonly speedRelations: SpeedRelation[] = [];
  private readonly touched = new Map<string, Set<NonHpStat>>();

  constructor(
    gen: Gen,
    mons: SolverMon[],
    hits: SolverHit[],
    speedFacts: SpeedFact[] = [],
    registry: ExceptionRegistry = championsExceptions,
  ) {
    const specs = this.specs;
    for (const mon of mons) {
      this.monIds.push(mon.id);
      specs.set(mon.id, mon.spec);
      this.touched.set(mon.id, new Set());
      // HP is READ (B5): SP_hp = maxHp − base − 75. An invalid HP raises (R3), never clamps.
      const spHp = maxHpToSpHp(baseStatOf(gen, mon.spec.species, 'hp'), mon.observedMaxHp);
      this.spHp.set(mon.id, spHp);
      for (const stat of NON_HP_STATS) this.domains.set(vkey(mon.id, stat), fullDomain());
      this.addConstraint(
        new BudgetConstraint(
          NON_HP_STATS.map((s) => vkey(mon.id, s)),
          SP_BUDGET - spHp,
          `budget:${mon.id}(=${SP_BUDGET - spHp})`,
        ),
      );
    }

    // A hit's attacker/defender may be in a Mega forme at the time: use that forme's
    // base stats + ability for this hit, while the SP variable stays the mon's own.
    const formeSpec = (base: MonSpec, species?: string): MonSpec => {
      if (!species || species === base.species) return base;
      const ability = primaryAbilityOf(gen, species);
      return { ...base, species, ...(ability ? { ability } : {}) };
    };

    for (const hit of hits) {
      const attackerBase = specs.get(hit.attackerId);
      const defenderBase = specs.get(hit.defenderId);
      if (!attackerBase) throw new Error(`hit references unknown attacker ${hit.attackerId}`);
      if (!defenderBase) throw new Error(`hit references unknown defender ${hit.defenderId}`);
      const attacker = formeSpec(attackerBase, hit.attackerSpecies);
      const defender = formeSpec(defenderBase, hit.defenderSpecies);
      const factor = damageFactor(
        gen,
        { attacker, defender, move: hit.move, observedDamage: hit.observedDamage, crit: hit.crit },
        registry,
      );
      const allowed = new Set(factor.feasible.map((p) => `${p.attackerSp},${p.defenderSp}`));
      const weights = new Map(factor.feasible.map((p) => [`${p.attackerSp},${p.defenderSp}`, p.weight]));
      this.hitFactors.push({
        attackerId: hit.attackerId,
        defenderId: hit.defenderId,
        offStat: factor.offensiveStat as NonHpStat,
        defStat: factor.defensiveStat as NonHpStat,
        weights,
        move: hit.move,
        observedDamage: hit.observedDamage,
        source: hit.source,
      });
      this.touched.get(hit.attackerId)!.add(factor.offensiveStat as NonHpStat);
      this.touched.get(hit.defenderId)!.add(factor.defensiveStat as NonHpStat);
      this.addConstraint(
        new BinaryRelation(
          vkey(hit.attackerId, factor.offensiveStat),
          vkey(hit.defenderId, factor.defensiveStat),
          allowed,
          `dmg:${hit.attackerId}->${hit.defenderId} ${hit.move}=${hit.observedDamage}`,
        ),
      );
    }

    for (const fact of speedFacts) {
      // §4 guard: orderings across different priority brackets carry NO speed info.
      if (!fact.samePriorityBracket) continue;
      const firstBase = specs.get(fact.firstId);
      const secondBase = specs.get(fact.secondId);
      if (!firstBase) throw new Error(`speed fact references unknown mon ${fact.firstId}`);
      if (!secondBase) throw new Error(`speed fact references unknown mon ${fact.secondId}`);
      const first = formeSpec(firstBase, fact.firstSpecies);
      const second = formeSpec(secondBase, fact.secondSpecies);
      const fBase = baseStatOf(gen, first.species, 'spe');
      const sBase = baseStatOf(gen, second.species, 'spe');
      const fRole = roleOf(first.alignment, 'spe');
      const sRole = roleOf(second.alignment, 'spe');
      const allowed = new Set<string>();
      for (let a = SP_MIN; a <= SP_MAX; a++) {
        const effA = effectiveSpeed(fBase, a, fRole, fact.firstControl);
        for (let b = SP_MIN; b <= SP_MAX; b++) {
          const effB = effectiveSpeed(sBase, b, sRole, fact.secondControl);
          // first acted before second: under Trick Room the slower acts first.
          const ok = fact.tie ? effA === effB : fact.trickRoom ? effA <= effB : effA >= effB;
          if (ok) allowed.add(`${a},${b}`);
        }
      }
      this.speedRelations.push({ firstId: fact.firstId, secondId: fact.secondId, allowed });
      this.touched.get(fact.firstId)!.add('spe');
      this.touched.get(fact.secondId)!.add('spe');
      this.addConstraint(
        new BinaryRelation(
          vkey(fact.firstId, 'spe'),
          vkey(fact.secondId, 'spe'),
          allowed,
          `speed:${fact.firstId}<${fact.secondId}${fact.trickRoom ? '(TR)' : ''}${fact.tie ? '(tie)' : ''}`,
        ),
      );
    }
  }

  private addConstraint(constraint: Constraint): void {
    this.constraints.push(constraint);
    for (const v of constraint.vars) {
      const list = this.byVar.get(v);
      if (list) list.push(constraint);
      else this.byVar.set(v, [constraint]);
    }
  }

  /** Intersect a stat's domain with a known set of SP values (e.g. a confirmed stat). */
  restrictDomain(monId: string, stat: NonHpStat, values: Iterable<number>): void {
    const dom = this.domains.get(vkey(monId, stat));
    if (!dom) throw new Error(`unknown variable ${monId}|${stat}`);
    const keep = new Set(values);
    for (const v of [...dom]) if (!keep.has(v)) dom.delete(v);
  }

  /** Run GAC to a fixpoint, returning the pruned domains and any contradictions. */
  propagate(): PhaseAResult {
    const queue: Array<[Constraint, VarKey]> = [];
    for (const c of this.constraints) for (const v of c.vars) queue.push([c, v]);

    const emptied = new Set<VarKey>();
    const contradictions: string[] = [];

    while (queue.length > 0) {
      const [c, v] = queue.shift()!;
      if (!c.revise(v, this.domains)) continue;
      if (this.domains.get(v)!.size === 0 && !emptied.has(v)) {
        emptied.add(v);
        contradictions.push(
          `INCONSISTENT: ${v} has no feasible SP under the clean constraints ` +
            `(triggered by ${c.describe()}) — likely a logging error or unrecorded modifier; recommend re-watch.`,
        );
      }
      for (const c2 of this.byVar.get(v) ?? []) {
        if (c2 === c) continue;
        for (const w of c2.vars) if (w !== v) queue.push([c2, w]);
      }
    }

    const domains = new Map<string, Map<NonHpStat, number[]>>();
    for (const monId of this.monIds) {
      const perStat = new Map<NonHpStat, number[]>();
      for (const stat of NON_HP_STATS) {
        perStat.set(stat, [...this.domains.get(vkey(monId, stat))!].sort((a, b) => a - b));
      }
      domains.set(monId, perStat);
    }
    return { domains, spHp: new Map(this.spHp), contradictions };
  }

  /**
   * Phase A + Phase B (Constraint Model §5–8): propagate hard constraints, then
   * weight the surviving feasible space by `prior × likelihood` and report a
   * tagged posterior per mon. Tags come from Phase A (never the prior, §E4).
   */
  solve(options: SolveOptions = {}): SolveResult {
    const prior = options.prior ?? structuralPrior;
    const maxCandidates = options.maxCandidates ?? 5;
    const enumCap = options.enumCap ?? 500_000;

    const phaseA = this.propagate();
    const components = this.components();
    const reports = new Map<string, MonReport>();

    for (const monId of this.monIds) {
      const perStatDomains = phaseA.domains.get(monId)!;
      const empty = NON_HP_STATS.some((s) => perStatDomains.get(s)!.length === 0);
      reports.set(monId, {
        monId,
        species: this.specs.get(monId)!.species,
        spHp: this.spHp.get(monId)!,
        perStat: [],
        candidates: [],
        remainingMass: 1,
        remainingMassPct: 100,
        evidence: this.computeEvidence(monId),
        missing: [],
        ...(empty
          ? { contradiction: phaseA.contradictions.find((c) => c.includes(monId)) ?? 'no feasible spread' }
          : {}),
      });
    }

    const method = options.method ?? 'auto';
    const sampleConfig: SampleConfig = { ...DEFAULT_SAMPLE_CONFIG, ...options.sampleConfig };

    for (const component of components) {
      // skip a component that contains a contradicted mon — already flagged.
      if (component.some((m) => reports.get(m)!.contradiction)) continue;
      if (method === 'sample') {
        this.sampleComponent(component, phaseA, prior, maxCandidates, sampleConfig, reports);
        continue;
      }
      const handled = this.exactComponent(component, phaseA, prior, maxCandidates, enumCap, reports);
      if (handled) continue;
      // too large to enumerate exactly:
      if (method === 'exact') this.degradeComponent(component, phaseA, reports);
      else this.sampleComponent(component, phaseA, prior, maxCandidates, sampleConfig, reports);
    }

    return {
      mons: this.monIds.map((id) => finalizeReport(reports.get(id)!, this.spHp.get(id)!)),
      contradictions: phaseA.contradictions,
    };
  }

  /** Connected components of mons, linked by shared damage hits and speed facts. */
  private components(): string[][] {
    const parent = new Map<string, string>();
    for (const id of this.monIds) parent.set(id, id);
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(x) !== r) {
        const next = parent.get(x)!;
        parent.set(x, r);
        x = next;
      }
      return r;
    };
    const union = (a: string, b: string): void => {
      parent.set(find(a), find(b));
    };
    for (const f of this.hitFactors) union(f.attackerId, f.defenderId);
    for (const s of this.speedRelations) union(s.firstId, s.secondId);
    const groups = new Map<string, string[]>();
    for (const id of this.monIds) {
      const root = find(id);
      (groups.get(root) ?? groups.set(root, []).get(root)!).push(id);
    }
    return [...groups.values()];
  }

  private computeEvidence(monId: string): EvidenceSummary {
    const hits: EvidenceHit[] = [];
    for (const f of this.hitFactors) {
      if (f.defenderId === monId)
        hits.push({ role: 'taken', stat: f.defStat, move: f.move, observedDamage: f.observedDamage, opponentSpecies: this.specs.get(f.attackerId)?.species ?? f.attackerId, ...(f.source ? { source: f.source } : {}) });
      if (f.attackerId === monId)
        hits.push({ role: 'dealt', stat: f.offStat, move: f.move, observedDamage: f.observedDamage, opponentSpecies: this.specs.get(f.defenderId)?.species ?? f.defenderId, ...(f.source ? { source: f.source } : {}) });
    }
    return {
      cleanHitsIn: this.hitFactors.filter((f) => f.defenderId === monId).length,
      cleanHitsOut: this.hitFactors.filter((f) => f.attackerId === monId).length,
      speedFacts: this.speedRelations.filter((s) => s.firstId === monId || s.secondId === monId).length,
      hits,
    };
  }

  private componentHits(component: string[]): HitFactor[] {
    return this.hitFactors.filter((f) => component.includes(f.attackerId));
  }

  private componentSpeeds(component: string[]): SpeedRelation[] {
    return this.speedRelations.filter((s) => component.includes(s.firstId));
  }

  private domainArrays(monId: string, phaseA: PhaseAResult): Record<NonHpStat, number[]> {
    return Object.fromEntries(
      NON_HP_STATS.map((s) => [s, phaseA.domains.get(monId)!.get(s)!]),
    ) as Record<NonHpStat, number[]>;
  }

  /** Exact enumeration over the component. Returns false (handled nothing) if any mon exceeds enumCap. */
  private exactComponent(
    component: string[],
    phaseA: PhaseAResult,
    prior: SpreadPrior,
    maxCandidates: number,
    enumCap: number,
    reports: Map<string, MonReport>,
  ): boolean {
    const spreadsByMon = new Map<string, Array<Record<NonHpStat, number>>>();
    for (const monId of component) {
      const target = SP_BUDGET - this.spHp.get(monId)!;
      const list = enumerateSpreads(this.domainArrays(monId, phaseA), target, enumCap);
      if (list === null) return false; // too large — caller will sample or degrade
      spreadsByMon.set(monId, list);
    }

    const hits = this.componentHits(component);
    const speeds = this.componentSpeeds(component);
    const monSpreadMass = new Map<string, Map<string, number>>();
    const statMass = new Map<string, Map<NonHpStat, Map<number, number>>>();
    for (const m of component) {
      monSpreadMass.set(m, new Map());
      statMass.set(m, new Map(NON_HP_STATS.map((s) => [s, new Map<number, number>()])));
    }
    let totalMass = 0;
    const assignment = new Map<string, Record<NonHpStat, number>>();

    const dfs = (i: number, weight: number): void => {
      if (weight === 0) return;
      if (i === component.length) {
        const w = jointWeight(assignment, hits, speeds, weight);
        if (w === 0) return;
        totalMass += w;
        record(component, assignment, w, monSpreadMass, statMass);
        return;
      }
      const monId = component[i]!;
      for (const spread of spreadsByMon.get(monId)!) {
        assignment.set(monId, spread);
        dfs(i + 1, weight * prior.weight(spread, this.spHp.get(monId)!));
      }
    };
    dfs(0, 1);

    if (totalMass === 0) {
      this.degradeComponent(component, phaseA, reports, 'no weighted joint support');
      return true;
    }
    this.writeComponentReports(component, monSpreadMass, statMass, totalMass, phaseA, maxCandidates, reports, 'exact');
    return true;
  }

  /**
   * Gibbs sampling over a too-large component (Constraint Model §10 fallback).
   * Moves reallocate SP between a pair of stats within a mon (sum preserved →
   * budget always respected), drawn from the exact local conditional, so the
   * chain targets the same posterior the exact path computes.
   */
  private sampleComponent(
    component: string[],
    phaseA: PhaseAResult,
    prior: SpreadPrior,
    maxCandidates: number,
    cfg: SampleConfig,
    reports: Map<string, MonReport>,
  ): void {
    const rng = mulberry32(cfg.seed);
    const hits = this.componentHits(component);
    const speeds = this.componentSpeeds(component);
    const domSets = new Map<string, Record<NonHpStat, Set<number>>>();
    const targets = new Map<string, number>();
    for (const monId of component) {
      const arr = this.domainArrays(monId, phaseA);
      domSets.set(monId, Object.fromEntries(NON_HP_STATS.map((s) => [s, new Set(arr[s])])) as Record<NonHpStat, Set<number>>);
      targets.set(monId, SP_BUDGET - this.spHp.get(monId)!);
    }

    const state = findFeasibleInit(component, domSets, targets, hits, speeds, rng, cfg.initTries);
    if (!state) {
      this.degradeComponent(component, phaseA, reports, 'could not find a feasible starting point to sample');
      return;
    }

    const monSpreadMass = new Map<string, Map<string, number>>();
    const statMass = new Map<string, Map<NonHpStat, Map<number, number>>>();
    for (const m of component) {
      monSpreadMass.set(m, new Map());
      statMass.set(m, new Map(NON_HP_STATS.map((s) => [s, new Map<number, number>()])));
    }
    let samples = 0;
    for (let iter = 0; iter < cfg.iterations; iter++) {
      gibbsSweep(state, component, domSets, prior, this.spHp, hits, speeds, rng);
      if (iter >= cfg.burnIn && (iter - cfg.burnIn) % cfg.thin === 0) {
        samples++;
        record(component, state, 1, monSpreadMass, statMass);
      }
    }
    this.writeComponentReports(component, monSpreadMass, statMass, samples, phaseA, maxCandidates, reports, 'sampled');
  }

  /** Honest fallback: report the Phase-A feasible ranges as uniform distributions. */
  private degradeComponent(
    component: string[],
    phaseA: PhaseAResult,
    reports: Map<string, MonReport>,
    reason = 'feasible space too large to weight exactly',
  ): void {
    for (const m of component) {
      const r = reports.get(m)!;
      r.method = 'phaseA-ranges';
      r.note = `${reason}; showing Phase-A feasible ranges`;
      r.perStat = phaseAStatReports(m, phaseA, this.spHp.get(m)!, this.touched.get(m)!);
    }
  }

  private writeComponentReports(
    component: string[],
    monSpreadMass: Map<string, Map<string, number>>,
    statMass: Map<string, Map<NonHpStat, Map<number, number>>>,
    totalMass: number,
    phaseA: PhaseAResult,
    maxCandidates: number,
    reports: Map<string, MonReport>,
    method: SolveMethod,
  ): void {
    for (const monId of component) {
      const report = reports.get(monId)!;
      report.method = method;
      report.perStat = buildStatReports(
        monId,
        statMass.get(monId)!,
        totalMass,
        this.spHp.get(monId)!,
        phaseA.domains.get(monId)!,
        this.touched.get(monId)!,
      );
      const ranked = [...monSpreadMass.get(monId)!.entries()]
        .map(([key, mass]) => {
          const confidence = mass / totalMass;
          return { spread: spreadFromKey(key), confidence, confidencePct: pct5(confidence) };
        })
        .sort((a, b) => b.confidence - a.confidence);
      report.candidates = ranked.slice(0, maxCandidates);
      if (ranked[0]) report.headline = ranked[0];
      report.remainingMass = 1 - report.candidates.reduce((acc, c) => acc + c.confidence, 0);
      report.remainingMassPct = pct5(report.remainingMass);
    }
  }
}

const spreadFromKey = (key: string): Record<NonHpStat, number> => {
  const parts = key.split('/').map(Number);
  return { atk: parts[0]!, def: parts[1]!, spa: parts[2]!, spd: parts[3]!, spe: parts[4]! };
};

type Assignment = Map<string, Record<NonHpStat, number>>;

/** Hard/likelihood weight of a full joint assignment (0 if any factor forbids it). */
function jointWeight(assignment: Assignment, hits: HitFactor[], speeds: SpeedRelation[], base = 1): number {
  let w = base;
  for (const h of hits) {
    const off = assignment.get(h.attackerId)![h.offStat];
    const def = assignment.get(h.defenderId)![h.defStat];
    w *= h.weights.get(`${off},${def}`) ?? 0;
    if (w === 0) return 0;
  }
  for (const s of speeds) {
    if (!s.allowed.has(`${assignment.get(s.firstId)!.spe},${assignment.get(s.secondId)!.spe}`)) return 0;
  }
  return w;
}

/** Accumulate one weighted joint assignment into the per-mon and per-stat mass maps. */
function record(
  component: string[],
  assignment: Assignment,
  w: number,
  monSpreadMass: Map<string, Map<string, number>>,
  statMass: Map<string, Map<NonHpStat, Map<number, number>>>,
): void {
  for (const m of component) {
    const spread = assignment.get(m)!;
    const key = NON_HP_STATS.map((s) => spread[s]).join('/');
    const sm = monSpreadMass.get(m)!;
    sm.set(key, (sm.get(key) ?? 0) + w);
    const stm = statMass.get(m)!;
    for (const s of NON_HP_STATS) {
      const map = stm.get(s)!;
      map.set(spread[s], (map.get(spread[s]) ?? 0) + w);
    }
  }
}

/** Deterministic, seedable PRNG (mulberry32) — reproducible sampling for tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** A random spread within `doms` summing to `target` (suffix bounds keep it feasible); null if none. */
function randomComposition(
  doms: Record<NonHpStat, Set<number>>,
  target: number,
  rng: () => number,
): Record<NonHpStat, number> | null {
  const order = shuffle(NON_HP_STATS, rng);
  const arrs = order.map((s) => [...doms[s]].sort((a, b) => a - b));
  const n = order.length;
  const sufMin = new Array<number>(n + 1).fill(0);
  const sufMax = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const a = arrs[i]!;
    sufMin[i] = sufMin[i + 1]! + (a.length ? a[0]! : Infinity);
    sufMax[i] = sufMax[i + 1]! + (a.length ? a[a.length - 1]! : -Infinity);
  }
  const out: Record<string, number> = {};
  let remaining = target;
  for (let i = 0; i < n; i++) {
    const feasible = arrs[i]!.filter((v) => {
      const rem = remaining - v;
      return rem >= sufMin[i + 1]! && rem <= sufMax[i + 1]!;
    });
    if (feasible.length === 0) return null;
    const v = feasible[Math.floor(rng() * feasible.length)]!;
    out[order[i]!] = v;
    remaining -= v;
  }
  return out as Record<NonHpStat, number>;
}

function findFeasibleInit(
  component: string[],
  domSets: Map<string, Record<NonHpStat, Set<number>>>,
  targets: Map<string, number>,
  hits: HitFactor[],
  speeds: SpeedRelation[],
  rng: () => number,
  tries: number,
): Assignment | null {
  for (let t = 0; t < tries; t++) {
    const state: Assignment = new Map();
    let ok = true;
    for (const m of component) {
      const comp = randomComposition(domSets.get(m)!, targets.get(m)!, rng);
      if (!comp) {
        ok = false;
        break;
      }
      state.set(m, comp);
    }
    if (ok && jointWeight(state, hits, speeds, 1) > 0) return state;
  }
  return null;
}

/**
 * One Gibbs sweep: for every mon and every stat pair, reallocate SP between the
 * two (sum fixed → budget preserved), drawn from the exact local conditional.
 */
function gibbsSweep(
  state: Assignment,
  component: string[],
  domSets: Map<string, Record<NonHpStat, Set<number>>>,
  prior: SpreadPrior,
  spHpMap: Map<string, number>,
  hits: HitFactor[],
  speeds: SpeedRelation[],
  rng: () => number,
): void {
  for (const monId of component) {
    const doms = domSets.get(monId)!;
    const spHp = spHpMap.get(monId)!;
    for (let a = 0; a < NON_HP_STATS.length; a++) {
      for (let b = a + 1; b < NON_HP_STATS.length; b++) {
        const si = NON_HP_STATS[a]!;
        const sj = NON_HP_STATS[b]!;
        const original = state.get(monId)!;
        const sum = original[si] + original[sj];
        const candidates: Array<{ ti: number; tj: number; w: number }> = [];
        let totalW = 0;
        for (const ti of doms[si]) {
          const tj = sum - ti;
          if (tj < 0 || !doms[sj].has(tj)) continue;
          const trial = { ...original, [si]: ti, [sj]: tj } as Record<NonHpStat, number>;
          state.set(monId, trial);
          const w = prior.weight(trial, spHp) * jointWeight(state, hits, speeds, 1);
          state.set(monId, original);
          if (w > 0) {
            candidates.push({ ti, tj, w });
            totalW += w;
          }
        }
        if (totalW <= 0 || candidates.length === 0) continue; // no valid move; keep current
        let r = rng() * totalW;
        let chosen = candidates[candidates.length - 1]!;
        for (const c of candidates) {
          r -= c.w;
          if (r <= 0) {
            chosen = c;
            break;
          }
        }
        state.set(monId, { ...original, [si]: chosen.ti, [sj]: chosen.tj } as Record<NonHpStat, number>);
      }
    }
  }
}

/** Enumerate every spread whose stats lie in `doms` and sum to `target`; null if > cap. */
function enumerateSpreads(
  doms: Record<NonHpStat, number[]>,
  target: number,
  cap: number,
): Array<Record<NonHpStat, number>> | null {
  const order: NonHpStat[] = ['atk', 'def', 'spa', 'spd', 'spe'];
  const suffixMin = new Array<number>(order.length + 1).fill(0);
  const suffixMax = new Array<number>(order.length + 1).fill(0);
  for (let i = order.length - 1; i >= 0; i--) {
    const d = doms[order[i]!];
    suffixMin[i] = suffixMin[i + 1]! + (d.length ? Math.min(...d) : Infinity);
    suffixMax[i] = suffixMax[i + 1]! + (d.length ? Math.max(...d) : -Infinity);
  }
  const results: Array<Record<NonHpStat, number>> = [];
  const cur: Record<string, number> = {};
  let overflow = false;
  const rec = (i: number, remaining: number): void => {
    if (overflow) return;
    if (i === order.length) {
      if (remaining === 0) {
        results.push({ ...cur } as Record<NonHpStat, number>);
        if (results.length > cap) overflow = true;
      }
      return;
    }
    for (const v of doms[order[i]!]) {
      const rem = remaining - v;
      if (rem < suffixMin[i + 1]! || rem > suffixMax[i + 1]!) continue;
      cur[order[i]!] = v;
      rec(i + 1, rem);
      if (overflow) return;
    }
  };
  rec(0, target);
  return overflow ? null : results;
}

/** Tag a stat from Phase A: never `locked` unless a factor pinned it to one value (§E4). */
function tagFor(stat: AllStat, touched: boolean, domainSize: number): StatTag {
  if (stat === 'hp') return 'read';
  if (!touched) return 'guessed'; // no relevant observation — the prior is talking
  return domainSize === 1 ? 'locked' : 'bounded';
}

function buildStatReports(
  monId: string,
  statMass: Map<NonHpStat, Map<number, number>>,
  totalMass: number,
  spHp: number,
  domains: Map<NonHpStat, number[]>,
  touched: Set<NonHpStat>,
): StatReport[] {
  const reports: StatReport[] = [{ stat: 'hp', tag: 'read', best: spHp, distribution: [{ sp: spHp, p: 1 }] }];
  for (const stat of NON_HP_STATS) {
    const dist = [...statMass.get(stat)!.entries()]
      .map(([sp, mass]) => ({ sp, p: mass / totalMass }))
      .sort((a, b) => b.p - a.p);
    const domain = domains.get(stat)!;
    const report: StatReport = {
      stat,
      tag: tagFor(stat, touched.has(stat), domain.length),
      best: dist[0]?.sp ?? domain[0] ?? 0,
      distribution: dist,
    };
    if (domain.length > 0) report.range = [Math.min(...domain), Math.max(...domain)];
    reports.push(report);
  }
  return reports;
}

/** Degraded path: report Phase-A feasible ranges as uniform distributions (honest). */
function phaseAStatReports(
  monId: string,
  phaseA: PhaseAResult,
  spHp: number,
  touched: Set<NonHpStat>,
): StatReport[] {
  const reports: StatReport[] = [{ stat: 'hp', tag: 'read', best: spHp, distribution: [{ sp: spHp, p: 1 }] }];
  for (const stat of NON_HP_STATS) {
    const domain = phaseA.domains.get(monId)!.get(stat)!;
    const p = domain.length ? 1 / domain.length : 0;
    const report: StatReport = {
      stat,
      tag: tagFor(stat, touched.has(stat), domain.length),
      best: domain[0] ?? 0,
      distribution: domain.map((sp) => ({ sp, p })),
    };
    if (domain.length > 0) report.range = [Math.min(...domain), Math.max(...domain)];
    reports.push(report);
  }
  return reports;
}

/** Round a probability (0..1) to the nearest 5% for honest display. */
function pct5(p: number): number {
  return Math.round((p * 100) / 5) * 5;
}

const STAT_LABEL: Record<NonHpStat, string> = {
  atk: 'physical attack',
  def: 'physical bulk',
  spa: 'special attack',
  spd: 'special bulk',
  spe: 'Speed',
};

/** Missing-evidence note for one loose stat: why it is loose and what footage resolves it. */
function noteFor(stat: NonHpStat, tag: StatTag): MissingNote {
  const offensive = stat === 'atk' || stat === 'spa';
  const defensive = stat === 'def' || stat === 'spd';
  const physical = stat === 'atk' || stat === 'def';
  const kind = physical ? 'physical' : 'special';
  if (stat === 'spe') {
    return tag === 'guessed'
      ? { stat, tag, reason: 'no turn-order evidence pins this mon’s Speed.', resolve: 'log a move-order vs a known-Speed mon in the same priority bracket.' }
      : { stat, tag, reason: 'bracketed by turn order but not pinned.', resolve: 'log a speed tie, or an order against a known Speed at the boundary.' };
  }
  if (tag === 'guessed') {
    return offensive
      ? { stat, tag, reason: `never seen dealing a ${kind} hit, so ${STAT_LABEL[stat]} is unconstrained.`, resolve: `log one clean ${kind} hit it deals.` }
      : { stat, tag, reason: `never seen taking a ${kind} hit, so ${STAT_LABEL[stat]} is unconstrained.`, resolve: `log one clean ${kind} hit it takes.` };
  }
  // bounded
  return offensive || defensive
    ? { stat, tag, reason: `${STAT_LABEL[stat]} is observed but coupled to a single matchup.`, resolve: `log a ${kind} hit ${offensive ? 'it deals against a different defender' : 'from a different attacker'}.` }
    : { stat, tag, reason: `${STAT_LABEL[stat]} narrowed but not pinned.`, resolve: 'log a more diverse matchup touching it.' };
}

function missingNotes(perStat: StatReport[]): MissingNote[] {
  const notes: MissingNote[] = [];
  for (const r of perStat) {
    if (r.stat === 'hp') continue;
    if (r.tag === 'guessed' || r.tag === 'bounded') notes.push(noteFor(r.stat, r.tag));
  }
  return notes;
}

/** Finalize a report: minimal HP entry if empty, plus missing-evidence notes. */
function finalizeReport(report: MonReport, spHp: number): MonReport {
  if (report.perStat.length === 0) {
    report.perStat = [{ stat: 'hp', tag: 'read', best: spHp, distribution: [{ sp: spHp, p: 1 }] }];
  }
  report.missing = missingNotes(report.perStat);
  return report;
}

/** Render a mon report as the human-readable Output Contract §11 block. */
export function formatMonReport(report: MonReport): string {
  const lines: string[] = [];
  lines.push(`${report.monId}  ${report.species}`);
  if (report.contradiction) {
    lines.push(`  FLAG: ${report.contradiction}`);
    return lines.join('\n');
  }
  if (report.headline) {
    const h = report.headline.spread;
    lines.push(
      `  HEADLINE  HP ${report.spHp} · Atk ${h.atk} · Def ${h.def} · SpA ${h.spa} · SpD ${h.spd} · Spe ${h.spe}` +
        `   (${report.headline.confidencePct}%${report.method === 'sampled' ? ', sampled' : ''})`,
    );
  }
  lines.push('  PER-STAT:');
  for (const r of report.perStat) {
    const range = r.range && r.tag === 'bounded' ? `  range ${r.range[0]}–${r.range[1]}` : '';
    lines.push(`    ${r.stat.toUpperCase().padEnd(3)} ${String(r.best).padStart(2)} SP   [${r.tag}]${range}`);
  }
  lines.push(
    `  EVIDENCE: ${report.evidence.cleanHitsIn} clean hits taken · ${report.evidence.cleanHitsOut} dealt · ${report.evidence.speedFacts} speed facts`,
  );
  if (report.candidates.length > 0) {
    lines.push('  CANDIDATES:');
    report.candidates.forEach((c, i) => {
      const s = c.spread;
      lines.push(`    ${i + 1}  ${s.atk}/${s.def}/${s.spa}/${s.spd}/${s.spe}   ${c.confidencePct}%`);
    });
    lines.push(`    remaining mass: ${report.remainingMassPct}%`);
  }
  if (report.missing.length > 0) {
    lines.push('  MISSING:');
    for (const m of report.missing) lines.push(`    ${m.stat.toUpperCase()}  ${m.reason} Resolve: ${m.resolve}`);
  }
  return lines.join('\n');
}
