import { describe, it, expect } from 'vitest';
import {
  addGame,
  addMatch,
  applyWorkspace,
  deriveWorkspace,
  emptyStore,
  matchStanding,
  setMatchField,
  standingLabel,
  storeFromLegacyWorkspace,
  winsNeeded,
  type Match,
} from './store';
import type { MonEntry, Workspace } from './model';

const game = (winner?: 'A' | 'B', reason: 'ko' | 'forfeit' = 'ko', n = 1) => ({
  gameId: `g${n}`,
  gameNumber: n,
  leadsA: [],
  leadsB: [],
  events: [],
  ...(winner ? { result: { winner, reason } } : {}),
});

const match = (games: Match['games'], bestOf = 3, forfeitWinner?: 'A' | 'B'): Match => ({
  matchId: 'm',
  round: 'R1',
  bestOf,
  teamAId: 'A',
  teamBId: 'B',
  games,
  ...(forfeitWinner ? { forfeitWinner } : {}),
});

describe('winsNeeded', () => {
  it('Bo1→1, Bo3→2, Bo5→3', () => {
    expect(winsNeeded(1)).toBe(1);
    expect(winsNeeded(3)).toBe(2);
    expect(winsNeeded(5)).toBe(3);
  });
});

describe('matchStanding (derived match winner)', () => {
  it('in progress until a side reaches the needed wins', () => {
    const s = matchStanding(match([game('A', 'ko', 1)]));
    expect(s.scoreA).toBe(1);
    expect(s.decided).toBe(false);
    expect(s.winnerSide).toBeUndefined();
  });

  it('decides a Bo3 at 2 game wins and carries the deciding reason', () => {
    const s = matchStanding(match([game('A', 'ko', 1), game('B', 'ko', 2), game('A', 'forfeit', 3)]));
    expect(s.scoreA).toBe(2);
    expect(s.scoreB).toBe(1);
    expect(s.decided).toBe(true);
    expect(s.winnerSide).toBe('A');
    expect(s.reason).toBe('forfeit'); // reason of A's last (clinching) win
  });

  it('a clean 2–0 sweep decides', () => {
    const s = matchStanding(match([game('B', 'ko', 1), game('B', 'ko', 2)]));
    expect(s.winnerSide).toBe('B');
    expect(s.decided).toBe(true);
  });

  it('Bo1 decides on one game', () => {
    expect(matchStanding(match([game('A', 'ko', 1)], 1)).winnerSide).toBe('A');
  });

  it('whole-set forfeit overrides an undecided set', () => {
    const s = matchStanding(match([], 3, 'B'));
    expect(s.winnerSide).toBe('B');
    expect(s.decided).toBe(true);
    expect(s.reason).toBe('forfeit');
  });

  it('a forfeit override does NOT override a set already won on games', () => {
    const s = matchStanding(match([game('A', 'ko', 1), game('A', 'ko', 2)], 3, 'B'));
    expect(s.winnerSide).toBe('A'); // games already decided it; the override is ignored
  });
});

