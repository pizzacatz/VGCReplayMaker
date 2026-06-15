import { useEffect, useRef, useState } from 'react';
import { emptyWorkspace, type Workspace } from './model';
import { TeamsTab } from './TeamsTab';
import { TranscribeTab } from './TranscribeTab';
import { SolveTab } from './SolveTab';
import { ReplayTab } from './ReplayTab';
import { ErrorBoundary } from './ErrorBoundary';

const STORAGE_KEY = 'vgc-workspace-v1';

function load(): Workspace {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...emptyWorkspace(), ...(JSON.parse(raw) as Workspace) };
  } catch {
    /* ignore */
  }
  return emptyWorkspace();
}

type Tab = 'teams' | 'transcribe' | 'solve' | 'replay';

export function App() {
  const [ws, setWs] = useState<Workspace>(load);
  const [tab, setTab] = useState<Tab>('teams');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ws));
  }, [ws]);

  const saveFile = () => {
    const blob = new Blob([JSON.stringify(ws, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ws.round || 'transcription'}-${ws.sideA.player}-vs-${ws.sideB.player}.json`.replace(/\s+/g, '_');
    a.click();
    URL.revokeObjectURL(url);
  };

  const loadFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as Workspace;
        if (!parsed.sideA || !parsed.sideB || !Array.isArray(parsed.events)) throw new Error('not a transcription file');
        setWs({ ...emptyWorkspace(), ...parsed });
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

  return (
    <div className="app notranslate" translate="no">
      <h1>Champions Match Analysis</h1>
      <p className="muted">
        {ws.round ? <strong style={{ color: 'var(--text)' }}>{ws.round} · </strong> : null}
        {ws.sideA.player} vs {ws.sideB.player} · Regulation M-A · open sheets.
      </p>
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button onClick={saveFile} title="Download this transcription as a file">⬇ Save</button>
          <button onClick={() => fileRef.current?.click()} title="Load a saved transcription to edit">⬆ Load</button>
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
              if (confirm('Clear the entire workspace (teams + events)?')) setWs(emptyWorkspace());
            }}
          >
            Reset
          </button>
        </span>
      </div>

      <ErrorBoundary key={tab} onReset={() => setWs(emptyWorkspace())}>
        {tab === 'teams' && <TeamsTab ws={ws} setWs={setWs} />}
        {tab === 'transcribe' && <TranscribeTab ws={ws} setWs={setWs} />}
        {tab === 'solve' && <SolveTab ws={ws} />}
        {tab === 'replay' && <ReplayTab ws={ws} />}
      </ErrorBoundary>
    </div>
  );
}
