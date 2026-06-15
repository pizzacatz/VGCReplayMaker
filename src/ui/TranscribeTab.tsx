import { useMemo, useState } from 'react';
import type { MatchEvent } from '../log';
import type { ReplayState } from '../replay';
import {
  activeMonIds,
  benchMons,
  currentBoard,
  megaFormeFromItem,
  monLabel,
  moveCanFlinch,
  nextEventId,
  planTargets,
  slotOfMon,
  slotPosition,
  type MonEntry,
  type Workspace,
} from './model';
import { AdvancedEvents } from './AdvancedEvents';
import { MatchSetup } from './MatchSetup';

type Mode = 'idle' | 'move' | 'switch';
type Cert = 'clean' | 'composite' | 'unresolved';

/** Per-target outcome of the selected move (spread moves crit/flinch/miss individually). */
interface TargetOutcome {
  hpAfter: string;
  crit: boolean;
  flinch: boolean;
  eff: string;
  missed: boolean;
  status: Cert;
}
const blankOutcome = (): TargetOutcome => ({ hpAfter: '', crit: false, flinch: false, eff: '1x', missed: false, status: 'clean' });

export function TranscribeTab({ ws, setWs }: { ws: Workspace; setWs: (w: Workspace) => void }) {
  const board = useMemo(() => currentBoard(ws), [ws]);
  const [actor, setActor] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [move, setMove] = useState<string | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, TargetOutcome>>({});
  const [showAdvanced, setShowAdvanced] = useState(false);

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

  const pickActor = (monId: string) => {
    setActor(monId);
    setMode('move');
    setMove(null);
    setTargets([]);
    setOutcomes({});
  };

  const plan = move && actor ? planTargets(move, actor, board) : null;

  const pickMove = (m: string) => {
    setMove(m);
    const p = planTargets(m, actor!, board);
    const ts = p.spread ? p.candidates : p.candidates.slice(0, 1);
    setTargets(ts);
    setOutcomes(Object.fromEntries(ts.map((t) => [t, blankOutcome()])));
  };

  const setOutcome = (t: string, patch: Partial<TargetOutcome>) =>
    setOutcomes((o) => ({ ...o, [t]: { ...(o[t] ?? blankOutcome()), ...patch } }));

  const toggleTarget = (t: string) => {
    if (plan?.spread) return;
    if (targets.includes(t)) {
      setTargets(targets.filter((x) => x !== t));
    } else {
      setTargets([...targets, t]);
      if (!outcomes[t]) setOutcome(t, {});
    }
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
      for (const t of targets) {
        const o = outcomes[t] ?? blankOutcome();
        if (o.missed) {
          builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'random_outcome', mon: t, eventKind: 'miss', outcome: 'yes' }));
          continue;
        }
        if (o.hpAfter === '') continue;
        const slot = slotOfMon(board, t);
        const before = slot ? board.slots[slot]!.hp : 0;
        const after = Number(o.hpAfter);
        builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'damage', attacker: actor, move, defender: t, hpBefore: before, hpAfter: after, crit: o.crit, status: o.status, observedEffectiveness: o.eff }));
        if (canFlinch && o.flinch) {
          builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'random_outcome', mon: t, eventKind: 'flinch', outcome: 'yes' }));
        }
      }
    }
    emit(builders);
    reset();
  };

  const doSwitch = (incoming: string) => {
    const slot = slotOfMon(board, actor!);
    if (!slot) return;
    const { side, position } = slotPosition(slot);
    emit([(seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'switch', side, position, in: incoming })]);
    reset();
  };

  const doMega = () => {
    if (!actor || !megaForme) return;
    emit([(seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'mega_evolution', mon: actor, megaSpecies: megaForme })]);
    reset();
  };

  return (
    <div className="row">
      <div className="col panel">
        <MatchSetup ws={ws} setWs={setWs} startOpen={ws.events.length === 0} />

        <div className="controls">
          <strong>Turn {currentTurn}</strong>
          <button onClick={newTurn}>▶ New turn</button>
          <span className="muted">Click the acting Pokémon, then its move.</span>
        </div>

        <Board actives={actives} actor={actor} onPick={pickActor} />

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
                  return (
                    <div className="panel" key={t} style={{ marginTop: 8 }}>
                      <strong>{monLabel(ws, t)}</strong>
                      <div className="controls" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                        <label className="chip"><input type="checkbox" checked={o.missed} onChange={(e) => setOutcome(t, { missed: e.target.checked })} /> missed</label>
                        {!o.missed && (
                          <>
                            <span className="muted">{before} →</span>
                            <input type="number" placeholder="hp after" value={o.hpAfter} onChange={(e) => setOutcome(t, { hpAfter: e.target.value })} style={{ width: 90 }} />
                            <span className="muted">{o.hpAfter !== '' ? `= ${before - Number(o.hpAfter)} dmg` : ''}</span>
                            <label className="chip"><input type="checkbox" checked={o.crit} onChange={(e) => setOutcome(t, { crit: e.target.checked })} /> crit</label>
                            {canFlinch && <label className="chip"><input type="checkbox" checked={o.flinch} onChange={(e) => setOutcome(t, { flinch: e.target.checked })} /> flinched</label>}
                            <select value={o.eff} onChange={(e) => setOutcome(t, { eff: e.target.value })}>{['0.25x', '0.5x', '1x', '2x', '4x'].map((x) => <option key={x}>{x}</option>)}</select>
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
        {[...ws.events].sort((a, b) => a.seq - b.seq).map((e) => (
          <div key={e.eventId} className="event">
            <span className="seq">{e.seq}</span>
            <span>{describe(e, (id) => monLabel(ws, id))}</span>
            <span className="x" onClick={() => setWs({ ...ws, events: ws.events.filter((x) => x.eventId !== e.eventId) })}>✕</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Board({ actives, actor, onPick }: { actives: ReturnType<typeof activeMonIds>; actor: string | null; onPick: (id: string) => void }) {
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
      <div className="muted" style={{ fontSize: 12 }}>Opponent</div>
      <div className="board">{foes.length ? foes.map(card) : <span className="muted">no active mon — set leads above</span>}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>You</div>
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
    case 'switch': return `switch ${e.side}${e.position} → ${label(e.in)}`;
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
