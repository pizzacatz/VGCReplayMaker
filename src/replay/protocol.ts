/**
 * Event log → battle-protocol translation (Replay Spec T2.3 §2–3).
 *
 * We use the Showdown REPLAY-VIEWER path only — never the simulator (Constitution
 * §G2). Every outcome is already in the log, so the protocol is fully determined:
 * each event maps to one or more protocol messages in `seq` order.
 *
 * Each ProtocolMessage carries BOTH a `line` (the Showdown text the viewer
 * renders) and a structured `effect` (drives the headless deterministic-rebuild
 * state). Both derive from the same event, so the viewer and the rebuild can
 * never disagree.
 *
 * NOTE: the exact protocol strings are REPRESENTATIVE and must be verified
 * against current @pkmn/protocol / Showdown PROTOCOL.md before wiring a live
 * viewer (Constitution §G4, Replay Spec §9). The mapping logic is the spec.
 */

import type { MatchEvent, MatchLog, Position, Side } from '../log';

export type Effect =
  | { kind: 'turn'; n: number }
  | { kind: 'switchIn'; slot: string; monId: string; species: string; hp: number; maxHp: number }
  | { kind: 'hp'; slot: string; hp: number }
  | { kind: 'faint'; slot: string }
  | { kind: 'status'; monId: string; status: string; action: 'set' | 'cure' }
  | { kind: 'boost'; monId: string; stat: string; stages: number }
  | { kind: 'weather'; value: string | null }
  | { kind: 'field'; condition: string; action: 'set' | 'end' }
  | { kind: 'side'; side: Side; condition: string; action: 'set' | 'end' }
  | { kind: 'noop' };

export interface ProtocolMessage {
  index: number;
  seq: number;
  turn: number;
  line: string;
  effect: Effect;
}

const WEATHERS = new Set(['Sun', 'Rain', 'Sand', 'Sandstorm', 'Snow', 'Hail', 'Harsh Sunlight']);
const SIDE_CONDITIONS = new Set(['Reflect', 'Light Screen', 'Aurora Veil', 'Tailwind']);

const protoId = (side: Side, position: Position): string => `p${side === 'A' ? 1 : 2}${position === 0 ? 'a' : 'b'}`;