describe('store ⇄ workspace round-trip', () => {
  const mon = (id: string): MonEntry => ({
    monId: id,
    parsed: { species: 'Garchomp', level: 50, moves: [], alignment: 'neutral', spreadKnown: false, flags: [] },
    observedMaxHp: 183,
  });

  it('deriveWorkspace exposes the active game with inherited teams', () => {
    const store = emptyStore();
    const ws = deriveWorkspace(store);
    expect(ws.sideA.player).toBe('Player 1');
    expect(ws.sideB.player).toBe('Player 2');
    expect(ws.round).toBe('Round 1');
  });

  it('applyWorkspace writes team edits (shared) and per-game edits back', () => {
    let store = emptyStore();
    const ws: Workspace = deriveWorkspace(store);
    const edited: Workspace = {
      ...ws,
      sideA: { ...ws.sideA, player: 'Alice', mons: [mon('A0')], leads: ['A0'] },
      events: [{ eventId: 'e1', seq: 1, turn: 1, type: 'move_used', user: 'A0', move: 'Earthquake', targets: ['B0'] }],
      result: { winner: 'A', reason: 'ko' },
    };
    store = applyWorkspace(store, edited);
    const ws2 = deriveWorkspace(store);
    expect(ws2.sideA.player).toBe('Alice');
    expect(ws2.sideA.mons).toHaveLength(1);
    expect(ws2.events).toHaveLength(1);
    expect(ws2.result).toEqual({ winner: 'A', reason: 'ko' });
  });

  it('a new game inherits teams but starts with a fresh log + no result', () => {
    let store = emptyStore();
    store = applyWorkspace(store, {
      ...deriveWorkspace(store),
      sideA: { ...deriveWorkspace(store).sideA, player: 'Alice', mons: [mon('A0')] },
      result: { winner: 'A', reason: 'ko' },
    });
    store = addGame(store); // Game 2, now active
    const ws2 = deriveWorkspace(store);
    expect(ws2.sideA.player).toBe('Alice'); // team inherited
    expect(ws2.sideA.mons).toHaveLength(1);
    expect(ws2.events).toHaveLength(0); // fresh log
    expect(ws2.result).toBeUndefined(); // not played yet
  });

  it('game results across games drive the match standing label', () => {
    let store = emptyStore();
    // Game 1 → A wins
    store = applyWorkspace(store, { ...deriveWorkspace(store), result: { winner: 'A', reason: 'ko' } });
    const g1 = store; // capture id
    store = addGame(g1); // Game 2
    store = applyWorkspace(store, { ...deriveWorkspace(store), result: { winner: 'A', reason: 'ko' } });
    const t = store.tournaments[0]!;
    const m = t.matches[0]!;
    expect(matchStanding(m).decided).toBe(true);
    expect(standingLabel(store, m)).toContain('2–0');
  });

  it('clearing a game result removes it (undecides the match)', () => {
    let store = emptyStore();
    store = applyWorkspace(store, { ...deriveWorkspace(store), result: { winner: 'A', reason: 'ko' } });
    const withResult = deriveWorkspace(store);
    expect(withResult.result).toBeDefined();
    const cleared: Workspace = { ...withResult };
    delete cleared.result;
    store = applyWorkspace(store, cleared);
    expect(deriveWorkspace(store).result).toBeUndefined();
  });
});

describe('addMatch reuses or creates teams', () => {
  it('reusing a player by teamId shares the same roster (team-lock)', () => {
    let store = emptyStore();
    const aId = store.tournaments[0]!.teams[0]!.teamId;
    store = addMatch(store, 'Round 2', { teamId: aId }, { newPlayer: 'Carol' });
    const t = store.tournaments[0]!;
    expect(t.matches).toHaveLength(2);
    expect(t.teams.some((x) => x.player === 'Carol')).toBe(true);
    expect(t.matches[1]!.teamAId).toBe(aId); // same team object reused
  });
});

describe('setMatchField', () => {
  it('sets and clears the forfeit override', () => {
    let store = emptyStore();
    store = setMatchField(store, { forfeitWinner: 'B' });
    expect(store.tournaments[0]!.matches[0]!.forfeitWinner).toBe('B');
    store = setMatchField(store, { forfeitWinner: undefined });
    expect(store.tournaments[0]!.matches[0]!.forfeitWinner).toBeUndefined();
  });
});

describe('legacy migration', () => {
  it('wraps a single workspace as one tournament → match → game, preserving ids/events', () => {
    const legacy = {
      round: 'Top 8',
      sideA: { player: 'Alice', rawPaste: '', mons: [], leads: ['A0'] },
      sideB: { player: 'Bob', rawPaste: '', mons: [], leads: ['B0'] },
      events: [{ eventId: 'e1', seq: 1, turn: 1, type: 'move_used' as const, user: 'A0', move: 'Protect', targets: ['A0'] }],
      result: { winner: 'A' as const, reason: 'ko' as const },
    };
    const store = storeFromLegacyWorkspace(legacy);
    const ws = deriveWorkspace(store);
    expect(ws.sideA.player).toBe('Alice');
    expect(ws.round).toBe('Top 8');
    expect(ws.events).toHaveLength(1);
    expect(ws.result).toEqual({ winner: 'A', reason: 'ko' });
    expect(matchStanding(store.tournaments[0]!.matches[0]!).winnerSide).toBeUndefined(); // 1 game, Bo3 → not decided
  });
});
