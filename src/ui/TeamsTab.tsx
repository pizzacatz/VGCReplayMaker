import { useState } from 'react';
import { parseSide, type SideId, type SideState, type Workspace } from './model';

function SidePanel({
  side,
  state,
  onChange,
}: {
  side: SideId;
  state: SideState;
  onChange: (next: SideState) => void;
}) {
  const [error, setError] = useState<string | undefined>();

  const reparse = (paste: string) => {
    const { mons, error: err } = parseSide(side, paste);
    setError(err);
    if (err) {
      onChange({ ...state, rawPaste: paste });
    } else {
      // default the starting two explicitly (visible + changeable in Transcribe)
      onChange({ ...state, rawPaste: paste, mons, leads: mons.slice(0, 2).map((m) => m.monId) });
    }
  };

  return (
    <div className="col panel">
      <div className="field">
        <label>Player name</label>
        <input value={state.player} onChange={(e) => onChange({ ...state, player: e.target.value })} />
      </div>
      <h2>Pokepaste ({side === 'A' ? 'your side' : 'opponent'})</h2>
      <textarea
        placeholder={'Paste a team here. Omit the spread line to have the solver reverse-engineer it.'}
        value={state.rawPaste}
        onChange={(e) => reparse(e.target.value)}
      />
      {error && <p className="error">Parse error: {error}</p>}
      <h2>Roster</h2>
      {state.mons.length === 0 && <p className="muted">No mons parsed yet.</p>}
      {state.mons.map((m, i) => (
        <div key={m.monId} className="panel" style={{ marginBottom: 8 }}>
          <strong>
            {m.parsed.species}
            {m.parsed.item ? ` @ ${m.parsed.item}` : ''}
          </strong>{' '}
          <span className="muted">
            {m.parsed.ability ?? '—'} · {m.parsed.spreadKnown ? 'known spread' : 'spread to solve'}
          </span>
          <div className="field">
            <label>Observed max HP</label>
            <input
              type="number"
              value={m.observedMaxHp}
              onChange={(e) => {
                const mons = [...state.mons];
                mons[i] = { ...m, observedMaxHp: Number(e.target.value) };
                onChange({ ...state, mons });
              }}
            />
            <span className="muted">read off screen → gives HP Stat Points</span>
          </div>
          <div className="chips">
            <span className="chip">
              align: {m.parsed.alignment === 'neutral' ? 'neutral' : `+${m.parsed.alignment.up} −${m.parsed.alignment.down}`}
            </span>
            {m.parsed.moves.map((mv) => (
              <span key={mv} className="chip">
                {mv}
              </span>
            ))}
            {m.parsed.flags.map((f, fi) => (
              <span key={fi} className="chip" style={{ color: 'var(--warn)' }}>
                ⚠ {f}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TeamsTab({ ws, setWs }: { ws: Workspace; setWs: (w: Workspace) => void }) {
  return (
    <div className="row">
      <SidePanel side="A" state={ws.sideA} onChange={(sideA) => setWs({ ...ws, sideA })} />
      <SidePanel side="B" state={ws.sideB} onChange={(sideB) => setWs({ ...ws, sideB })} />
    </div>
  );
}
