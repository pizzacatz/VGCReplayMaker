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
    let leads = s.leads && s.leads.length ? [...s.leads] : leadMonIds(s);
    if (leads.includes(monId)) leads = leads.filter((x) => x !== monId);
    else if (leads.length < 2) leads = [...leads, monId];
    else leads = [leads[1]!, monId]; // replace the older lead
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
  const info = broughtInfo(ws, side);
  const status = (monId: string): 'lead' | 'brought' | 'not' | 'unknown' => {
    if (leads.includes(monId)) return 'lead';
    if (info.notBrought.includes(monId)) return 'not';
    if (info.brought.includes(monId)) return 'brought';
    return 'unknown';
  };

  return (
    <div className="col">
      <div className="muted" style={{ fontSize: 12 }}>{label} · pick the 2 starters (click); bring deduced below</div>
      <div className="chips" style={{ marginTop: 6 }}>
        {state.mons.map((m) => {
          const st = status(m.monId);
          const isLead = st === 'lead';
          const pos = leads.indexOf(m.monId);
          return (
            <button
              key={m.monId}
              className={isLead ? 'primary' : ''}
              style={st === 'not' ? { opacity: 0.4, textDecoration: 'line-through' } : undefined}
              onClick={() => onToggleLead(side, m.monId)}
              title={
                st === 'lead' ? `lead (${pos === 0 ? 'left' : 'right'})`
                  : st === 'brought' ? 'brought (switched in)'
                    : st === 'not' ? 'deduced NOT brought'
                      : 'not yet seen'
              }
            >
              {m.parsed.species}
              {isLead ? ` ◀${pos === 0 ? 'L' : 'R'}` : st === 'brought' ? ' ✓' : st === 'not' ? ' ✗' : ''}
            </button>
          );
        })}
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Brought {info.brought.length}/{BRING_COUNT}
        {info.confirmed
          ? ` — bring confirmed; ${info.notBrought.length} deduced not brought`
          : info.unknown.length
            ? ` — ${info.unknown.length} still unseen (possibly brought)`
            : ''}
      </div>
    </div>
  );
}
