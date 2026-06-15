/**
 * Conversion module tests — Validation List v2 §1 (T2.1 / T3.1).
 * Each test cites the unit-test ID it satisfies. Anchors were independently
 * confirmed against @smogon/calc in spike/probe-calc.ts (110 @ SP0, 142 @ SP32).
 */

import { describe, it, expect } from 'vitest';
import {
  applyAlignment,
  finalToSp,
  maxHpToSpHp,
  neutralStat,
  reachableFinals,
  spHpToMaxHp,
  spToEv,
  spToFinal,
  SP_MAX,
  SP_MIN,
  type AlignmentRole,
} from './conversion';

/** Exact integer-division reference using BigInt — cannot suffer float error. */
function bigIntAlign(neutral: number, num: bigint): number {
  return Number((BigInt(neutral) * num) / 100n);
}

describe('§1.1 forward conversion (SP → stat)', () => {
  it('U1.1.1 — base-90 neutral SpD @ SP0 → 110', () => {
    expect(spToFinal(90, 0, 'neutral')).toBe(110);
  });

  it('U1.1.2 — base-90 neutral SpD @ SP32 → 142', () => {
    expect(spToFinal(90, 32, 'neutral')).toBe(142);
  });

  it('U1.1.3 — neutral stat increases by exactly 1 per SP (33 strictly-increasing values, no gaps)', () => {
    const values = Array.from({ length: 33 }, (_, sp) => neutralStat(90, sp));
    expect(values).toHaveLength(33);
    expect(values[0]).toBe(110);
    expect(values[32]).toBe(142);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]! - values[i - 1]!).toBe(1);
    }
  });

  it('U1.1.4 — SP → EV-equivalent = 8 × SP (0 → 0, 32 → 256)', () => {
    expect(spToEv(0)).toBe(0);
    expect(spToEv(32)).toBe(256);
    for (let sp = SP_MIN; sp <= SP_MAX; sp++) expect(spToEv(sp)).toBe(8 * sp);
  });

  it('U1.1.5 — defined & monotonic for every SP 0..32; out-of-range rejected', () => {
    for (let sp = SP_MIN; sp <= SP_MAX; sp++) {
      expect(Number.isInteger(spToFinal(90, sp, 'neutral'))).toBe(true);
    }
    expect(() => spToFinal(90, -1, 'neutral')).toThrow();
    expect(() => spToFinal(90, 33, 'neutral')).toThrow();
    expect(() => spToFinal(90, 1.5, 'neutral')).toThrow();
  });

  it('U1.1.6 — closed form Base+20+SP holds for a second base (not Incineroar-specific)', () => {
    expect(spToFinal(100, 0, 'neutral')).toBe(120);
    expect(spToFinal(100, 32, 'neutral')).toBe(152);
    expect(spToFinal(55, 0, 'neutral')).toBe(75);
    expect(spToFinal(55, 32, 'neutral')).toBe(107);
  });
});

describe('§1.2 alignment (§B4)', () => {
  it('U1.2.1 — up = floor(n×110/100), down = floor(n×90/100), neutral = ×1.0', () => {
    expect(applyAlignment(110, 'neutral')).toBe(110);
    expect(applyAlignment(110, 'up')).toBe(121);
    expect(applyAlignment(110, 'down')).toBe(99);
  });

  it('U1.2.2 — alignment applied AFTER the SP→stat step, never before', () => {
    // up on base 90, SP 0: neutral 110 → 121. Multiplying base-then-adding would differ.
    expect(spToFinal(90, 0, 'up')).toBe(121);
    const wrongOrder = Math.floor((90 * 110) / 100) + 20 + 0; // align base first (forbidden)
    expect(spToFinal(90, 0, 'up')).not.toBe(wrongOrder);
  });

  it('U1.2.3 — reduced (×0.9) produces a collision: two adjacent SP → same final', () => {
    // base 90 down: neutral 110 (SP0) and 111 (SP1) both floor to 99.
    expect(spToFinal(90, 0, 'down')).toBe(99);
    expect(spToFinal(90, 1, 'down')).toBe(99);
    const preimage = finalToSp(90, 99, 'down');
    expect(preimage).toEqual([0, 1]); // ≥2 ⇒ bounded, never locked
  });

  it('U1.2.4 — boosted (×1.1) produces a gap (unreachable final); reachable finals are unique', () => {
    const finals = reachableFinals(90, 'up');
    // ×1.1 never collides → all 33 SP yield distinct finals...
    expect(finals.length).toBe(33);
    const lo = finals[0]!;
    const hi = finals[finals.length - 1]!;
    // ...but they are NOT contiguous — the span exceeds the count ⇒ gaps exist.
    expect(hi - lo + 1).toBeGreaterThan(finals.length);
    // every reachable boosted final maps from exactly one SP
    for (const f of finals) {
      expect(finalToSp(90, f, 'up')).toHaveLength(1);
    }
    // a specific unreachable value returns empty (never snaps)
    const reachableSet = new Set(finals);
    const min = finals[0]!;
    const max = finals[finals.length - 1]!;
    let foundGap = false;
    for (let v = min; v <= max; v++) {
      if (!reachableSet.has(v)) {
        expect(finalToSp(90, v, 'up')).toEqual([]);
        foundGap = true;
        break;
      }
    }
    expect(foundGap).toBe(true);
  });

  it('U1.2.5 — alignment uses integer math, matching an exact BigInt reference (R1; float forbidden)', () => {
    // The named anchor: neutral 110 boosted → 121, not 120.
    expect(applyAlignment(110, 'up')).toBe(121);
    // Exhaustive agreement with EXACT integer division (BigInt) across a wide
    // range — the real R1 guarantee: our result is the integer-arithmetic value,
    // never a float-rounded one. (For these ÷10 multipliers float happens not to
    // diverge in range; we still mandate integer math so no value ever can.)
    for (let n = 0; n <= 100_000; n++) {
      expect(applyAlignment(n, 'up')).toBe(bigIntAlign(n, 110n));
      expect(applyAlignment(n, 'down')).toBe(bigIntAlign(n, 90n));
    }
  });
});

