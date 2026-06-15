/**
 * Scouting store: the persistent shape behind the UI. A Tournament holds
 * team-locked rosters (one registered 6 per player, reused every game), Matches
 * (a best-of set, "Round 7"), and Games (game 1/2/3) that each own an event log.
 *
 * The four tabs still operate on a single `Workspace`; this module derives that
 * Workspace from the active game (teams inherited from the tournament) and writes
 * edits back. The MATCH winner is always DERIVED from game results — never stored.
 */

import {
  emptyWorkspace,
  buildLog,
  toSpec,
  type MatchResultReason,
  type MonEntry,
  type SideId,
  type Workspace,
} from './model';
import { championsGen } from '../engine';
import { extractCleanHits, extractSpeedFacts } from '../integration';
import {
  ScoutingDB,
  rosterMonFromParsed,
  type GameHit,
  type GameSpeedFact,
  type InstanceReport,
  type MonRef,
} from '../aggregation';
import type { MatchEvent } from '../log';

export interface GameResult {
  winner: SideId;
  reason: MatchResultReason;
}

export interface Game {
  gameId: string;
  gameNumber: number;
  leadsA: string[];
  leadsB: string[];
  events: MatchEvent[];
  /** the game's recorded outcome; absent = unplayed/in-progress */
  result?: GameResult;
  /** when true, this game's hits are quarantined from the tournament solve (kept, not deleted) */
  excludedFromSolve?: boolean;
}

export interface TournamentTeam {
  /** unique within the tournament; doubles as the mon-id prefix (team-lock identity) */
  teamId: string;
  player: string;
  rawPaste: string;
  mons: MonEntry[];
}

export interface Match {
  matchId: string;
  /** label like "Round 7", "Top 4B" */
  round: string;
  bestOf: number;
  teamAId: string;
  teamBId: string;
  games: Game[];
  /** whole-set forfeit / no-show override; wins the set with reason 'forfeit' */
  forfeitWinner?: SideId;
}

export interface Tournament {
  tournamentId: string;
  name: string;
  date: string;
  format: string;
  teams: TournamentTeam[];
  matches: Match[];
}

export interface ScoutingStore {
  tournaments: Tournament[];
  activeTournamentId: string;
  activeMatchId: string;
  activeGameId: string;
}

// ── id generation (browser-side; stable enough for keys) ──────────────────────

let idc = 0;
function uid(prefix: string): string {
  idc += 1;
  return `${prefix}${idc}_${Math.floor(performance.now())}`;
}

// ── factories ─────────────────────────────────────────────────────────────────

function newTeam(player: string, teamId = uid('tm')): TournamentTeam {
  return { teamId, player, rawPaste: '', mons: [] };
}

function newGame(gameNumber: number, gameId = uid('g')): Game {
  return { gameId, gameNumber, leadsA: [], leadsB: [], events: [] };
}

function newMatch(round: string, teamAId: string, teamBId: string, matchId = uid('m')): Match {
  return { matchId, round, bestOf: 3, teamAId, teamBId, games: [newGame(1)] };
}

/** A fresh store with one tournament, two players, one match, one game — ready to use. */
export function emptyStore(): ScoutingStore {
  const a = newTeam('Player 1');
  const b = newTeam('Player 2');
  const tournament: Tournament = {
    tournamentId: uid('t'),
    name: 'New Tournament',
    date: '',
    format: 'Champions Reg M-A',
    teams: [a, b],
    matches: [newMatch('Round 1', a.teamId, b.teamId)],
  };
  const match = tournament.matches[0]!;
  return {
    tournaments: [tournament],
    activeTournamentId: tournament.tournamentId,
    activeMatchId: match.matchId,
    activeGameId: match.games[0]!.gameId,
  };
}

// ── selectors ─────────────────────────────────────────────────────────────────

