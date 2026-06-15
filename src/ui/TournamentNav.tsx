import { useState } from 'react';
import {
  activeGame,
  activeMatch,
  activeTournament,
  addGame,
  addMatch,
  addTournament,
  deleteGame,
  matchStanding,
  moveGame,
  renameTournament,
  selectGame,
  selectMatch,
  selectTournament,
  setMatchField,
  standingLabel,
  teamById,
  toggleGameExcluded,
  winsNeeded,
  type Match,
  type ScoutingStore,
} from './store';
import type { SideId } from './model';

export function TournamentNav({ store, setStore }: { store: ScoutingStore; setStore: (s: ScoutingStore) => void }) {
  const t = activeTournament(store);
  const match = activeMatch(store);
  const game = activeGame(store);
  const [addingMatch, setAddingMatch] = useState(false);
  if (!t || !match || !game) return null;

  const standing = matchStanding(match);
  const teamA = teamById(t, match.teamAId);
  const teamB = teamById(t, match.teamBId);
  const winnerName = standing.winnerSide === 'A' ? teamA?.player : teamB?.player;

  return (
    <div className="panel" style={{ marginBottom: 12, background: 'var(--panel2)' }}>
      {/* Tournament row */}
      <div className="controls" style={{ marginTop: 0 }}>
        <strong>Tournament</strong>
        <select value={t.tournamentId} onChange={(e) => setStore(selectTournament(store, e.target.value))}>
          {store.tournaments.map((x) => (
            <option key={x.tournamentId} value={x.tournamentId}>{x.name}</option>
          ))}
        </select>
        <input
          aria-label="Tournament name"
          value={t.name}
          onChange={(e) => setStore(renameTournament(store, e.target.value))}
          style={{ minWidth: 200 }}
        />
        <button onClick={() => setStore(addTournament(store))} title="Start a new tournament">＋ Tournament</button>
      </div>

      {/* Match row */}
      <div className="controls">
        <strong>Match</strong>
        <select value={match.matchId} onChange={(e) => setStore(selectMatch(store, e.target.value))}>
          {t.matches.map((m) => (
            <option key={m.matchId} value={m.matchId}>{m.round} · {standingLabel(store, m)}</option>
          ))}
        </select>
        <button onClick={() => setAddingMatch((v) => !v)}>{addingMatch ? 'cancel' : '＋ Match'}</button>
      </div>

      {addingMatch && (
        <NewMatchForm
          store={store}
          onAdd={(round, a, b) => {
            setStore(addMatch(store, round, a, b));
            setAddingMatch(false);
          }}
        />
      )}

      {/* Match detail: round / best-of / standing / forfeit */}
      <div className="controls">
        <div className="field" style={{ margin: 0 }}>
          <label>Round</label>
          <input value={match.round} onChange={(e) => setStore(setMatchField(store, { round: e.target.value }))} placeholder="Round 7, Top 4B" />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Best of</label>
          <select value={match.bestOf} onChange={(e) => setStore(setMatchField(store, { bestOf: Number(e.target.value) }))}>
            {[1, 3, 5].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <span className="chip" style={{ fontWeight: 600 }}>{standingLabel(store, match)}</span>
        {standing.decided ? (
          <span className="chip" style={{ color: 'var(--good)' }}>
            ✓ {winnerName} wins the set ({standing.scoreA}–{standing.scoreB}, by {standing.reason})
          </span>
        ) : (
          <span className="muted" style={{ fontSize: 12 }}>
            first to {standing.winsNeeded} · in progress
          </span>
        )}
      </div>

      {/* Games row */}
      <div className="controls">
        <strong>Games</strong>
        {match.games.map((g, i) => {
          const mark = g.result ? (g.result.winner === 'A' ? `${teamA?.player ?? 'A'} ✓` : `${teamB?.player ?? 'B'} ✓`) : '…';
          return (
            <span key={g.gameId} style={{ display: 'inline-flex', alignItems: 'center' }}>
              {match.games.length > 1 && (
                <button
                  onClick={() => setStore(moveGame(store, g.gameId, -1))}
                  disabled={i === 0}
                  title="move this game earlier in the set"
                  style={{ padding: '2px 5px' }}
                >
                  ◀
                </button>
              )}
              <button
                className={g.gameId === game.gameId ? 'active' : ''}
                onClick={() => setStore(selectGame(store, g.gameId))}
                title={g.result ? `won by ${g.result.reason}` : 'in progress'}
                style={g.excludedFromSolve ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}
              >
                Game {g.gameNumber} <span className="muted">· {mark}</span>
              </button>
              <button
                onClick={() => setStore(toggleGameExcluded(store, g.gameId))}
                title={g.excludedFromSolve ? 'excluded from the solve — click to include' : 'exclude this game from the solve (kept, not deleted)'}
                style={{ padding: '2px 5px', color: g.excludedFromSolve ? 'var(--warn)' : 'var(--muted)' }}
              >
                {g.excludedFromSolve ? '⊘' : '⊙'}
              </button>
              {match.games.length > 1 && (
                <button
                  onClick={() => setStore(moveGame(store, g.gameId, 1))}
                  disabled={i === match.games.length - 1}
                  title="move this game later in the set"
                  style={{ padding: '2px 5px' }}
                >
                  ▶
                </button>
              )}
            </span>
          );
        })}
        <button onClick={() => setStore(addGame(store))} title="Add the next game in this set">＋ Game</button>
        {match.games.length > 1 && (
          <button
            style={{ color: 'var(--muted)' }}
            onClick={() => {
              if (confirm(`Delete Game ${game.gameNumber}? Its event log is removed.`)) setStore(deleteGame(store, game.gameId));
            }}
          >
            ✕ delete game
          </button>
        )}
      </div>

      {/* Set forfeit override — only relevant before the set is decided on games */}
      {!standing.decided && standing.played < winsNeeded(match.bestOf) && (
        <div className="controls">
          <span className="muted" style={{ fontSize: 12 }}>Whole-set forfeit / no-show:</span>
          <select
            value={match.forfeitWinner ?? ''}
            onChange={(e) => setStore(setMatchField(store, { forfeitWinner: (e.target.value || undefined) as SideId | undefined }))}
          >
            <option value="">—</option>
            <option value="A">{teamA?.player} wins (opponent forfeits)</option>
            <option value="B">{teamB?.player} wins (opponent forfeits)</option>
          </select>
        </div>
      )}
    </div>
  );
}

function NewMatchForm({
  store,
  onAdd,
}: {
  store: ScoutingStore;
  onAdd: (round: string, a: { teamId: string } | { newPlayer: string }, b: { teamId: string } | { newPlayer: string }) => void;
}) {
  const t = activeTournament(store);
  const teams = t?.teams ?? [];
  const [round, setRound] = useState('');
  const [aSel, setASel] = useState('__new__');
  const [aName, setAName] = useState('');
  const [bSel, setBSel] = useState('__new__');
  const [bName, setBName] = useState('');

  const ref = (sel: string, name: string): { teamId: string } | { newPlayer: string } =>
    sel === '__new__' ? { newPlayer: name || 'New player' } : { teamId: sel };

  const picker = (sel: string, setSel: (v: string) => void, name: string, setName: (v: string) => void, label: string) => (
    <div className="field" style={{ margin: 0 }}>
      <label>{label}</label>
      <select value={sel} onChange={(e) => setSel(e.target.value)}>
        {teams.map((tm) => (
          <option key={tm.teamId} value={tm.teamId}>{tm.player}</option>
        ))}
        <option value="__new__">➕ new player…</option>
      </select>
      {sel === '__new__' && <input placeholder="player name" value={name} onChange={(e) => setName(e.target.value)} />}
    </div>
  );

  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <div className="controls" style={{ marginTop: 0 }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Round</label>
          <input placeholder="Round 8, Top 8" value={round} onChange={(e) => setRound(e.target.value)} />
        </div>
        {picker(aSel, setASel, aName, setAName, 'Player A')}
        {picker(bSel, setBSel, bName, setBName, 'Player B')}
        <button className="primary" onClick={() => onAdd(round, ref(aSel, aName), ref(bSel, bName))}>Add match</button>
      </div>
      <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
        Pick an existing player to reuse their team (team-locked, aggregated across the tournament), or add a new one.
      </p>
    </div>
  );
}
