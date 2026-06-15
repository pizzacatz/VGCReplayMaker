import { useEffect, useRef, useState } from 'react';
import { type Workspace } from './model';
import {
  activeGame,
  activeMatch,
  activeTournament,
  applyWorkspace,
  deriveWorkspace,
  emptyStore,
  exportMatch,
  importMatchBundle,
  loadStore,
  matchStanding,
  standingLabel,
  teamById,
  type MatchBundle,
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
  const matchFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  }, [store]);

  const ws: Workspace = deriveWorkspace(store);
  const setWs = (w: Workspace) => setStore(applyWorkspace(store, w));

  const t = activeTournament(store);
  const match = activeMatch(store);
  const game = activeGame(store);
  const standing = match ? matchStanding(match) : undefined;

  // "Tournament - Round - P1 vs P2" — labels both the whole-store and the per-match files.
  const contextLabel = () => {
    const p1 = teamById(t, match?.teamAId ?? '')?.player ?? ws.sideA.player;
    const p2 = teamById(t, match?.teamBId ?? '')?.player ?? ws.sideB.player;
    const label = [t?.name, match?.round, `${p1} vs ${p2}`].filter(Boolean).join(' - ');
    return (label || 'tournament').replace(/[/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  };

  const download = (name: string, data: unknown) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const saveFile = () => download(`${contextLabel()}.json`, store); // whole store

  const exportMatchFile = () => {
    const bundle = exportMatch(store);
    if (!bundle) return;
    download(`${contextLabel()} (match).json`, bundle); // just this set + its two teams
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

  const importMatchFiles = async (files: FileList) => {
    const texts = await Promise.all([...files].map((f) => f.text()));
    let next = store;
    const failed: string[] = [];
    texts.forEach((raw, i) => {
      try {
        next = importMatchBundle(next, JSON.parse(raw) as MatchBundle); // fold each in; merges, never overwrites
      } catch (e) {
        failed.push(`${files[i]!.name}: ${(e as Error).message}`);
      }
    });
    setStore(next);
    if (failed.length) alert(`Some files could not be imported:\n${failed.join('\n')}`);
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
          <button onClick={exportMatchFile} title="Export just this match (set + its two teams) to share/back up">⤓ Match</button>
          <button onClick={() => matchFileRef.current?.click()} title="Import one or more match files — merged in, nothing is overwritten">⤒ Match(es)</button>
          <input
            ref={matchFileRef}
            type="file"
            accept="application/json,.json"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fs = e.target.files;
              if (fs && fs.length) void importMatchFiles(fs);
              e.target.value = '';
            }}
          />
          <button onClick={saveFile} title="Download the whole store (all tournaments) as a backup">⬇ Save all</button>
          <button onClick={() => fileRef.current?.click()} title="Load a whole store (or legacy transcription) — REPLACES everything">⬆ Load all</button>
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
        {tab === 'solve' && <SolveTab ws={ws} store={store} setStore={setStore} />}
        {tab === 'replay' && <ReplayTab ws={ws} />}
      </ErrorBoundary>
    </div>
  );
}
