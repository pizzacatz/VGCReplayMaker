/** Aggregation tests — Data Model T1.3, Validation List v2 §7.1. */

import { describe, it, expect } from 'vitest';
import { championsGen, predictHit, type MonSpec } from '../engine';
import type { SpSpread } from '../conversion';
import { ScoutingDB, type Game, type TeamInstance } from './scouting';

const gen = championsGen();
const SLOW = 30_000;

const incSpec: MonSpec = { species: 'Incineroar', alignment: { up: 'atk', down: 'spa' } };
const garSpec: MonSpec = { species: 'Garchomp', alignment: { up: 'spe', down: 'spa' } };

const INC_SPREAD: SpSpread = { hp: 0, atk: 20, def: 12, spa: 0, spd: 12, spe: 22 }; // non-HP sum 66
const GAR_SPREAD: SpSpread = { hp: 20, atk: 0, def: 8, spa: 0, spd: 18, spe: 20 }; // non-HP sum 46

const observed = predictHit(gen, {
  attacker: incSpec,
  attackerSp: INC_SPREAD.atk,
  defender: garSpec,
  defenderSp: GAR_SPREAD.def,
  move: 'Flare Blitz',
}).rolls[7]!;

const instanceX: TeamInstance = {
  instanceId: 'X',
  playerId: 'W',
  roster: [{ monId: 'inc', spec: incSpec, observedMaxHp: 170, knownSpread: INC_SPREAD }],
};
const instanceY: TeamInstance = {
  instanceId: 'Y',
  playerId: 'O',
  roster: [{ monId: 'gar', spec: garSpec, observedMaxHp: 203, knownSpread: GAR_SPREAD }],
};

const baseGame: Game = {
  gameId: 'G1',
  tournamentId: 'T1',
  sideA: { playerId: 'W', instanceId: 'X' },
  sideB: { playerId: 'O', instanceId: 'Y' },
  cleanHits: [{ attacker: { instanceId: 'X', monId: 'inc' }, defender: { instanceId: 'Y', monId: 'gar' }, move: 'Flare Blitz', observedDamage: observed }],
};

function baseDB(): ScoutingDB {
  const db = new ScoutingDB();
  db.addPlayer({ playerId: 'W', displayName: 'Wolfe' });
  db.addPlayer({ playerId: 'O', displayName: 'Opp' });
  db.addTournament({ tournamentId: 'T1', name: 'Regional 1', date: '2026-05-01', format: 'Champions Reg M-A' });
  db.addInstance(instanceX);
  db.addInstance(instanceY);
  db.addGame(baseGame);
  return db;
}

describe('U7.1.1 / U7.1.7 — a game feeds both sides; output sliced per instance', () => {
  it(
    'reports each instance separately, both informed by the shared game',
    () => {
      const reports = baseDB().solve();
      expect([...reports.keys()].sort()).toEqual(['X', 'Y']);
      const inc = reports.get('X')!.mons.find((m) => m.monId === 'inc')!;
      const gar = reports.get('Y')!.mons.find((m) => m.monId === 'gar')!;
      expect(reports.get('X')!.playerId).toBe('W');
      expect(inc.report.headline!.spread).toEqual({ atk: 20, def: 12, spa: 0, spd: 12, spe: 22 });
      expect(gar.report.headline!.spread).toEqual({ atk: 0, def: 8, spa: 0, spd: 18, spe: 20 });
      expect(reports.get('X')!.flags).toHaveLength(0);
      expect(inc.report.contradiction).toBeUndefined();
    },
    SLOW,
  );
});

describe('U7.1.5 — no aggregation across an instance boundary without a shared game', () => {
  it(
    'an instance with no shared game is solved independently',
    () => {
      const db = baseDB();
      db.addPlayer({ playerId: 'P', displayName: 'Other' });
      // A valid non-HP-sum-66 spread for Z, which never shares a game with X/Y.
      const zValid: SpSpread = { hp: 0, atk: 32, def: 0, spa: 0, spd: 2, spe: 32 };
      db.addInstance({ instanceId: 'Z', playerId: 'P', roster: [{ monId: 'z', spec: garSpec, observedMaxHp: 183, knownSpread: zValid }] });
      const reports = db.solve();
      const z = reports.get('Z')!.mons.find((m) => m.monId === 'z')!;
      // Z is its own component; X/Y's hit cannot touch it.
      expect(z.report.headline!.spread).toEqual({ atk: 32, def: 0, spa: 0, spd: 2, spe: 32 });
      expect(z.report.contradiction).toBeUndefined();
    },
    SLOW,
  );
});

describe('U7.1.6 — a partially-sheeted game is flagged and its hits skipped', () => {
  it(
    'a hit referencing an unsheeted instance is dropped and flagged',
    () => {
      const db = baseDB();
      db.addGame({
        gameId: 'G2',
        tournamentId: 'T1',
        sideA: { playerId: 'W', instanceId: 'X' },
        sideB: { playerId: 'Q', instanceId: 'GHOST' }, // not registered
        cleanHits: [{ attacker: { instanceId: 'X', monId: 'inc' }, defender: { instanceId: 'GHOST', monId: 'g' }, move: 'Flare Blitz', observedDamage: 50 }],
      });
      const reports = db.solve();
      expect(reports.get('X')!.flags.some((f) => /partial sheet/i.test(f))).toBe(true);
      // still solves the sheeted side without crashing
      expect(reports.get('X')!.mons.find((m) => m.monId === 'inc')!.report.headline).toBeDefined();
    },
    SLOW,
  );
});

describe('U7.1.4 — cross-tournament aggregation is surfaced, not silent', () => {
  it(
    'an instance whose games span tournaments is flagged',
    () => {
      const db = baseDB();
      db.addTournament({ tournamentId: 'T2', name: 'Regional 2', date: '2026-06-01', format: 'Champions Reg M-A' });
      db.addGame({
        gameId: 'G3',
        tournamentId: 'T2',
        sideA: { playerId: 'W', instanceId: 'X' },
        sideB: { playerId: 'O', instanceId: 'Y' },
        cleanHits: [],
      });
      const reports = db.solve();
      expect(reports.get('X')!.flags.some((f) => /cross-tournament/i.test(f))).toBe(true);
    },
    SLOW,
  );
});
