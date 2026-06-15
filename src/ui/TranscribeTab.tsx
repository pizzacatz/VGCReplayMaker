import { useMemo, useState } from 'react';
import type { MatchEvent } from '../log';
import type { ReplayState } from '../replay';
import {
  activeMonIds,
  benchMons,
  currentBoard,
  endOfTurnEvents,
  entryEffectEvents,
  estimateDamage,
  megaFormeAbility,
  megaFormeFromItem,
  monAbility,
  monItem,
  monLabel,
  monMaxHp,
  moveCanFlinch,
  moveMakesContact,
  moveRecoilDrain,
  nextEventId,
  planTargets,
  protectionBlocking,
  slotOfMon,
  slotPosition,
  typeEffectiveness,
  type MonEntry,
  type Workspace,
} from './model';
import { AdvancedEvents } from './AdvancedEvents';
import { MatchSetup } from './MatchSetup';
import { EventEditor } from './EventEditor';

type Mode = 'idle' | 'move' | 'switch';
type Cert = 'clean' | 'composite' | 'unresolved';

/** Per-target outcome of the selected move (spread moves crit/flinch/miss individually). */
interface TargetOutcome {
  hpAfter: string;
  crit: boolean;
  flinch: boolean;
  missed: boolean;
  ko: boolean;
  status: Cert;
}
const blankOutcome = (): TargetOutcome => ({ hpAfter: '', crit: false, flinch: false, missed: false, ko: false, status: 'clean' });

