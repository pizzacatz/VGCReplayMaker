import { useMemo, useState } from 'react';
import type { MatchEvent } from '../log';
import { ReplayPlayer, toProtocol } from '../replay';
import { allMons, buildLog, monLabel, nextEventId, type Workspace } from './model';

type NewEvent = {
  type: MatchEvent['type'];
  user: string;
  move: string;
  attacker: string;
  defender: string;
  target: string;
  hpBefore: number;
  hpAfter: number;
  crit: boolean;
  status: 'clean' | 'composite' | 'unresolved';
  effectiveness: string;
  field: string;
  action: 'set' | 'end';
  side: 'A' | 'B';
  statusName: string;
  stat: string;
  stages: number;
  source: string;
  position: 0 | 1;
  isSpread: boolean;
};

const blank = (): NewEvent => ({
  type: 'damage', user: '', move: '', attacker: '', defender: '', target: '', hpBefore: 0, hpAfter: 0,
  crit: false, status: 'clean', effectiveness: '1x', field: 'Sun', action: 'set', side: 'A', statusName: 'brn',
  stat: 'atk', stages: 1, source: '', position: 0, isSpread: false,
});

const EVENT_TYPES: Array<[MatchEvent['type'], string]> = [
  ['turn_start', 'Turn start'],
  ['move_used', 'Move used'],
  ['damage', 'Damage'],
  ['heal', 'Heal'],
  ['passive_hp_change', 'Passive HP change'],
  ['switch', 'Switch'],
  ['faint', 'Faint'],
  ['status_applied', 'Status applied'],
  ['status_cured', 'Status cured'],
  ['stat_stage_change', 'Stat stage change'],
  ['field_change', 'Field change'],
];

