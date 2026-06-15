import { useMemo, useState } from 'react';
import type { MatchEvent } from '../log';
import type { ReplayState } from '../replay';
import {
  activeMonIds,
  benchMons,
  currentBoard,
  megaFormesFor,
  monLabel,
  nextEventId,
  planTargets,
  slotOfMon,
  slotPosition,
  type Workspace,
} from './model';
import { AdvancedEvents } from './AdvancedEvents';

type Mode = 'idle' | 'move' | 'switch' | 'mega';

export function TranscribeTab({ ws, setWs }: { ws: Workspace; setWs: (w: Workspace) => void }) {
  const board = useMemo(() => currentBoard(ws), [ws]);
  const [actor, setActor] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [move, setMove] = useState<string | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [hpAfter, setHpAfter] = useState<Record<string, string>>({});
  const [crit, setCrit] = useState(false);
  const [eff, setEff] = useState('1x');
  const [status, setStatus] = useState<'clean' | 'composite' | 'unresolved'>('clean');
  const [noDamage, setNoDamage] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const currentTurn = useMemo(() => {
    const ts = ws.events.filter((e) => e.type === 'turn_start');
    return ts.length ? Math.max(...ts.map((e) => e.turn)) : 1;
  }, [ws.events]);

  if (ws.sideA.mons.length === 0 && ws.sideB.mons.length === 0) {
    return <div className="panel">Add teams first (Teams tab).</div>;
  }
  if (!board) return <div className="panel error">The event log is inconsistent (a hit references an inactive mon). Remove the offending event.</div>;

  const monMoves = (monId: string): string[] => [...ws.sideA.mons, ...ws.sideB.mons].find((m) => m.monId === monId)?.parsed.moves ?? [];
  const actives = activeMonIds(board);
  const reset = () => {
    setActor(null);
    setMode('idle');
    setMove(null);
    setTargets([]);
    setHpAfter({});
    setCrit(false);
    setEff('1x');
    setStatus('clean');
    setNoDamage(false);
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
    setHpAfter({});
  };

  const pickMove = (m: string) => {
    setMove(m);
    const plan = planTargets(m, actor!, board);
    setTargets(plan.spread ? plan.candidates : plan.candidates.slice(0, 1));
    setHpAfter({});
    setNoDamage(!plan.isDamaging);
  };

  const plan = move && actor ? planTargets(move, actor, board) : null;

  const confirmMove = () => {
    if (!actor || !move) return;
    const builders: Array<(seq: number, turn: number) => MatchEvent> = [
      (seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'move_used', user: actor, move, targets, isSpread: plan?.spread ?? false }),
    ];
    if (!noDamage && plan?.isDamaging) {
      for (const t of targets) {
        const slot = slotOfMon(board, t);
        const before = slot ? board.slots[slot]!.hp : 0;
        const afterRaw = hpAfter[t];
        if (afterRaw === undefined || afterRaw === '') continue;
        const after = Number(afterRaw);
        builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'damage', attacker: actor, move, defender: t, hpBefore: before, hpAfter: after, crit, status, observedEffectiveness: eff }));
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

  const doMega = (forme: string) => {
    emit([(seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'mega_evolution', mon: actor!, megaSpecies: forme })]);
    reset();
  };

  const actorSpecies = actor ? actives.find((a) => a.monId === actor)?.species : undefined;
  const megaFormes = actorSpecies ? megaFormesFor(actorSpecies.replace(/-Mega.*$/, '')) : [];

  return (
    <div className="row">
      <div className="col panel">
        <div className="controls">
          <strong>Turn {currentTurn}</strong>
          <button onClick={newTurn}>▶ New turn</button>
          <span className="muted">Click the acting Pokémon, then its move.</span>
        </div>

        {/* Board — click to choose the actor */}
        <Board actives={actives} actor={actor} onPick={pickActor} />

        {/* Action panel */}
        {actor && (
          <div className="panel" style={{ marginTop: 12, background: 'var(--panel2)' }}>
            <div className="controls" style={{ marginTop: 0 }}>
              <strong>{monLabel(ws, actor)}</strong>
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
                  {megaFormes.length > 0 && <button onClick={() => setMode('mega')}>Mega Evolve ✦</button>}
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
                      {plan.candidates.map((t) => {
                        const on = targets.includes(t);
                        return (
                          <button
                            key={t}
                            className={on ? 'primary' : ''}
                            onClick={() => {
                              if (plan.spread) return;
                              setTargets(on ? targets.filter((x) => x !== t) : [...targets, t]);
                            }}
                          >
                            {monLabel(ws, t)}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}

                {!noDamage && plan.isDamaging && targets.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {targets.map((t) => {
                      const slot = slotOfMon(board, t);
                      const before = slot ? board.slots[slot]!.hp : 0;
                      return (
                        <div className="field" key={t}>
                          <label>{monLabel(ws, t)} HP</label>
                          <span className="muted">{before} →</span>
                          <input
                            type="number"
                            autoFocus
                            placeholder="hp after"
                            value={hpAfter[t] ?? ''}
                            onChange={(e) => setHpAfter({ ...hpAfter, [t]: e.target.value })}
                          />
                          <span className="muted">{hpAfter[t] !== undefined && hpAfter[t] !== '' ? `= ${before - Number(hpAfter[t])} dmg` : ''}</span>
                        </div>
                      );
                    })}
                    <div className="controls" style={{ flexWrap: 'wrap' }}>
                      <label className="chip"><input type="checkbox" checked={crit} onChange={(e) => setCrit(e.target.checked)} /> crit</label>
                      <select value={eff} onChange={(e) => setEff(e.target.value)}>
                        {['0.25x', '0.5x', '1x', '2x', '4x'].map((x) => <option key={x}>{x}</option>)}
                      </select>
                      <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                        <option value="clean">clean</option>
                        <option value="composite">composite</option>
                        <option value="unresolved">unresolved</option>
                      </select>
                    </div>
                  </div>
                )}

                <label className="chip" style={{ marginTop: 6, display: 'inline-block' }}>
                  <input type="checkbox" checked={noDamage} onChange={(e) => setNoDamage(e.target.checked)} /> no damage (status / missed)
                </label>

                <ReconstructedPanel ws={ws} attacker={actor} state={board} />

                <div style={{ marginTop: 8 }}>
                  <button className="primary" onClick={confirmMove}>Log action</button>
                </div>
              </div>
            )}

            {mode === 'switch' && (
              <div>
                <div className="muted" style={{ fontSize: 12 }}>Bring in:</div>
                <div className="chips">
                  {benchMons(ws, slotPosition(slotOfMon(board, actor)!).side, board).map((m) => (
                    <button key={m.monId} onClick={() => doSwitch(m.monId)}>{m.parsed.species}</button>
                  ))}
                </div>
              </div>
            )}

            {mode === 'mega' && (
              <div>
                <div className="muted" style={{ fontSize: 12 }}>Mega forme:</div>
                <div className="chips">
                  {megaFormes.map((f) => (
                    <button key={f} onClick={() => doMega(f)}>{f}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          <button onClick={() => setShowAdvanced(!showAdvanced)}>{showAdvanced ? '▾' : '▸'} Other events (status, field, heal, faint…)</button>
          {showAdvanced && <AdvancedEvents ws={ws} setWs={setWs} currentTurn={currentTurn} />}
        </div>
      </div>

      <div className="col panel">
        <h2>Event log ({ws.events.length})</h2>
        {ws.events.length === 0 && <p className="muted">No events yet. Click a Pokémon above to start.</p>}
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
      <div className="muted" style={{ fontSize: 12 }}>{m.hp}/{m.maxHp} HP{m.fainted ? ' · fainted' : ''}</div>
    </button>
  );
  return (
    <>
      <div className="muted" style={{ fontSize: 12 }}>Opponent</div>
      <div className="board">{foes.length ? foes.map(card) : <span className="muted">no active mon</span>}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>You</div>
      <div className="board">{you.length ? you.map(card) : <span className="muted">no active mon</span>}</div>
    </>
  );
}

function ReconstructedPanel({ ws, attacker, state }: { ws: Workspace; attacker: string; state: ReplayState }) {
  const chips: string[] = [];
  if (state.weather) chips.push(`weather: ${state.weather}`);
  for (const c of state.field) chips.push(c);
  const ab = state.boosts[attacker];
  if (ab) for (const [s, n] of Object.entries(ab)) if (n) chips.push(`atk ${s} ${n > 0 ? '+' : ''}${n}`);
  if (state.status[attacker]) chips.push(`atk ${state.status[attacker]}`);
  void ws;
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
    case 'mega_evolution': return `${label(e.mon)} Mega → ${e.megaSpecies}`;
    case 'random_outcome': return `${label(e.mon)} ${e.eventKind}: ${e.outcome}`;
  }
}
