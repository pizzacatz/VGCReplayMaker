/**
 * Integration tests (T3.5) — Validation §6 (end-to-end) + §D3 (clean-only).
 * One transcribed log → extract clean hits → solve → recover the generating
 * spread; composite/unresolved never enter the solver; speed facts are derived
 * soundly from move order.
 */

import { describe, it, expect } from 'vitest';
import { championsGen, predictHit, type MonSpec } from '../engine';
import { ConstraintSystem } from '../solver';
import type { MatchEvent, MatchLog } from '../log';
import { extractCleanHits, extractSpeedFacts, logToGame } from './index';

const gen = championsGen();
const SLOW = 30_000;

const incSpec: MonSpec = { species: 'Incineroar', alignment: { up: 'atk', down: 'spa' } };
const garSpec: MonSpec = { species: 'Garchomp', alignment: { up: 'spe', down: 'spa' } };
const zapSpec: MonSpec = { species: 'Zapdos', alignment: { up: 'spa', down: 'atk' } };

const INC_SPREAD = { hp: 0, atk: 20, def: 12, spa: 0, spd: 12, spe: 22 } as const;
const TRUE_GAR_DEF = 8;

const rolls = predictHit(gen, { attacker: incSpec, attackerSp: INC_SPREAD.atk, defender: garSpec, defenderSp: TRUE_GAR_DEF, move: 'Flare Blitz' }).rolls;

/** A transcribed match: three clean Flare Blitz hits on Garchomp + one composite drop. */
function buildRoundTripLog(): MatchLog {
  const d = [rolls[3]!, rolls[7]!, rolls[11]!];
  let hp = 203; // Garchomp max HP (SP_hp 20)
  const dmg = (seq: number, turn: number, amount: number, status: 'clean' | 'composite', attacker: string): MatchEvent => {
    const before = hp;
    hp -= amount;
    return { eventId: `d${seq}`, seq, turn, type: 'damage', attacker, move: attacker === 'inc' ? 'Flare Blitz' : 'Make It Rain', defender: 'gar', hpBefore: before, hpAfter: hp, crit: false, status };
  };
  return {
    matchId: 'rt', format: 'Champions Reg M-A',
    sideA: { player: 'W', mons: [{ monId: 'inc', species: 'Incineroar', maxHp: 170 }, { monId: 'zap', species: 'Zapdos', maxHp: 160 }] },
    sideB: { player: 'O', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 203 }] },
    leads: [{ side: 'A', position: 0, monId: 'inc' }, { side: 'A', position: 1, monId: 'zap' }, { side: 'B', position: 0, monId: 'gar' }],
    events: [
      { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
      { eventId: 'm1', seq: 2, turn: 1, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
      dmg(3, 1, d[0]!, 'clean', 'inc'),
      { eventId: 'm2', seq: 4, turn: 1, type: 'move_used', user: 'zap', move: 'Make It Rain', targets: ['gar'] },
      dmg(5, 1, 30, 'composite', 'zap'), // a drop the solver must ignore
      { eventId: 't2', seq: 6, turn: 2, type: 'turn_start' },
      { eventId: 'm3', seq: 7, turn: 2, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
      dmg(8, 2, d[1]!, 'clean', 'inc'),
      { eventId: 't3', seq: 9, turn: 3, type: 'turn_start' },
      { eventId: 'm4', seq: 10, turn: 3, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
      dmg(11, 3, d[2]!, 'clean', 'inc'),
    ],
  };
}

describe('§D3 — only clean hits reach the solver', () => {
  it('extracts the three clean hits and excludes the composite drop', () => {
    const hits = extractCleanHits(buildRoundTripLog());
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.attackerId === 'inc' && h.defenderId === 'gar')).toBe(true);
    expect(hits.some((h) => h.move === 'Make It Rain')).toBe(false);
    expect(hits[0]!.observedDamage).toBe(rolls[3]); // hp_before − hp_after
  });
});

