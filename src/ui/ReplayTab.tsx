import { useMemo, useState } from 'react';
import { ReplayPlayer, showdownReplayHtml, toProtocol, type ReplayState, type SlotState } from '../replay';
import { buildLog, type Workspace } from './model';

const SLOTS = ['p1a', 'p1b', 'p2a', 'p2b'] as const;

export function ReplayTab({ ws }: { ws: Workspace }) {
  const [view, setView] = useState<'showdown' | 'board'>('showdown');
  const { messages, error } = useMemo(() => {
    try {
      return { messages: toProtocol(buildLog(ws)), error: undefined as string | undefined };
    } catch (e) {
      return { messages: [], error: (e as Error).message };
    }
  }, [ws]);

  const player = useMemo(() => new ReplayPlayer(messages), [messages]);
  const [index, setIndex] = useState(-1);
  const state = player.stateAt(index);

  if (error) return <div className="panel error">Replay error: {error}</div>;
  if (messages.length === 0) return <div className="panel">Add teams and events first.</div>;

  const viewToggle = (
    <div className="controls">
      <button className={view === 'showdown' ? 'primary' : ''} onClick={() => setView('showdown')}>Showdown view</button>
      <button className={view === 'board' ? 'primary' : ''} onClick={() => setView('board')}>Simple board</button>
    </div>
  );

  if (view === 'showdown') {
    return (
      <div>
        {viewToggle}
        <ShowdownView ws={ws} />
      </div>
    );
  }

  const current = messages[index];
  const turns = player.turnIndices();
  const toTurnIndex = (dir: 1 | -1) => {
    const candidates = dir === 1 ? turns.filter((t) => t > index) : turns.filter((t) => t < index).reverse();
    if (candidates[0] !== undefined) setIndex(candidates[0]);
  };

  return (
    <div>
      {viewToggle}
      <div className="controls">
        <button onClick={() => setIndex(-1)}>⏮ start</button>
        <button onClick={() => toTurnIndex(-1)}>◀ turn</button>
        <button onClick={() => setIndex(Math.max(-1, index - 1))}>◀ step</button>
        <button onClick={() => setIndex(Math.min(messages.length - 1, index + 1))}>step ▶</button>
        <button onClick={() => toTurnIndex(1)}>turn ▶</button>
        <button onClick={() => setIndex(messages.length - 1)}>end ⏭</button>
        <span className="muted">
          action {index + 1}/{messages.length} · turn {state.turn}
        </span>
      </div>

      <div className="panel" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, minHeight: 22 }}>
        {current ? current.line : '(pre-battle)'}
      </div>

      <h2>{ws.sideB.player} (p2)</h2>
      <div className="board">{SLOTS.slice(2).map((s) => <Slot key={s} state={state.slots[s] ?? null} />)}</div>
      <h2>{ws.sideA.player} (p1)</h2>
      <div className="board">{SLOTS.slice(0, 2).map((s) => <Slot key={s} state={state.slots[s] ?? null} />)}</div>

      <FieldStrip state={state} />

      <input
        type="range"
        min={-1}
        max={messages.length - 1}
        value={index}
        onChange={(e) => setIndex(Number(e.target.value))}
        style={{ width: '100%', marginTop: 16 }}
      />
    </div>
  );
}

function ShowdownView({ ws }: { ws: Workspace }) {
  const html = useMemo(() => {
    try {
      return showdownReplayHtml(buildLog(ws));
    } catch (e) {
      return `<p style="font-family:sans-serif;color:#c33">Could not build replay: ${(e as Error).message}</p>`;
    }
  }, [ws]);

  const download = () => {
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${ws.round || 'match'}-${ws.sideA.player}-vs-${ws.sideB.player}.html`.replace(/\s+/g, '_');
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <p className="muted" style={{ fontSize: 12 }}>
        Rendered by the official Pokémon Showdown replay engine (needs internet for sprites/animations). If it doesn’t load,
        download the replay and open it, or upload it to Showdown.
      </p>
      <div className="controls">
        <button onClick={download}>⬇ Download replay (.html)</button>
      </div>
      <iframe
        title="Showdown replay"
        srcDoc={html}
        sandbox="allow-scripts allow-same-origin"
        style={{ width: '100%', height: 560, border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }}
      />
    </div>
  );
}

function Slot({ state }: { state: SlotState | null }) {
  if (!state) return <div className="slot muted">empty</div>;
  const pct = Math.max(0, Math.round((state.hp / state.maxHp) * 100));
  const band = pct > 50 ? '' : pct > 20 ? 'mid' : 'low';
  return (
    <div className={`slot ${state.fainted ? 'fainted' : ''}`}>
      <strong>{state.species}</strong>
      <div className="muted" style={{ fontSize: 12 }}>
        {state.hp}/{state.maxHp} HP {state.fainted ? '· fainted' : ''}
      </div>
      <div className={`hpbar ${band}`}>
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function FieldStrip({ state }: { state: ReplayState }) {
  const chips: string[] = [];
  if (state.weather) chips.push(`weather: ${state.weather}`);
  for (const c of state.field) chips.push(c);
  for (const c of state.sides.A) chips.push(`your side: ${c}`);
  for (const c of state.sides.B) chips.push(`opp side: ${c}`);
  for (const [mon, st] of Object.entries(state.status)) chips.push(`${mon}: ${st}`);
  if (chips.length === 0) return null;
  return (
    <div className="chips" style={{ marginTop: 12 }}>
      {chips.map((c, i) => (
        <span key={i} className="chip">{c}</span>
      ))}
    </div>
  );
}

