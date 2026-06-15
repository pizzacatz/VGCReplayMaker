import { useEffect, useRef, useState } from 'react';
import { type Workspace } from './model';
import {
  activeGame,
  activeMatch,
  activeTournament,
  applyWorkspace,
  deriveWorkspace,
  emptyStore,
  loadStore,
  matchStanding,
  standingLabel,
  teamById,
  type ScoutingStore,
} from './store';
import { TournamentNav } from './TournamentNav';
import { TeamsTab } from './TeamsTab';
import { TranscribeTab } from './TranscribeTab';
import { SolveTab } from './SolveTab';
import { ReplayTab } from './ReplayTab';
import { ErrorBoundary } from './ErrorBoundary';

const STORE_KEY = 'vgc-store-v1';
const LEGACY_KEY = 'vgc-workspace-v1';

function load(): ScoutingStore {
  try {
    return loadStore(localStorage.getItem(STORE_KEY), localStorage.getItem(LEGACY_KEY));
  } catch {
    return emptyStore();
  }
}

type Tab = 'teams' | 'transcribe' | 'solve' | 'replay';

export function App() {
  const [store, setStore] = useState<ScoutingStore>(load);
  const [tab, setTab] = useState<Tab>('teams');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }, [store]);

  const ws: Workspace = deriveWorkspace(store);
  const setWs = (w: Workspace) => setStore(applyWorkspace(store, w));

  const t = activeTournament(store);
  const match = activeMatch(store);
  const game = activeGame(store);
  const standing = match ? matchStanding(match) : undefined;

  const saveFile = () => {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t?.name || 'tournament'}.json`.replace(/\s+/g, '_');
    a.click();
    URL.revokeObjectURL(url);
  };

  const loadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = String(reader.result);
        setStore(loadStore(raw, raw)); // accepts a tournament store OR a legacy single-game workspace
      } catch (e) {
        alert(`Could not load: ${(e as Error).message}`);
      }
    };
    reader.readAsText(file);
  };

  const tabs: Array<[Tab, string]> = [
    ['teams', 'Teams'],
    ['transcribe', `Transcribe (${ws.events.length})`],
    ['solve', 'Solve'],
    ['replay', 'Replay'],
  ];

  const winnerName = standing?.winnerSide === 'A' ? teamById(t, match!.teamAId)?.player : teamById(t, match!.teamBId)?.player;

  return (
    <div className="app notranslate" translate="no">
      <h1>Champions Match Analysis</h1>
      <p className="muted">
        {t ? <strong style={{ color: 'var(--text)' }}>{t.name} · </strong> : null}
        {match ? `${match.round} · ` : null}
        {match ? standingLabel(store, match) : null}
        {game ? <span> · Game {game.gameNumber}</span> : null}
        {standing?.decided ? (
          <strong style={{ color: 'var(--good)' }}> · {winnerName} won the set</strong>
        ) : null}
      </p>

      <TournamentNav store={store} setStore={setStore} />

      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button onClick={saveFile} title="Download this whole tournament as a file">⬇ Save</button>
          <button onClick={() => fileRef.current?.click()} title="Load a saved tournament (or legacy transcription) to edit">⬆ Load</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadFile(f);
              e.target.value = '';
            }}
          />
          <button
            style={{ color: 'var(--muted)' }}
            onClick={() => {
              if (confirm('Clear everything (all tournaments, matches, games)?')) setStore(emptyStore());
            }}
          >
            Reset
          </button>
        </span>
      </div>

      <ErrorBoundary key={`${tab}-${store.activeGameId}`} onReset={() => setStore(emptyStore())}>
        {tab === 'teams' && <TeamsTab ws={ws} setWs={setWs} />}
        {tab === 'transcribe' && <TranscribeTab ws={ws} setWs={setWs} />}
        {tab === 'solve' && <SolveTab ws={ws} store={store} />}
        {tab === 'replay' && <ReplayTab ws={ws} />}
      </ErrorBoundary>
    </div>
  );
}
