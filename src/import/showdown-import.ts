/**
 * Showdown replay import: parse a Showdown battle log (the `|move|`, `|switch|`,
 * `|-damage|` … protocol) into our event log + rosters, so a Showdown-sourced
 * game doesn't have to be hand-transcribed. The reverse of replay/showdown.ts.
 *
 * Honest about HP precision: spectator replays show opponent HP as PERCENT
 * (x/100), which isn't the exact integer the solver needs — those damage events
 * are imported as `unresolved` (they replay, but don't feed inference) and a
 * warning is raised. Absolute HP (x/Max, Max≠100) imports as `clean`.
 */

import type { MatchEvent, MatchLog, Side, Position } from '../log';

export interface ImportedReplay {
  log: MatchLog;
  warnings: string[];
}

const SIDE: Record<string, Side> = { p1: 'A', p2: 'B' };
const WEATHER: Record<string, string> = { SunnyDay: 'Sun', RainDance: 'Rain', Sandstorm: 'Sand', Snowscape: 'Snow', Hail: 'Hail', none: 'none' };

/** "p1a: Brute Bonnet" → { side, position, nick }. */
function parseSlot(token: string): { side: Side; position: Position; nick: string } | null {
  const m = /^(p[12])([ab]):\s*(.+)$/.exec(token.trim());
  if (!m) return null;
  return { side: SIDE[m[1]!]!, position: m[2] === 'a' ? 0 : 1, nick: m[3]!.trim() };
}

/** "150/183" / "72/100" / "0 fnt" → { hp, max }. max is 100 for a percent replay. */
function parseHp(token: string): { hp: number; max: number } {
  const t = token.trim();
  if (/^0 fnt/.test(t)) return { hp: 0, max: 0 };
  const m = /^(\d+)\/(\d+)/.exec(t);
  return m ? { hp: Number(m[1]), max: Number(m[2]) } : { hp: 0, max: 0 };
}

const speciesOf = (detail: string): string => detail.split(',')[0]!.trim();

