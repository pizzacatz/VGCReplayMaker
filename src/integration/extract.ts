/**
 * Integration (T3.5) — derive the solver's inputs from a transcribed event log.
 *
 * The event log is the shared spine: replay reads everything, the solver reads
 * only the `clean` damage subset (Constitution §D3, the primary guard against
 * silent corruption). This module performs that extraction and the sound
 * derivation of speed facts from move order.
 */

import { toID } from '@smogon/calc';
import type { Gen, MonSpec } from '../engine';
import type { SolverHit } from '../solver';
import type { MatchEvent, MatchLog, Side } from '../log';

/** The Mega forme a mon is in just before `seq` (a mon can't un-Mega), else undefined. */
function megaFormeAt(log: MatchLog, monId: string, seq: number): string | undefined {
  let forme: string | undefined;
  for (const ev of [...log.events].sort((a, b) => a.seq - b.seq)) {
    if (ev.seq >= seq) break;
    if (ev.type === 'mega_evolution' && ev.mon === monId) forme = ev.megaSpecies;
  }
  return forme;
}

/** Clean damage events → solver hits. Composite/unresolved are excluded (§D3). */
export function extractCleanHits(log: MatchLog): SolverHit[] {
  const hits: SolverHit[] = [];
  for (const ev of [...log.events].sort((a, b) => a.seq - b.seq)) {
    if (ev.type !== 'damage' || ev.status !== 'clean') continue;
    const aForme = megaFormeAt(log, ev.attacker, ev.seq); // post-Mega hits use the Mega's stats
    const dForme = megaFormeAt(log, ev.defender, ev.seq);
    hits.push({
      attackerId: ev.attacker,
      defenderId: ev.defender,
      move: ev.move,
      observedDamage: ev.hpBefore - ev.hpAfter, // exact integer (Constitution §C3)
      ...(ev.crit ? { crit: ev.crit } : {}),
      ...(aForme ? { attackerSpecies: aForme } : {}),
      ...(dForme ? { defenderSpecies: dForme } : {}),
      source: `T${ev.turn}`, // game/round context prepended by the caller (drill-down)
      eventId: ev.eventId, // lets the UI exclude this exact hit
    });
  }
  return hits;
}

export interface ExtractedSpeedFact {
  first: string;
  second: string;
  samePriorityBracket: boolean;
  trickRoom?: boolean;
  /** Mega forme of each mover at the time (changes its Speed base), if any. */
  firstSpecies?: string;
  secondSpecies?: string;
}

export interface SpeedExtraction {
  facts: ExtractedSpeedFact[];
  /** orderings deliberately NOT turned into facts, with why (kept honest) */
  skipped: Array<{ turn: number; first: string; second: string; reason: string }>;
}

/**
 * Derive speed facts from move order within each turn (Constraint §4). SOUND by
 * construction:
 *  - only SAME-priority-bracket orderings inform Speed (the mandatory guard);
 *  - an ordering is emitted only when the effective-speed comparison is exact —
 *    i.e. no un-modelled speed-control magnitude (Tailwind / paralysis / Choice
 *    Scarf) on either mover. Those orderings are SKIPPED, not guessed wrong;
 *  - Trick Room only reverses the comparison (no magnitude change), so TR turns
 *    are emitted with the flag.
 */
export function extractSpeedFacts(log: MatchLog, gen: Gen, specs: Map<string, MonSpec>): SpeedExtraction {
  const facts: ExtractedSpeedFact[] = [];
  const skipped: SpeedExtraction['skipped'] = [];
  const events = [...log.events].sort((a, b) => a.seq - b.seq);
  const priorityOf = (move: string): number => gen.moves.get(toID(move))?.priority ?? 0;
  const sideOf = (monId: string): Side => (log.sideA.mons.some((m) => m.monId === monId) ? 'A' : 'B');

  const byTurn = new Map<number, Array<{ user: string; move: string; seq: number }>>();
  for (const ev of events) {
    if (ev.type !== 'move_used') continue;
    const list = byTurn.get(ev.turn) ?? [];
    list.push({ user: ev.user, move: ev.move, seq: ev.seq });
    byTurn.set(ev.turn, list);
  }

  for (const [turn, moves] of byTurn) {
    for (let i = 0; i < moves.length; i++) {
      for (let j = i + 1; j < moves.length; j++) {
        const a = moves[i]!;
        const b = moves[j]!;
        if (priorityOf(a.move) !== priorityOf(b.move)) continue; // §4 guard: different bracket → no info
        const reason = controlReason(log, gen, specs, a.user, b.user, a.seq);
        if (reason) {
          skipped.push({ turn, first: a.user, second: b.user, reason });
          continue;
        }
        const fForme = megaFormeAt(log, a.user, a.seq);
        const sForme = megaFormeAt(log, b.user, a.seq);
        facts.push({
          first: a.user,
          second: b.user,
          samePriorityBracket: true,
          ...(isActiveAt(log, 'Trick Room', undefined, a.seq) ? { trickRoom: true } : {}),
          ...(fForme ? { firstSpecies: fForme } : {}),
          ...(sForme ? { secondSpecies: sForme } : {}),
        });
      }
    }
  }
  return { facts, skipped };

  function controlReason(
    l: MatchLog,
    g: Gen,
    sp: Map<string, MonSpec>,
    first: string,
    second: string,
    seq: number,
  ): string | null {
    for (const mon of [first, second]) {
      if (isActiveAt(l, 'Tailwind', sideOf(mon), seq)) return `Tailwind active on side ${sideOf(mon)}`;
      if (isStatusAt(l, mon, 'par', seq)) return `${mon} paralyzed`;
      const item = sp.get(mon)?.item;
      if (item === 'Choice Scarf') return `${mon} holds Choice Scarf`;
      if (!sp.has(mon)) return `${mon} unsheeted (cannot rule out a Choice item)`;
    }
    return null;
  }
}

/** Whether a field/side condition is active just before `seq` (last set/end wins). */
function isActiveAt(log: MatchLog, field: string, side: Side | undefined, seq: number): boolean {
  let active = false;
  for (const ev of orderedFieldChanges(log)) {
    if (ev.seq >= seq) break;
    if (ev.field !== field) continue;
    if (side !== undefined && ev.side !== side) continue;
    active = ev.action === 'set';
  }
  return active;
}

function isStatusAt(log: MatchLog, monId: string, status: string, seq: number): boolean {
  let active = false;
  for (const ev of [...log.events].sort((a, b) => a.seq - b.seq)) {
    if (ev.seq >= seq) break;
    if (ev.type === 'status_applied' && ev.target === monId && ev.status === status) active = true;
    if (ev.type === 'status_cured' && ev.target === monId && ev.status === status) active = false;
  }
  return active;
}

function orderedFieldChanges(log: MatchLog): Array<Extract<MatchEvent, { type: 'field_change' }>> {
  return log.events
    .filter((e): e is Extract<MatchEvent, { type: 'field_change' }> => e.type === 'field_change')
    .sort((a, b) => a.seq - b.seq);
}