export function activeTournament(store: ScoutingStore): Tournament | undefined {
  return store.tournaments.find((t) => t.tournamentId === store.activeTournamentId);
}
export function activeMatch(store: ScoutingStore): Match | undefined {
  return activeTournament(store)?.matches.find((m) => m.matchId === store.activeMatchId);
}
export function activeGame(store: ScoutingStore): Game | undefined {
  return activeMatch(store)?.games.find((g) => g.gameId === store.activeGameId);
}
export function teamById(t: Tournament | undefined, teamId: string): TournamentTeam | undefined {
  return t?.teams.find((x) => x.teamId === teamId);
}

// ── winner derivation (the smart bit) ─────────────────────────────────────────

export function winsNeeded(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

export interface MatchStanding {
  scoreA: number;
  scoreB: number;
  winsNeeded: number;
  /** decided winner side, if any */
  winnerSide?: SideId;
  decided: boolean;
  /** reason of the deciding game (or 'forfeit' for a whole-set forfeit) */
  reason?: MatchResultReason;
  /** total games that have a recorded result */
  played: number;
}

/** Derive a match's standing purely from its games' results (+ optional set forfeit). */
export function matchStanding(match: Match): MatchStanding {
  const need = winsNeeded(match.bestOf);
  let scoreA = 0;
  let scoreB = 0;
  let played = 0;
  let aReason: MatchResultReason | undefined;
  let bReason: MatchResultReason | undefined;
  for (const g of match.games) {
    if (!g.result) continue;
    played += 1;
    if (g.result.winner === 'A') {
      scoreA += 1;
      aReason = g.result.reason;
    } else {
      scoreB += 1;
      bReason = g.result.reason;
    }
  }

  // Whole-set forfeit / no-show overrides a not-yet-decided set.
  if (match.forfeitWinner && scoreA < need && scoreB < need) {
    return {
      scoreA,
      scoreB,
      winsNeeded: need,
      winnerSide: match.forfeitWinner,
      decided: true,
      reason: 'forfeit',
      played,
    };
  }

  let winnerSide: SideId | undefined;
  let reason: MatchResultReason | undefined;
  if (scoreA >= need) {
    winnerSide = 'A';
    reason = aReason;
  } else if (scoreB >= need) {
    winnerSide = 'B';
    reason = bReason;
  }
  return {
    scoreA,
    scoreB,
    winsNeeded: need,
    decided: winnerSide !== undefined,
    played,
    ...(winnerSide ? { winnerSide } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** "Alice 2–1 Bob" (or "Alice 2 – 1 Bob · in progress"). */
export function standingLabel(store: ScoutingStore, match: Match): string {
  const t = activeTournament(store);
  const a = teamById(t, match.teamAId)?.player ?? 'A';
  const b = teamById(t, match.teamBId)?.player ?? 'B';
  const s = matchStanding(match);
  return `${a} ${s.scoreA}–${s.scoreB} ${b}`;
}

// ── derive Workspace ⇄ store ───────────────────────────────────────────────────

function workspaceFromGame(t: Tournament, match: Match, game: Game): Workspace {
  const teamA = teamById(t, match.teamAId) ?? newTeam('Player 1');
  const teamB = teamById(t, match.teamBId) ?? newTeam('Player 2');
  return {
    round: match.round,
    sideA: { player: teamA.player, rawPaste: teamA.rawPaste, mons: teamA.mons, leads: game.leadsA, idPrefix: teamA.teamId },
    sideB: { player: teamB.player, rawPaste: teamB.rawPaste, mons: teamB.mons, leads: game.leadsB, idPrefix: teamB.teamId },
    events: game.events,
    ...(game.result ? { result: game.result } : {}),
  };
}

/** The Workspace the tabs operate on — the active game with teams inherited. */
export function deriveWorkspace(store: ScoutingStore): Workspace {
  const t = activeTournament(store);
  const match = activeMatch(store);
  const game = activeGame(store);
  if (!t || !match || !game) return emptyWorkspace();
  return workspaceFromGame(t, match, game);
}

/** Write a Workspace edit back into the active game + shared teams (immutably). */
export function applyWorkspace(store: ScoutingStore, ws: Workspace): ScoutingStore {
  return mapActive(store, (t, match, game) => {
    const teams = t.teams.map((team) => {
      if (team.teamId === match.teamAId)
        return { ...team, player: ws.sideA.player, rawPaste: ws.sideA.rawPaste, mons: ws.sideA.mons };
      if (team.teamId === match.teamBId)
        return { ...team, player: ws.sideB.player, rawPaste: ws.sideB.rawPaste, mons: ws.sideB.mons };
      return team;
    });
    const nextMatch: Match = { ...match, round: ws.round ?? match.round };
    const nextGame: Game = {
      ...game,
      leadsA: ws.sideA.leads ?? [],
      leadsB: ws.sideB.leads ?? [],
      events: ws.events,
      ...(ws.result ? { result: ws.result } : {}),
    };
    if (!ws.result) delete (nextGame as { result?: GameResult }).result;
    return { t: { ...t, teams }, match: nextMatch, game: nextGame };
  });
}

/** Immutable active-path update; the callback returns the new t/match/game. */
function mapActive(
  store: ScoutingStore,
  fn: (t: Tournament, match: Match, game: Game) => { t: Tournament; match: Match; game: Game },
): ScoutingStore {
  const t = activeTournament(store);
  const match = activeMatch(store);
  const game = activeGame(store);
  if (!t || !match || !game) return store;
  const { t: nt, match: nm, game: ng } = fn(t, match, game);
  const matches = nt.matches.map((m) =>
    m.matchId === nm.matchId ? { ...nm, games: nm.games.map((g) => (g.gameId === ng.gameId ? ng : g)) } : m,
  );
  const tournaments = store.tournaments.map((x) => (x.tournamentId === nt.tournamentId ? { ...nt, matches } : x));
  return { ...store, tournaments };
}

// ── structural mutations (nav) ─────────────────────────────────────────────────

function replaceTournament(store: ScoutingStore, t: Tournament): ScoutingStore {
  return { ...store, tournaments: store.tournaments.map((x) => (x.tournamentId === t.tournamentId ? t : x)) };
}

export function addTournament(store: ScoutingStore): ScoutingStore {
  const fresh = emptyStore();
  const t = fresh.tournaments[0]!;
  return {
    tournaments: [...store.tournaments, t],
    activeTournamentId: t.tournamentId,
    activeMatchId: t.matches[0]!.matchId,
    activeGameId: t.matches[0]!.games[0]!.gameId,
  };
}

export function selectTournament(store: ScoutingStore, tournamentId: string): ScoutingStore {
  const t = store.tournaments.find((x) => x.tournamentId === tournamentId);
  if (!t) return store;
  const match = t.matches[0];
  return {
    ...store,
    activeTournamentId: tournamentId,
    activeMatchId: match?.matchId ?? '',
    activeGameId: match?.games[0]?.gameId ?? '',
  };
}

export function renameTournament(store: ScoutingStore, name: string): ScoutingStore {
  const t = activeTournament(store);
  if (!t) return store;
  return replaceTournament(store, { ...t, name });
}

/** Add a match. Reuses existing teams by id, or creates new players where given a name. */
export function addMatch(
  store: ScoutingStore,
  round: string,
  teamA: { teamId: string } | { newPlayer: string },
  teamB: { teamId: string } | { newPlayer: string },
): ScoutingStore {
  const t = activeTournament(store);
  if (!t) return store;
  let teams = t.teams;
  const resolve = (ref: { teamId: string } | { newPlayer: string }): { id: string; created?: TournamentTeam } => {
    if ('teamId' in ref) return { id: ref.teamId };
    const created = newTeam(ref.newPlayer);
    teams = [...teams, created];
    return { id: created.teamId, created };
  };
  const a = resolve(teamA);
  const b = resolve(teamB);
  const match = newMatch(round || `Round ${t.matches.length + 1}`, a.id, b.id);
  const nt: Tournament = { ...t, teams, matches: [...t.matches, match] };
  return {
    ...replaceTournament(store, nt),
    activeMatchId: match.matchId,
    activeGameId: match.games[0]!.gameId,
  };
}

export function selectMatch(store: ScoutingStore, matchId: string): ScoutingStore {
  const t = activeTournament(store);
  const match = t?.matches.find((m) => m.matchId === matchId);
  if (!match) return store;
  return { ...store, activeMatchId: matchId, activeGameId: match.games[0]?.gameId ?? '' };
}

export function setMatchField(
  store: ScoutingStore,
  patch: { round?: string; bestOf?: number; forfeitWinner?: SideId | undefined },
): ScoutingStore {
  const t = activeTournament(store);
  const match = activeMatch(store);
  if (!t || !match) return store;
  const { forfeitWinner, ...rest } = patch;
  let nextMatch: Match = { ...match, ...rest };
  if ('forfeitWinner' in patch) {
    if (forfeitWinner) nextMatch = { ...nextMatch, forfeitWinner };
    else {
      const m = { ...nextMatch };
      delete m.forfeitWinner;
      nextMatch = m;
    }
  }
  return replaceTournament(store, { ...t, matches: t.matches.map((m) => (m.matchId === match.matchId ? nextMatch : m)) });
}

export function addGame(store: ScoutingStore): ScoutingStore {
  const t = activeTournament(store);
  const match = activeMatch(store);
  if (!t || !match) return store;
  const game = newGame(match.games.length + 1);
  const nextMatch: Match = { ...match, games: [...match.games, game] };
  return {
    ...replaceTournament(store, { ...t, matches: t.matches.map((m) => (m.matchId === match.matchId ? nextMatch : m)) }),
    activeGameId: game.gameId,
  };
}

export function selectGame(store: ScoutingStore, gameId: string): ScoutingStore {
  return { ...store, activeGameId: gameId };
}

/** Toggle whether a game's hits feed the tournament solve (quarantine without deleting). */
export function toggleGameExcluded(store: ScoutingStore, gameId: string): ScoutingStore {
  const t = activeTournament(store);
  if (!t) return store;
  let changed = false;
  const matches = t.matches.map((m) => {
    if (!m.games.some((g) => g.gameId === gameId)) return m;
    changed = true;
    const games = m.games.map((g) => {
      if (g.gameId !== gameId) return g;
      if (g.excludedFromSolve) {
        const { excludedFromSolve: _drop, ...rest } = g;
        return rest;
      }
      return { ...g, excludedFromSolve: true };
    });
    return { ...m, games };
  });
  return changed ? replaceTournament(store, { ...t, matches }) : store;
}

/** Set a damage event's certainty (clean feeds the solver; unresolved excludes it). Searches the active tournament. */
export function setDamageStatus(store: ScoutingStore, eventId: string, status: 'clean' | 'composite' | 'unresolved'): ScoutingStore {
  const t = activeTournament(store);
  if (!t) return store;
  let changed = false;
  const matches = t.matches.map((m) => ({
    ...m,
    games: m.games.map((g) => {
      if (!g.events.some((e) => e.eventId === eventId && e.type === 'damage')) return g;
      changed = true;
      return { ...g, events: g.events.map((e) => (e.eventId === eventId && e.type === 'damage' ? { ...e, status } : e)) };
    }),
  }));
  return changed ? replaceTournament(store, { ...t, matches }) : store;
}

export interface SourceGame {
  gameId: string;
  label: string;
  /** clean hits this game contributes to the solve */
  cleanHits: number;
  excluded: boolean;
}

/** Every game in the tournament and how many clean hits it feeds the solve (the source library). */
export function tournamentSources(t: Tournament): SourceGame[] {
  const out: SourceGame[] = [];
  for (const match of t.matches) {
    for (const game of match.games) {
      const teamA = teamById(t, match.teamAId);
      const teamB = teamById(t, match.teamBId);
      let cleanHits = 0;
      if (teamA && teamB) {
        try {
          cleanHits = extractCleanHits(buildLog(workspaceFromGame(t, match, game))).length;
        } catch {
          cleanHits = 0;
        }
      }
      out.push({ gameId: game.gameId, label: `${match.round} · G${game.gameNumber}`, cleanHits, excluded: !!game.excludedFromSolve });
    }
  }
  return out;
}

/** Move a game earlier (delta -1) or later (delta +1) in the set; gameNumbers follow position. */
export function moveGame(store: ScoutingStore, gameId: string, delta: number): ScoutingStore {
  const t = activeTournament(store);
  const match = activeMatch(store);
  if (!t || !match) return store;
  const idx = match.games.findIndex((g) => g.gameId === gameId);
  const to = idx + delta;
  if (idx < 0 || to < 0 || to >= match.games.length) return store;
  const games = [...match.games];
  const [moved] = games.splice(idx, 1);
  games.splice(to, 0, moved!);
  const renumbered = games.map((g, i) => ({ ...g, gameNumber: i + 1 }));
  const nextMatch: Match = { ...match, games: renumbered };
  return replaceTournament(store, { ...t, matches: t.matches.map((m) => (m.matchId === match.matchId ? nextMatch : m)) });
}

export function deleteGame(store: ScoutingStore, gameId: string): ScoutingStore {
  const t = activeTournament(store);
  const match = activeMatch(store);
  if (!t || !match || match.games.length <= 1) return store;
  const games = match.games.filter((g) => g.gameId !== gameId).map((g, i) => ({ ...g, gameNumber: i + 1 }));
  const nextMatch: Match = { ...match, games };
  return {
    ...replaceTournament(store, { ...t, matches: t.matches.map((m) => (m.matchId === match.matchId ? nextMatch : m)) }),
    activeGameId: store.activeGameId === gameId ? games[0]!.gameId : store.activeGameId,
  };
}

// ── per-match ("battle") export / import (merge, never overwrite) ──────────────

export interface MatchBundle {
  kind: 'vgc-match';
  version: 1;
  tournament: { name: string; date: string; format: string };
  match: Match;
  /** the two teams the match references, so the bundle is self-contained */
  teams: TournamentTeam[];
}

/** Bundle the active match + its two teams for sharing/backup of a single set. */
export function exportMatch(store: ScoutingStore): MatchBundle | null {
  const t = activeTournament(store);
  const m = activeMatch(store);
  if (!t || !m) return null;
  const teams = [teamById(t, m.teamAId), teamById(t, m.teamBId)].filter((x): x is TournamentTeam => !!x);
  return { kind: 'vgc-match', version: 1, tournament: { name: t.name, date: t.date, format: t.format }, match: m, teams };
}

/** Rewrite every mon-id reference in an event through `map` (unmapped strings pass through). */
function remapEventIds(event: MatchEvent, map: Map<string, string>): MatchEvent {
  const o = { ...(event as unknown as Record<string, unknown>) };
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'string' && map.has(v)) o[k] = map.get(v);
    else if (Array.isArray(v)) o[k] = v.map((x) => (typeof x === 'string' && map.has(x) ? map.get(x) : x));
  }
  return o as unknown as MatchEvent;
}

const speciesSeq = (team: TournamentTeam): string => team.mons.map((m) => m.parsed.species).join('|');

/**
 * Merge a match bundle into the store WITHOUT overwriting anything. The bundle is
 * added to the tournament with a matching name (or a new one). Team ids and every
 * mon-id reference are remapped so there can be no collision; a bundle team that
 * matches an existing team (same player + same roster) is REUSED so re-imported
 * battles of one tournament still aggregate in the solver.
 */
export function importMatchBundle(store: ScoutingStore, bundle: MatchBundle): ScoutingStore {
  if (!bundle || bundle.kind !== 'vgc-match' || !bundle.match || !Array.isArray(bundle.teams)) {
    throw new Error('not a match (battle) file');
  }
  const created = !store.tournaments.some((t) => t.name === bundle.tournament.name);
  const target: Tournament =
    store.tournaments.find((t) => t.name === bundle.tournament.name) ?? {
      tournamentId: uid('t'),
      name: bundle.tournament.name || 'Imported',
      date: bundle.tournament.date || '',
      format: bundle.tournament.format || 'Champions Reg M-A',
      teams: [],
      matches: [],
    };

  const teamIdMap = new Map<string, string>();
  const monIdMap = new Map<string, string>();
  let teams = [...target.teams];
  for (const bt of bundle.teams) {
    const existing = target.teams.find((t) => t.player === bt.player && speciesSeq(t) === speciesSeq(bt));
    if (existing) {
      teamIdMap.set(bt.teamId, existing.teamId);
      bt.mons.forEach((m, i) => {
        const em = existing.mons[i];
        if (em) monIdMap.set(m.monId, em.monId);
      });
    } else {
      const newTeamId = uid('tm');
      teamIdMap.set(bt.teamId, newTeamId);
      const mons = bt.mons.map((m) => {
        const newMonId = `${newTeamId}${m.monId.slice(bt.teamId.length)}`;
        monIdMap.set(m.monId, newMonId);
        return { ...m, monId: newMonId };
      });
      teams = [...teams, { teamId: newTeamId, player: bt.player, rawPaste: bt.rawPaste, mons }];
    }
  }

  const bm = bundle.match;
  const teamAId = teamIdMap.get(bm.teamAId);
  const teamBId = teamIdMap.get(bm.teamBId);
  if (!teamAId || !teamBId) throw new Error('corrupt match file: a side references a team not in the bundle');

  const games: Game[] = bm.games.map((g) => ({
    gameId: uid('g'),
    gameNumber: g.gameNumber,
    leadsA: g.leadsA.map((id) => monIdMap.get(id) ?? id),
    leadsB: g.leadsB.map((id) => monIdMap.get(id) ?? id),
    events: g.events.map((e) => remapEventIds(e, monIdMap)),
    ...(g.result ? { result: g.result } : {}),
  }));
  const match: Match = {
    matchId: uid('m'),
    round: bm.round,
    bestOf: bm.bestOf,
    teamAId,
    teamBId,
    games,
    ...(bm.forfeitWinner ? { forfeitWinner: bm.forfeitWinner } : {}),
  };

  const nextTournament: Tournament = { ...target, teams, matches: [...target.matches, match] };
  const tournaments = created
    ? [...store.tournaments, nextTournament]
    : store.tournaments.map((t) => (t.tournamentId === nextTournament.tournamentId ? nextTournament : t));
  return {
    tournaments,
    activeTournamentId: nextTournament.tournamentId,
    activeMatchId: match.matchId,
    activeGameId: games[0]?.gameId ?? '',
  };
}

// ── tournament-wide solve (aggregate every game per opponent) ──────────────────

/** All games' clean hits feed ONE solve per team; returns each team's report. */
export function solveTournament(t: Tournament): Map<string, InstanceReport> {
  const gen = championsGen();
  const db = new ScoutingDB();
  db.addTournament({ tournamentId: t.tournamentId, name: t.name, date: t.date, format: t.format });

  const teamOfMon = new Map<string, string>();
  for (const team of t.teams) {
    db.addPlayer({ playerId: team.teamId, displayName: team.player });
    db.addInstance({
      instanceId: team.teamId,
      playerId: team.teamId,
      roster: team.mons.map((m) => rosterMonFromParsed(m.parsed, m.monId, m.observedMaxHp)),
    });
    for (const m of team.mons) teamOfMon.set(m.monId, team.teamId);
  }

  const ref = (monId: string): MonRef => ({ instanceId: teamOfMon.get(monId) ?? '', monId });

  for (const match of t.matches) {
    for (const game of match.games) {
      if (game.excludedFromSolve) continue; // quarantined — its hits don't feed the solve
      const teamA = teamById(t, match.teamAId);
      const teamB = teamById(t, match.teamBId);
      if (!teamA || !teamB) continue;
      const ws = workspaceFromGame(t, match, game);
      const log = buildLog(ws);
      const specs = new Map([...teamA.mons, ...teamB.mons].map((m) => [m.monId, toSpec(m.parsed)]));
      const cleanHits: GameHit[] = extractCleanHits(log).map((h) => ({
        attacker: ref(h.attackerId),
        defender: ref(h.defenderId),
        move: h.move,
        observedDamage: h.observedDamage,
        ...(h.crit !== undefined ? { crit: h.crit } : {}),
        ...(h.attackerSpecies ? { attackerSpecies: h.attackerSpecies } : {}),
        ...(h.defenderSpecies ? { defenderSpecies: h.defenderSpecies } : {}),
        source: `${match.round} G${game.gameNumber}${h.source ? ` · ${h.source}` : ''}`, // full provenance
        ...(h.eventId ? { eventId: h.eventId } : {}),
        ...(h.context ? { context: h.context } : {}),
        ...(h.hits ? { hits: h.hits } : {}),
      }));
      const speedFacts: GameSpeedFact[] = extractSpeedFacts(log, gen, specs).facts.map((f) => ({
        first: ref(f.first),
        second: ref(f.second),
        samePriorityBracket: f.samePriorityBracket,
        ...(f.trickRoom !== undefined ? { trickRoom: f.trickRoom } : {}),
        ...(f.firstSpecies ? { firstSpecies: f.firstSpecies } : {}),
        ...(f.secondSpecies ? { secondSpecies: f.secondSpecies } : {}),
        ...(f.firstControl ? { firstControl: f.firstControl } : {}),
        ...(f.secondControl ? { secondControl: f.secondControl } : {}),
      }));
      db.addGame({
        gameId: game.gameId,
        tournamentId: t.tournamentId,
        sideA: { playerId: teamA.teamId, instanceId: teamA.teamId },
        sideB: { playerId: teamB.teamId, instanceId: teamB.teamId },
        cleanHits,
        speedFacts,
      });
    }
  }

  return db.solve();
}

// ── migration / load ───────────────────────────────────────────────────────────

interface LegacyWorkspace {
  round?: string;
  sideA: { player: string; rawPaste: string; mons: MonEntry[]; leads?: string[] };
  sideB: { player: string; rawPaste: string; mons: MonEntry[]; leads?: string[] };
  events: MatchEvent[];
  result?: GameResult;
}

/** Wrap a single legacy Workspace as one tournament → match → game (ids preserved). */
export function storeFromLegacyWorkspace(ws: LegacyWorkspace): ScoutingStore {
  const teamA: TournamentTeam = { teamId: 'A', player: ws.sideA.player, rawPaste: ws.sideA.rawPaste, mons: ws.sideA.mons };
  const teamB: TournamentTeam = { teamId: 'B', player: ws.sideB.player, rawPaste: ws.sideB.rawPaste, mons: ws.sideB.mons };
  const game: Game = {
    gameId: uid('g'),
    gameNumber: 1,
    leadsA: ws.sideA.leads ?? [],
    leadsB: ws.sideB.leads ?? [],
    events: ws.events,
    ...(ws.result ? { result: ws.result } : {}),
  };
  const match: Match = { matchId: uid('m'), round: ws.round || 'Round 1', bestOf: 3, teamAId: 'A', teamBId: 'B', games: [game] };
  const tournament: Tournament = {
    tournamentId: uid('t'),
    name: ws.round || 'Imported',
    date: '',
    format: 'Champions Reg M-A',
    teams: [teamA, teamB],
    matches: [match],
  };
  return {
    tournaments: [tournament],
    activeTournamentId: tournament.tournamentId,
    activeMatchId: match.matchId,
    activeGameId: game.gameId,
  };
}

const looksLikeStore = (v: unknown): v is ScoutingStore =>
  !!v && typeof v === 'object' && Array.isArray((v as ScoutingStore).tournaments);
const looksLikeWorkspace = (v: unknown): v is LegacyWorkspace =>
  !!v && typeof v === 'object' && 'sideA' in (v as object) && 'events' in (v as object);

/** Load from either the new store JSON, a legacy workspace, or start empty. */
export function loadStore(storeRaw: string | null, legacyRaw: string | null): ScoutingStore {
  try {
    if (storeRaw) {
      const parsed = JSON.parse(storeRaw) as unknown;
      if (looksLikeStore(parsed) && parsed.tournaments.length) return parsed;
    }
  } catch {
    /* fall through */
  }
  try {
    if (legacyRaw) {
      const parsed = JSON.parse(legacyRaw) as unknown;
      if (looksLikeWorkspace(parsed)) return storeFromLegacyWorkspace(parsed);
    }
  } catch {
    /* fall through */
  }
  return emptyStore();
}
