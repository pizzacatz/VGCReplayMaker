import { useState } from 'react';
import { BRING_COUNT, broughtInfo, leadSlots, type SideId, type SideState, type Workspace } from './model';

export function MatchSetup({ ws, setWs, startOpen }: { ws: Workspace; setWs: (w: Workspace) => void; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);

  const setSide = (side: SideId, next: SideState) =>
    setWs(side === 'A' ? { ...ws, sideA: next } : { ...ws, sideB: next });

  /** Set a lead slot; selecting a mon already in the other slot swaps their positions. */
  const setLead = (side: SideId, pos: 0 | 1, monId: string) => {
    const s = side === 'A' ? ws.sideA : ws.sideB;
    const [L, R] = leadSlots(s);
    let next: [string, string];
    if (pos === 0) next = monId && R === monId ? [monId, L] : [monId, R];
    else next = monId && L === monId ? [R, monId] : [L, monId];
    setSide(side, { ...s, leads: next });
  };

  return (
    <div className="panel" style={{ background: 'var(--panel2)', marginBottom: 12 }}>
      <div className="controls" style={{ marginTop: 0 }}>
        <strong>Match setup</strong>
        <button onClick={() => setOpen(!open)}>{open ? 'hide' : 'edit leads / bring'}</button>
        <span className="muted">leads vary per game; the bring is deduced as mons appear</span>
      </div>
      {open && (
        <div className="row">
          <SideSetup side="A" state={ws.sideA} ws={ws} onSetLead={setLead} />
          <SideSetup side="B" state={ws.sideB} ws={ws} onSetLead={setLead} />
        </div>
      )}
    </div>
  );
}

function SideSetup({
  side,
  state,
  ws,
  onSetLead,
}: {
  side: SideId;
  state: SideState;
  ws: Workspace;
  onSetLead: (side: SideId, pos: 0 | 1, monId: string) => void;
}) {
  if (state.mons.length === 0) return <div className="col"><div className="muted">{state.player}: no team</div></div>;
  const [left, right] = leadSlots(state);
  const info = broughtInfo(ws, side);

  const leadSelect = (pos: 0 | 1, value: string) => (
    <select value={value} onChange={(e) => onSetLead(side, pos, e.target.value)}>
      <option value="">—</option>
      {state.mons.map((m) => (
        <option key={m.monId} value={m.monId}>{m.parsed.species}</option>
      ))}
    </select>
  );

  return (
    <div className="col">
      <div className="muted" style={{ fontSize: 12 }}>{state.player} · starting Pokémon</div>
      <div className="field"><label>Left lead</label>{leadSelect(0, left)}</div>
      <div className="field"><label>Right lead</label>{leadSelect(1, right)}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        {`Brought ${info.brought.length}/${BRING_COUNT}` +
          (info.confirmed
            ? ` — bring confirmed; not brought: ${info.notBrought.map((id) => state.mons.find((m) => m.monId === id)?.parsed.species).join(', ')}`
            : info.unknown.length
              ? ` — ${info.unknown.length} still unseen (possibly brought)`
              : '')}
      </div>
    </div>
  );
}
