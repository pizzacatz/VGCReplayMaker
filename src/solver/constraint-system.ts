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

import { baseStatOf, championsExceptions, roleOf, type ExceptionRegistry, type Gen, type MonSpec } from '../engine';
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
  confidence: number;
}

export interface MonReport {
  monId: string;
  species: string;
  spHp: number;
  perStat: StatReport[];
  headline?: SpreadCandidate;
  candidates: SpreadCandidate[];
  /** posterior mass not covered by the listed candidates */
  remainingMass: number;
  /** set when this mon's clean constraints are unsatisfiable (no force-fit) */
  contradiction?: string;
  /** set when the feasible space was too large to weight exactly (Phase A still shown) */
  note?: string;
}

export interface SolveResult {
  mons: MonReport[];
  contradictions: string[];
}

export interface SolveOptions {
  prior?: SpreadPrior;
  /** how many ranked full spreads per mon (default 5) */
  maxCandidates?: number;
  /** enumeration ceiling per mon / per component before degrading to Phase-A ranges */
  enumCap?: number;
}

interface HitFactor {
  attackerId: string;
  defenderId: string;
  offStat: NonHpStat;
  defStat: NonHpStat;
  weights: Map<string, number>;
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

    for (const hit of hits) {
      const attacker = specs.get(hit.attackerId);
      const defender = specs.get(hit.defenderId);
      if (!attacker) throw new Error(`hit references unknown attacker ${hit.attackerId}`);
      if (!defender) throw new Error(`hit references unknown defender ${hit.defenderId}`);
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
      const first = specs.get(fact.firstId);
      const second = specs.get(fact.secondId);
      if (!first) throw new Error(`speed fact references unknown mon ${fact.firstId}`);
      if (!second) throw new Error(`speed fact references unknown mon ${fact.secondId}`);
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
        ...(empty
          ? { contradiction: phaseA.contradictions.find((c) => c.includes(monId)) ?? 'no feasible spread' }
          : {}),
      });
    }

    for (const component of components) {
      // skip a component that contains a contradicted mon — already flagged.
      if (component.some((m) => reports.get(m)!.contradiction)) continue;
      this.solveComponent(component, phaseA, prior, maxCandidates, enumCap, reports);
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

  private solveComponent(
    component: string[],
    phaseA: PhaseAResult,
    prior: SpreadPrior,
    maxCandidates: number,
    enumCap: number,
    reports: Map<string, MonReport>,
  ): void {
    // Enumerate each mon's feasible spreads (Phase-A domains ∩ budget equality).
    const spreadsByMon = new Map<string, Array<Record<NonHpStat, number>>>();
    for (const monId of component) {
      const doms: Record<NonHpStat, number[]> = Object.fromEntries(
        NON_HP_STATS.map((s) => [s, phaseA.domains.get(monId)!.get(s)!]),
      ) as Record<NonHpStat, number[]>;
      const target = SP_BUDGET - this.spHp.get(monId)!;
      const list = enumerateSpreads(doms, target, enumCap);
      if (list === null) {
        // Too large to weight exactly — degrade to Phase-A ranges, honestly noted.
        for (const m of component) {
          const r = reports.get(m)!;
          r.note = 'feasible space too large to weight exactly; showing Phase-A feasible ranges';
          r.perStat = phaseAStatReports(m, phaseA, this.spHp.get(m)!, this.touched.get(m)!);
        }
        return;
      }
      spreadsByMon.set(monId, list);
    }

    const hits = this.hitFactors.filter((f) => component.includes(f.attackerId));
    const speeds = this.speedRelations.filter((s) => component.includes(s.firstId));

    // Joint weight accumulation over the component (DFS over mons).
    const monSpreadMass = new Map<string, Map<string, number>>(); // monId → spreadKey → mass
    const statMass = new Map<string, Map<NonHpStat, Map<number, number>>>();
    for (const m of component) {
      monSpreadMass.set(m, new Map());
      statMass.set(m, new Map(NON_HP_STATS.map((s) => [s, new Map<number, number>()])));
    }
    let totalMass = 0;
    let leaves = 0;
    const assignment = new Map<string, Record<NonHpStat, number>>();

    const dfs = (i: number, weight: number): void => {
      if (weight === 0) return;
      if (i === component.length) {
        let w = weight;
        for (const h of hits) {
          const off = assignment.get(h.attackerId)![h.offStat];
          const def = assignment.get(h.defenderId)![h.defStat];
          w *= h.weights.get(`${off},${def}`) ?? 0;
          if (w === 0) return;
        }
        for (const s of speeds) {
          if (!s.allowed.has(`${assignment.get(s.firstId)!.spe},${assignment.get(s.secondId)!.spe}`)) return;
        }
        leaves++;
        totalMass += w;
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
        return;
      }
      const monId = component[i]!;
      for (const spread of spreadsByMon.get(monId)!) {
        assignment.set(monId, spread);
        dfs(i + 1, weight * prior.weight(spread, this.spHp.get(monId)!));
      }
    };
    dfs(0, 1);

    if (totalMass === 0 || leaves === 0) {
      // Feasible per Phase A but no joint support (rare numeric corner) — degrade.
      for (const m of component) {
        const r = reports.get(m)!;
        r.note = 'no weighted joint support; showing Phase-A feasible ranges';
        r.perStat = phaseAStatReports(m, phaseA, this.spHp.get(m)!, this.touched.get(m)!);
      }
      return;
    }

    for (const monId of component) {
      const report = reports.get(monId)!;
      report.perStat = buildStatReports(
        monId,
        statMass.get(monId)!,
        totalMass,
        this.spHp.get(monId)!,
        phaseA.domains.get(monId)!,
        this.touched.get(monId)!,
      );
      const ranked = [...monSpreadMass.get(monId)!.entries()]
        .map(([key, mass]) => ({
          spread: spreadFromKey(key),
          confidence: mass / totalMass,
        }))
        .sort((a, b) => b.confidence - a.confidence);
      report.candidates = ranked.slice(0, maxCandidates);
      if (ranked[0]) report.headline = ranked[0];
      report.remainingMass = 1 - report.candidates.reduce((acc, c) => acc + c.confidence, 0);
    }
  }
}

const spreadFromKey = (key: string): Record<NonHpStat, number> => {
  const parts = key.split('/').map(Number);
  return { atk: parts[0]!, def: parts[1]!, spa: parts[2]!, spd: parts[3]!, spe: parts[4]! };
};

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

/** Ensure a contradicted/empty report still has a minimal HP read entry. */
function finalizeReport(report: MonReport, spHp: number): MonReport {
  if (report.perStat.length === 0) {
    report.perStat = [{ stat: 'hp', tag: 'read', best: spHp, distribution: [{ sp: spHp, p: 1 }] }];
  }
  return report;
}