export function TranscribeTab({ ws, setWs }: { ws: Workspace; setWs: (w: Workspace) => void }) {
  const board = useMemo(() => currentBoard(ws), [ws]);
  const [actor, setActor] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [move, setMove] = useState<string | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, TargetOutcome>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const currentTurn = useMemo(() => {
    const ts = ws.events.filter((e) => e.type === 'turn_start');
    return ts.length ? Math.max(...ts.map((e) => e.turn)) : 1;
  }, [ws.events]);

  if (ws.sideA.mons.length === 0 && ws.sideB.mons.length === 0) {
    return <div className="panel">Add teams first (Teams tab).</div>;
  }
  if (!board) {
    return (
      <div className="panel error">
        <p>The event log is inconsistent (a move/hit references an inactive mon, or the leads changed under existing events).</p>
        <div className="controls">
          <button onClick={() => setWs({ ...ws, events: ws.events.slice(0, -1) })}>Undo last event</button>
          <button onClick={() => setWs({ ...ws, events: [] })}>Clear all events</button>
        </div>
      </div>
    );
  }

  const allRoster: MonEntry[] = [...ws.sideA.mons, ...ws.sideB.mons];
  const entryOf = (monId: string) => allRoster.find((m) => m.monId === monId);
  const monMoves = (monId: string): string[] => entryOf(monId)?.parsed.moves ?? [];
  const actives = activeMonIds(board);

  const reset = () => {
    setActor(null);
    setMode('idle');
    setMove(null);
    setTargets([]);
    setOutcomes({});
  };

  const emit = (builders: Array<(seq: number, turn: number) => MatchEvent>) => {
    let seq = ws.events.length ? Math.max(...ws.events.map((e) => e.seq)) : 0;
    const evs = builders.map((b) => {
      seq += 1;
      return b(seq, currentTurn);
    });
    setWs({ ...ws, events: [...ws.events, ...evs] });
  };

  const newTurn = () => {
    const n = ws.events.filter((e) => e.type === 'turn_start').length + 1;
    emit([(seq) => ({ eventId: nextEventId(), seq, turn: n, type: 'turn_start' })]);
  };

  // Start of match: turn 1 + lead entry abilities (Intimidate, weather/terrain).
  const startMatch = () => {
    const builders: Array<(seq: number, turn: number) => MatchEvent> = [(seq) => ({ eventId: nextEventId(), seq, turn: 1, type: 'turn_start' })];
    for (const m of activeMonIds(board)) builders.push(...entryEffectEvents(ws, m.monId, monAbility(ws, m.monId), board, true));
    emit(builders);
  };

  const pickActor = (monId: string) => {
    setActor(monId);
    setMode('move');
    setMove(null);
    setTargets([]);
    setOutcomes({});
  };

  const plan = move && actor ? planTargets(move, actor, board) : null;

  // pre-fill HP-after from a calc estimate (blocked targets stay no-damage)
  const initialOutcome = (t: string, m: string, isDamaging: boolean): TargetOutcome => {
    const blocked = !!protectionBlocking(ws, t, m, currentTurn);
    let hpAfter = '';
    if (!blocked && isDamaging && actor) {
      const slot = slotOfMon(board, t);
      const before = slot ? board.slots[slot]!.hp : 0;
      const est = estimateDamage(ws, board, actor, t, m, false);
      if (est) hpAfter = String(Math.max(0, before - est.avg));
    }
    return { ...blankOutcome(), missed: blocked, hpAfter };
  };

  const pickMove = (m: string) => {
    setMove(m);
    const p = planTargets(m, actor!, board);
    const ts = p.spread ? p.candidates : p.candidates.slice(0, 1);
    setTargets(ts);
    setOutcomes(Object.fromEntries(ts.map((t) => [t, initialOutcome(t, m, p.isDamaging)])));
  };

  const setOutcome = (t: string, patch: Partial<TargetOutcome>) =>
    setOutcomes((o) => ({ ...o, [t]: { ...(o[t] ?? blankOutcome()), ...patch } }));

  const toggleTarget = (t: string) => {
    if (plan?.spread) return;
    // single-target moves allow exactly one target: select it (or deselect).
    if (targets.includes(t)) {
      setTargets([]);
    } else {
      setTargets([t]);
      setOutcomes({ [t]: outcomes[t] ?? (move ? initialOutcome(t, move, plan?.isDamaging ?? true) : blankOutcome()) });
    }
  };

  // effectiveness derived from the dex (move type vs the target's current types)
  const effOf = (targetMonId: string): ReturnType<typeof typeEffectiveness> =>
    move ? typeEffectiveness(move, actives.find((a) => a.monId === targetMonId)?.species ?? '') : null;

  const reorderEvents = (fromId: string, toId: string) => {
    const sorted = [...ws.events].sort((a, b) => a.seq - b.seq);
    const from = sorted.findIndex((e) => e.eventId === fromId);
    const to = sorted.findIndex((e) => e.eventId === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = sorted.splice(from, 1);
    sorted.splice(to, 0, moved!);
    setWs({ ...ws, events: sorted.map((e, i) => ({ ...e, seq: i + 1 })) });
  };

  const actorEntry = actor ? entryOf(actor) : undefined;
  const actorItem = actorEntry?.parsed.item;
  const actorAbility = actorEntry?.parsed.ability;
  const actorBase = actorEntry?.parsed.species;
  const actorBoardSpecies = actor ? actives.find((a) => a.monId === actor)?.species : undefined;
  const alreadyMega = (actorBoardSpecies ?? '').includes('-Mega');
  const megaForme = actorBase ? megaFormeFromItem(actorItem, actorBase) : null;
  const canFlinch = move ? moveCanFlinch(move, actorItem, actorAbility) : false;

  const confirmMove = () => {
    if (!actor || !move) return;
    const builders: Array<(seq: number, turn: number) => MatchEvent> = [
      (seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'move_used', user: actor, move, targets, isSpread: plan?.spread ?? false }),
    ];
    if (plan?.isDamaging) {
      const contact = moveMakesContact(move);
      const aMax = monMaxHp(ws, actor);
      let totalDamage = 0;
      let contactLoss = 0;
      for (const t of targets) {
        const o = outcomes[t] ?? blankOutcome();
        if (o.missed) {
          builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'random_outcome', mon: t, eventKind: 'miss', outcome: 'yes' }));
          continue;
        }
        const after = o.ko ? 0 : o.hpAfter === '' ? null : Number(o.hpAfter);
        if (after === null) continue;
        const slot = slotOfMon(board, t);
        const before = slot ? board.slots[slot]!.hp : 0;
        const dmg = before - after;
        totalDamage += dmg;
        const eff = effOf(t)?.label ?? '1x'; // derived from the type chart, not entered
        builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'damage', attacker: actor, move, defender: t, hpBefore: before, hpAfter: after, crit: o.crit, status: o.status, observedEffectiveness: eff }));
        if (o.ko) builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'faint', target: t }));
        if (canFlinch && o.flinch) builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'random_outcome', mon: t, eventKind: 'flinch', outcome: 'yes' }));
        // Sitrus Berry: heals the defender at ≤50% HP (alive)
        const dMax = monMaxHp(ws, t);
        if (!o.ko && after > 0 && dMax && monItem(ws, t) === 'Sitrus Berry' && after <= Math.floor(dMax / 2)) {
          const healed = Math.min(dMax, after + Math.floor(dMax / 4));
          builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'item_or_ability_event', mon: t, kind: 'enditem', name: 'Sitrus Berry' }));
          builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'heal', target: t, source: 'Sitrus Berry', hpBefore: after, hpAfter: healed }));
        }
        // Contact: Rocky Helmet / Rough Skin / Iron Barbs chip the attacker
        if (contact && dmg > 0 && aMax) {
          if (monItem(ws, t) === 'Rocky Helmet') contactLoss += Math.floor(aMax / 6);
          const dAbility = monAbility(ws, t);
          if (dAbility === 'Rough Skin' || dAbility === 'Iron Barbs') contactLoss += Math.floor(aMax / 8);
        }
      }
      // Attacker residuals, chained: contact → Life Orb → recoil (losses), drain (gain)
      const rd = moveRecoilDrain(move);
      const lifeOrb = monItem(ws, actor) === 'Life Orb' && totalDamage > 0 && aMax ? Math.floor(aMax / 10) : 0;
      const recoil = rd.recoil && totalDamage > 0 ? Math.floor((totalDamage * rd.recoil[0]) / rd.recoil[1]) : 0;
      const drain = rd.drain && totalDamage > 0 ? Math.floor((totalDamage * rd.drain[0]) / rd.drain[1]) : 0;
      const residuals: Array<{ source: string; delta: number; kind: 'passive_hp_change' | 'heal' }> = [];
      if (contactLoss > 0) residuals.push({ source: 'Contact', delta: -contactLoss, kind: 'passive_hp_change' });
      if (lifeOrb > 0) residuals.push({ source: 'Life Orb', delta: -lifeOrb, kind: 'passive_hp_change' });
      if (recoil > 0) residuals.push({ source: 'Recoil', delta: -recoil, kind: 'passive_hp_change' });
      if (drain > 0) residuals.push({ source: 'Drain', delta: drain, kind: 'heal' });
      const aSlot = slotOfMon(board, actor);
      let aHp = aSlot ? board.slots[aSlot]!.hp : 0;
      const cap = aMax || aHp + 9999;
      for (const r of residuals) {
        const hpBefore = aHp;
        aHp = Math.max(0, Math.min(cap, aHp + r.delta));
        const target = actor;
        builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: r.kind, target, source: r.source, hpBefore, hpAfter: aHp }));
      }
    }
    emit(builders);
    reset();
  };

  const doSwitch = (incoming: string) => {
    const slot = slotOfMon(board, actor!);
    if (!slot || !actor) return;
    const { side, position } = slotPosition(slot);
    const builders: Array<(seq: number, turn: number) => MatchEvent> = [
      (seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'switch', side, position, out: actor, in: incoming }),
    ];
    builders.push(...entryEffectEvents(ws, incoming, monAbility(ws, incoming), board, true)); // Intimidate / weather on entry
    emit(builders);
    reset();
  };

  const doMega = () => {
    if (!actor || !megaForme) return;
    const builders: Array<(seq: number, turn: number) => MatchEvent> = [
      (seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'mega_evolution', mon: actor, megaSpecies: megaForme }),
    ];
    builders.push(...entryEffectEvents(ws, actor, megaFormeAbility(megaForme), board, false)); // e.g. Mega Char Y → Drought (no Intimidate)
    emit(builders);
    reset();
  };

  return (
    <div className="row">
      <div className="col panel">
        <MatchSetup ws={ws} setWs={setWs} startOpen={ws.events.length === 0} />

        <div className="controls">
          <strong>Turn {currentTurn}</strong>
          {ws.events.length === 0 ? (
            <button className="primary" onClick={startMatch}>▶ Start match (applies lead abilities)</button>
          ) : (
            <>
              <button onClick={() => emit(endOfTurnEvents(ws, board))}>⤓ End of turn (residuals)</button>
              <button onClick={newTurn}>▶ New turn</button>
            </>
          )}
          <span className="muted">Damage, recoil, Intimidate, weather, items auto-fill — adjust HP to the screen.</span>
        </div>

        <Board actives={actives} actor={actor} onPick={pickActor} youName={ws.sideA.player} oppName={ws.sideB.player} />

        {actor && (
          <div className="panel" style={{ marginTop: 12, background: 'var(--panel2)' }}>
            <div className="controls" style={{ marginTop: 0 }}>
              <strong>{monLabel(ws, actor)}{alreadyMega ? ' (Mega)' : ''}</strong>
              <button onClick={reset}>cancel</button>
            </div>

            {mode === 'move' && !move && (
              <>
                <div className="grid">
                  {monMoves(actor).map((m) => (
                    <button key={m} onClick={() => pickMove(m)}>{m}</button>
                  ))}
                </div>
                <div className="controls">
                  <button onClick={() => setMode('switch')}>Switch out ↔</button>
                  {megaForme && !alreadyMega && (
                    <button onClick={doMega} title={`held stone → ${megaForme}`}>Mega Evolve ✦</button>
                  )}
                </div>
              </>
            )}

            {mode === 'move' && move && plan && (
              <div>
                <div className="controls" style={{ marginTop: 0 }}>
                  <strong>{move}</strong>
                  <span className="muted">{plan.spread ? 'spread' : plan.scope} · {plan.isDamaging ? 'damaging' : 'status'}</span>
                  <button onClick={() => { setMove(null); setTargets([]); }}>change move</button>
                </div>

                {plan.scope !== 'field' && (
                  <>
                    <div className="muted" style={{ fontSize: 12 }}>Targets (foes first){plan.spread ? ' — spread, all selected' : ''}:</div>
                    <div className="chips">
                      {plan.candidates.map((t) => (
                        <button key={t} className={targets.includes(t) ? 'primary' : ''} onClick={() => toggleTarget(t)}>
                          {monLabel(ws, t)}
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {plan.isDamaging && targets.map((t) => {
                  const slot = slotOfMon(board, t);
                  const before = slot ? board.slots[slot]!.hp : 0;
                  const o = outcomes[t] ?? blankOutcome();
                  const eff = effOf(t);
                  const blocked = move ? protectionBlocking(ws, t, move, currentTurn) : null;
                  return (
                    <div className="panel" key={t} style={{ marginTop: 8 }}>
                      <strong>{monLabel(ws, t)}</strong>
                      {eff && (
                        <span className="chip" style={{ marginLeft: 8, color: eff.mult > 1 ? 'var(--good)' : eff.mult < 1 ? 'var(--warn)' : 'var(--muted)' }}>
                          {eff.text}
                        </span>
                      )}
                      {blocked && <span className="chip" style={{ marginLeft: 6, color: 'var(--accent)' }}>🛡 blocked by {blocked}</span>}
                      <div className="controls" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                        <label className="chip"><input type="checkbox" checked={o.missed} onChange={(e) => setOutcome(t, { missed: e.target.checked })} /> {blocked ? 'blocked (no damage)' : 'missed'}</label>
                        {!o.missed && (
                          <>
                            <span className="muted">{before} →</span>
                            <input type="number" placeholder="hp after" value={o.ko ? 0 : o.hpAfter} disabled={o.ko} onChange={(e) => setOutcome(t, { hpAfter: e.target.value })} style={{ width: 90 }} />
                            <span className="muted">{o.ko ? `= ${before} dmg (KO)` : o.hpAfter !== '' ? `= ${before - Number(o.hpAfter)} dmg (est — adjust)` : ''}</span>
                            <label className="chip" style={{ color: o.ko ? 'var(--bad)' : undefined }}><input type="checkbox" checked={o.ko} onChange={(e) => setOutcome(t, { ko: e.target.checked })} /> KO</label>
                            <label className="chip"><input type="checkbox" checked={o.crit} onChange={(e) => setOutcome(t, { crit: e.target.checked })} /> crit</label>
                            {canFlinch && <label className="chip"><input type="checkbox" checked={o.flinch} onChange={(e) => setOutcome(t, { flinch: e.target.checked })} /> flinched</label>}
                            <select value={o.status} onChange={(e) => setOutcome(t, { status: e.target.value as Cert })}>
                              <option value="clean">clean</option>
                              <option value="composite">composite</option>
                              <option value="unresolved">unresolved</option>
                            </select>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}

                <ReconstructedPanel attacker={actor} state={board} />

                <div style={{ marginTop: 8 }}>
                  <button className="primary" onClick={confirmMove}>Log action</button>
                </div>
              </div>
            )}

            {mode === 'switch' && (() => {
              const actorSlot = slotOfMon(board, actor);
              if (!actorSlot) return <div className="muted">This Pokémon isn’t active, so it can’t switch.</div>;
              const bench = benchMons(ws, slotPosition(actorSlot).side, board);
              return (
                <div>
                  <div className="muted" style={{ fontSize: 12 }}>Bring in:</div>
                  <div className="chips">
                    {bench.length === 0 && <span className="muted">no bench mon available</span>}
                    {bench.map((m) => <button key={m.monId} onClick={() => doSwitch(m.monId)}>{m.parsed.species}</button>)}
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <button onClick={() => setShowAdvanced(!showAdvanced)}>{showAdvanced ? '▾' : '▸'} Other events (status, field, heal, faint…)</button>
          {showAdvanced && <AdvancedEvents ws={ws} setWs={setWs} currentTurn={currentTurn} />}
        </div>
      </div>

      <div className="col panel">
        <h2>Event log ({ws.events.length})</h2>
        {ws.events.length === 0 && <p className="muted">No events yet. Set your leads above, then click a Pokémon to start.</p>}
        {ws.events.length > 0 && <p className="muted" style={{ fontSize: 11 }}>drag ⠿ to reorder · click ✎ to edit</p>}
        {[...ws.events].sort((a, b) => a.seq - b.seq).map((e) =>
          editId === e.eventId ? (
            <EventEditor
              key={e.eventId}
              ws={ws}
              event={e}
              onCancel={() => setEditId(null)}
              onSave={(updated) => {
                setWs({ ...ws, events: ws.events.map((x) => (x.eventId === updated.eventId ? updated : x)) });
                setEditId(null);
              }}
            />
          ) : (
            <div
              key={e.eventId}
              className="event"
              draggable
              onDragStart={(ev) => ev.dataTransfer.setData('text/plain', e.eventId)}
              onDragOver={(ev) => ev.preventDefault()}
              onDrop={(ev) => {
                ev.preventDefault();
                const fromId = ev.dataTransfer.getData('text/plain');
                if (fromId) reorderEvents(fromId, e.eventId);
              }}
            >
              <span className="drag" title="drag to reorder" style={{ cursor: 'grab', color: 'var(--muted)' }}>⠿</span>
              <span className="seq">{e.seq}</span>
              <span>{describe(e, (id) => monLabel(ws, id))}</span>
              <span className="x" title="edit" style={{ marginLeft: 'auto', color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setEditId(e.eventId)}>✎</span>
              <span className="x" title="delete" onClick={() => setWs({ ...ws, events: ws.events.filter((x) => x.eventId !== e.eventId) })}>✕</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function Board({ actives, actor, onPick, youName, oppName }: { actives: ReturnType<typeof activeMonIds>; actor: string | null; onPick: (id: string) => void; youName: string; oppName: string }) {
  const foes = actives.filter((m) => m.side === 'B');
  const you = actives.filter((m) => m.side === 'A');
  const card = (m: ReturnType<typeof activeMonIds>[number]) => (
    <button
      key={m.monId}
      className="slot"
      style={{ textAlign: 'left', borderColor: actor === m.monId ? 'var(--accent)' : undefined, opacity: m.fainted ? 0.4 : 1 }}
      disabled={m.fainted}
      onClick={() => onPick(m.monId)}
    >
      <strong>{m.species}</strong>
      <div className="muted" style={{ fontSize: 12 }}>{`${m.hp}/${m.maxHp} HP${m.fainted ? ' · fainted' : ''}`}</div>
    </button>
  );
  return (
    <>
      <div className="muted" style={{ fontSize: 12 }}>{oppName}</div>
      <div className="board">{foes.length ? foes.map(card) : <span className="muted">no active mon — set leads above</span>}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{youName}</div>
      <div className="board">{you.length ? you.map(card) : <span className="muted">no active mon — set leads above</span>}</div>
    </>
  );
}

function ReconstructedPanel({ attacker, state }: { attacker: string; state: ReplayState }) {
  const chips: string[] = [];
  if (state.weather) chips.push(`weather: ${state.weather}`);
  for (const c of state.field) chips.push(c);
  const ab = state.boosts[attacker];
  if (ab) for (const [s, n] of Object.entries(ab)) if (n) chips.push(`atk ${s} ${n > 0 ? '+' : ''}${n}`);
  if (state.status[attacker]) chips.push(`atk ${state.status[attacker]}`);
  if (chips.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="muted" style={{ fontSize: 11 }}>Engine will apply (confirm vs. video):</div>
      <div className="chips">{chips.map((c, i) => <span key={i} className="chip">{c}</span>)}</div>
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
    case 'switch': return e.out ? `${label(e.out)} → ${label(e.in)} (switch)` : `${label(e.in)} switched in (${e.side} ${e.position === 0 ? 'left' : 'right'})`;
    case 'faint': return `${label(e.target)} fainted`;
    case 'status_applied': return `${label(e.target)} → ${e.status}`;
    case 'status_cured': return `${label(e.target)} cured ${e.status}`;
    case 'stat_stage_change': return `${label(e.target)} ${e.stat} ${e.stages > 0 ? '+' : ''}${e.stages}`;
    case 'field_change': return `${e.field} ${e.action}${e.side ? ` [${e.side}]` : ''}`;
    case 'item_or_ability_event': return `${label(e.mon)} ${e.kind} ${e.name}`;
    case 'mega_evolution': return `${label(e.mon)} Mega-Evolved → ${e.megaSpecies}`;
    case 'random_outcome': return e.eventKind === 'flinch' ? `${label(e.mon)} flinched` : e.eventKind === 'miss' ? `${label(e.mon)} was missed` : `${label(e.mon)} ${e.eventKind}: ${e.outcome}`;
  }
}
