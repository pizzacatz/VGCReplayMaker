/** Champions ruleset tests — roll-table adaptation (Spike 1) + exception registry. */

import { describe, it, expect } from 'vitest';
import {
  CHAMPIONS_ROLL_PERCENTS,
  ExceptionRegistry,
  toChampionsRolls,
  type DamageException,
} from './champions';

describe('Champions roll table (Constitution §C2; Spike 1)', () => {
  it('has 15 uniform rolls, 86–100% inclusive', () => {
    expect(CHAMPIONS_ROLL_PERCENTS).toHaveLength(15);
    expect(CHAMPIONS_ROLL_PERCENTS[0]).toBe(86);
    expect(CHAMPIONS_ROLL_PERCENTS[14]).toBe(100);
  });

  it('drops index 0 (the 85% roll) from a 16-roll calc array', () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => 100 + i); // 100..115
    const champ = toChampionsRolls(sixteen);
    expect(champ).toHaveLength(15);
    expect(champ[0]).toBe(101); // 85% roll (100) dropped
    expect(champ[14]).toBe(115);
  });

  it('passes a 15-roll array through unchanged', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => i);
    expect(toChampionsRolls(fifteen)).toEqual(fifteen);
  });

  it('widens a scalar (variance-free / fixed damage) to 15 identical rolls', () => {
    expect(toChampionsRolls(40)).toEqual(Array(15).fill(40));
  });

  it('rejects an unexpected array length', () => {
    expect(() => toChampionsRolls([1, 2, 3])).toThrow();
  });
});

describe('ExceptionRegistry — the slot-in point', () => {
  const ctx = {
    move: 'Flare Blitz',
    attackerSpecies: 'Incineroar',
    defenderSpecies: 'Garchomp',
    category: 'Physical' as const,
  };

  it('defaults to empty (standard Gen 9) and is a no-op', () => {
    const reg = new ExceptionRegistry();
    expect(reg.size).toBe(0);
    const rolls = [10, 11, 12];
    expect(reg.apply(rolls, ctx)).toEqual(rolls);
  });

  it('applies a registered exception only when it matches', () => {
    const reg = new ExceptionRegistry();
    const halveVsGarchomp: DamageException = {
      id: 'test-halve-vs-garchomp',
      description: 'example: halve damage dealt to Garchomp',
      matches: (c) => c.defenderSpecies === 'Garchomp',
      apply: (rolls) => rolls.map((r) => Math.floor(r / 2)),
    };
    reg.register(halveVsGarchomp);
    expect(reg.size).toBe(1);
    expect(reg.apply([10, 20, 30], ctx)).toEqual([5, 10, 15]);
    expect(reg.apply([10, 20, 30], { ...ctx, defenderSpecies: 'Dragonite' })).toEqual([10, 20, 30]);
  });

  it('rejects duplicate exception ids', () => {
    const reg = new ExceptionRegistry();
    const e: DamageException = { id: 'dup', description: '', matches: () => false, apply: (r) => r };
    reg.register(e);
    expect(() => reg.register(e)).toThrow();
  });
});
