/**
 * Phase A tests — Constraint Model §5–6, Validation §4.3.
 * Synthetic ground truth via the real shared engine; assertions check the exact,
 * prior-free behaviors the tags hang off.
 */

import { describe, it, expect } from 'vitest';
import { championsGen, predictHit, type MonSpec } from '../engine';
import { maxHpToSpHp } from '../conversion';
import { ConstraintSystem, NON_HP_STATS, type SolverMon, type SpeedFact } from './constraint-system';

const gen = championsGen();
const SLOW = 30_000;

const incineroar: MonSpec = { species: 'Incineroar', alignment: { up: 'atk', down: 'spa' } };
const garchomp: MonSpec = { species: 'Garchomp', alignment: { up: 'spe', down: 'spa' } };
const dragonite: MonSpec = { species: 'Dragonite', alignment: { up: 'atk', down: 'spa' } };

// Garchomp base HP 108 → maxHp = 108 + 75 + SP_hp.
const GARCHOMP_MAXHP_SPHP0 = 108 + 75; // 183

describe('U4.3.4 — HP is read, never solved', () => {
  it('reads SP_hp from observed max HP and keeps HP out of the variable domains', () => {
    const mon: SolverMon = { id: 'D', spec: garchomp, observedMaxHp: GARCHOMP_MAXHP_SPHP0 + 20 };
    const result = new ConstraintSystem(gen, [mon], []).propagate();
    expect(result.spHp.get('D')).toBe(maxHpToSpHp(108, GARCHOMP_MAXHP_SPHP0 + 20)); // 20
    expect([...result.domains.get('D')!.keys()].sort()).toEqual([...NON_HP_STATS].sort());
  });

  it('raises on an impossible observed HP rather than clamping (R3)', () => {
    const bad: SolverMon = { id: 'D', spec: garchomp, observedMaxHp: 9999 };
    expect(() => new ConstraintSystem(gen, [bad], [])).toThrow();
  });
});

describe('U4.3.5 — budget closure', () => {
  it('pinning four non-HP stats forces the fifth via the 66 − SP_hp equality', () => {
    const mon: SolverMon = { id: 'D', spec: garchomp, observedMaxHp: GARCHOMP_MAXHP_SPHP0 }; // SP_hp 0 → target 66
    const system = new ConstraintSystem(gen, [mon], []);
    system.restrictDomain('D', 'atk', [20]);
    system.restrictDomain('D', 'def', [12]);
    system.restrictDomain('D', 'spa', [0]);
    system.restrictDomain('D', 'spd', [12]);
    const result = system.propagate();
    expect(result.domains.get('D')!.get('spe')).toEqual([22]); // 66 − (20+12+0+12)
    expect(result.contradictions).toHaveLength(0);
  });
});

describe('U4.3.2 / U4.3.3 — fused until separated', () => {
  const D: SolverMon = { id: 'D', spec: garchomp, observedMaxHp: GARCHOMP_MAXHP_SPHP0 + 20 }; // SP_hp 20
  const A: SolverMon = { id: 'A', spec: incineroar, observedMaxHp: 95 + 75 }; // SP_hp 0
  const B: SolverMon = { id: 'B', spec: dragonite, observedMaxHp: 91 + 75 }; // SP_hp 0

  const TRUE_DEF = 8;
  const hit1Dmg = predictHit(gen, {
    attacker: incineroar,
    attackerSp: 12,
    defender: garchomp,
    defenderSp: TRUE_DEF,
    move: 'Flare Blitz',
  }).rolls[7]!;
  const hit2Dmg = predictHit(gen, {
    attacker: dragonite,
    attackerSp: 20,
    defender: garchomp,
    defenderSp: TRUE_DEF,
    move: 'Earthquake',
  }).rolls[7]!;

  it(
    'one attacker vs one defender leaves the defense fused (wide marginal, true value kept)',
    () => {
      const result = new ConstraintSystem(gen, [A, D], [
        { attackerId: 'A', defenderId: 'D', move: 'Flare Blitz', observedDamage: hit1Dmg },
      ]).propagate();
      const defDomain = result.domains.get('D')!.get('def')!;
      expect(defDomain).toContain(TRUE_DEF); // recovery
      expect(defDomain.length).toBeGreaterThan(1); // fused, not falsely pinned
    },
    SLOW,
  );

  it(
    'a second matchup sharing the defender separates them (marginal tightens, truth kept)',
    () => {
      const oneHit = new ConstraintSystem(gen, [A, D], [
        { attackerId: 'A', defenderId: 'D', move: 'Flare Blitz', observedDamage: hit1Dmg },
      ]).propagate();
      const twoHits = new ConstraintSystem(gen, [A, B, D], [
        { attackerId: 'A', defenderId: 'D', move: 'Flare Blitz', observedDamage: hit1Dmg },
        { attackerId: 'B', defenderId: 'D', move: 'Earthquake', observedDamage: hit2Dmg },
      ]).propagate();

      const w1 = oneHit.domains.get('D')!.get('def')!;
      const w2 = twoHits.domains.get('D')!.get('def')!;
      expect(w2).toContain(TRUE_DEF); // truth survives
      expect(w2.length).toBeLessThanOrEqual(w1.length); // never looser
      expect(w2.length).toBeLessThan(w1.length); // diverse matchup tightens (global coupling)
    },
    SLOW,
  );
});

