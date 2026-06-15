import { useEffect, useState } from 'react';
import { emptyWorkspace, type Workspace } from './model';
import { TeamsTab } from './TeamsTab';
import { TranscribeTab } from './TranscribeTab';
import { SolveTab } from './SolveTab';
import { ReplayTab } from './ReplayTab';

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

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ws));
  }, [ws]);

  const tabs: Array<[Tab, string]> = [
    ['teams', 'Teams'],
    ['transcribe', `Transcribe (${ws.events.length})`],
    ['solve', 'Solve'],
    ['replay', 'Replay'],
  ];

  return (
    <div className="app">
      <h1>Champions Match Analysis</h1>
      <p className="muted">
        Single-user scouting tool · Regulation M-A · open sheets. Honest about what the data proves vs. guesses.
      </p>
      <div className="tabs">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <button
          style={{ marginLeft: 'auto', color: 'var(--muted)' }}
          onClick={() => {
            if (confirm('Clear the entire workspace (teams + events)?')) setWs(emptyWorkspace());
          }}
        >
          Reset
        </button>
      </div>

      {tab === 'teams' && <TeamsTab ws={ws} setWs={setWs} />}
      {tab === 'transcribe' && <TranscribeTab ws={ws} setWs={setWs} />}
      {tab === 'solve' && <SolveTab ws={ws} />}
      {tab === 'replay' && <ReplayTab ws={ws} />}
    </div>
  );
}