export function parseShowdownReplay(protocol: string): ImportedReplay {
  const warnings: string[] = [];
  const players: Record<Side, string> = { A: 'Player 1', B: 'Player 2' };
  const mons: Record<Side, Array<{ monId: string; species: string; maxHp: number; nickname?: string }>> = { A: [], B: [] };
  const idByKey = new Map<string, string>(); // `${side}|${nick}` → monId
  const slotMon: Record<string, string> = {}; // "p1a" → monId
  const monMax: Record<string, number> = {}; // monId → maxHp (best known)
  const hp: Record<string, number> = {}; // monId → current HP
  const isPercent: Record<string, boolean> = {};
  const events: MatchEvent[] = [];
  const leads: MatchLog['leads'] = [];
  let result: MatchLog['result'];
  let turn = 0;
  let seq = 0;
  let started = false;
  let pendingCrit = false;
  let lastMove: { user: string; move: string } | null = null;

  const ensureMon = (side: Side, nick: string, detail: string, max: number): string => {
    const key = `${side}|${nick}`;
    let id = idByKey.get(key);
    if (!id) {
      id = `${side}${mons[side].length}`;
      idByKey.set(key, id);
      mons[side].push({ monId: id, species: speciesOf(detail), maxHp: max || 100, ...(nick !== speciesOf(detail) ? { nickname: nick } : {}) });
    }
    if (max && max !== 100) {
      monMax[id] = max;
      const entry = mons[side].find((m) => m.monId === id);
      if (entry) entry.maxHp = max;
    } else if (max === 100) {
      isPercent[id] = true;
    }
    return id;
  };

  for (const raw of protocol.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const parts = line.slice(1).split('|');
    const cmd = parts[0];

    switch (cmd) {
      case 'player': {
        const side = SIDE[parts[1] ?? ''];
        if (side && parts[2]) players[side] = parts[2];
        break;
      }
      case 'turn':
        turn = Number(parts[1]) || turn + 1;
        started = true;
        events.push({ eventId: `e${++seq}`, seq, turn, type: 'turn_start' });
        break;
      case 'switch':
      case 'drag': {
        const slot = parseSlot(parts[1] ?? '');
        if (!slot) break;
        const detail = parts[2] ?? '';
        const { hp: h, max } = parseHp(parts[3] ?? '');
        const id = ensureMon(slot.side, slot.nick, detail, max);
        const key = `${slot.side === 'A' ? 'p1' : 'p2'}${slot.position === 0 ? 'a' : 'b'}`;
        const out = slotMon[key];
        hp[id] = h;
        if (!started) {
          leads.push({ side: slot.side, position: slot.position, monId: id });
        } else {
          events.push({ eventId: `e${++seq}`, seq, turn, type: 'switch', side: slot.side, position: slot.position, in: id, ...(out && out !== id ? { out } : {}) });
        }
        slotMon[key] = id;
        break;
      }
      case 'move': {
        const user = parseSlot(parts[1] ?? '');
        const move = parts[2] ?? '';
        const tgt = parseSlot(parts[3] ?? '');
        if (!user) break;
        const userId = slotMon[`${user.side === 'A' ? 'p1' : 'p2'}${user.position === 0 ? 'a' : 'b'}`];
        if (!userId) break;
        const targetId = tgt ? slotMon[`${tgt.side === 'A' ? 'p1' : 'p2'}${tgt.position === 0 ? 'a' : 'b'}`] : undefined;
        lastMove = { user: userId, move };
        events.push({ eventId: `e${++seq}`, seq, turn, type: 'move_used', user: userId, move, targets: targetId ? [targetId] : [] });
        break;
      }
      case '-crit':
        pendingCrit = true;
        break;
      case '-damage':
      case '-heal': {
        const slot = parseSlot(parts[1] ?? '');
        if (!slot) break;
        const id = slotMon[`${slot.side === 'A' ? 'p1' : 'p2'}${slot.position === 0 ? 'a' : 'b'}`];
        if (!id) break;
        const { hp: newHp } = parseHp(parts[2] ?? '');
        const before = hp[id] ?? newHp;
        const from = parts.find((p) => p.startsWith('[from]'))?.replace('[from]', '').trim();
        hp[id] = newHp;
        if (cmd === '-heal') {
          events.push({ eventId: `e${++seq}`, seq, turn, type: 'heal', target: id, source: from ?? 'heal', hpBefore: before, hpAfter: newHp });
        } else if (from || !lastMove) {
          // residual / item / status damage — not a move factor
          events.push({ eventId: `e${++seq}`, seq, turn, type: 'passive_hp_change', target: id, source: from ?? 'chip', hpBefore: before, hpAfter: newHp });
        } else {
          const clean = !isPercent[id];
          events.push({ eventId: `e${++seq}`, seq, turn, type: 'damage', attacker: lastMove.user, move: lastMove.move, defender: id, hpBefore: before, hpAfter: newHp, crit: pendingCrit, status: clean ? 'clean' : 'unresolved' });
        }
        pendingCrit = false;
        break;
      }
      case 'faint': {
        const slot = parseSlot(parts[1] ?? '');
        const id = slot ? slotMon[`${slot.side === 'A' ? 'p1' : 'p2'}${slot.position === 0 ? 'a' : 'b'}`] : undefined;
        if (id) events.push({ eventId: `e${++seq}`, seq, turn, type: 'faint', target: id });
        break;
      }
      case '-status': {
        const slot = parseSlot(parts[1] ?? '');
        const id = slot ? slotMon[`${slot.side === 'A' ? 'p1' : 'p2'}${slot.position === 0 ? 'a' : 'b'}`] : undefined;
        if (id && parts[2]) events.push({ eventId: `e${++seq}`, seq, turn, type: 'status_applied', target: id, status: parts[2] });
        break;
      }
      case '-boost':
      case '-unboost': {
        const slot = parseSlot(parts[1] ?? '');
        const id = slot ? slotMon[`${slot.side === 'A' ? 'p1' : 'p2'}${slot.position === 0 ? 'a' : 'b'}`] : undefined;
        const stages = (Number(parts[3]) || 0) * (cmd === '-unboost' ? -1 : 1);
        if (id && parts[2]) events.push({ eventId: `e${++seq}`, seq, turn, type: 'stat_stage_change', target: id, stat: parts[2], stages });
        break;
      }
      case '-weather': {
        const w = WEATHER[parts[1] ?? ''] ?? parts[1];
        if (w === 'none') events.push({ eventId: `e${++seq}`, seq, turn, type: 'field_change', field: 'weather', action: 'end' });
        else if (w && !parts.some((p) => p.startsWith('[upkeep]'))) events.push({ eventId: `e${++seq}`, seq, turn, type: 'field_change', field: w, action: 'set' });
        break;
      }
      case '-fieldstart':
      case '-fieldend': {
        const field = (parts[1] ?? '').replace('move:', '').trim();
        if (field) events.push({ eventId: `e${++seq}`, seq, turn, type: 'field_change', field, action: cmd === '-fieldstart' ? 'set' : 'end' });
        break;
      }
      case '-sidestart':
      case '-sideend': {
        const side = SIDE[(parts[1] ?? '').split(':')[0]!.trim()];
        const field = (parts[2] ?? '').replace('move:', '').trim();
        if (side && field) events.push({ eventId: `e${++seq}`, seq, turn, type: 'field_change', field, action: cmd === '-sidestart' ? 'set' : 'end', side });
        break;
      }
      case 'win': {
        const name = parts[1] ?? '';
        const winnerSide: Side = name === players.B ? 'B' : 'A';
        result = { winnerSide, reason: 'ko' };
        break;
      }
      default:
        break;
    }
  }

  if (Object.values(isPercent).some(Boolean)) {
    warnings.push('Some HP was shown as percent (spectator replay) — those damage events were imported as "unresolved" (they replay but won\'t feed the solver). Correct them to exact HP to use them.');
  }
  if (mons.A.length === 0 && mons.B.length === 0) warnings.push('No Pokémon were parsed — is this a Showdown battle log?');

  const log: MatchLog = {
    matchId: 'imported',
    format: 'Champions Reg M-A',
    sideA: { player: players.A, mons: mons.A.map((m) => ({ monId: m.monId, species: m.species, maxHp: m.maxHp, ...(m.nickname ? { nickname: m.nickname } : {}) })) },
    sideB: { player: players.B, mons: mons.B.map((m) => ({ monId: m.monId, species: m.species, maxHp: m.maxHp, ...(m.nickname ? { nickname: m.nickname } : {}) })) },
    leads,
    events,
    ...(result ? { result } : {}),
  };
  return { log, warnings };
}
