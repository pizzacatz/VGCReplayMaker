/**
 * The damage factor (Constraint Model T2.2 §3) — the heart of the solver.
 *
 * One clean damage event becomes one factor relating the attacker's offensive
 * stat and the defender's defensive stat. For a candidate stat pair we predict
 * the 15 Champions rolls (shared engine) and ask how many floor to the observed
 * integer damage:
 *
 *   P(observe d | attacker off, defender def) = (#rolls flooring to d) / 15.
 *
 *   0 matching rolls  → the pair is IMPOSSIBLE for this hit (Phase A drops it).
 *   ≥1 matching roll  → feasible, weighted by the count (Phase B likelihood).
 *
 * A single hit is one equation in two unknowns: it pins neither stat alone, only
 * their joint relationship — a band in the 2-D pair space (§3.3). Separation
 * comes from other factors sharing a variable; that is the global solve, built on
 * top of this factor in later slices.
 */

import { predictHit, predictMultiHit, type Gen, type HitContext, type HitInput, type MonSpec } from '../engine';
import { championsExceptions, type ExceptionRegistry } from '../engine';
import { SP_MAX, SP_MIN } from '../conversion';

/** Likelihood of an observed integer damage given a candidate's predicted rolls. */
export function likelihood(observedDamage: number, rolls: readonly number[]): number {
  if (rolls.length === 0) return 0;
  let matches = 0;
  for (const r of rolls) if (r === observedDamage) matches++;
  return matches / rolls.length;
}

/**
 * Likelihood of an observed TOTAL for a multi-hit move: the convolution of each
 * sub-hit's independent roll distribution. Computed as a DP over reachable sums,
 * so it's cheap even at 10 hits. P(total) = (#combos summing to total) / ∏|Rᵢ|.
 */
export function multiHitLikelihood(observedTotal: number, perHitRolls: number[][]): number {
  if (perHitRolls.some((r) => r.length === 0)) return 0;
  let dist = new Map<number, number>([[0, 1]]);
  for (const rolls of perHitRolls) {
    const next = new Map<number, number>();
    for (const [sum, count] of dist) for (const r of rolls) next.set(sum + r, (next.get(sum + r) ?? 0) + count);
    dist = next;
  }
  const total = perHitRolls.reduce((p, r) => p * r.length, 1);
  return (dist.get(observedTotal) ?? 0) / total;
}

export interface CleanHit {
  attacker: MonSpec;
  defender: MonSpec;
  move: string;
  /** exact observed integer damage = hp_before − hp_after (Constitution §C3) */
  observedDamage: number;
  crit?: boolean | undefined;
  /** reconstructed field/boosts/burn at hit time */
  context?: HitContext | undefined;
  /** observed number of sub-hits for a multi-hit move (>1 → convolution likelihood) */
  hits?: number | undefined;
}

export interface FeasiblePair {
  attackerSp: number;
  defenderSp: number;
  /** P(observed | this pair) — the Phase-B weight; >0 by construction here */
  weight: number;
}

export interface DamageFactor {
  /** every (attackerSp, defenderSp) pair consistent with the observed damage */
  feasible: FeasiblePair[];
  /** which two stats this factor constrains */
  offensiveStat: string;
  defensiveStat: string;
  /** pairs scanned (the full SP grid) */
  scanned: number;
}

/**
 * Build the per-hit damage factor: scan the candidate SP grid for the attacker's
 * offensive stat × the defender's defensive stat, keeping every pair whose
 * predicted rolls can produce the observed damage. The feasible set is the
 * factor's support (Phase A); the weights are its likelihood (Phase B).
 *
 * NOTE: this is the exact, brute-force form — 33×33 predictions per hit. It is
 * the ground-truth the Constraint Model §10 algorithm (enumeration vs sampling)
 * is validated against; optimization comes later, correctness first.
 */
export function damageFactor(
  gen: Gen,
  hit: CleanHit,
  registry: ExceptionRegistry = championsExceptions,
): DamageFactor {
  const feasible: FeasiblePair[] = [];
  let offensiveStat = '';
  let defensiveStat = '';
  let scanned = 0;

  const multiHit = hit.hits !== undefined && hit.hits > 1;
  for (let attackerSp = SP_MIN; attackerSp <= SP_MAX; attackerSp++) {
    for (let defenderSp = SP_MIN; defenderSp <= SP_MAX; defenderSp++) {
      const input: HitInput = {
        attacker: hit.attacker,
        attackerSp,
        defender: hit.defender,
        defenderSp,
        move: hit.move,
        crit: hit.crit,
        context: hit.context,
      };
      let weight: number;
      if (multiHit) {
        const r = predictMultiHit(gen, input, hit.hits!, registry);
        offensiveStat = r.offensiveStat;
        defensiveStat = r.defensiveStat;
        weight = multiHitLikelihood(hit.observedDamage, r.perHitRolls); // observed = the summed total
      } else {
        const { rolls, offensiveStat: off, defensiveStat: def } = predictHit(gen, input, registry);
        offensiveStat = off;
        defensiveStat = def;
        weight = likelihood(hit.observedDamage, rolls);
      }
      scanned++;
      if (weight > 0) feasible.push({ attackerSp, defenderSp, weight });
    }
  }

  return { feasible, offensiveStat, defensiveStat, scanned };
}

/** Marginal feasible SP values for the attacker's offensive stat (projection of the band). */
export function attackerMarginal(factor: DamageFactor): number[] {
  return [...new Set(factor.feasible.map((p) => p.attackerSp))].sort((a, b) => a - b);
}

/** Marginal feasible SP values for the defender's defensive stat (projection of the band). */
export function defenderMarginal(factor: DamageFactor): number[] {
  return [...new Set(factor.feasible.map((p) => p.defenderSp))].sort((a, b) => a - b);
}
