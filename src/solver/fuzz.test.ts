/**
 * Property / fuzz test for the solver's core soundness guarantee (Constraint §5):
 * Phase A only removes GENUINELY impossible Stat Points, so the spread that
 * generated the hits must NEVER be pruned. We sweep many true Defense values and
 * several roll samples per value, each through the real shared engine, and assert
 * the truth survives and the system is never falsely contradicted.
 */

import { describe, it, expect } from 'vitest';
import { championsGen, predictHit, type MonSpec } from '../engine';
import { ConstraintSystem, type SolverHit } from './constraint-system';

const gen = championsGen();
const incSpec: MonSpec = { species: 'Incineroar', alignment: { up: 'atk', down: 'spa' } };
const garSpec: MonSpec = { species: 'Garchomp', alignment: 'neutral' };
const ATTACKER_ATK = 20;

// Deterministic "random" roll-index picks per (trueDef, sample) — reproducible, no Math.random.
const ROLL_SAMPLES: number[][] = [[7], [0, 14], [3, 8, 12]];

describe('solver soundness (fuzz): Phase A never prunes the generating spread', () => {
  it(
    'keeps the true Defense feasible across all spreads and hit samples',
    () => {
      for (let trueDef = 0; trueDef <= 32; trueDef += 4) {
        const rolls = predictHit(gen, { attacker: incSpec, attackerSp: ATTACKER_ATK, defender: garSpec, defenderSp: trueDef, move: 'Flare Blitz', context: {} }).rolls;
        for (const sample of ROLL_SAMPLES) {
          const hits: SolverHit[] = sample.map((i) => ({ attackerId: 'inc', defenderId: 'gar', move: 'Flare Blitz', observedDamage: rolls[i]!, context: {} }));
          const sys = new ConstraintSystem(gen, [
            { id: 'inc', spec: incSpec, observedMaxHp: 95 + 75 },
            { id: 'gar', spec: garSpec, observedMaxHp: 108 + 75 },
          ], hits);
          sys.restrictDomain('inc', 'atk', [ATTACKER_ATK]); // open sheet: attacker known
          const result = sys.propagate();
          const dom = result.domains.get('gar')!.get('def')!;
          expect(result.contradictions).toHaveLength(0); // never a false contradiction
          expect(dom).toContain(trueDef); // SOUNDNESS: the generating value is never pruned
          expect(dom.length).toBeGreaterThan(0);
        }
      }
    },
    60_000,
  );

  it('more diverse hits never widen the feasible set (monotone tightening)', () => {
    const trueDef = 10;
    const rolls = predictHit(gen, { attacker: incSpec, attackerSp: ATTACKER_ATK, defender: garSpec, defenderSp: trueDef, move: 'Flare Blitz', context: {} }).rolls;
    const solveWith = (idxs: number[]): number[] => {
      const hits: SolverHit[] = idxs.map((i) => ({ attackerId: 'inc', defenderId: 'gar', move: 'Flare Blitz', observedDamage: rolls[i]!, context: {} }));
      const sys = new ConstraintSystem(gen, [
        { id: 'inc', spec: incSpec, observedMaxHp: 95 + 75 },
        { id: 'gar', spec: garSpec, observedMaxHp: 108 + 75 },
      ], hits);
      sys.restrictDomain('inc', 'atk', [ATTACKER_ATK]);
      return sys.propagate().domains.get('gar')!.get('def')!;
    };
    const few = solveWith([7]);
    const many = solveWith([0, 7, 14]);
    expect(many.length).toBeLessThanOrEqual(few.length); // adding extremes can only narrow
    expect(many).toContain(trueDef);
  });
});
