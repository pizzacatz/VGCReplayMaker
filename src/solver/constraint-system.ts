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

import { baseStatOf, championsExceptions, type ExceptionRegistry, type Gen, type MonSpec } from '../engine';
import { maxHpToSpHp, SP_BUDGET, SP_MAX, SP_MIN, type StatKey } from '../conversion';
import { damageFactor } from './damage-factor';

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

export interface PhaseAResult {
  /** monId → stat → sorted feasible SP values (the pruned domains) */
  domains: Map<string, Map<NonHpStat, number[]>>;
  /** monId → read SP_hp */
  spHp: Map<string, number>;
  /** non-empty when clean constraints are unsatisfiable; never a force-fit */
  contradictions: string[];
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

/** Binary damage relation: allowed (offensive SP, defensive SP) pairs for one hit. */
class DamageConstraint implements Constraint {
  readonly vars: VarKey[];
  constructor(
    private readonly offVar: VarKey,
    private readonly defVar: VarKey,
    private readonly allowed: Set<string>,
    private readonly label: string,
  ) {
    this.vars = [offVar, defVar];
  }

  revise(target: VarKey, domains: Map<VarKey, Set<number>>): boolean {
    const dom = domains.get(target)!;
    const isOff = target === this.offVar;
    const otherDom = domains.get(isOff ? this.defVar : this.offVar)!;
    let changed = false;
    for (const value of [...dom]) {
      let supported = false;
      for (const other of otherDom) {
        const key = isOff ? `${value},${other}` : `${other},${value}`;
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

  constructor(
    gen: Gen,
    mons: SolverMon[],
    hits: SolverHit[],
    registry: ExceptionRegistry = championsExceptions,
  ) {
    const specs = new Map<string, MonSpec>();
    for (const mon of mons) {
      this.monIds.push(mon.id);
      specs.set(mon.id, mon.spec);
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
      this.addConstraint(
        new DamageConstraint(
          vkey(hit.attackerId, factor.offensiveStat),
          vkey(hit.defenderId, factor.defensiveStat),
          allowed,
          `dmg:${hit.attackerId}->${hit.defenderId} ${hit.move}=${hit.observedDamage}`,
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
}
