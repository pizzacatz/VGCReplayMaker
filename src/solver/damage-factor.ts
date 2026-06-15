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
 * The per-cell predicted rolls for a whole SP grid — everything about a hit
 * EXCEPT the observed damage. Cached, because the observed damage only *filters*
 * this grid: the same matchup (attacker spec × defender spec × move × crit ×
 * context × hit count) recurs across turns and across re-solves, so the 33×33
 * predictions are computed once and reused. Stored as per-sub-hit rolls so single
 * and multi-hit share one code path (single hit = one sub-hit array).
 */
interface RollGrid {
  offensiveStat: string;
  defensiveStat: string;
  cells: Array<{ attackerSp: number; defenderSp: number; perHitRolls: number[][] }>;
}

const gridCache = new Map<string, RollGrid>();
const GRID_CACHE_CAP = 256; // ~each grid is 1089 cells; FIFO-evict to bound memory

/** Clear the memoized roll grids (tests / explicit reset). */
export function clearDamageFactorCache(): void {
  gridCache.clear();
}

/** Canonical, content-based key — different inputs never collide (a miss is safe, only slower). */
function gridKey(hit: CleanHit): string {
  const spec = (s: MonSpec) => ({ s: s.species, a: s.alignment, i: s.item ?? null, b: s.ability ?? null, l: s.level ?? 50 });
  const ctx = hit.context ? Object.fromEntries(Object.entries(hit.context).sort(([x], [y]) => x.localeCompare(y))) : null;
  return JSON.stringify([spec(hit.attacker), spec(hit.defender), hit.move, !!hit.crit, hit.hits ?? 1, ctx]);
}

function buildOrGetGrid(gen: Gen, hit: CleanHit, registry: ExceptionRegistry): RollGrid {
  const key = gridKey(hit);
  const cached = gridCache.get(key);
  if (cached) return cached;

  const multiHit = hit.hits !== undefined && hit.hits > 1;
  const cells: RollGrid['cells'] = [];
  let offensiveStat = '';
  let defensiveStat = '';
  for (let attackerSp = SP_MIN; attackerSp <= SP_MAX; attackerSp++) {
    for (let defenderSp = SP_MIN; defenderSp <= SP_MAX; defenderSp++) {
      const input: HitInput = { attacker: hit.attacker, attackerSp, defender: hit.defender, defenderSp, move: hit.move, crit: hit.crit, context: hit.context };
      if (multiHit) {
        const r = predictMultiHit(gen, input, hit.hits!, registry);
        offensiveStat = r.offensiveStat;
        defensiveStat = r.defensiveStat;
        cells.push({ attackerSp, defenderSp, perHitRolls: r.perHitRolls });
      } else {
        const r = predictHit(gen, input, registry);
        offensiveStat = r.offensiveStat;
        defensiveStat = r.defensiveStat;
        cells.push({ attackerSp, defenderSp, perHitRolls: [r.rolls] });
      }
    }
  }
  const grid: RollGrid = { offensiveStat, defensiveStat, cells };
  if (gridCache.size >= GRID_CACHE_CAP) gridCache.delete(gridCache.keys().next().value!);
  gridCache.set(key, grid);
  return grid;
}

/**
 * Build the per-hit damage factor: keep every (attackerSp, defenderSp) pair whose
 * predicted rolls can produce the observed damage. The feasible set is the
 * factor's support (Phase A); the weights are its likelihood (Phase B).
 *
 * The 33×33 predictions are memoized by matchup (everything but the observed
 * damage); the observed damage is applied here as a cheap likelihood filter. So a
 * repeated matchup — same mons/move/context across turns, or a re-solve after
 * excluding a hit — is near-instant. A single hit is one sub-hit array, so the
 * convolution likelihood reduces to the plain roll likelihood.
 */
export function damageFactor(
  gen: Gen,
  hit: CleanHit,
  registry: ExceptionRegistry = championsExceptions,
): DamageFactor {
  const grid = buildOrGetGrid(gen, hit, registry);
  const feasible: FeasiblePair[] = [];
  for (const cell of grid.cells) {
    const weight = multiHitLikelihood(hit.observedDamage, cell.perHitRolls);
    if (weight > 0) feasible.push({ attackerSp: cell.attackerSp, defenderSp: cell.defenderSp, weight });
  }
  return { feasible, offensiveStat: grid.offensiveStat, defensiveStat: grid.defensiveStat, scanned: grid.cells.length };
}

/** Marginal feasible SP values for the attacker's offensive stat (projection of the band). */
export function attackerMarginal(factor: DamageFactor): number[] {
  return [...new Set(factor.feasible.map((p) => p.attackerSp))].sort((a, b) => a - b);
}

/** Marginal feasible SP values for the defender's defensive stat (projection of the band). */
export function defenderMarginal(factor: DamageFactor): number[] {
  return [...new Set(factor.feasible.map((p) => p.defenderSp))].sort((a, b) => a - b);
}
