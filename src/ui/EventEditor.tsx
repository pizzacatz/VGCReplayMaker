import { useState } from 'react';
import type { MatchEvent, Position, Side } from '../log';
import { allMons, type Workspace } from './model';

/** Inline editor for a single logged event — edit its fields in place. */
export function EventEditor({
  ws,
  event,
  onSave,
  onCancel,
}: {
  ws: Workspace;
  event: MatchEvent;
  onSave: (e: MatchEvent) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<MatchEvent>(event);
  const patch = (p: Partial<MatchEvent>) => setDraft({ ...draft, ...p } as MatchEvent);
  const mons = allMons(ws);

  const monSel = (value: string, onChange: (v: string) => void, label: string) => (
    <div className="field"><label>{label}</label>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {mons.map((m) => <option key={m.monId} value={m.monId}>{m.side}: {m.parsed.species}</option>)}
      </select>
    </div>
  );
  const numField = (label: string, value: number, onChange: (n: number) => void) => (
    <div className="field"><label>{label}</label><input aria-label={label} type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} /></div>
  );
  const txtField = (label: string, value: string, onChange: (v: string) => void) => (
    <div className="field"><label>{label}</label><input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} /></div>
  );

  const d = draft;
  return (
    <div className="panel" style={{ background: 'var(--panel2)', margin: '4px 0' }}>
      <div className="muted" style={{ fontSize: 11 }}>editing #{d.seq} · {d.type}</div>

      {d.type === 'turn_start' && numField('Turn', d.turn, (turn) => patch({ turn }))}

      {d.type === 'move_used' && (<>
        {monSel(d.user, (user) => patch({ user }), 'User')}
        {txtField('Move', d.move, (move) => patch({ move }))}
        <label className="chip"><input type="checkbox" checked={!!d.isSpread} onChange={(e) => patch({ isSpread: e.target.checked })} /> spread</label>
      </>)}

      {d.type === 'damage' && (<>
        {monSel(d.attacker, (attacker) => patch({ attacker }), 'Attacker')}
        {txtField('Move', d.move, (move) => patch({ move }))}
        {monSel(d.defender, (defender) => patch({ defender }), 'Defender')}
        {numField('HP before', d.hpBefore, (hpBefore) => patch({ hpBefore }))}
        {numField('HP after', d.hpAfter, (hpAfter) => patch({ hpAfter }))}
        <div className="controls" style={{ flexWrap: 'wrap' }}>
          <label className="chip"><input type="checkbox" checked={d.crit} onChange={(e) => patch({ crit: e.target.checked })} /> crit</label>
          <select value={d.status} onChange={(e) => patch({ status: e.target.value as 'clean' | 'composite' | 'unresolved' })}>
            <option value="clean">clean</option><option value="composite">composite</option><option value="unresolved">unresolved</option>
          </select>
          <select value={d.observedEffectiveness ?? '1x'} onChange={(e) => patch({ observedEffectiveness: e.target.value })}>
            {['0.25x', '0.5x', '1x', '2x', '4x'].map((x) => <option key={x}>{x}</option>)}
          </select>
        </div>
      </>)}

      {(d.type === 'heal' || d.type === 'passive_hp_change') && (<>
        {monSel(d.target, (target) => patch({ target }), 'Target')}
        {txtField('Source', d.source, (source) => patch({ source }))}
        {numField('HP before', d.hpBefore, (hpBefore) => patch({ hpBefore }))}
        {numField('HP after', d.hpAfter, (hpAfter) => patch({ hpAfter }))}
      </>)}

      {d.type === 'switch' && (<>
        <div className="field"><label>Side / pos</label>
          <select value={d.side} onChange={(e) => patch({ side: e.target.value as Side })}><option>A</option><option>B</option></select>
          <select value={d.position} onChange={(e) => patch({ position: Number(e.target.value) as Position })}><option value={0}>left</option><option value={1}>right</option></select>
        </div>
        {monSel(d.in, (v) => patch({ in: v }), 'Switch in')}
      </>)}

      {d.type === 'faint' && monSel(d.target, (target) => patch({ target }), 'Target')}

      {(d.type === 'status_applied' || d.type === 'status_cured') && (<>
        {monSel(d.target, (target) => patch({ target }), 'Target')}
        <div className="field"><label>Status</label><select value={d.status} onChange={(e) => patch({ status: e.target.value })}>{['brn', 'par', 'psn', 'tox', 'slp', 'frz'].map((s) => <option key={s}>{s}</option>)}</select></div>
      </>)}

      {d.type === 'stat_stage_change' && (<>
        {monSel(d.target, (target) => patch({ target }), 'Target')}
        <div className="field"><label>Stat</label><select value={d.stat} onChange={(e) => patch({ stat: e.target.value })}>{['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'].map((s) => <option key={s}>{s}</option>)}</select></div>
        {numField('Stages', d.stages, (stages) => patch({ stages }))}
      </>)}

      {d.type === 'field_change' && (<>
        {txtField('Field', d.field, (field) => patch({ field }))}
        <div className="field"><label>Action</label><select value={d.action} onChange={(e) => patch({ action: e.target.value as 'set' | 'end' })}><option>set</option><option>end</option></select></div>
        <div className="field"><label>Side</label><select value={d.side ?? ''} onChange={(e) => {
          const v = e.target.value;
          if (v === 'A' || v === 'B') patch({ side: v });
          else { const copy = { ...d }; delete copy.side; setDraft(copy); }
        }}><option value="">field-wide</option><option value="A">A</option><option value="B">B</option></select></div>
      </>)}

      {d.type === 'mega_evolution' && (<>
        {monSel(d.mon, (mon) => patch({ mon }), 'Mon')}
        {txtField('Mega forme', d.megaSpecies, (megaSpecies) => patch({ megaSpecies }))}
      </>)}

      {d.type === 'item_or_ability_event' && (<>
        {monSel(d.mon, (mon) => patch({ mon }), 'Mon')}
        {txtField('Name', d.name, (name) => patch({ name }))}
      </>)}

      {d.type === 'random_outcome' && (<>
        {monSel(d.mon, (mon) => patch({ mon }), 'Mon')}
        {txtField('Kind', d.eventKind, (eventKind) => patch({ eventKind }))}
        {txtField('Outcome', d.outcome, (outcome) => patch({ outcome }))}
      </>)}

      <div className="controls">
        <button className="primary" onClick={() => onSave(draft)}>Save</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
