import { useState } from 'react';
import type { MatchEvent } from '../log';
import { allMons, currentBoard, nextEventId, type Workspace } from './model';

type AdvType = 'status_applied' | 'status_cured' | 'stat_stage_change' | 'field_change' | 'heal' | 'passive_hp_change' | 'faint' | 'flinch' | 'paradox';

const LABELS: Array<[AdvType, string]> = [
  ['flinch', 'Flinch (reveals action order)'],
  ['stat_stage_change', 'Stat stage (boost/drop)'],
  ['paradox', 'Paradox boost (Protosynthesis/Quark Drive)'],
  ['field_change', 'Field (weather/terrain/screen)'],
  ['status_applied', 'Status applied'],
  ['status_cured', 'Status cured'],
  ['heal', 'Heal'],
  ['passive_hp_change', 'Passive HP change'],
  ['faint', 'Faint'],
];

export function AdvancedEvents({ ws, setWs, currentTurn }: { ws: Workspace; setWs: (w: Workspace) => void; currentTurn: number }) {
  const mons = allMons(ws);
  const board = currentBoard(ws);
  const [type, setType] = useState<AdvType>('stat_stage_change');
  const [mon, setMon] = useState('');
  const [statusName, setStatusName] = useState('brn');
  const [stat, setStat] = useState('atk');
  const [stages, setStages] = useState(1);
  const [source, setSource] = useState('');
  const [field, setField] = useState('Sun');
  const [action, setAction] = useState<'set' | 'end'>('set');
  const [side, setSide] = useState<'' | 'A' | 'B'>('');
  const [hpAfter, setHpAfter] = useState('');

  const hpBefore = mon && board ? board.slots[Object.keys(board.slots).find((k) => board.slots[k]?.monId === mon) ?? '']?.hp ?? 0 : 0;

  const add = () => {
    const seq = ws.events.length ? Math.max(...ws.events.map((e) => e.seq)) + 1 : 1;
    const base = { eventId: nextEventId(), seq, turn: currentTurn };
    let ev: MatchEvent | null = null;
    switch (type) {
      case 'status_applied': if (mon) ev = { ...base, type, target: mon, status: statusName }; break;
      case 'status_cured': if (mon) ev = { ...base, type, target: mon, status: statusName }; break;
      case 'stat_stage_change': if (mon) ev = { ...base, type, target: mon, stat, stages, source }; break;
      case 'field_change': ev = { ...base, type, field, action, ...(side ? { side } : {}) }; break;
      case 'heal': if (mon) ev = { ...base, type, target: mon, source, hpBefore, hpAfter: Number(hpAfter) }; break;
      case 'passive_hp_change': if (mon) ev = { ...base, type, target: mon, source, hpBefore, hpAfter: Number(hpAfter) }; break;
      case 'faint': if (mon) ev = { ...base, type, target: mon }; break;
      case 'flinch': if (mon) ev = { ...base, type: 'random_outcome', mon, eventKind: 'flinch', outcome: 'yes' }; break;
      case 'paradox': if (mon) ev = { ...base, type: 'item_or_ability_event', mon, kind: 'paradox', name: stat }; break; // boosts `stat` ×1.3 (×1.5 Spe)
    }
    if (ev) setWs({ ...ws, events: [...ws.events, ev] });
  };

  const monSelect = (
    <select value={mon} onChange={(e) => setMon(e.target.value)}>
      <option value="">— mon —</option>
      {mons.map((m) => <option key={m.monId} value={m.monId}>{m.side}: {m.parsed.species}</option>)}
    </select>
  );

  return (
    <div className="panel" style={{ marginTop: 8, background: 'var(--panel2)' }}>
      <div className="field">
        <label>Event</label>
        <select value={type} onChange={(e) => setType(e.target.value as AdvType)}>
          {LABELS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>

      {type === 'field_change' ? (
        <>
          <div className="field"><label>Field</label><input value={field} onChange={(e) => setField(e.target.value)} placeholder="Sun / Grassy Terrain / Light Screen / Trick Room / Tailwind" /></div>
          <div className="field"><label>Action</label><select value={action} onChange={(e) => setAction(e.target.value as 'set' | 'end')}><option>set</option><option>end</option></select></div>
          <div className="field"><label>Side</label><select value={side} onChange={(e) => setSide(e.target.value as '' | 'A' | 'B')}><option value="">field-wide</option><option value="A">A (you)</option><option value="B">B (opp)</option></select></div>
        </>
      ) : (
        <div className="field"><label>Mon</label>{monSelect}</div>
      )}

      {(type === 'status_applied' || type === 'status_cured') && (
        <div className="field"><label>Status</label>
          <select value={statusName} onChange={(e) => setStatusName(e.target.value)}>{['brn', 'par', 'psn', 'tox', 'slp', 'frz'].map((s) => <option key={s}>{s}</option>)}</select>
        </div>
      )}
      {type === 'paradox' && (
        <div className="field"><label>Boosted stat</label>
          <select value={stat} onChange={(e) => setStat(e.target.value)}>{['atk', 'def', 'spa', 'spd', 'spe'].map((s) => <option key={s}>{s}</option>)}</select>
          <span className="muted" style={{ fontSize: 11 }}>the stat the game announced (highest); ×1.3, or ×1.5 for Speed</span>
        </div>
      )}
      {type === 'stat_stage_change' && (
        <>
          <div className="field"><label>Stat</label><select value={stat} onChange={(e) => setStat(e.target.value)}>{['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'].map((s) => <option key={s}>{s}</option>)}</select></div>
          <div className="field"><label>Stages</label><input type="number" value={stages} onChange={(e) => setStages(Number(e.target.value))} /></div>
          <div className="field"><label>Source</label><input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Swords Dance, Intimidate" /></div>
        </>
      )}
      {(type === 'heal' || type === 'passive_hp_change') && (
        <>
          <div className="field"><label>Source</label><input value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. Leftovers, Sandstorm" /></div>
          <div className="field"><label>HP {hpBefore} →</label><input type="number" value={hpAfter} onChange={(e) => setHpAfter(e.target.value)} placeholder="hp after" /></div>
        </>
      )}

      <button onClick={add} style={{ marginTop: 6 }}>Add event</button>
    </div>
  );
}