describe('§1.3 HP (§B5)', () => {
  it('U1.3.1 — maxHP = Base+75+SP_hp and round-trips', () => {
    for (let sp = SP_MIN; sp <= SP_MAX; sp++) {
      const maxHp = spHpToMaxHp(90, sp);
      expect(maxHp).toBe(90 + 75 + sp);
      expect(maxHpToSpHp(90, maxHp)).toBe(sp);
    }
  });

  it('U1.3.2 — base-90 HP: SP_hp 0 → 165, SP_hp 32 → 197', () => {
    expect(spHpToMaxHp(90, 0)).toBe(165);
    expect(spHpToMaxHp(90, 32)).toBe(197);
  });

  it('U1.3.3 — alignment multiplier is NOT applied to HP (HP fns take no role)', () => {
    // HP differs from a non-HP stat of the same base because it uses +75 not +20 and no align.
    expect(spHpToMaxHp(90, 0)).toBe(165);
    expect(spToFinal(90, 0, 'up')).toBe(121); // wholly independent path
  });
});

describe('§1.4 inverse conversion', () => {
  it('U1.4.1 — neutral stat: observed value maps to exactly one SP', () => {
    expect(finalToSp(90, 110, 'neutral')).toEqual([0]);
    expect(finalToSp(90, 142, 'neutral')).toEqual([32]);
    for (let sp = SP_MIN; sp <= SP_MAX; sp++) {
      expect(finalToSp(90, spToFinal(90, sp, 'neutral'), 'neutral')).toEqual([sp]);
    }
  });

  it('U1.4.2 — reduced stat at a collision returns ≥2 SP (→ bounded, never locked)', () => {
    expect(finalToSp(90, 99, 'down').length).toBeGreaterThanOrEqual(2);
  });

  it('U1.4.3 — no valid SP preimage raises / returns empty, never snaps to nearest', () => {
    // HP path: out-of-range observation raises, not clamps.
    expect(() => maxHpToSpHp(90, 1000)).toThrow();
    expect(() => maxHpToSpHp(90, 90)).toThrow(); // below base+75 → negative SP_hp
    // non-HP gap value: empty set, not a nearest-SP snap.
    const finals = new Set(reachableFinals(90, 'up'));
    const min = Math.min(...finals);
    const max = Math.max(...finals);
    for (let v = min; v <= max; v++) {
      if (!finals.has(v)) {
        expect(finalToSp(90, v, 'up')).toEqual([]);
        return;
      }
    }
  });
});

describe('R4 — alignment role required (never assume neutral)', () => {
  it('refuses a non-HP conversion with a missing/invalid role', () => {
    // @ts-expect-error — role is required
    expect(() => spToFinal(90, 0, undefined)).toThrow();
    // @ts-expect-error — invalid role string
    expect(() => spToFinal(90, 0, 'boosted')).toThrow();
  });
});

describe('cross-check against the spike anchors', () => {
  it('matches @smogon/calc-confirmed values (110 @ SP0, 142 @ SP32, base-90 neutral)', () => {
    const roundTrip = (sp: number, role: AlignmentRole) => finalToSp(90, spToFinal(90, sp, role), role);
    expect(spToFinal(90, 0, 'neutral')).toBe(110);
    expect(spToFinal(90, 32, 'neutral')).toBe(142);
    expect(roundTrip(0, 'neutral')).toEqual([0]);
    expect(roundTrip(32, 'neutral')).toEqual([32]);
  });
});
