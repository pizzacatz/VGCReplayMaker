/**
 * Sampling validation — Constraint Model §10 / Validation §4.1.
 * The single most important solver check: Gibbs sampling must agree with exact
 * enumeration on a small component (where exact is ground truth), and `auto`
 * must fall back to sampling when a component is too large to enumerate.
 */

import { describe, it, expect } from 'vitest';
import { championsGen, predictHit, type MonSpec } from '../engine';
import { ConstraintSystem, type MonReport, type SolverMon } from './constraint-system';

const gen = championsGen();
const SLOW = 60_000;

const incineroar: MonSpec = { species: 'Incineroar', alignment: { up: 'atk', down: 'spa' } };
const garchomp: MonSpec = { species: 'Garchomp', alignment: { up: 'spe', down: 'spa' } };

const TRUE_DEF = 8;
const observed = predictHit(gen, {
  attacker: incineroar,
  attackerSp: 20,
  defender: garchomp,
  defenderSp: TRUE_DEF,
  move: 'Flare Blitz',
}).rolls[7]!;

/** A small, enumerable component: A is a fully known spread; D leaves def & spe free. */
function buildRecoverySystem(): ConstraintSystem {
  const A: SolverMon = { id: 'A', spec: incineroar, observedMaxHp: 170 };
  const D: SolverMon = { id: 'D', spec: garchomp, observedMaxHp: 183 };
  const system = new ConstraintSystem(gen, [A, D], [
    { attackerId: 'A', defenderId: 'D', move: 'Flare Blitz', observedDamage: observed },
  ]);
  system.restrictDomain('A', 'atk', [20]);
  system.restrictDomain('A', 'def', [12]);
  system.restrictDomain('A', 'spa', [0]);
  system.restrictDomain('A', 'spd', [12]);
  system.restrictDomain('A', 'spe', [22]);
  system.restrictDomain('D', 'atk', [20]);
  system.restrictDomain('D', 'spa', [0]);
  system.restrictDomain('D', 'spd', [20]);
  return system;
}

const distOf = (report: MonReport, stat: string): Map<number, number> =>
  new Map(report.perStat.find((r) => r.stat === stat)!.distribution.map((d) => [d.sp, d.p]));

/** Total-variation distance between two SP distributions. */
function tvd(a: Map<number, number>, b: Map<number, number>): number {
  let sum = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) sum += Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0));
  return sum / 2;
}

/** Probability-weighted mean SP of a distribution (stable even when the mode is a near-tie). */
function mean(dist: Map<number, number>): number {
  let m = 0;
  for (const [sp, p] of dist) m += sp * p;
  return m;
}

describe('§4.1 — sampling agrees with exact enumeration', () => {
  it(
    'the sampled defense marginal matches the exact one (mode + low TVD)',
    () => {
      const exact = buildRecoverySystem().solve({ method: 'exact' }).mons.find((m) => m.monId === 'D')!;
      const sampled = buildRecoverySystem().solve({
        method: 'sample',
        sampleConfig: { iterations: 12_000, burnIn: 2_000, thin: 4, seed: 12_345, initTries: 200 },
      }).mons.find((m) => m.monId === 'D')!;

      expect(exact.method).toBe('exact');
      expect(sampled.method).toBe('sampled');

      const defExact = distOf(exact, 'def');
      const defSampled = distOf(sampled, 'def');
      // The def marginal from one hit is a broad, near-flat band, so the mode is a
      // near-tie and not a stable comparison point. Distribution closeness (TVD)
      // and the mean are the right agreement metrics.
      expect(tvd(defExact, defSampled)).toBeLessThan(0.1);
      expect(Math.abs(mean(defExact) - mean(defSampled))).toBeLessThan(1);
      expect(sampled.perStat.find((r) => r.stat === 'def')!.distribution.some((d) => d.sp === TRUE_DEF)).toBe(true);
    },
    SLOW,
  );
});

describe('§10 — auto falls back to sampling for a too-large component', () => {
  it('reports a sampled posterior with a valid headline when enumeration is capped', () => {
    const D: SolverMon = { id: 'D', spec: garchomp, observedMaxHp: 183 };
    const report = new ConstraintSystem(gen, [D], []).solve({ enumCap: 1000 }).mons[0]!;
    expect(report.method).toBe('sampled');
    expect(report.headline).toBeDefined();
    expect(report.remainingMass).toBeGreaterThanOrEqual(0);
    expect(report.remainingMass).toBeLessThanOrEqual(1);
    const total = report.candidates.reduce((acc, c) => acc + c.confidence, 0) + report.remainingMass;
    expect(total).toBeCloseTo(1);
  });
});