describe('§4 speed factor — order within a bracket, with the priority guard', () => {
  // Two Garchomps (base Spe 102, alignment up=spe → role 'up'). Y's Spe is known
  // (restricted to SP 10 → final 145); X acted first, so X is constrained vs 145.
  const X: SolverMon = { id: 'X', spec: garchomp, observedMaxHp: 183 }; // SP_hp 0
  const Y: SolverMon = { id: 'Y', spec: garchomp, observedMaxHp: 183 };

  const run = (fact: SpeedFact) => {
    const system = new ConstraintSystem(gen, [X, Y], [], [fact]);
    system.restrictDomain('Y', 'spe', [10]); // Y's Spe known
    return system.propagate().domains.get('X')!.get('spe')!;
  };

  it('a same-bracket order prunes the faster mon to ≥ the known speed', () => {
    const xSpe = run({ firstId: 'X', secondId: 'Y', samePriorityBracket: true });
    expect(xSpe).toContain(10); // SP 10 → final 145 = boundary
    expect(xSpe).not.toContain(9); // SP 9 → final 144 < 145, ruled out
    expect(Math.min(...xSpe)).toBe(10);
  });

  it('U4.3.6 guard — a cross-bracket order contributes NO speed constraint', () => {
    const xSpe = run({ firstId: 'X', secondId: 'Y', samePriorityBracket: false });
    expect(xSpe).toHaveLength(33); // untouched: priority order carries no speed info
    expect(xSpe).toContain(0);
  });

  it('Trick Room reverses the comparison (faster-acting mon is the slower one)', () => {
    const xSpe = run({ firstId: 'X', secondId: 'Y', samePriorityBracket: true, trickRoom: true });
    expect(xSpe).toContain(10);
    expect(xSpe).not.toContain(11); // SP 11 → final 146 > 145, too fast to move first under TR
  });

  it('a speed tie pins the Spe to equality', () => {
    const xSpe = run({ firstId: 'X', secondId: 'Y', samePriorityBracket: true, tie: true });
    expect(xSpe).toEqual([10]); // only SP 10 yields final 145 == 145
  });
});

describe('U4.3.8 — contradiction yields an empty set and a flag, never a force-fit', () => {
  it(
    'an impossible observed damage empties the coupled domains and raises a flag',
    () => {
      const D: SolverMon = { id: 'D', spec: garchomp, observedMaxHp: GARCHOMP_MAXHP_SPHP0 };
      const A: SolverMon = { id: 'A', spec: incineroar, observedMaxHp: 95 + 75 };
      const result = new ConstraintSystem(gen, [A, D], [
        { attackerId: 'A', defenderId: 'D', move: 'Flare Blitz', observedDamage: 999_999 },
      ]).propagate();
      expect(result.contradictions.length).toBeGreaterThan(0);
      expect(result.domains.get('D')!.get('def')).toEqual([]);
    },
    SLOW,
  );
});
