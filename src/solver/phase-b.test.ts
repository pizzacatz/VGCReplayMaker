/**
 * Phase B tests — Constraint Model §7–8, Validation §4.1 (recovery), §4.2
 * (honest tagging), §4.4 (prior). Posterior = prior × likelihood over the
 * Phase-A feasible space; tags come from Phase A, never the prior.
 */

import { describe, it, expect } from 'vitest';
import { championsGen, predictHit, type MonSpec } from '../engine';
import { ConstraintSystem, type SolverMon } from './constraint-system';
import { uniformPrior } from './prior';

const gen = championsGen();
const SLOW = 30_000;

const incineroar: MonSpec = { species: 'Incineroar', alignment: { up: 'atk', down: 'spa' } };
const garchomp: MonSpec = { species: 'Garchomp', alignment: { up: 'spe', down: 'spa' } };

describe('U4.4.1 — with zero clean hits, the posterior equals the prior, all guessed', () => {
  it('uniform prior → equal-confidence candidates; every non-HP stat guessed, HP read', () => {
    const D: SolverMon = { id: 'D', spec: garchomp, observedMaxHp: 183 }; // SP_hp 0
    const system = new ConstraintSystem(gen, [D], []);
    // leave def & spe free (sum 26); no hit touches anything.
    system.restrictDomain('D', 'atk', [20]);
    system.restrictDomain('D', 'spa', [10]);
    system.restrictDomain('D', 'spd', [10]);
    const report = system.solve({ prior: uniformPrior }).mons[0]!;

    const confidences = report.candidates.map((c) => c.confidence);
    expect(confidences.length).toBeGreaterThan(1);
    for (const c of confidences) expect(c).toBeCloseTo(confidences[0]!); // posterior == flat prior

    const tag = (s: string) => report.perStat.find((r) => r.stat === s)!.tag;
    expect(tag('hp')).toBe('read');
    for (const s of ['atk', 'def', 'spa', 'spd', 'spe']) expect(tag(s)).toBe('guessed');
  });
});

describe('U4.1.1 / U4.2.x — recovery and honest tagging from a clean hit', () => {
  it(
    'recovers the defender defense as a bounded stat; unobserved spe stays guessed',
    () => {
      const TRUE_DEF = 8;
      const A: SolverMon = { id: 'A', spec: incineroar, observedMaxHp: 170 }; // SP_hp 0
      const D: SolverMon = { id: 'D', spec: garchomp, observedMaxHp: 183 }; // SP_hp 0

      const observed = predictHit(gen, {
        attacker: incineroar,
        attackerSp: 20,
        defender: garchomp,
        defenderSp: TRUE_DEF,
        move: 'Flare Blitz',
      }).rolls[7]!;

      const system = new ConstraintSystem(gen, [A, D], [
        { attackerId: 'A', defenderId: 'D', move: 'Flare Blitz', observedDamage: observed },
      ]);
      // A is a fully known spread (open sheet); D leaves def & spe free.
      system.restrictDomain('A', 'atk', [20]);
      system.restrictDomain('A', 'def', [12]);
      system.restrictDomain('A', 'spa', [0]);
      system.restrictDomain('A', 'spd', [12]);
      system.restrictDomain('A', 'spe', [22]);
      system.restrictDomain('D', 'atk', [20]);
      system.restrictDomain('D', 'spa', [0]);
      system.restrictDomain('D', 'spd', [20]);

      const report = system.solve().mons.find((m) => m.monId === 'D')!;
      const def = report.perStat.find((r) => r.stat === 'def')!;
      const spe = report.perStat.find((r) => r.stat === 'spe')!;

      expect(def.tag).toBe('bounded'); // observed but not pinned
      expect(Math.abs(def.best - TRUE_DEF)).toBeLessThanOrEqual(5); // recovered near truth
      expect(def.distribution.some((d) => d.sp === TRUE_DEF)).toBe(true);
      expect(spe.tag).toBe('guessed'); // never observed
      expect(report.headline).toBeDefined();
    },
    SLOW,
  );
});

describe('U4.2.3 — locked only with a pinning constraint (speed tie)', () => {
  it('a speed tie pins Spe and tags it locked', () => {
    const X: SolverMon = { id: 'X', spec: garchomp, observedMaxHp: 183 };
    const Y: SolverMon = { id: 'Y', spec: garchomp, observedMaxHp: 183 };
    const system = new ConstraintSystem(gen, [X, Y], [], [
      { firstId: 'X', secondId: 'Y', samePriorityBracket: true, tie: true },
    ]);
    system.restrictDomain('X', 'atk', [20]);
    system.restrictDomain('X', 'def', [20]);
    system.restrictDomain('X', 'spa', [0]);
    // X: spd + spe = 26 free; tie vs Y(spe 10 → final 145) pins X spe to 10.
    system.restrictDomain('Y', 'atk', [32]);
    system.restrictDomain('Y', 'def', [0]);
    system.restrictDomain('Y', 'spa', [0]);
    system.restrictDomain('Y', 'spd', [24]);
    system.restrictDomain('Y', 'spe', [10]);

    const report = system.solve().mons.find((m) => m.monId === 'X')!;
    const spe = report.perStat.find((r) => r.stat === 'spe')!;
    expect(spe.tag).toBe('locked');
    expect(spe.best).toBe(10);
  });
});

describe('contradiction surfaces in the report (no force-fit)', () => {
  it(
    'an impossible hit yields a contradiction flag and no candidates',
    () => {
      const A: SolverMon = { id: 'A', spec: incineroar, observedMaxHp: 170 };
      const D: SolverMon = { id: 'D', spec: garchomp, observedMaxHp: 183 };
      const result = new ConstraintSystem(gen, [A, D], [
        { attackerId: 'A', defenderId: 'D', move: 'Flare Blitz', observedDamage: 999_999 },
      ]).solve();
      const report = result.mons.find((m) => m.monId === 'D')!;
      expect(report.contradiction).toBeDefined();
      expect(report.candidates).toHaveLength(0);
      expect(result.contradictions.length).toBeGreaterThan(0);
    },
    SLOW,
  );
});