/** Translate a match log into the ordered battle-protocol message stream. */
export function toProtocol(log: MatchLog): ProtocolMessage[] {
  const sheets = new Map<string, { species: string; maxHp: number; side: Side }>();
  for (const m of log.sideA.mons) sheets.set(m.monId, { species: m.nickname ?? m.species, maxHp: m.maxHp, side: 'A' });
  for (const m of log.sideB.mons) sheets.set(m.monId, { species: m.nickname ?? m.species, maxHp: m.maxHp, side: 'B' });

  const slotByMon = new Map<string, string>(); // monId → 'p1a'
  const hpByMon = new Map<string, number>(); // current HP carried across switches

  const messages: ProtocolMessage[] = [];
  let index = 0;
  const push = (seq: number, turn: number, line: string, effect: Effect): void => {
    messages.push({ index: index++, seq, turn, line, effect });
  };
  const slotOf = (monId: string): string => {
    const slot = slotByMon.get(monId);
    if (!slot) throw new Error(`mon ${monId} is not on the board (bad log: damage/move references an inactive mon)`);
    return slot;
  };
  const place = (side: Side, position: Position, monId: string): string => {
    const slot = protoId(side, position);
    for (const [mon, s] of slotByMon) if (s === slot) slotByMon.delete(mon);
    slotByMon.set(monId, slot);
    return slot;
  };

  // Initial board (leads) → |switch| messages first.
  for (const lead of log.leads) {
    const sheet = sheets.get(lead.monId);
    if (!sheet) throw new Error(`lead ${lead.monId} has no sheet`);
    const slot = place(lead.side, lead.position, lead.monId);
    const hp = sheet.maxHp;
    hpByMon.set(lead.monId, hp);
    push(0, 0, `|switch|${slot}|${sheet.species}|${hp}/${sheet.maxHp}`, {
      kind: 'switchIn',
      slot,
      monId: lead.monId,
      species: sheet.species,
      hp,
      maxHp: sheet.maxHp,
    });
  }

  for (const ev of [...log.events].sort((a, b) => a.seq - b.seq)) {
    emit(ev);
  }
  return messages;

  function emit(ev: MatchEvent): void {
    switch (ev.type) {
      case 'turn_start':
        push(ev.seq, ev.turn, `|turn|${ev.turn}`, { kind: 'turn', n: ev.turn });
        return;
      case 'move_used': {
        const src = slotOf(ev.user);
        const targets = ev.targets.map((t) => slotByMon.get(t)).filter(Boolean).join(',');
        push(ev.seq, ev.turn, `|move|${src}|${ev.move}|${targets}`, { kind: 'noop' });
        return;
      }
      case 'damage': {
        const slot = slotOf(ev.defender);
        const sheet = sheets.get(ev.defender)!;
        if (ev.crit) push(ev.seq, ev.turn, `|-crit|${slot}`, { kind: 'noop' });
        if (ev.observedEffectiveness === '2x' || ev.observedEffectiveness === '4x') {
          push(ev.seq, ev.turn, `|-supereffective|${slot}`, { kind: 'noop' });
        } else if (ev.observedEffectiveness === '0.5x' || ev.observedEffectiveness === '0.25x') {
          push(ev.seq, ev.turn, `|-resisted|${slot}`, { kind: 'noop' });
        }
        hpByMon.set(ev.defender, ev.hpAfter);
        push(ev.seq, ev.turn, `|-damage|${slot}|${ev.hpAfter}/${sheet.maxHp}`, { kind: 'hp', slot, hp: ev.hpAfter });
        return;
      }
      case 'passive_hp_change': {
        const slot = slotOf(ev.target);
        const sheet = sheets.get(ev.target)!;
        hpByMon.set(ev.target, ev.hpAfter);
        push(ev.seq, ev.turn, `|-damage|${slot}|${ev.hpAfter}/${sheet.maxHp}|[from] ${ev.source}`, { kind: 'hp', slot, hp: ev.hpAfter });
        return;
      }
      case 'heal': {
        const slot = slotOf(ev.target);
        const sheet = sheets.get(ev.target)!;
        hpByMon.set(ev.target, ev.hpAfter);
        push(ev.seq, ev.turn, `|-heal|${slot}|${ev.hpAfter}/${sheet.maxHp}|[from] ${ev.source}`, { kind: 'hp', slot, hp: ev.hpAfter });
        return;
      }
      case 'switch': {
        const sheet = sheets.get(ev.in)!;
        const slot = place(ev.side, ev.position, ev.in);
        const hp = hpByMon.get(ev.in) ?? sheet.maxHp;
        hpByMon.set(ev.in, hp);
        push(ev.seq, ev.turn, `|switch|${slot}|${sheet.species}|${hp}/${sheet.maxHp}`, {
          kind: 'switchIn',
          slot,
          monId: ev.in,
          species: sheet.species,
          hp,
          maxHp: sheet.maxHp,
        });
        return;
      }
      case 'faint': {
        const slot = slotOf(ev.target);
        hpByMon.set(ev.target, 0);
        push(ev.seq, ev.turn, `|faint|${slot}`, { kind: 'faint', slot });
        return;
      }
      case 'status_applied': {
        const slot = slotOf(ev.target);
        push(ev.seq, ev.turn, `|-status|${slot}|${ev.status}`, { kind: 'status', monId: ev.target, status: ev.status, action: 'set' });
        return;
      }
      case 'status_cured': {
        const slot = slotOf(ev.target);
        push(ev.seq, ev.turn, `|-curestatus|${slot}|${ev.status}`, { kind: 'status', monId: ev.target, status: ev.status, action: 'cure' });
        return;
      }
      case 'stat_stage_change': {
        const slot = slotOf(ev.target);
        const verb = ev.stages >= 0 ? '-boost' : '-unboost';
        push(ev.seq, ev.turn, `|${verb}|${slot}|${ev.stat}|${Math.abs(ev.stages)}`, { kind: 'boost', monId: ev.target, stat: ev.stat, stages: ev.stages });
        return;
      }
      case 'field_change': {
        if (ev.side || SIDE_CONDITIONS.has(ev.field)) {
          const side = ev.side ?? 'A';
          const verb = ev.action === 'set' ? '-sidestart' : '-sideend';
          push(ev.seq, ev.turn, `|${verb}|p${side === 'A' ? 1 : 2}|${ev.field}`, { kind: 'side', side, condition: ev.field, action: ev.action });
        } else if (WEATHERS.has(ev.field)) {
          push(ev.seq, ev.turn, `|-weather|${ev.action === 'set' ? ev.field : 'none'}`, { kind: 'weather', value: ev.action === 'set' ? ev.field : null });
        } else {
          const verb = ev.action === 'set' ? '-fieldstart' : '-fieldend';
          push(ev.seq, ev.turn, `|${verb}|${ev.field}`, { kind: 'field', condition: ev.field, action: ev.action });
        }
        return;
      }
      case 'item_or_ability_event': {
        const slot = slotByMon.get(ev.mon);
        push(ev.seq, ev.turn, `|-${ev.kind}|${slot ?? ev.mon}|${ev.name}`, { kind: 'noop' });
        return;
      }
      case 'random_outcome':
        // Usually implied by the linked event (e.g. a flinch shows as the move not
        // executing); no standalone protocol message (Replay Spec §2). Skipped.
        return;
    }
  }
}
