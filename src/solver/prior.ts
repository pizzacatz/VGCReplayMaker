/**
 * The prior (Constraint Model §8) — pluggable, weak, honest.
 *
 * Phase B re-weights the Phase-A feasible space by `prior × likelihood`. The
 * prior is the ONLY place modeling assumptions enter; it never touches Phase A,
 * so it can never manufacture a `locked` tag (§1, §E4).
 *
 * The default is STRUCTURAL, not empirical: there is no Champions meta-spread
 * data and we will not invent it (§A2). It mildly prefers investment concentrated
 * in a few stats over a smear across all five; full-budget is already hard-
 * enforced by the budget constraint. An empirical prior (a learned spread catalog)
 * is a drop-in replacement implementing the same interface — never hardcoded.
 *
 * WEAKNESS is the contract (§E5): `STRENGTH` is a single small tunable, set so a
 * handful of clean hits dominate the prior. Tests U4.4.2–3 enforce this.
 */

import type { NonHpStat } from './constraint-system';

export interface SpreadPrior {
  readonly name: string;
  /** unnormalized prior weight for a full non-HP spread (higher = more likely a priori) */
  weight(spread: Record<NonHpStat, number>, spHp: number): number;
}

const NON_HP: readonly NonHpStat[] = ['atk', 'def', 'spa', 'spd', 'spe'];

/** Tunable prior strength. Small by design so likelihood dominates with little data. */
export const STRUCTURAL_PRIOR_STRENGTH = 0.05;

/**
 * Weak structural prior: rewards concentration via the (normalized) sum of
 * squares of the SP allocation. Maximum tilt ≈ (1 + STRENGTH), tiny next to the
 * up-to-15× likelihood ratios a single clean hit produces.
 */
export const structuralPrior: SpreadPrior = {
  name: 'structural-concentration',
  weight(spread) {
    let sumSq = 0;
    for (const s of NON_HP) sumSq += spread[s] * spread[s];
    // 32^2 = 1024 sets a per-stat scale; concentration in roughly [0, 5].
    return 1 + STRUCTURAL_PRIOR_STRENGTH * (sumSq / 1024);
  },
};

/** A flat prior — useful for tests and for isolating the likelihood's effect. */
export const uniformPrior: SpreadPrior = {
  name: 'uniform',
  weight: () => 1,
};
