/**
 * Output Contract surface — Solver Output Contract T1.2 §7 (evidence), §8
 * (missing-evidence notes), §14 (coarse-rounded confidence), §11 (formatted block).
 */

import { describe, it, expect } from 'vitest';
import { championsGen, predictHit, type MonSpec } from '../engine';
import { ConstraintSystem, formatMonReport, type SolverMon } from './constraint-system';

const gen = championsGen();
const SLOW = 30_000;

const incineroar: MonSpec = { species: 'Incineroar', alignment: { up: 'atk', down: 'spa' } };
const garchomp: MonSpec = { species: 'Garchomp', alignment: { up: 'spe', down: 'spa' } };

const observed = predictHit(gen, {
  attacker: incineroar,
  attackerSp: 20,
  defender: garchomp,
  defenderSp: 8,
  move: 'Flare Blitz',
}).rolls[7]!;

function recoverySystem(): ConstraintSystem {
  const A: SolverMon = { id: 'A', spec: incineroar, observedMaxHp: 170 };
  const D: SolverMon = { id: 'D', spec: garchomp, observedMaxHp: 183 };
  const system = new ConstraintSystem(gen, [A, D], [
    { attackerId: 'A', defenderId: 'D', move: 'Flare Blitz', observedDamage: observed },
  ]);
  for (const [s, v] of [['atk', 20], ['def', 12], ['spa', 0], ['spd', 12], ['spe', 22]] as const) {
    system.restrictDomain('A', s, [v]);
  }
  system.restrictDomain('D', 'atk', [20]);
  system.restrictDomain('D', 'spa', [0]);
  system.restrictDomain('D', 'spd', [20]);
  return system;
}

describe('§7 — evidence summary', () => {
  it(
    'counts clean hits in/out from each mon’s perspective',
    () => {
      const result = recoverySystem().solve();
      const A = result.mons.find((m) => m.monId === 'A')!;
      const D = result.mons.find((m) => m.monId === 'D')!;
      expect(D.evidence).toMatchObject({ cleanHitsIn: 1, cleanHitsOut: 0, speedFacts: 0 });
      expect(A.evidence).toMatchObject({ cleanHitsIn: 0, cleanHitsOut: 1, speedFacts: 0 });
      // the drill-down lists exactly those hits, from each mon's perspective
      expect(D.evidence.hits.filter((h) => h.role === 'taken')).toHaveLength(1);
      expect(A.evidence.hits.filter((h) => h.role === 'dealt')).toHaveLength(1);
    },
    SLOW,
  );

  it('counts speed facts touching a mon', () => {
    const X: SolverMon = { id: 'X', spec: garchomp, observedMaxHp: 183 };
    const Y: SolverMon = { id: 'Y', spec: garchomp, observedMaxHp: 183 };
    const result = new ConstraintSystem(gen, [X, Y], [], [
      { firstId: 'X', secondId: 'Y', samePriorityBracket: true },
    ]).solve({ enumCap: 1000 });
    expect(result.mons.find((m) => m.monId === 'X')!.evidence.speedFacts).toBe(1);
    expect(result.mons.find((m) => m.monId === 'Y')!.evidence.speedFacts).toBe(1);
  });
});

describe('§8 — missing-evidence notes', () => {
  it(
    'emits a note for every loose stat, with a why and a resolve; none for HP/locked',
    () => {
      const D = recoverySystem().solve().mons.find((m) => m.monId === 'D')!;
      const speNote = D.missing.find((n) => n.stat === 'spe');
      const defNote = D.missing.find((n) => n.stat === 'def');
      expect(speNote?.tag).toBe('guessed');
      expect(speNote?.resolve).toMatch(/move-order|Speed/i);
      expect(defNote?.tag).toBe('bounded');
      expect(defNote?.resolve.length).toBeGreaterThan(0);
      // never a note for HP, and every note has both fields populated.
      expect(D.missing.some((n) => (n.stat as string) === 'hp')).toBe(false);
      for (const n of D.missing) {
        expect(n.reason.length).toBeGreaterThan(0);
        expect(n.resolve.length).toBeGreaterThan(0);
      }
    },
    SLOW,
  );
});

describe('§14 — confidence rounded to the nearest 5%', () => {
  it(
    'headline, candidates, and remaining mass are multiples of 5',
    () => {
      const D = recoverySystem().solve().mons.find((m) => m.monId === 'D')!;
      expect(D.headline!.confidencePct % 5).toBe(0);
      expect(D.remainingMassPct % 5).toBe(0);
      for (const c of D.candidates) expect(c.confidencePct % 5).toBe(0);
    },
    SLOW,
  );
});

describe('§11 — formatted report block', () => {
  it(
    'renders the human-readable scouting block',
    () => {
      const D = recoverySystem().solve().mons.find((m) => m.monId === 'D')!;
      const block = formatMonReport(D);
      expect(block).toContain('Garchomp');
      expect(block).toContain('HEADLINE');
      expect(block).toContain('PER-STAT');
      expect(block).toContain('EVIDENCE');
      expect(block).toContain('MISSING');
    },
    SLOW,
  );
});
