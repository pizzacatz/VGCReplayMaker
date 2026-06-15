/**
 * Stat-Point budget invariants (Constitution §B1, §E3; Validation §1.5).
 *
 * Exactly 66 SP across the six stats, each 0..32. Lives alongside the conversion
 * module because it is pure stat-system arithmetic (R5 — single source).
 */

import { SP_MAX, SP_MIN } from './conversion';

export const SP_BUDGET = 66;

export type StatKey = 'hp' | 'atk' | 'def' | 'spa' | 'spd' | 'spe';
export const STAT_KEYS: readonly StatKey[] = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;

export type SpSpread = Record<StatKey, number>;

/** Throw unless every stat is an integer 0..32 and the six sum to exactly 66. */
export function validateSpread(spread: SpSpread): void {
  for (const key of STAT_KEYS) {
    const v = spread[key];
    if (!Number.isInteger(v) || v < SP_MIN || v > SP_MAX) {
      throw new RangeError(`SP ${key}=${v} is outside ${SP_MIN}..${SP_MAX}`);
    }
  }
  const sum = STAT_KEYS.reduce((acc, key) => acc + spread[key], 0);
  if (sum !== SP_BUDGET) {
    throw new RangeError(`SP spread sums to ${sum}, must be exactly ${SP_BUDGET}`);
  }
}

/**
 * Given exactly five known stats, the budget forces the sixth (Constitution §E3, U1.5.2).
 * Throws if not exactly five are provided, or if the forced value is outside 0..32.
 */
export function solveSixth(known: Partial<SpSpread>): number {
  const provided = STAT_KEYS.filter((key) => known[key] !== undefined);
  if (provided.length !== 5) {
    throw new Error(`solveSixth needs exactly 5 known stats, got ${provided.length}`);
  }
  const sum = provided.reduce((acc, key) => acc + (known[key] as number), 0);
  const sixth = SP_BUDGET - sum;
  if (sixth < SP_MIN || sixth > SP_MAX) {
    throw new RangeError(`forced sixth stat = ${sixth} is outside ${SP_MIN}..${SP_MAX} — spread invalid`);
  }
  return sixth;
}