describe('§6 — end-to-end round trip: transcribe → extract → solve → recover', () => {
  it(
    'recovers the generating defense from the transcribed log',
    () => {
      const hits = extractCleanHits(buildRoundTripLog());
      const system = new ConstraintSystem(gen, [
        { id: 'inc', spec: incSpec, observedMaxHp: 170 },
        { id: 'gar', spec: garSpec, observedMaxHp: 203 },
      ], hits);
      // open sheets: Incineroar known; Garchomp leaves def & spe free.
      for (const [s, v] of Object.entries(INC_SPREAD)) if (s !== 'hp') system.restrictDomain('inc', s as 'atk', [v]);
      system.restrictDomain('gar', 'atk', [0]);
      system.restrictDomain('gar', 'spa', [0]);
      system.restrictDomain('gar', 'spd', [18]); // def + spe = 28

      const report = system.solve({ method: 'exact' }).mons.find((m) => m.monId === 'gar')!;
      const def = report.perStat.find((r) => r.stat === 'def')!;
      expect(report.contradiction).toBeUndefined();
      expect(def.tag).toBe('bounded');
      expect(Math.abs(def.best - TRUE_GAR_DEF)).toBeLessThanOrEqual(4);
      expect(def.distribution.some((x) => x.sp === TRUE_GAR_DEF)).toBe(true);
    },
    SLOW,
  );
});

describe('§4 — sound speed-fact extraction from move order', () => {
  const specs = new Map<string, MonSpec>([['inc', incSpec], ['gar', garSpec], ['zap', zapSpec]]);
  const baseLog = (events: MatchEvent[]): MatchLog => ({
    matchId: 's', format: 'Champions Reg M-A',
    sideA: { player: 'W', mons: [{ monId: 'inc', species: 'Incineroar', maxHp: 170 }] },
    sideB: { player: 'O', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 203 }] },
    leads: [{ side: 'A', position: 0, monId: 'inc' }, { side: 'B', position: 0, monId: 'gar' }],
    events,
  });

  it('emits a fact for a same-bracket order and skips a cross-bracket one (the guard)', () => {
    const log = baseLog([
      { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
      { eventId: 'a', seq: 2, turn: 1, type: 'move_used', user: 'inc', move: 'Fake Out', targets: ['gar'] }, // priority +3
      { eventId: 'b', seq: 3, turn: 1, type: 'move_used', user: 'gar', move: 'Earthquake', targets: ['inc'] }, // priority 0
      { eventId: 't2', seq: 4, turn: 2, type: 'turn_start' },
      { eventId: 'c', seq: 5, turn: 2, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] }, // 0
      { eventId: 'd', seq: 6, turn: 2, type: 'move_used', user: 'gar', move: 'Earthquake', targets: ['inc'] }, // 0
    ]);
    const { facts } = extractSpeedFacts(log, gen, specs);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ first: 'inc', second: 'gar', samePriorityBracket: true });
  });

  it('skips (does not fabricate) an order when Tailwind is active', () => {
    const log = baseLog([
      { eventId: 'tw', seq: 1, turn: 1, type: 'field_change', field: 'Tailwind', action: 'set', side: 'A' },
      { eventId: 't1', seq: 2, turn: 1, type: 'turn_start' },
      { eventId: 'c', seq: 3, turn: 1, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
      { eventId: 'd', seq: 4, turn: 1, type: 'move_used', user: 'gar', move: 'Earthquake', targets: ['inc'] },
    ]);
    const { facts, skipped } = extractSpeedFacts(log, gen, specs);
    expect(facts).toHaveLength(0);
    expect(skipped.some((s) => /Tailwind/i.test(s.reason))).toBe(true);
  });
});

describe('bridge — log → aggregation Game', () => {
  it('resolves mon ids to the right instances', () => {
    const specs = new Map<string, MonSpec>([['inc', incSpec], ['zap', zapSpec], ['gar', garSpec]]);
    const game = logToGame(
      buildRoundTripLog(),
      { gameId: 'G1', tournamentId: 'T1', sideA: { playerId: 'W', instanceId: 'X' }, sideB: { playerId: 'O', instanceId: 'Y' } },
      gen,
      specs,
    );
    expect(game.cleanHits).toHaveLength(3);
    expect(game.cleanHits[0]!.attacker).toEqual({ instanceId: 'X', monId: 'inc' });
    expect(game.cleanHits[0]!.defender).toEqual({ instanceId: 'Y', monId: 'gar' });
  });
});
