/**
 * Integration (T3.5) — derive the solver's inputs from a transcribed event log.
 *
 * The event log is the shared spine: replay reads everything, the solver reads
 * only the `clean` damage subset (Constitution §D3, the primary guard against
 * silent corruption). This module performs that extraction and the sound
 * derivation of speed facts from move order.
 */

import { toID } from '@smogon/calc';
import type { Gen, HitContext, MonSpec } from '../engine';
import type { SolverHit, SpeedControl } from '../solver';
import type { MatchEvent, MatchLog, Side } from '../log';

/**
 * Moves whose power depends on the Speed stats (Gyro Ball = 25×target/user, Electro
 * Ball = a user/target ratio). Their damage couples to BOTH mons' (unknown) Speed,
 * so it can't be pinned with the offense×defense factor — the calc would silently
 * use default speeds and infer a wrong stat. Excluded from the clean factor set
 * (Constraint §11) until a Speed-coupled factor exists; the hit still replays.
 */
const SPEED_DEPENDENT_MOVES = new Set(['gyroball', 'electroball']);

const WEATHERS = ['Sun', 'Rain', 'Sand', 'Snow', 'Hail'];
const TERRAINS: Record<string, string> = { 'Grassy Terrain': 'Grassy', 'Electric Terrain': 'Electric', 'Psychic Terrain': 'Psychic', 'Misty Terrain': 'Misty' };

const sideOfMon = (log: MatchLog, monId: string): Side => (log.sideA.mons.some((m) => m.monId === monId) ? 'A' : 'B');

/** Net boost stages on a mon just before `seq` (reset when it switches in/out). */
function boostsAt(log: MatchLog, monId: string, seq: number): Record<string, number> {
  let boosts: Record<string, number> = {};
  for (const ev of [...log.events].sort((a, b) => a.seq - b.seq)) {
    if (ev.seq >= seq) break;
    if (ev.type === 'switch' && (ev.out === monId || ev.in === monId)) boosts = {};
    if (ev.type === 'stat_stage_change' && ev.target === monId) {
      boosts[ev.stat] = Math.max(-6, Math.min(6, (boosts[ev.stat] ?? 0) + ev.stages));
    }
  }
  return boosts;
}

/** The Paradox boost (Protosynthesis/Quark Drive) stat active on a mon, lost on switch-out. */
function paradoxBoostAt(log: MatchLog, monId: string, seq: number): string | undefined {
  let stat: string | undefined;
  for (const ev of [...log.events].sort((a, b) => a.seq - b.seq)) {
    if (ev.seq >= seq) break;
    if (ev.type === 'item_or_ability_event' && ev.mon === monId && ev.kind === 'paradox') stat = ev.name;
    if (ev.type === 'switch' && ev.out === monId) stat = undefined;
  }
  return stat;
}

/** The mon active alongside `monId` on its side just before `seq` (its ally), if any. */
function allyAt(log: MatchLog, monId: string, seq: number): string | undefined {
  const side = sideOfMon(log, monId);
  const occ: Record<number, string | undefined> = {};
  for (const l of log.leads) if (l.side === side) occ[l.position] = l.monId;
  for (const ev of [...log.events].sort((a, b) => a.seq - b.seq)) {
    if (ev.seq >= seq) break;
    if (ev.type === 'switch' && ev.side === side) occ[ev.position] = ev.in;
    if (ev.type === 'faint') for (const p of [0, 1]) if (occ[p] === ev.target) occ[p] = undefined;
  }
  const pos = occ[0] === monId ? 0 : occ[1] === monId ? 1 : undefined;
  if (pos === undefined) return undefined;
  return occ[pos === 0 ? 1 : 0];
}