export function TranscribeTab({ ws, setWs }: { ws: Workspace; setWs: (w: Workspace) => void }) {
  const [f, setF] = useState<NewEvent>(blank);
  const mons = allMons(ws);
  const set = (patch: Partial<NewEvent>) => setF({ ...f, ...patch });

  const nextSeq = ws.events.length ? Math.max(...ws.events.map((e) => e.seq)) + 1 : 1;
  const currentTurn = useMemo(() => {
    const turns = ws.events.filter((e) => e.type === 'turn_start');
    return turns.length ? Math.max(...turns.map((e) => e.turn)) : 1;
  }, [ws.events]);

  // Reconstructed state the next event will see (Schema v2 §6.3 confirmation).
  const reconstructed = useMemo(() => {
    try {
      const player = new ReplayPlayer(toProtocol(buildLog(ws)));
      return player.stateAt(player.length - 1);
    } catch {
      return null;
    }
  }, [ws]);

  const moveOptions = (monId: string): string[] => mons.find((m) => m.monId === monId)?.parsed.moves ?? [];

  const addEvent = () => {
    const base = { eventId: nextEventId(), seq: nextSeq, turn: f.type === 'turn_start' ? currentTurn + (ws.events.length ? 1 : 0) || 1 : currentTurn };
    let ev: MatchEvent | null = null;
    switch (f.type) {
      case 'turn_start': ev = { ...base, turn: (ws.events.filter((e) => e.type === 'turn_start').length || 0) + 1, type: 'turn_start' }; break;
      case 'move_used': if (f.user) ev = { ...base, type: 'move_used', user: f.user, move: f.move, targets: f.target ? [f.target] : [], isSpread: f.isSpread }; break;
      case 'damage': if (f.attacker && f.defender) ev = { ...base, type: 'damage', attacker: f.attacker, move: f.move, defender: f.defender, hpBefore: f.hpBefore, hpAfter: f.hpAfter, crit: f.crit, status: f.status, observedEffectiveness: f.effectiveness }; break;
      case 'heal': if (f.target) ev = { ...base, type: 'heal', target: f.target, source: f.source, hpBefore: f.hpBefore, hpAfter: f.hpAfter }; break;
      case 'passive_hp_change': if (f.target) ev = { ...base, type: 'passive_hp_change', target: f.target, source: f.source, hpBefore: f.hpBefore, hpAfter: f.hpAfter }; break;
      case 'switch': if (f.target) ev = { ...base, type: 'switch', side: f.side, position: f.position, in: f.target }; break;
      case 'faint': if (f.target) ev = { ...base, type: 'faint', target: f.target }; break;
      case 'status_applied': if (f.target) ev = { ...base, type: 'status_applied', target: f.target, status: f.statusName }; break;
      case 'status_cured': if (f.target) ev = { ...base, type: 'status_cured', target: f.target, status: f.statusName }; break;
      case 'stat_stage_change': if (f.target) ev = { ...base, type: 'stat_stage_change', target: f.target, stat: f.stat, stages: f.stages, source: f.source }; break;
      case 'field_change': ev = { ...base, type: 'field_change', field: f.field, action: f.action, ...(f.side ? { side: f.side } : {}) }; break;
      default: break;
    }
    if (ev) setWs({ ...ws, events: [...ws.events, ev] });
  };

  const remove = (eventId: string) => setWs({ ...ws, events: ws.events.filter((e) => e.eventId !== eventId) });

  const monSelect = (value: string, onChange: (v: string) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— mon —</option>
      {mons.map((m) => (
        <option key={m.monId} value={m.monId}>
          {m.side}: {m.parsed.species}
        </option>
      ))}
    </select>
  );

  if (mons.length === 0) return <div className="panel">Add teams first (Teams tab).</div>;

  return (
    <div className="row">
      <div className="col panel">
        <h2>Add event · seq {nextSeq} · turn {currentTurn}</h2>
        <div className="field">
          <label>Type</label>
          <select value={f.type} onChange={(e) => set({ type: e.target.value as MatchEvent['type'] })}>
            {EVENT_TYPES.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </div>

        {f.type === 'move_used' && (
          <>
            <div className="field"><label>User</label>{monSelect(f.user, (v) => set({ user: v, move: moveOptions(v)[0] ?? '' }))}</div>
            <div className="field"><label>Move</label>
              <select value={f.move} onChange={(e) => set({ move: e.target.value })}>
                {moveOptions(f.user).map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div className="field"><label>Target</label>{monSelect(f.target, (v) => set({ target: v }))}</div>
            <div className="field"><label>Spread move</label><input type="checkbox" checked={f.isSpread} onChange={(e) => set({ isSpread: e.target.checked })} /></div>
          </>
        )}

        {f.type === 'damage' && (
          <>
            <div className="field"><label>Attacker</label>{monSelect(f.attacker, (v) => set({ attacker: v, move: moveOptions(v)[0] ?? '' }))}</div>
            <div className="field"><label>Move</label>
              <select value={f.move} onChange={(e) => set({ move: e.target.value })}>
                {moveOptions(f.attacker).map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
            <div className="field"><label>Defender</label>{monSelect(f.defender, (v) => set({ defender: v }))}</div>
            <div className="field"><label>HP before → after</label>
              <input type="number" value={f.hpBefore} onChange={(e) => set({ hpBefore: Number(e.target.value) })} />
              <input type="number" value={f.hpAfter} onChange={(e) => set({ hpAfter: Number(e.target.value) })} />
              <span className="muted">= {f.hpBefore - f.hpAfter} dmg</span>
            </div>
            <div className="field"><label>Crit</label><input type="checkbox" checked={f.crit} onChange={(e) => set({ crit: e.target.checked })} /></div>
            <div className="field"><label>Effectiveness</label>
              <select value={f.effectiveness} onChange={(e) => set({ effectiveness: e.target.value })}>
                {['0.25x', '0.5x', '1x', '2x', '4x'].map((x) => <option key={x}>{x}</option>)}
              </select>
            </div>
            <div className="field"><label>Source certainty</label>
              <select value={f.status} onChange={(e) => set({ status: e.target.value as NewEvent['status'] })}>
                <option value="clean">clean (one known attacker → solver-usable)</option>
                <option value="composite">composite (combined sources → ignored by solver)</option>
                <option value="unresolved">unresolved (reclassify later)</option>
              </select>
            </div>
            <ReconstructedPanel ws={ws} attacker={f.attacker} defender={f.defender} state={reconstructed} />
          </>
        )}

        {(f.type === 'heal' || f.type === 'passive_hp_change') && (
          <>
            <div className="field"><label>Target</label>{monSelect(f.target, (v) => set({ target: v }))}</div>
            <div className="field"><label>Source</label><input value={f.source} onChange={(e) => set({ source: e.target.value })} placeholder="e.g. Grassy Terrain" /></div>
            <div className="field"><label>HP before → after</label>
              <input type="number" value={f.hpBefore} onChange={(e) => set({ hpBefore: Number(e.target.value) })} />
              <input type="number" value={f.hpAfter} onChange={(e) => set({ hpAfter: Number(e.target.value) })} />
            </div>
          </>
        )}

        {f.type === 'switch' && (
          <>
            <div className="field"><label>Side / position</label>
              <select value={f.side} onChange={(e) => set({ side: e.target.value as 'A' | 'B' })}><option>A</option><option>B</option></select>
              <select value={f.position} onChange={(e) => set({ position: Number(e.target.value) as 0 | 1 })}><option value={0}>left</option><option value={1}>right</option></select>
            </div>
            <div className="field"><label>Switch in</label>{monSelect(f.target, (v) => set({ target: v }))}</div>
          </>
        )}

        {f.type === 'faint' && <div className="field"><label>Target</label>{monSelect(f.target, (v) => set({ target: v }))}</div>}

        {(f.type === 'status_applied' || f.type === 'status_cured') && (
          <>
            <div className="field"><label>Target</label>{monSelect(f.target, (v) => set({ target: v }))}</div>
            <div className="field"><label>Status</label>
              <select value={f.statusName} onChange={(e) => set({ statusName: e.target.value })}>
                {['brn', 'par', 'psn', 'tox', 'slp', 'frz'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
          </>
        )}

        {f.type === 'stat_stage_change' && (
          <>
            <div className="field"><label>Target</label>{monSelect(f.target, (v) => set({ target: v }))}</div>
            <div className="field"><label>Stat</label>
              <select value={f.stat} onChange={(e) => set({ stat: e.target.value })}>
                {['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="field"><label>Stages</label><input type="number" value={f.stages} onChange={(e) => set({ stages: Number(e.target.value) })} /></div>
            <div className="field"><label>Source</label><input value={f.source} onChange={(e) => set({ source: e.target.value })} placeholder="e.g. Swords Dance" /></div>
          </>
        )}

        {f.type === 'field_change' && (
          <>
            <div className="field"><label>Field</label><input value={f.field} onChange={(e) => set({ field: e.target.value })} placeholder="Sun / Grassy Terrain / Light Screen / Trick Room / Tailwind" /></div>
            <div className="field"><label>Action</label><select value={f.action} onChange={(e) => set({ action: e.target.value as 'set' | 'end' })}><option>set</option><option>end</option></select></div>
            <div className="field"><label>Side (screens/Tailwind)</label><select value={f.side} onChange={(e) => set({ side: e.target.value as 'A' | 'B' })}><option value="">— field-wide —</option><option>A</option><option>B</option></select></div>
          </>
        )}

        <button className="primary" onClick={addEvent} style={{ marginTop: 10 }}>Add event</button>
      </div>

      <div className="col panel">
        <h2>Event log ({ws.events.length})</h2>
        {ws.events.length === 0 && <p className="muted">No events yet.</p>}
        {[...ws.events].sort((a, b) => a.seq - b.seq).map((e) => (
          <div key={e.eventId} className="event">
            <span className="seq">{e.seq}</span>
            <span>{describe(e, (id) => monLabel(ws, id))}</span>
            <span className="x" onClick={() => remove(e.eventId)}>✕</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReconstructedPanel({
  ws,
  attacker,
  defender,
  state,
}: {
  ws: Workspace;
  attacker: string;
  defender: string;
  state: ReturnType<ReplayPlayer['stateAt']> | null;
}) {
  if (!state) return null;
  const chips: string[] = [];
  if (state.weather) chips.push(`weather: ${state.weather}`);
  for (const c of state.field) chips.push(c);
  const atkBoosts = state.boosts[attacker];
  if (atkBoosts) for (const [s, n] of Object.entries(atkBoosts)) if (n) chips.push(`attacker ${s} ${n > 0 ? '+' : ''}${n}`);
  const defSide = ws.sideA.mons.some((m) => m.monId === defender) ? 'A' : 'B';
  for (const c of state.sides[defSide]) chips.push(`def side: ${c}`);
  if (state.status[attacker]) chips.push(`attacker ${state.status[attacker]}`);
  return (
    <div className="panel" style={{ marginTop: 8, background: 'var(--panel2)' }}>
      <div className="muted" style={{ fontSize: 12 }}>Reconstructed context the engine will apply (confirm vs. video):</div>
      <div className="chips">{chips.length ? chips.map((c, i) => <span key={i} className="chip">{c}</span>) : <span className="chip">no active modifiers</span>}</div>
    </div>
  );
}

function describe(e: MatchEvent, label: (id: string) => string): string {
  switch (e.type) {
    case 'turn_start': return `── turn ${e.turn} ──`;
    case 'move_used': return `${label(e.user)} used ${e.move}${e.isSpread ? ' (spread)' : ''}`;
    case 'damage': return `${label(e.attacker)} ${e.move} → ${label(e.defender)}  ${e.hpBefore}→${e.hpAfter} [${e.status}]${e.crit ? ' CRIT' : ''}`;
    case 'heal': return `${label(e.target)} healed ${e.hpBefore}→${e.hpAfter} (${e.source})`;
    case 'passive_hp_change': return `${label(e.target)} chip ${e.hpBefore}→${e.hpAfter} (${e.source})`;
    case 'switch': return `switch ${e.side}${e.position} → ${label(e.in)}`;
    case 'faint': return `${label(e.target)} fainted`;
    case 'status_applied': return `${label(e.target)} → ${e.status}`;
    case 'status_cured': return `${label(e.target)} cured ${e.status}`;
    case 'stat_stage_change': return `${label(e.target)} ${e.stat} ${e.stages > 0 ? '+' : ''}${e.stages} (${e.source ?? ''})`;
    case 'field_change': return `${e.field} ${e.action}${e.side ? ` [${e.side}]` : ''}`;
    case 'item_or_ability_event': return `${label(e.mon)} ${e.kind} ${e.name}`;
    case 'random_outcome': return `${label(e.mon)} ${e.eventKind}: ${e.outcome}`;
  }
}
