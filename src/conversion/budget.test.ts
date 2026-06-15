/** Budget invariant tests — Validation List v2 §1.5 (Constitution §B1, §E3). */

import { describe, it, expect } from 'vitest';
import { solveSixth, validateSpread, SP_BUDGET, type SpSpread } from './budget';

const spread = (hp: number, atk: number, def: number, spa: number, spd: number, spe: number): SpSpread => ({
  hp,
  atk,
  def,
  spa,
  spd,
  spe,
});

describe('§1.5 budget (§B1)', () => {
  it('U1.5.1 — six SP not summing to exactly 66 is rejected', () => {
    expect(() => validateSpread(spread(20, 0, 12, 0, 12, 22))).not.toThrow(); // sums to 66
    expect(() => validateSpread(spread(20, 0, 12, 0, 12, 21))).toThrow(); // 65
    expect(() => validateSpread(spread(20, 0, 12, 0, 12, 23))).toThrow(); // 67
    expect(SP_BUDGET).toBe(66);
  });

  it('U1.5.2 — five known SP force the sixth to 66 − sum; reject if outside 0..32', () => {
    expect(solveSixth({ hp: 20, atk: 0, def: 12, spa: 0, spd: 12 })).toBe(22); // → spe 22
    expect(solveSixth({ hp: 32, atk: 32, def: 2, spa: 0, spd: 0 })).toBe(0);
    // forced value out of range → reject
    expect(() => solveSixth({ hp: 0, atk: 0, def: 0, spa: 0, spd: 0 })).toThrow(); // would force 66
    expect(() => solveSixth({ hp: 32, atk: 32, def: 32, spa: 0, spd: 0 })).toThrow(); // would force -30
  });

  it('U1.5.2 — solveSixth requires exactly five known stats', () => {
    expect(() => solveSixth({ hp: 20, atk: 0, def: 12, spa: 0 })).toThrow(); // only 4
    expect(() => solveSixth({ hp: 20, atk: 0, def: 12, spa: 0, spd: 12, spe: 22 })).toThrow(); // 6
  });

  it('U1.5.3 — each stat SP must be in 0..32', () => {
    expect(() => validateSpread(spread(33, 0, 11, 0, 0, 22))).toThrow(); // hp 33 > 32 (and sum 66)
    expect(() => validateSpread(spread(-1, 1, 12, 10, 22, 22))).toThrow(); // negative
    expect(() => validateSpread(spread(10.5, 0, 11.5, 0, 22, 22))).toThrow(); // non-integer
  });
});
