import { useMemo, useState } from 'react';
import type { MatchEvent } from '../log';
import type { ReplayState } from '../replay';
import {
  activeMonIds,
  backfillDerivedEvents,
  benchMons,
  diagnoseLog,
  NATURAL_CURE_ABILITIES,
  endOfTurnEvents,
  entryEffectEvents,
  estimateDamage,
  fieldExpiryEvents,
  forfeitFromEvents,
  itemConsumed,
  megaFormeAbility,
  megaFormeFromItem,
  monAbility,
  monItem,
  monLabel,
  monMaxHp,
  moveCanFlinch,
  moveMakesContact,
  moveMultiHit,
  moveRecoilDrain,
  moveStatChangeEvents,
  moveStatus,
  nextEventId,
  oneHitSurvivor,
  reactiveDefenderEvents,
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
  /** number of sub-hits for a multi-hit move (the HP delta is the summed total) */
  hits?: string;
}
const blankOutcome = (): TargetOutcome => ({ hpAfter: '', crit: false, flinch: false, missed: false, ko: false, status: 'clean' });

/** Sources emitted by end-of-turn residuals — used to detect "already applied this turn". */
const END_OF_TURN_SOURCES = new Set(['Sandstorm', 'Leftovers', 'Black Sludge', 'Burn', 'Poison', 'Toxic', 'Poison Heal', 'Grassy Terrain']);
/** Moves that only work on the user's FIRST turn out — they fail otherwise. */
const FIRST_TURN_MOVES = new Set(['Fake Out', 'First Impression', 'Mat Block']);

/** Moves that only connect if the TARGET is using an attacking move this turn —
 *  they fail against a target that switched in, used a status move, or already moved. */
const NEEDS_TARGET_ATTACKING = new Set(['Sucker Punch', 'Thunderclap', 'Upper Hand']);

