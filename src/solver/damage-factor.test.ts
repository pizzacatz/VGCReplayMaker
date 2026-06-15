/**
 * Damage-factor tests — Constraint Model §3 + Validation §2.3 (band semantics)
 * and §4.1.1 (recovery foundation). Synthetic ground truth: generate a hit from
 * known stats via the real shared engine, then confirm the factor recovers the
 * truth and behaves as a band, not a point.
 */

import { describe, it, expect } from 'vitest';
import { championsGen, predictHit, type MonSpec } from '../engine';
import { attackerMarginal, damageFactor, defenderMarginal, likelihood } from './damage-factor';

const gen = championsGen();

const incineroar: MonSpec = { species: 'Incineroar', alignment: { up: 'atk', down: 'spa' } };
const garchomp: MonSpec = { species: 'Garchomp', alignment: { up: 'spe', down: 'spa' } };

describe('likelihood', () => {
  it('is (#matching rolls)/15', () => {
    expect(likelihood(5, [5, 5, 6, 7, 5])).toBeCloseTo(3 / 5);
    expect(likelihood(99, [1, 2, 3])).toBe(0);
    expect(likelihood(1, [])).toBe(0);
  });
});

describe('damageFactor — synthetic recovery & band semantics', () => {
  // Ground truth: Incineroar (Atk 20 SP) hits Garchomp (Def 0 SP) with Flare Blitz.
  const TRUE_ATK_SP = 20;
  const TRUE_DEF_SP = 0;
  const truth = predictHit(gen, {
    attacker: incineroar,
    attackerSp: TRUE_ATK_SP,
    defender: garchomp,
    defenderSp: TRUE_DEF_SP,
    move: 'Flare Blitz',
  }).rolls;
  const observedDamage = truth[7]!; // a mid roll — the only thing transcription sees

  const factor = damageFactor(gen, {
    attacker: incineroar,
    defender: garchomp,
    move: 'Flare Blitz',
    observedDamage,
  });

  it('U2.3.1 — recovers the true stat pair as feasible', () => {
    expect(factor.scanned).toBe(33 * 33);
    expect(factor.feasible.some((p) => p.attackerSp === TRUE_ATK_SP && p.defenderSp === TRUE_DEF_SP)).toBe(true);
  });

  it('U2.3.1 — one hit is a band, not a point (multiple feasible pairs)', () => {
    expect(factor.feasible.length).toBeGreaterThan(1);
    // the true stats survive in the marginals
    expect(attackerMarginal(factor)).toContain(TRUE_ATK_SP);
    expect(defenderMarginal(factor)).toContain(TRUE_DEF_SP);
  });

  it('constrains the right two stats (physical → atk/def)', () => {
    expect(factor.offensiveStat).toBe('atk');
    expect(factor.defensiveStat).toBe('def');
  });

  it('every feasible pair carries a positive weight = k/15', () => {
    for (const p of factor.feasible) {
      expect(p.weight).toBeGreaterThan(0);
      expect(p.weight).toBeLessThanOrEqual(1);
      expect(Math.round(p.weight * 15)).toBeCloseTo(p.weight * 15); // multiple of 1/15
    }
  });

  it('an impossible observed damage yields an empty feasible set (Phase A rules it out)', () => {
    const impossible = damageFactor(gen, {
      attacker: incineroar,
      defender: garchomp,
      move: 'Flare Blitz',
      observedDamage: observedDamage + 100_000,
    });
    expect(impossible.feasible).toHaveLength(0);
  });
});