/** The reconstructed field/boosts/burn/Helping-Hand/HP at the moment of a hit (always Doubles). */
function contextAt(log: MatchLog, ev: Extract<MatchEvent, { type: 'damage' }>, specs?: Map<string, MonSpec>): HitContext {
  const { attacker, defender, seq, turn } = ev;
  const ally = specs ? allyAt(log, defender, seq) : undefined;
  const friendGuard = ally ? specs!.get(ally)?.ability === 'Friend Guard' : false;
  const dSide = sideOfMon(log, defender);
  const aSide = sideOfMon(log, attacker);
  const weather = WEATHERS.find((w) => isActiveAt(log, w, undefined, seq));
  let terrain: string | undefined;
  for (const [field, calc] of Object.entries(TERRAINS)) if (isActiveAt(log, field, undefined, seq)) terrain = calc;
  const aBoosts = boostsAt(log, attacker, seq);
  const dBoosts = boostsAt(log, defender, seq);
  const aBoosted = paradoxBoostAt(log, attacker, seq);
  const dBoosted = paradoxBoostAt(log, defender, seq);
  // Helping Hand: an ally boosted THIS attacker earlier in the turn.
  const helpingHand = log.events.some(
    (e) => e.type === 'move_used' && e.move === 'Helping Hand' && e.turn === turn && e.seq < seq && sideOfMon(log, e.user) === aSide && e.targets.includes(attacker),
  );
  // A spread move that hit only one target → drop the Doubles 0.75.
  const mv = log.events.find((e) => e.type === 'move_used' && e.user === attacker && e.move === ev.move && e.turn === turn);
  const singleTargetSpread = mv?.type === 'move_used' && !!mv.isSpread && mv.targets.length <= 1;
  // Multiscale / Shadow Shield only at full HP.
  const defMax = [...log.sideA.mons, ...log.sideB.mons].find((m) => m.monId === defender)?.maxHp ?? 0;
  const defenderFullHp = defMax > 0 ? ev.hpBefore >= defMax : true;
  return {
    ...(weather ? { weather } : {}),
    ...(terrain ? { terrain } : {}),
    ...(isActiveAt(log, 'Reflect', dSide, seq) ? { reflect: true } : {}),
    ...(isActiveAt(log, 'Light Screen', dSide, seq) ? { lightScreen: true } : {}),
    ...(isActiveAt(log, 'Aurora Veil', dSide, seq) ? { auroraVeil: true } : {}),
    ...(Object.keys(aBoosts).length ? { attackerBoosts: aBoosts } : {}),
    ...(Object.keys(dBoosts).length ? { defenderBoosts: dBoosts } : {}),
    ...(isStatusAt(log, attacker, 'brn', seq) ? { attackerBurned: true } : {}),
    ...(aBoosted ? { attackerBoostedStat: aBoosted } : {}),
    ...(dBoosted ? { defenderBoostedStat: dBoosted } : {}),
    ...(helpingHand ? { helpingHand: true } : {}),
    ...(singleTargetSpread ? { singleTargetSpread: true } : {}),
    ...(defenderFullHp ? {} : { defenderFullHp: false }),
    ...(friendGuard ? { friendGuard: true } : {}),
  };
}

/** The Mega forme a mon is in just before `seq` (a mon can't un-Mega), else undefined. */
function megaFormeAt(log: MatchLog, monId: string, seq: number): string | undefined {
  let forme: string | undefined;
  for (const ev of [...log.events].sort((a, b) => a.seq - b.seq)) {
    if (ev.seq >= seq) break;
    if (ev.type === 'mega_evolution' && ev.mon === monId) forme = ev.megaSpecies;
  }
  return forme;
}

/** Clean damage events → solver hits. Composite/unresolved are excluded (§D3). `specs` (optional) enables ability-dependent context (Friend Guard). */
export function extractCleanHits(log: MatchLog, specs?: Map<string, MonSpec>): SolverHit[] {
  const hits: SolverHit[] = [];
  for (const ev of [...log.events].sort((a, b) => a.seq - b.seq)) {
    if (ev.type !== 'damage' || ev.status !== 'clean') continue;
    if (SPEED_DEPENDENT_MOVES.has(toID(ev.move))) continue; // power couples to unknown Speed — can't pin (§11)
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
      context: contextAt(log, ev, specs), // field/boosts/burn/Helping-Hand/spread/HP/Friend-Guard (Doubles)
      ...(ev.hits && ev.hits > 1 ? { hits: ev.hits } : {}), // multi-hit → convolution factor
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
  /** known speed-control multiplier on each mover (Tailwind ×2, paralysis ×0.5, Choice Scarf ×1.5). */
  firstControl?: SpeedControl;
  secondControl?: SpeedControl;
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
 *  - a KNOWN speed-control magnitude is modelled, not discarded: Tailwind (×2),
 *    paralysis (×0.5), and Choice Scarf (×1.5, known from the open sheet) are
 *    emitted as the mover's control. Only genuinely un-pinnable cases are SKIPPED:
 *    an UNSHEETED mover (could hold an unknown Choice item), or STACKED modifiers
 *    on one mover (a single num/den floor can't reproduce the chained flooring);
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
        const ca = speedControl(log, specs, a.user, a.seq);
        const cb = speedControl(log, specs, b.user, a.seq);
        if (ca.skip || cb.skip) {
          skipped.push({ turn, first: a.user, second: b.user, reason: ca.reason ?? cb.reason ?? 'unknown' });
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
          ...(ca.control ? { firstControl: ca.control } : {}),
          ...(cb.control ? { secondControl: cb.control } : {}),
        });
      }
    }
  }
  return { facts, skipped };

  /** A mover's known speed-control multiplier, or a skip reason when it can't be pinned. */
  function speedControl(
    l: MatchLog,
    sp: Map<string, MonSpec>,
    mon: string,
    seq: number,
  ): { control?: SpeedControl; skip: boolean; reason?: string } {
    if (!sp.has(mon)) return { skip: true, reason: `${mon} unsheeted (cannot rule out a Choice item)` };
    const mods: SpeedControl[] = [];
    if (isActiveAt(l, 'Tailwind', sideOf(mon), seq)) mods.push({ num: 2, den: 1 });
    if (isStatusAt(l, mon, 'par', seq)) mods.push({ num: 1, den: 2 });
    if (sp.get(mon)?.item === 'Choice Scarf') mods.push({ num: 3, den: 2 });
    if (mods.length === 0) return { skip: false };
    if (mods.length === 1) return { control: mods[0]!, skip: false };
    return { skip: true, reason: `${mon} has stacked speed modifiers (single floor can't reproduce chained flooring)` };
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