export function TranscribeTab({ ws, setWs }: { ws: Workspace; setWs: (w: Workspace) => void }) {
  const diagnosis = useMemo(() => diagnoseLog(ws), [ws]);
  const board = diagnosis.board;
  const [actor, setActor] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('idle');
  const [move, setMove] = useState<string | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, TargetOutcome>>({});
  const [manualFail, setManualFail] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [backfillNote, setBackfillNote] = useState<string | null>(null);

  const currentTurn = useMemo(() => {
    const ts = ws.events.filter((e) => e.type === 'turn_start');
    return ts.length ? Math.max(...ts.map((e) => e.turn)) : 1;
  }, [ws.events]);

  if (ws.sideA.mons.length === 0 && ws.sideB.mons.length === 0) {
    return <div className="panel">Add teams first (Teams tab).</div>;
  }
  if (!board) {
    const badEvent = diagnosis.badEventId ? ws.events.find((e) => e.eventId === diagnosis.badEventId) : undefined;
    const deleteBad = () => setWs({ ...ws, events: ws.events.filter((e) => e.eventId !== diagnosis.badEventId) });
    return (
      <div className="row">
        <div className="col panel">
          <div className="panel error" style={{ marginBottom: 12 }}>
            <strong>The event log can’t be reconstructed.</strong>
            <p style={{ margin: '6px 0' }}>{diagnosis.message ?? 'A move or hit references a Pokémon that isn’t on the field.'}</p>
            {badEvent && (
              <p style={{ margin: '6px 0' }}>
                Offending event <span className="seq">{badEvent.seq}</span>:{' '}
                <strong>{describe(badEvent, (id) => monLabel(ws, id))}</strong> — it’s highlighted in the log.
              </p>
            )}
            <div className="controls">
              {diagnosis.badEventId && (
                <button className="primary" onClick={deleteBad} style={{ color: 'var(--bad)' }}>✕ Delete the offending event</button>
              )}
              <button onClick={() => setWs({ ...ws, events: ws.events.slice(0, -1) })}>Undo last event</button>
              <button onClick={() => setWs({ ...ws, events: [] })}>Clear all events</button>
            </div>
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              {diagnosis.setupProblem
                ? 'Fix the leads below so they match the roster — then the board returns.'
                : 'Or fix the leads below, or edit/delete any event in the log on the right. The board returns as soon as the log is consistent.'}
            </p>
          </div>
          <MatchSetup ws={ws} setWs={setWs} startOpen />
        </div>
        <EventLogColumn ws={ws} setWs={setWs} {...(diagnosis.badEventId ? { highlightId: diagnosis.badEventId } : {})} />
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
    setManualFail(false);
  };

  const emit = (builders: Array<(seq: number, turn: number) => MatchEvent>) => {
    let seq = ws.events.length ? Math.max(...ws.events.map((e) => e.seq)) : 0;
    const evs = builders.map((b) => {
      seq += 1;
      return b(seq, currentTurn);
    });
    setWs({ ...ws, events: [...ws.events, ...evs] });
  };

  // Have this turn's end-of-turn residuals already been logged? (reload-safe, source-based)
  const residualsApplied = (turn: number): boolean =>
    ws.events.some(
      (e) =>
        e.turn === turn &&
        (((e.type === 'passive_hp_change' || e.type === 'heal') && END_OF_TURN_SOURCES.has(e.source)) ||
          (e.type === 'status_applied' && (e.source === 'Flame Orb' || e.source === 'Toxic Orb'))),
    );
  const faintedAwaitingReplacement = actives.some((m) => m.fainted) && residualsApplied(currentTurn);

  /**
   * End the turn: apply this turn's residuals (if not already), then advance —
   * UNLESS a residual KO'd a Pokémon, in which case it pauses so you can send a
   * replacement; clicking again then advances. Residuals + the new turn are one
   * atomic update (no stale-state races).
   */
  const endTurn = () => {
    let seq = ws.events.length ? Math.max(...ws.events.map((e) => e.seq)) : 0;
    const newEvents: MatchEvent[] = [];
    let faintNow = false;
    if (!residualsApplied(currentTurn)) {
      for (const b of endOfTurnEvents(ws, board)) {
        seq += 1;
        const ev = b(seq, currentTurn);
        newEvents.push(ev);
        if (ev.type === 'faint') faintNow = true;
      }
    }
    // Timed-effect expiry (weather/terrain/Trick Room/screens/Tailwind) — self-idempotent,
    // so it runs regardless of the residuals guard; once ended it leaves the board.
    for (const b of fieldExpiryEvents(ws, board)) {
      seq += 1;
      newEvents.push(b(seq, currentTurn));
    }
    if (!faintNow) {
      const n = ws.events.filter((e) => e.type === 'turn_start').length + 1; // advance
      seq += 1;
      newEvents.push({ eventId: nextEventId(), seq, turn: n, type: 'turn_start' });
    }
    setWs({ ...ws, events: [...ws.events, ...newEvents] });
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
    setManualFail(false);
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
    move ? typeEffectiveness(move, actives.find((a) => a.monId === targetMonId)?.species ?? '', monAbility(ws, targetMonId)) : null;

  const actorFainted = actor ? !!actives.find((a) => a.monId === actor)?.fainted : false;
  const actorEntry = actor ? entryOf(actor) : undefined;
  const actorItem = actorEntry?.parsed.item;
  const actorAbility = actorEntry?.parsed.ability;
  const actorBase = actorEntry?.parsed.species;
  const actorBoardSpecies = actor ? actives.find((a) => a.monId === actor)?.species : undefined;
  const alreadyMega = (actorBoardSpecies ?? '').includes('-Mega');
  const megaForme = actorBase ? megaFormeFromItem(actorItem, actorBase) : null;
  const canFlinch = move ? moveCanFlinch(move, actorItem, actorAbility) : false;
  const moveHits = move ? moveMultiHit(move) : null;
  // Surface an auto-detected outright failure (no damage) so the user sees why "Log action" will fail.
  const autoFailHint: string | null = (() => {
    if (!actor || !move) return null;
    const entryTurn = ws.events
      .filter((e) => e.type === 'switch' && (e as Extract<MatchEvent, { type: 'switch' }>).in === actor)
      .reduce((mx, e) => Math.max(mx, e.turn), 1);
    if (FIRST_TURN_MOVES.has(move) && entryTurn !== currentTurn) return `${move} only works the turn this Pokémon switches in`;
    const switchedIn = targets.some((t) => ws.events.some((e) => e.type === 'switch' && (e as Extract<MatchEvent, { type: 'switch' }>).in === t && e.turn === currentTurn));
    if (NEEDS_TARGET_ATTACKING.has(move) && switchedIn) return `${move} fails — the target switched in, so it isn’t attacking`;
    return null;
  })();

  const confirmMove = () => {
    if (!actor || !move) return;
    const builders: Array<(seq: number, turn: number) => MatchEvent> = [
      (seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'move_used', user: actor, move, targets, isSpread: plan?.spread ?? false }),
    ];
    // A move can FAIL outright (deals nothing) when a conditional requirement isn't met.
    // Auto-detected cases + a manual override; any fail short-circuits the damage/status block.
    const entryTurn = ws.events
      .filter((e): e is Extract<MatchEvent, { type: 'switch' }> => e.type === 'switch' && e.in === actor)
      .reduce((mx, e) => Math.max(mx, e.turn), 1);
    // Sucker Punch / Thunderclap / Upper Hand fail when the target isn't attacking — the clearest
    // sign is a target that switched IN this turn (switching is not an attack).
    const targetSwitchedInThisTurn = targets.some((t) =>
      ws.events.some((e) => e.type === 'switch' && e.in === t && e.turn === currentTurn));
    const failed =
      manualFail ||
      (FIRST_TURN_MOVES.has(move) && entryTurn !== currentTurn) ||
      (NEEDS_TARGET_ATTACKING.has(move) && targetSwitchedInThisTurn);
    if (failed) {
      const user = actor;
      builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'random_outcome', mon: user, eventKind: 'fail', outcome: 'yes' }));
      emit(builders);
      reset();
      return;
    }
    if (plan?.isDamaging) {
      const contact = moveMakesContact(move);
      const aMax = monMaxHp(ws, actor);
      let totalDamage = 0;
      let contactLoss = 0;
      for (const t of targets) {
        const o = outcomes[t] ?? blankOutcome();
        if (o.missed) {
          // distinguish a Protect/Wide Guard block ("protected itself!") from a real accuracy miss
          const blocker = protectionBlocking(ws, t, move, currentTurn);
          builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'random_outcome', mon: t, eventKind: blocker ? 'blocked' : 'miss', outcome: blocker ?? 'yes' }));
          continue;
        }
        const rawAfter = o.ko ? 0 : o.hpAfter === '' ? null : Number(o.hpAfter);
        if (rawAfter === null) continue;
        const slot = slotOfMon(board, t);
        const before = slot ? board.slots[slot]!.hp : 0;
        const dMax = monMaxHp(ws, t);
        const nHits = moveHits ? Number(o.hits) || moveHits.max : undefined;
        // Focus Sash (item) / Sturdy (ability): survive a would-be KO from full HP at 1, single-hit only.
        const survivor = oneHitSurvivor(ws, t, dMax > 0 && before === dMax, rawAfter === 0, !nHits || nHits <= 1);
        const after = survivor ? 1 : rawAfter;
        const dmg = before - after;
        totalDamage += dmg;
        const eff = effOf(t)?.label ?? '1x'; // derived from the type chart, not entered
        builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'damage', attacker: actor, move, defender: t, hpBefore: before, hpAfter: after, crit: o.crit, status: o.status, observedEffectiveness: eff, ...(nHits && nHits > 1 ? { hits: nHits } : {}) }));
        if (survivor === 'Focus Sash') builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'item_or_ability_event', mon: t, kind: 'enditem', name: 'Focus Sash' }));
        else if (survivor === 'Sturdy') builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'item_or_ability_event', mon: t, kind: 'activate', name: 'ability: Sturdy' }));
        if (after === 0) builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'faint', target: t })); // auto-faint at 0 HP
        if (canFlinch && o.flinch) builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'random_outcome', mon: t, eventKind: 'flinch', outcome: 'yes' }));
        // Reactive defender items: Weakness Policy (SE), Cell Battery/Absorb Bulb/Snowball/Luminous Moss (by type), Air Balloon (pops).
        builders.push(...reactiveDefenderEvents(ws, t, move, effOf(t)?.mult ?? 1, dmg, after > 0));
        // Sitrus Berry: heals the defender at ≤50% HP (alive) — only if it hasn't already been eaten.
        if (after > 0 && dMax && monItem(ws, t) === 'Sitrus Berry' && after <= Math.floor(dMax / 2) && !itemConsumed(ws, t)) {
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
        if (aHp === 0 && hpBefore > 0) builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'faint', target })); // recoil/contact KO
      }
    }
    // Auto-apply a GUARANTEED status (Toxic→tox, Will-O-Wisp→brn, …) so end-of-turn ticks derive.
    const inflicts = moveStatus(move);
    if (inflicts) {
      for (const t of targets) {
        const o = outcomes[t] ?? blankOutcome();
        if (o.missed) continue; // blocked / missed → no status
        builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'status_applied', target: t, status: inflicts }));
      }
    }
    // Stat-stage changes the move causes (Swords Dance, Parting Shot, Close Combat self-drop, Snarl, …).
    // Self-boosts need the move to connect on ≥1 target (a fully-blocked damaging move drops nothing);
    // foe drops apply only to targets actually hit (not missed/blocked/fainted).
    const connected = !plan?.isDamaging || targets.some((t) => !(outcomes[t]?.missed));
    if (connected) {
      const statTargets = targets.filter((t) => {
        const o = outcomes[t];
        return !(plan?.isDamaging && (o?.missed || o?.ko));
      });
      builders.push(...moveStatChangeEvents(ws, board, actor, move, statTargets));
    }
    emit(builders);
    reset();
  };

  const doSwitch = (incoming: string) => {
    const slot = slotOfMon(board, actor!);
    if (!slot || !actor) return;
    const { side, position } = slotPosition(slot);
    const builders: Array<(seq: number, turn: number) => MatchEvent> = [];
    // Regenerator: the OUTGOING mon restores 1/3 max HP on switch-out (so it returns healthier).
    const outMax = monMaxHp(ws, actor);
    const outHp = board.slots[slot]?.hp ?? outMax;
    const outAbility = monAbility(ws, actor);
    if (outAbility === 'Regenerator' && outHp > 0 && outHp < outMax) {
      const healed = Math.min(outMax, outHp + Math.floor(outMax / 3));
      const t = actor;
      builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'heal', target: t, source: 'Regenerator', hpBefore: outHp, hpAfter: healed }));
    }
    // Natural Cure: the OUTGOING mon's status condition clears as it switches out.
    const outStatus = board.status[actor];
    if (outAbility && NATURAL_CURE_ABILITIES.has(outAbility) && outStatus && outHp > 0) {
      const t = actor;
      builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'status_cured', target: t, status: outStatus }));
    }
    builders.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'switch', side, position, out: actor, in: incoming }));
    builders.push(...entryEffectEvents(ws, incoming, monAbility(ws, incoming), board, true)); // Intimidate / weather on entry
    emit(builders);
    reset();
  };

  const doFaint = () => {
    if (!actor) return;
    emit([(seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'faint', target: actor })]);
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
            <button
              className="primary"
              onClick={endTurn}
              title="Apply end-of-turn residuals, then advance. Pauses on a residual KO so you can send a replacement."
            >
              {faintedAwaitingReplacement ? '▶ Next turn' : '▶ End turn'}
            </button>
          )}
          <span className="muted">
            {faintedAwaitingReplacement
              ? 'A Pokémon fainted from residuals — send its replacement on the board, then advance.'
              : 'End turn applies residuals (weather/status/items) then advances — adjust HP to the screen.'}
          </span>
        </div>

        <div className="controls" style={{ marginTop: 0 }}>
          <span className="muted" style={{ fontSize: 12 }}>🏁 Result:</span>
          <select
            value={ws.result?.winner ?? ''}
            onChange={(e) => {
              const w = e.target.value as '' | 'A' | 'B';
              if (!w) {
                const { result: _drop, ...rest } = ws;
                setWs(rest);
              } else {
                setWs({ ...ws, result: { winner: w, reason: ws.result?.reason ?? 'ko' } });
              }
            }}
          >
            <option value="">— in progress —</option>
            <option value="A">{ws.sideA.player} wins</option>
            <option value="B">{ws.sideB.player} wins</option>
          </select>
          {ws.result && (
            <select value={ws.result.reason} onChange={(e) => setWs({ ...ws, result: { ...ws.result!, reason: e.target.value as 'ko' | 'timeout' | 'dq' } })}>
              <option value="ko">by KO</option>
              <option value="timeout">by timeout</option>
              <option value="dq">by DQ</option>
            </select>
          )}
          <span className="muted" style={{ fontSize: 12 }}>· forfeit (logs an event):</span>
          <button title={`${ws.sideA.player} forfeits → ${ws.sideB.player} wins`} onClick={() => emit([(seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'forfeit', side: 'A' })])}>
            ⚑ {ws.sideA.player}
          </button>
          <button title={`${ws.sideB.player} forfeits → ${ws.sideA.player} wins`} onClick={() => emit([(seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'forfeit', side: 'B' })])}>
            ⚑ {ws.sideB.player}
          </button>
          {(() => {
            const f = forfeitFromEvents(ws.events);
            return f ? (
              <span className="chip" style={{ color: 'var(--bad)' }}>
                ⚑ {(f.winner === 'A' ? ws.sideB.player : ws.sideA.player)} forfeited → {(f.winner === 'A' ? ws.sideA.player : ws.sideB.player)} wins
              </span>
            ) : null;
          })()}
        </div>

        {ws.events.length > 0 && (
          <div className="controls" style={{ marginTop: 0 }}>
            <button
              title="Scan the log and add any missing auto-derived effects (Regenerator/Natural Cure on switch-out, weather/field expiry) without changing what's there. Use after importing or on an older game. Safe to run repeatedly."
              onClick={() => {
                const { events, added } = backfillDerivedEvents(ws);
                if (added > 0) setWs({ ...ws, events });
                setBackfillNote(added > 0 ? `Added ${added} missing effect${added === 1 ? '' : 's'}.` : 'Nothing missing — the log is already up to date.');
              }}
            >
              ⟳ Re-derive effects
            </button>
            {backfillNote && <span className="muted" style={{ fontSize: 12 }}>{backfillNote}</span>}
          </div>
        )}

        <Board actives={actives} actor={actor} onPick={pickActor} youName={ws.sideA.player} oppName={ws.sideB.player} />

        {actor && (
          <div className="panel" style={{ marginTop: 12, background: 'var(--panel2)' }}>
            <div className="controls" style={{ marginTop: 0 }}>
              <strong>{monLabel(ws, actor)}{alreadyMega ? ' (Mega)' : ''}{actorFainted ? ' — fainted' : ''}</strong>
              <button onClick={reset}>cancel</button>
            </div>

            {actorFainted && (() => {
              const actorSlot = slotOfMon(board, actor);
              const side = actorSlot ? slotPosition(actorSlot).side : 'A';
              const bench = benchMons(ws, side, board);
              return (
                <div>
                  <div className="muted" style={{ fontSize: 12 }}>Send out a replacement{actorSlot ? ` (${slotPosition(actorSlot).position === 0 ? 'left' : 'right'} slot)` : ''}:</div>
                  <div className="chips">
                    {bench.length === 0 && <span className="muted">no bench Pokémon left to send in</span>}
                    {bench.map((m) => (
                      <button key={m.monId} onClick={() => doSwitch(m.monId)}>{m.parsed.species}</button>
                    ))}
                  </div>
                </div>
              );
            })()}

            {!actorFainted && mode === 'move' && !move && (
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
                  <button onClick={doFaint} title="mark this Pokémon as fainted" style={{ color: 'var(--bad)' }}>Faint ✕</button>
                </div>
              </>
            )}

            {!actorFainted && mode === 'move' && move && plan && (
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
                      {monItem(ws, t) && itemConsumed(ws, t) && (
                        <span className="chip" style={{ marginLeft: 8, color: 'var(--warn)' }} title="This Pokémon already used its held item — one-time items (Sitrus Berry, Focus Sash, herbs, …) won't trigger again.">
                          🚫 {monItem(ws, t)} used
                        </span>
                      )}
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
                            {moveHits && (
                              <label className="chip" title={`multi-hit move (${moveHits.min === moveHits.max ? moveHits.max : `${moveHits.min}–${moveHits.max}`}); enter how many times it hit`}>
                                × hits
                                <input
                                  type="number"
                                  min={moveHits.min}
                                  max={moveHits.max}
                                  value={o.hits ?? String(moveHits.max)}
                                  onChange={(e) => setOutcome(t, { hits: e.target.value })}
                                  style={{ width: 44, marginLeft: 4 }}
                                />
                              </label>
                            )}
                            <label className="chip" style={{ color: o.ko ? 'var(--bad)' : undefined }}><input type="checkbox" checked={o.ko} onChange={(e) => setOutcome(t, { ko: e.target.checked })} /> KO</label>
                            {o.ko && (() => {
                              const s = oneHitSurvivor(ws, t, monMaxHp(ws, t) > 0 && before === monMaxHp(ws, t), true, !moveHits || (Number(o.hits) || moveHits.max) <= 1);
                              return s ? <span className="chip" style={{ color: 'var(--accent)' }} title={`From full HP, ${s} lets it survive a single hit at 1 HP — it'll be logged as surviving, not fainting.`}>🛟 survives at 1 ({s})</span> : null;
                            })()}
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
                  {autoFailHint && <div className="muted" style={{ marginBottom: 4, color: 'var(--accent)' }}>⚠ {autoFailHint} — will log as failed.</div>}
                  {!autoFailHint && (
                    <label className="chip" style={{ marginRight: 8 }} title="The move fails outright (a conditional requirement wasn't met) — logs as failed, no damage or status.">
                      <input type="checkbox" checked={manualFail} onChange={(e) => setManualFail(e.target.checked)} /> move failed
                    </label>
                  )}
                  <button className="primary" onClick={confirmMove}>Log action</button>
                </div>
              </div>
            )}

            {!actorFainted && mode === 'switch' && (() => {
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

      <EventLogColumn ws={ws} setWs={setWs} />
    </div>
  );
}

/** The event log (drag-reorder + inline edit + delete). Reused in the recovery screen. */
function EventLogColumn({ ws, setWs, highlightId }: { ws: Workspace; setWs: (w: Workspace) => void; highlightId?: string }) {
  const [editId, setEditId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const reorderEvents = (fromId: string, toId: string) => {
    const sorted = [...ws.events].sort((a, b) => a.seq - b.seq);
    const from = sorted.findIndex((e) => e.eventId === fromId);
    const to = sorted.findIndex((e) => e.eventId === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = sorted.splice(from, 1);
    sorted.splice(to, 0, moved!);
    setWs({ ...ws, events: sorted.map((e, i) => ({ ...e, seq: i + 1 })) });
  };
  return (
    <div className="col panel">
      <h2>Event log ({ws.events.length})</h2>
      {ws.events.length === 0 && <p className="muted">No events yet. Set your leads above, then click a Pokémon to start.</p>}
      {ws.events.length > 0 && <p className="muted" style={{ fontSize: 11 }}>drag ⠿ to reorder — the blue line shows where it’ll drop · click ✎ to edit</p>}
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
            style={{
              ...(highlightId === e.eventId ? { border: '1px solid var(--bad)', borderRadius: 4 } : {}),
              ...(dragId === e.eventId ? { opacity: 0.4 } : {}),
              // insertion line above the drop target (box-shadow → no layout shift)
              ...(overId === e.eventId && dragId && dragId !== e.eventId ? { boxShadow: 'inset 0 3px 0 0 var(--accent)' } : {}),
            }}
            draggable
            onDragStart={(ev) => {
              setDragId(e.eventId);
              ev.dataTransfer.setData('text/plain', e.eventId);
              ev.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(ev) => {
              ev.preventDefault();
              ev.dataTransfer.dropEffect = 'move';
              if (overId !== e.eventId) setOverId(e.eventId);
            }}
            onDragLeave={() => setOverId((cur) => (cur === e.eventId ? null : cur))}
            onDrop={(ev) => {
              ev.preventDefault();
              const fromId = ev.dataTransfer.getData('text/plain');
              if (fromId) reorderEvents(fromId, e.eventId);
              setDragId(null);
              setOverId(null);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
          >
            <span className="drag" title="drag to reorder" style={{ cursor: 'grab', color: 'var(--muted)' }}>⠿</span>
            <span className="seq">{e.seq}</span>
            <span>{describe(e, (id) => monLabel(ws, id), (s) => (s === 'A' ? ws.sideA.player : ws.sideB.player))}</span>
            <span className="x" title="edit" style={{ marginLeft: 'auto', color: 'var(--accent)', cursor: 'pointer' }} onClick={() => setEditId(e.eventId)}>✎</span>
            <span className="x" title="delete" onClick={() => setWs({ ...ws, events: ws.events.filter((x) => x.eventId !== e.eventId) })}>✕</span>
          </div>
        ),
      )}
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
      style={{ textAlign: 'left', borderColor: actor === m.monId ? 'var(--accent)' : undefined, opacity: m.fainted ? 0.5 : 1 }}
      onClick={() => onPick(m.monId)}
      title={m.fainted ? 'fainted — click to send out a replacement' : undefined}
    >
      <strong>{m.species}</strong>
      <div className="muted" style={{ fontSize: 12 }}>{`${m.hp}/${m.maxHp} HP${m.fainted ? ' · fainted — click to replace' : ''}`}</div>
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

function describe(e: MatchEvent, label: (id: string) => string, sideName?: (s: 'A' | 'B') => string): string {
  switch (e.type) {
    case 'forfeit': return `⚑ ${sideName?.(e.side) ?? `Player ${e.side}`} forfeited — game over`;
    case 'turn_start': return `── turn ${e.turn} ──`;
    case 'move_used': return `${label(e.user)} used ${e.move}${e.isSpread ? ' (spread)' : ''}`;
    case 'damage': return `${label(e.attacker)} ${e.move} → ${label(e.defender)}  ${e.hpBefore}→${e.hpAfter} [${e.status}]${e.crit ? ' CRIT' : ''}`;
    case 'heal': return `${label(e.target)} healed ${e.hpBefore}→${e.hpAfter} (${e.source})`;
    case 'passive_hp_change': return `${label(e.target)} chip ${e.hpBefore}→${e.hpAfter} (${e.source})`;
    case 'switch': return e.out ? `${label(e.out)} → ${label(e.in)} (switch)` : `${label(e.in)} switched in (${e.side} ${e.position === 0 ? 'left' : 'right'})`;
    case 'faint': return `${label(e.target)} fainted`;
    case 'status_applied': return `${label(e.target)} → ${e.status}`;
    case 'status_cured': return `${label(e.target)} cured ${e.status}`;
    case 'stat_stage_change': return `${label(e.target)} ${e.stat} ${e.stages > 0 ? '+' : ''}${e.stages}${e.source ? ` (${e.source})` : ''}`;
    case 'field_change': return e.action === 'end' ? `${e.field} faded${e.side ? ` [${e.side}]` : ''}` : `${e.field} set${e.side ? ` [${e.side}]` : ''}${e.turnsKnown ? ` (${e.turnsKnown}t)` : ''}`;
    case 'item_or_ability_event': return `${label(e.mon)} ${e.kind} ${e.name}`;
    case 'mega_evolution': return `${label(e.mon)} Mega-Evolved → ${e.megaSpecies}`;
    case 'volatile': return `${label(e.mon)} ${e.action === 'start' ? '→' : 'ended'} ${e.effect.replace(/^move: /, '')}`;
    case 'random_outcome':
      if (e.eventKind === 'flinch') return `${label(e.mon)} flinched`;
      if (e.eventKind === 'miss') return `${label(e.mon)} avoided the attack (missed)`;
      if (e.eventKind === 'blocked') return `${label(e.mon)} protected itself (${e.outcome})`;
      if (e.eventKind === 'cant') return `${label(e.mon)} couldn’t move (${e.outcome})`;
      if (e.eventKind === 'fail') return `${label(e.mon)}'s move failed`;
      return `${label(e.mon)} ${e.eventKind}: ${e.outcome}`;
  }
}
