/** Damage engine tests — shared calc authority, R5 stat-equality guard. */

import { describe, it, expect } from 'vitest';
import { championsGen, natureFor, predictHit, roleOf, type MonSpec } from './damage-engine';

const gen = championsGen();

const incineroar: MonSpec = { species: 'Incineroar', alignment: { up: 'atk', down: 'spa' } }; // Adamant
const garchomp: MonSpec = { species: 'Garchomp', alignment: { up: 'spe', down: 'spa' } }; // Jolly

describe('alignment → nature / role', () => {
  it('maps alignments to the correct nature', () => {
    expect(natureFor({ up: 'atk', down: 'spa' })).toBe('Adamant');
    expect(natureFor({ up: 'spe', down: 'atk' })).toBe('Timid');
    expect(natureFor('neutral')).toBe('Hardy');
  });

  it('rejects HP alignment and equal up/down', () => {
    expect(() => natureFor({ up: 'hp', down: 'atk' })).toThrow();
    expect(() => natureFor({ up: 'atk', down: 'atk' })).toThrow();
  });

  it('derives per-stat role', () => {
    expect(roleOf({ up: 'atk', down: 'spa' }, 'atk')).toBe('up');
    expect(roleOf({ up: 'atk', down: 'spa' }, 'spa')).toBe('down');
    expect(roleOf({ up: 'atk', down: 'spa' }, 'def')).toBe('neutral');
    expect(roleOf('neutral', 'spe')).toBe('neutral');
  });
});

describe('predictHit — 15 Champions rolls via the shared calc', () => {
  it('returns 15 ascending integer rolls and identifies the stats', () => {
    const { rolls, category, offensiveStat, defensiveStat } = predictHit(gen, {
      attacker: incineroar,
      attackerSp: 20,
      defender: garchomp,
      defenderSp: 0,
      move: 'Flare Blitz',
    });
    expect(rolls).toHaveLength(15);
    expect(rolls.every((r) => Number.isInteger(r))).toBe(true);
    for (let i = 1; i < rolls.length; i++) expect(rolls[i]!).toBeGreaterThanOrEqual(rolls[i - 1]!);
    expect(category).toBe('Physical');
    expect(offensiveStat).toBe('atk');
    expect(defensiveStat).toBe('def');
  });

  it('a crit deals more than a non-crit (same stats)', () => {
    const base = { attacker: incineroar, attackerSp: 0, defender: garchomp, defenderSp: 0, move: 'Flare Blitz' };
    const normal = predictHit(gen, base).rolls;
    const crit = predictHit(gen, { ...base, crit: true }).rolls;
    expect(crit[14]!).toBeGreaterThan(normal[14]!);
  });

  it('routes a special move to spa/spd', () => {
    const special = predictHit(gen, {
      attacker: { species: 'Garchomp', alignment: { up: 'spa', down: 'atk' } }, // Modest
      attackerSp: 20,
      defender: { species: 'Incineroar', alignment: { up: 'spd', down: 'atk' } }, // Calm
      defenderSp: 0,
      move: 'Fire Blast',
    });
    expect(special.offensiveStat).toBe('spa');
    expect(special.defensiveStat).toBe('spd');
  });

  it('rejects a Status move', () => {
    expect(() =>
      predictHit(gen, { attacker: incineroar, attackerSp: 0, defender: garchomp, defenderSp: 0, move: 'Swords Dance' }),
    ).toThrow();
  });
});
