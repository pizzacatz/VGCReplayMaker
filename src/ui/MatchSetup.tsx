import { useState } from 'react';
import {
  BRING_COUNT,
  broughtInfo,
  leadMonIds,
  type SideId,
  type SideState,
  type Workspace,
} from './model';

export function MatchSetup({ ws, setWs, startOpen }: { ws: Workspace; setWs: (w: Workspace) => void; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);

  const setSide = (side: SideId, next: SideState) =>
    setWs(side === 'A' ? { ...ws, sideA: next } : { ...ws, sideB: next });

  const toggleLead = (side: SideId, monId: string) => {
    const s = side === 'A' ? ws.sideA : ws.sideB;
    const cur = leadMonIds(s);
    let leads: string[];
    if (cur.includes(monId)) leads = cur.filter((x) => x !== monId); // remove
    else if (cur.length < 2) leads = [...cur, monId]; // add to next open slot
    else return; // already 2 chosen — remove one first (no surprise replacement)
    setSide(side, { ...s, leads });
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
          <SideSetup side="A" state={ws.sideA} label="You" ws={ws} onToggleLead={toggleLead} />
          <SideSetup side="B" state={ws.sideB} label="Opponent" ws={ws} onToggleLead={toggleLead} />
        </div>
      )}
    </div>
  );
}

function SideSetup({
  side,
  state,
  label,
  ws,
  onToggleLead,
}: {
  side: SideId;
  state: SideState;
  label: string;
  ws: Workspace;
  onToggleLead: (side: SideId, monId: string) => void;
}) {
  if (state.mons.length === 0) return <div className="col"><div className="muted">{label}: no team</div></div>;
  const leads = leadMonIds(state);
  const full = leads.length >= 2;
  const info = broughtInfo(ws, side);
  const status = (monId: string): 'lead' | 'brought' | 'not' | 'unknown' => {
    if (leads.includes(monId)) return 'lead';
    if (info.notBrought.includes(monId)) return 'not';
    if (info.brought.includes(monId)) return 'brought';
    return 'unknown';
  };
  const nameOf = (monId?: string) => (monId ? state.mons.find((m) => m.monId === monId)?.parsed.species ?? '—' : '—');

  return (
    <div className="col">
      <div className="muted" style={{ fontSize: 12 }}>{label} · click two starters{full ? ' — both set (click one to change)' : leads.length === 1 ? ' — pick one more' : ''}</div>
      <div className="chips" style={{ margin: '6px 0' }}>
        <span className="chip">Lead L: <strong>{nameOf(leads[0])}</strong></span>
        <span className="chip">Lead R: <strong>{nameOf(leads[1])}</strong></span>
      </div>
      <div className="chips">
        {state.mons.map((m) => {
          const st = status(m.monId);
          const isLead = st === 'lead';
          const pos = leads.indexOf(m.monId);
          // when two are chosen, dim the non-leads so it's clear you remove one first
          const dim = (!isLead && full) || st === 'not';
          return (
            <button
              key={m.monId}
              className={isLead ? 'primary' : ''}
              style={dim ? { opacity: 0.4, ...(st === 'not' ? { textDecoration: 'line-through' } : {}) } : undefined}
              onClick={() => onToggleLead(side, m.monId)}
              title={isLead ? `lead (${pos === 0 ? 'left' : 'right'}) — click to remove` : st === 'brought' ? 'brought (switched in)' : st === 'not' ? 'deduced NOT brought' : full ? 'remove a lead first' : 'click to set as a lead'}
            >
              {m.parsed.species + (isLead ? ` ◀${pos === 0 ? 'L' : 'R'}` : st === 'brought' ? ' ✓' : st === 'not' ? ' ✗' : '')}
            </button>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        {`Brought ${info.brought.length}/${BRING_COUNT}` +
          (info.confirmed ? ` — bring confirmed; ${info.notBrought.length} deduced not brought` : info.unknown.length ? ` — ${info.unknown.length} still unseen (possibly brought)` : '')}
      </div>
    </div>
  );
}
