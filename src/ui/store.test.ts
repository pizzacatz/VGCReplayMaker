import { describe, it, expect } from 'vitest';
import {
  addGame,
  addMatch,
  applyWorkspace,
  deriveWorkspace,
  emptyStore,
  exportMatch,
  importMatchBundle,
  matchStanding,
  moveGame,
  renameTournament,
  setDamageStatus,
  setMatchField,
  toggleGameExcluded,
  tournamentSources,
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

describe('moveGame reorders + renumbers (the "this is actually Game 2" workflow)', () => {
  it('pushing the transcribed game later makes it Game 2 and keeps its events', () => {
    let store = emptyStore();
    store = applyWorkspace(store, {
      ...deriveWorkspace(store),
      events: [{ eventId: 'e1', seq: 1, turn: 1, type: 'move_used', user: 'A0', move: 'Protect', targets: ['A0'] }],
    });
    const transcribedId = store.activeGameId;
    store = addGame(store); // new empty game appended (Game 2), now active
    store = moveGame(store, transcribedId, 1); // push the transcribed game to the later slot
    const games = store.tournaments[0]!.matches[0]!.games;
    expect(games.map((g) => g.gameNumber)).toEqual([1, 2]);
    const moved = games.find((g) => g.gameId === transcribedId)!;
    expect(moved.gameNumber).toBe(2); // it's now Game 2
    expect(moved.events).toHaveLength(1); // transcription preserved
    expect(games[0]!.events).toHaveLength(0); // the new Game 1 is the empty one to transcribe
  });

  it('is a no-op at the ends', () => {
    const store = emptyStore();
    expect(moveGame(store, store.activeGameId, -1)).toBe(store); // single game, can't move earlier
  });
});

describe('sources library + per-hit exclude', () => {
  const mon = (id: string, species: string): MonEntry => ({
    monId: id,
    parsed: { species, level: 50, moves: [], alignment: 'neutral', spreadKnown: false, flags: [] },
    observedMaxHp: 175,
  });
  const withHit = () => {
    let s = emptyStore();
    const ws = deriveWorkspace(s);
    return applyWorkspace(s, {
      ...ws,
      sideA: { ...ws.sideA, player: 'Alice', mons: [mon('A0', 'Garchomp')], leads: ['A0'] },
      sideB: { ...ws.sideB, player: 'Bob', mons: [mon('B0', 'Incineroar')], leads: ['B0'] },
      events: [
        { eventId: 'mv', seq: 1, turn: 1, type: 'move_used', user: 'A0', move: 'Earthquake', targets: ['B0'] },
        { eventId: 'dmg', seq: 2, turn: 1, type: 'damage', attacker: 'A0', defender: 'B0', move: 'Earthquake', hpBefore: 175, hpAfter: 120, crit: false, status: 'clean' },
      ],
    });
  };

  it('tournamentSources counts clean hits per game', () => {
    const sources = tournamentSources(withHit().tournaments[0]!);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.cleanHits).toBe(1);
    expect(sources[0]!.excluded).toBe(false);
  });

  it('a per-game exclude drops that game from the source count', () => {
    let s = withHit();
    s = toggleGameExcluded(s, s.activeGameId);
    expect(tournamentSources(s.tournaments[0]!)[0]!.excluded).toBe(true);
  });

  it('setDamageStatus to unresolved removes the hit from the solve inputs', () => {
    let s = withHit();
    expect(tournamentSources(s.tournaments[0]!)[0]!.cleanHits).toBe(1);
    s = setDamageStatus(s, 'dmg', 'unresolved');
    expect(tournamentSources(s.tournaments[0]!)[0]!.cleanHits).toBe(0); // no longer clean → excluded
  });
});

