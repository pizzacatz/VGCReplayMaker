/**
 * End-to-end pipeline validation: a transcribed two-game match in the real store
 * (Tournament → Match → Games), solved via the SAME path the app uses
 * (deriveWorkspace → buildLog → extractCleanHits → ScoutingDB → solve). Confirms
 * a hidden opponent spread is recovered, tightens with more games, and is tagged
 * honestly — the whole stack, not a unit.
 */

import { describe, it, expect } from 'vitest';
import { championsGen, predictHit, type MonSpec } from '../engine';
import { activeTournament, addGame, applyWorkspace, deriveWorkspace, emptyStore, renameTournament, solveTournament, type ScoutingStore } from './store';
import type { MonEntry } from './model';

const gen = championsGen();
const TRUE_DEF = 8; // the hidden Garchomp Defense SP we should recover

const incSpec: MonSpec = { species: 'Incineroar', alignment: { up: 'atk', down: 'spa' } };
const garSpec: MonSpec = { species: 'Garchomp', alignment: 'neutral' };

// Flare Blitz from a KNOWN Incineroar (Atk SP 20) into Garchomp at a candidate Def SP.
// context:{} matches what extraction reconstructs (Doubles, no modifiers).
const rollsAtDef = (defSp: number): number[] =>
  predictHit(gen, { attacker: incSpec, attackerSp: 20, defender: garSpec, defenderSp: defSp, move: 'Flare Blitz', context: {} }).rolls;

const incEntry = (): MonEntry => ({
  monId: 'A0',
  parsed: { species: 'Incineroar', level: 50, moves: ['Flare Blitz'], alignment: { up: 'atk', down: 'spa' }, spreadKnown: true, flags: [], spSpread: { hp: 0, atk: 20, def: 12, spa: 0, spd: 12, spe: 22 } },
  observedMaxHp: 95 + 75,
});
const garEntry = (): MonEntry => ({
  monId: 'B0',
  parsed: { species: 'Garchomp', level: 50, moves: [], alignment: 'neutral', spreadKnown: false, flags: [] },
  observedMaxHp: 108 + 75, // SP_hp 0
});

/** Apply a one-hit transcription (Flare Blitz dealing `dmg`) to the active game. */
function transcribeHit(store: ScoutingStore, dmg: number): ScoutingStore {
  const ws = deriveWorkspace(store);
  return applyWorkspace(store, {
    ...ws,
    sideA: { ...ws.sideA, player: 'Me', mons: [incEntry()], leads: ['A0'] },
    sideB: { ...ws.sideB, player: 'Opp', mons: [garEntry()], leads: ['B0'] },
    events: [
      { eventId: 't', seq: 1, turn: 1, type: 'turn_start' },
      { eventId: 'm', seq: 2, turn: 1, type: 'move_used', user: 'A0', move: 'Flare Blitz', targets: ['B0'] },
      { eventId: 'd', seq: 3, turn: 1, type: 'damage', attacker: 'A0', defender: 'B0', move: 'Flare Blitz', hpBefore: 183, hpAfter: 183 - dmg, crit: false, status: 'clean' },
    ],
  });
}

function garchompReport(store: ScoutingStore) {
  const t = activeTournament(store)!;
  const reports = solveTournament(t);
  const oppTeamId = t.teams[1]!.teamId; // teams[1] = side B = Opp/Garchomp
  return reports.get(oppTeamId)!.mons.find((m) => m.monId === 'B0')!.report;
}

describe('end-to-end: transcribe → store → tournament solve recovers a hidden spread', () => {
  it(
    'recovers Garchomp’s Defense from two transcribed games and aggregates the evidence',
    () => {
      let store = renameTournament(emptyStore(), 'Regional A');
      store = transcribeHit(store, rollsAtDef(TRUE_DEF)[3]!); // game 1
      store = addGame(store); // game 2 inherits the teams
      store = transcribeHit(store, rollsAtDef(TRUE_DEF)[11]!); // a different roll, more evidence

      const report = garchompReport(store);
      const def = report.perStat.find((r) => r.stat === 'def')!;

      expect(report.contradiction).toBeUndefined();
      expect(report.evidence.cleanHitsIn).toBe(2); // BOTH games fed one inference (aggregation)
      expect(['bounded', 'locked', 'read']).toContain(def.tag); // never prior-only
      expect(Math.abs(def.best - TRUE_DEF)).toBeLessThanOrEqual(4); // recovered near the truth
    },
    30_000,
  );

  it('excluding one game (quarantine) drops it from the aggregated evidence', () => {
    let store = renameTournament(emptyStore(), 'Regional A');
    store = transcribeHit(store, rollsAtDef(TRUE_DEF)[3]!);
    store = addGame(store);
    store = transcribeHit(store, rollsAtDef(TRUE_DEF)[11]!);
    // exclude game 2 (the active one)
    const t = activeTournament(store)!;
    const g2 = t.matches[0]!.games[1]!;
    store = { ...store, tournaments: store.tournaments.map((x) => (x.tournamentId === t.tournamentId ? { ...x, matches: x.matches.map((m) => ({ ...m, games: m.games.map((g) => (g.gameId === g2.gameId ? { ...g, excludedFromSolve: true } : g)) })) } : x)) };

    expect(garchompReport(store).evidence.cleanHitsIn).toBe(1); // only game 1 remains
  });
});