describe('toggleGameExcluded (quarantine a game from the solve)', () => {
  it('flips the flag on and back off (cleared, not left false)', () => {
    let store = emptyStore();
    const id = store.activeGameId;
    store = toggleGameExcluded(store, id);
    expect(store.tournaments[0]!.matches[0]!.games[0]!.excludedFromSolve).toBe(true);
    store = toggleGameExcluded(store, id);
    expect('excludedFromSolve' in store.tournaments[0]!.matches[0]!.games[0]!).toBe(false);
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

describe('per-match (battle) export / import — merge, never overwrite', () => {
  const mon = (id: string, species: string): MonEntry => ({
    monId: id,
    parsed: { species, level: 50, moves: [], alignment: 'neutral', spreadKnown: false, flags: [] },
    observedMaxHp: 183,
  });

  // a store whose active match has named players, a roster on each side, and a transcribed game
  const seeded = (): ReturnType<typeof emptyStore> => {
    let s = renameTournament(emptyStore(), 'Regional A'); // distinct name from a fresh store's default
    const ws = deriveWorkspace(s);
    s = applyWorkspace(s, {
      ...ws,
      round: 'Round 7',
      sideA: { ...ws.sideA, player: 'Alice', mons: [mon('A0', 'Garchomp')], leads: ['A0'] },
      sideB: { ...ws.sideB, player: 'Bob', mons: [mon('B0', 'Incineroar')], leads: ['B0'] },
      events: [
        { eventId: 'e1', seq: 1, turn: 1, type: 'move_used', user: 'A0', move: 'Earthquake', targets: ['B0'] },
        { eventId: 'e2', seq: 2, turn: 1, type: 'damage', attacker: 'A0', defender: 'B0', move: 'Earthquake', hpBefore: 175, hpAfter: 100, crit: false, status: 'clean' },
      ],
      result: { winner: 'A', reason: 'ko' },
    });
    return s;
  };

  it('exports the active match with both teams, self-contained', () => {
    const bundle = exportMatch(seeded())!;
    expect(bundle.kind).toBe('vgc-match');
    expect(bundle.teams.map((t) => t.player).sort()).toEqual(['Alice', 'Bob']);
    expect(bundle.match.round).toBe('Round 7');
  });

  it('importing into a DIFFERENT store adds the match without overwriting existing data', () => {
    const bundle = exportMatch(seeded())!;
    const other = emptyStore(); // a separate store with its own (empty) tournament
    const otherTournamentCount = other.tournaments.length;
    const merged = importMatchBundle(other, bundle);
    expect(merged.tournaments.length).toBe(otherTournamentCount + 1); // new tournament added, old kept
    const imported = merged.tournaments.find((t) => t.name === 'Regional A' && t.matches.some((m) => m.round === 'Round 7'));
    expect(imported).toBeTruthy();
  });

  it('remaps ids so an imported game reconstructs and references no original ids', () => {
    const bundle = exportMatch(seeded())!;
    const merged = importMatchBundle(emptyStore(), bundle);
    const m = merged.tournaments.flatMap((t) => t.matches).find((x) => x.round === 'Round 7')!;
    const g = m.games[0]!;
    // events were remapped off the original A0/B0 ids onto the new team prefixes
    const ids = g.events.flatMap((e) => Object.values(e as unknown as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v : [v])));
    expect(ids).not.toContain('A0');
    expect(ids).not.toContain('B0');
    // and the derived workspace for that imported game is internally consistent
    const ws = deriveWorkspace({ ...merged, activeMatchId: m.matchId, activeGameId: g.gameId });
    expect(ws.events).toHaveLength(2);
    expect(ws.sideA.mons[0]!.monId).toBe(ws.sideA.leads![0]); // lead id matches the remapped roster id
  });

  it('re-importing a battle of the same tournament reuses the matching team (aggregation-friendly)', () => {
    const bundle = exportMatch(seeded())!;
    let s = importMatchBundle(emptyStore(), bundle); // creates tournament "Regional A" with Alice+Bob
    const teamsAfterFirst = s.tournaments.find((t) => t.name === 'Regional A')!.teams.length;
    s = importMatchBundle(s, bundle); // same tournament name + same rosters → teams reused, not duplicated
    const t = s.tournaments.find((x) => x.name === 'Regional A')!;
    expect(t.matches).toHaveLength(2); // both matches present
    expect(t.teams.length).toBe(teamsAfterFirst); // teams NOT duplicated
  });

  it('rejects a non-match file', () => {
    expect(() => importMatchBundle(emptyStore(), { kind: 'nope' } as never)).toThrow();
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
