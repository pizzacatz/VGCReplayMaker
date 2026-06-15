/**
 * UI ↔ engine bridge. The React app holds a Workspace (teams + event log) and
 * calls these helpers, which reuse the tested src/ modules (no logic here).
 */

import { toID } from '@smogon/calc';
import { Dex } from '@pkmn/dex';
import { championsGen, type MonSpec } from '../engine';
import { ConstraintSystem, type SolveResult } from '../solver';
import { parsePokepaste, type ParsedMon } from '../import';
import { extractCleanHits, extractSpeedFacts } from '../integration';
import { ReplayPlayer, toProtocol, type ReplayState } from '../replay';
import type { MatchEvent, MatchLog, Position, Side } from '../log';

export interface MonEntry {
  monId: string;
  parsed: ParsedMon;
  /** observed max HP (from video) — needed to read SP_hp */
  observedMaxHp: number;
}

export interface SideState {
  player: string;
  rawPaste: string;
  mons: MonEntry[];
  /** the two starting Pokémon (positions 0/1). Defaults to the first two; user-selectable. */
  leads?: string[];
}

export interface Workspace {
  /** tournament/round label, e.g. "Top 4B", "Round 8" */
  round?: string;
  sideA: SideState;
  sideB: SideState;
  events: MatchEvent[];
}

export function emptyWorkspace(): Workspace {
  return {
    round: '',
    sideA: { player: 'Player 1', rawPaste: '', mons: [], leads: [] },
    sideB: { player: 'Player 2', rawPaste: '', mons: [], leads: [] },
    events: [],
  };
}

/**
 * The two lead SLOTS [left, right] for a side, '' where empty. Positions are
 * preserved (unlike leadMonIds, which drops empties). Undefined leads (legacy)
 * default to the first two.
 */
export function leadSlots(side: SideState): [string, string] {
  const valid = (id?: string): string => (id && side.mons.some((m) => m.monId === id) ? id : '');
  if (side.leads !== undefined) return [valid(side.leads[0]), valid(side.leads[1])];
  return [side.mons[0]?.monId ?? '', side.mons[1]?.monId ?? ''];
}

/** The starting mon ids for a side (non-empty lead slots, left→right order). */
export function leadMonIds(side: SideState): string[] {
  return leadSlots(side).filter(Boolean);
}

export type SideId = 'A' | 'B';

export function allMons(ws: Workspace): Array<MonEntry & { side: SideId }> {
  return [
    ...ws.sideA.mons.map((m) => ({ ...m, side: 'A' as const })),
    ...ws.sideB.mons.map((m) => ({ ...m, side: 'B' as const })),
  ];
}

export function monLabel(ws: Workspace, monId: string): string {
  const m = allMons(ws).find((x) => x.monId === monId);
  return m ? `${m.parsed.species}${m.parsed.nickname ? ` (${m.parsed.nickname})` : ''}` : monId;
}

/** Parse one side's pokepaste into MonEntries (monIds assigned A0/A1/… per side). */
export function parseSide(side: SideId, paste: string): { mons: MonEntry[]; error?: string } {
  try {
    const result = parsePokepaste(paste);
    return {
      mons: result.mons.map((parsed, i) => ({ monId: `${side}${i}`, parsed, observedMaxHp: defaultMaxHp(parsed) })),
    };
  } catch (e) {
    return { mons: [], error: (e as Error).message };
  }
}

/** A reasonable starting max-HP guess (base + 75), to be corrected from video. */
function defaultMaxHp(parsed: ParsedMon): number {
  try {
    const base = championsGen().species.get(toID(parsed.species))?.baseStats.hp;
    return base ? base + 75 : 175;
  } catch {
    return 175;
  }
}

export function toSpec(parsed: ParsedMon): MonSpec {
  return {
    species: parsed.species,
    alignment: parsed.alignment,
    ...(parsed.item ? { item: parsed.item } : {}),
    ...(parsed.ability ? { ability: parsed.ability } : {}),
  };
}

export function buildLog(ws: Workspace): MatchLog {
  const sheet = (m: MonEntry) => ({ monId: m.monId, species: m.parsed.species, maxHp: m.observedMaxHp, ...(m.parsed.nickname ? { nickname: m.parsed.nickname } : {}) });
  const slotLeads = (side: SideState, sideId: SideId) =>
    leadSlots(side)
      .map((monId, i) => (monId ? { side: sideId, position: i as Position, monId } : null))
      .filter((x): x is { side: SideId; position: Position; monId: string } => x !== null);
  const leads = [...slotLeads(ws.sideA, 'A'), ...slotLeads(ws.sideB, 'B')];
  return {
    matchId: 'workspace',
    format: 'Champions Reg M-A',
    sideA: { player: ws.sideA.player, mons: ws.sideA.mons.map(sheet) },
    sideB: { player: ws.sideB.player, mons: ws.sideB.mons.map(sheet) },
    leads,
    events: [...ws.events].sort((a, b) => a.seq - b.seq),
  };
}

export function specsOf(ws: Workspace): Map<string, MonSpec> {
  return new Map(allMons(ws).map((m) => [m.monId, toSpec(m.parsed)]));
}

/** Run the full solve from the workspace (extract clean hits + speed facts → solve). */
export function runSolve(ws: Workspace): SolveResult {
  const gen = championsGen();
  const log = buildLog(ws);
  const specs = specsOf(ws);
  const hits = extractCleanHits(log);
  const speed = extractSpeedFacts(log, gen, specs).facts.map((f) => ({
    firstId: f.first,
    secondId: f.second,
    samePriorityBracket: f.samePriorityBracket,
    ...(f.trickRoom ? { trickRoom: true } : {}),
  }));
  const mons = allMons(ws).map((m) => ({ id: m.monId, spec: toSpec(m.parsed), observedMaxHp: m.observedMaxHp }));
  const system = new ConstraintSystem(gen, mons, hits, speed);
  for (const m of allMons(ws)) {
    if (!m.parsed.spSpread) continue;
    for (const stat of ['atk', 'def', 'spa', 'spd', 'spe'] as const) {
      system.restrictDomain(m.monId, stat, [m.parsed.spSpread[stat]]);
    }
  }
  return system.solve();
}

let seqCounter = 0;
export function nextEventId(): string {
  seqCounter += 1;
  return `e${seqCounter}_${Math.floor(performance.now())}`;
}

// ── Board / smart-targeting helpers (for the click-first transcription flow) ──

const SLOT_KEYS = ['p1a', 'p1b', 'p2a', 'p2b'] as const;

/** The active board after all current events (HP/species reconstructed). Null if the log is invalid. */
export function currentBoard(ws: Workspace): ReplayState | null {
  try {
    const player = new ReplayPlayer(toProtocol(buildLog(ws)));
    return player.stateAt(player.length - 1);
  } catch {
    return null;
  }
}

export function slotOfMon(board: ReplayState, monId: string): string | null {
  for (const key of SLOT_KEYS) if (board.slots[key]?.monId === monId) return key;
  return null;
}

const sideOfSlot = (slot: string): Side => (slot.startsWith('p1') ? 'A' : 'B');

/** Active mon ids on a side. */
export function activeMonIds(board: ReplayState): Array<{ slot: string; monId: string; species: string; hp: number; maxHp: number; side: Side; fainted: boolean }> {
  const out: Array<{ slot: string; monId: string; species: string; hp: number; maxHp: number; side: Side; fainted: boolean }> = [];
  for (const key of SLOT_KEYS) {
    const s = board.slots[key];
    if (s) out.push({ slot: key, monId: s.monId, species: s.species, hp: s.hp, maxHp: s.maxHp, side: sideOfSlot(key), fainted: s.fainted });
  }
  return out;
}

/** Bench (non-active, non-fainted) mons on a side — for switch-in choices. */
export function benchMons(ws: Workspace, side: Side, board: ReplayState): MonEntry[] {
  const activeIds = new Set(activeMonIds(board).map((m) => m.monId));
  const faintedIds = new Set(activeMonIds(board).filter((m) => m.fainted).map((m) => m.monId));
  const roster = side === 'A' ? ws.sideA.mons : ws.sideB.mons;
  return roster.filter((m) => !activeIds.has(m.monId) && !faintedIds.has(m.monId));
}

export type TargetScope = 'foes' | 'ally' | 'self' | 'field';
export interface TargetPlan {
  scope: TargetScope;
  spread: boolean;
  /** candidate target mon ids, foes first (empty for field moves) */
  candidates: string[];
  isDamaging: boolean;
}

/** Resolve a move's legal targets from dex target data — foes first (the smart bit). */
export function planTargets(move: string, actorMonId: string, board: ReplayState): TargetPlan {
  // @pkmn/dex has full move targeting data (the calc omits `target` for status moves).
  // Defensive: fall back to a single foe-targeting damaging move if lookup fails.
  let targetType = 'normal';
  let isDamaging = true;
  try {
    const data = Dex.moves.get(move);
    if (data.exists) {
      targetType = data.target;
      isDamaging = data.category !== 'Status';
    }
  } catch {
    /* keep defaults */
  }

  const actorSlot = slotOfMon(board, actorMonId);
  const actorSide: Side = actorSlot ? sideOfSlot(actorSlot) : 'A';
  const actives = activeMonIds(board).filter((m) => !m.fainted);
  const foes = actives.filter((m) => m.side !== actorSide).map((m) => m.monId);
  const ally = actives.filter((m) => m.side === actorSide && m.monId !== actorMonId).map((m) => m.monId);

  switch (targetType) {
    case 'self':
      return { scope: 'self', spread: false, candidates: [actorMonId], isDamaging };
    case 'adjacentAlly':
      return { scope: 'ally', spread: false, candidates: ally, isDamaging };
    case 'adjacentAllyOrSelf':
      return { scope: 'ally', spread: false, candidates: [...ally, actorMonId], isDamaging };
    case 'allAdjacentFoes':
    case 'foeSide':
      return { scope: 'foes', spread: true, candidates: foes, isDamaging };
    case 'allAdjacent':
      return { scope: 'foes', spread: true, candidates: [...foes, ...ally], isDamaging };
    case 'allySide':
    case 'allyTeam':
    case 'all':
      return { scope: 'field', spread: false, candidates: [], isDamaging };
    default:
      // normal / any / randomNormal / scripted → single, foes first then ally
      return { scope: 'foes', spread: false, candidates: [...foes, ...ally], isDamaging };
  }
}

/**
 * The mega forme a mon evolves into — determined ENTIRELY by its held Mega Stone
 * (no player choice; the stone dictates the forme). Returns null if the item is
 * not a mega stone for this species. Dex-driven, no invented data.
 */
export function megaFormeFromItem(item: string | undefined, species: string): string | null {
  if (!item) return null;
  try {
    const data = Dex.items.get(item) as { exists: boolean; megaStone?: Record<string, string> };
    if (!data.exists || !data.megaStone) return null;
    return data.megaStone[species] ?? Object.values(data.megaStone)[0] ?? null;
  } catch {
    return null;
  }
}

interface DexTypeOps {
  getEffectiveness(source: string, target: string): number;
  getImmunity(source: string, target: string): boolean;
}

/** Self-protect volatiles that block damage (Endure deliberately excluded — it doesn't block). */
const PROTECT_VOLATILES = new Set(['protect', 'spikyshield', 'banefulbunker', 'kingsshield', 'maxguard', 'silktrap', 'obstruct', 'burningbulwark']);

function rosterSideOf(ws: Workspace, monId: string): SideId | null {
  if (ws.sideA.mons.some((m) => m.monId === monId)) return 'A';
  if (ws.sideB.mons.some((m) => m.monId === monId)) return 'B';
  return null;
}

/**
 * Whether a damaging move on `targetMonId` is blocked this turn by a protection
 * move — self-protect (Protect/Detect/Spiky Shield/King's Shield/Max Guard…),
 * Wide Guard (spread moves), or Quick Guard (priority moves). Returns the
 * blocking move's name, or null. Moves with breaksProtect (Feint) bypass it.
 */
export function protectionBlocking(ws: Workspace, targetMonId: string, incomingMove: string, turn: number): string | null {
  try {
    const m = Dex.moves.get(incomingMove) as { exists: boolean; category: string; target: string; priority?: number; breaksProtect?: boolean };
    if (!m.exists || m.category === 'Status' || m.breaksProtect) return null;
    const targetSide = rosterSideOf(ws, targetMonId);
    const movesThisTurn = ws.events.filter((e): e is Extract<MatchEvent, { type: 'move_used' }> => e.type === 'move_used' && e.turn === turn);
    for (const ev of movesThisTurn) {
      const pm = Dex.moves.get(ev.move) as { volatileStatus?: string; sideCondition?: string; stallingMove?: boolean };
      // self-protect by the target itself
      if (ev.user === targetMonId && pm.stallingMove && pm.volatileStatus && PROTECT_VOLATILES.has(pm.volatileStatus)) return ev.move;
      // side guards on the target's side
      if (rosterSideOf(ws, ev.user) === targetSide) {
        if (pm.sideCondition === 'wideguard' && (m.target === 'allAdjacentFoes' || m.target === 'allAdjacent')) return ev.move;
        if (pm.sideCondition === 'quickguard' && (m.priority ?? 0) > 0) return ev.move;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function effLabel(mult: number): string {
  if (mult === 0) return '0x';
  if (mult === 0.25) return '0.25x';
  if (mult === 0.5) return '0.5x';
  if (mult === 2) return '2x';
  if (mult === 4) return '4x';
  return '1x';
}

function effText(mult: number): string {
  if (mult === 0) return 'Immune (0x)';
  if (mult === 0.25) return 'Mostly Ineffective (0.25x)';
  if (mult === 0.5) return 'Not Very Effective (0.5x)';
  if (mult === 2) return 'Super Effective (2x)';
  if (mult === 4) return 'Extremely Effective (4x)';
  return 'Effective (1x)';
}

export interface Effectiveness {
  mult: number;
  label: string;
  /** human phrasing for the UI */
  text: string;
}

/**
 * Type effectiveness of a move against a defender, derived from the dex type chart
 * (move type vs defender's current types) — so the transcriber doesn't pick it.
 * Returns null for status/unknown moves. Note: does not account for ability-based
 * immunities (Levitate, etc.) — those show up as 0 damage on screen regardless.
 */
export function typeEffectiveness(move: string, defenderSpecies: string): Effectiveness | null {
  try {
    const m = Dex.moves.get(move);
    if (!m.exists || m.category === 'Status') return null;
    const sp = Dex.species.get(defenderSpecies);
    if (!sp.exists) return null;
    const ops = Dex as unknown as DexTypeOps;
    let mult = 1;
    for (const dt of sp.types) {
      if (!ops.getImmunity(m.type, dt)) {
        mult = 0;
        break;
      }
      mult *= 2 ** ops.getEffectiveness(m.type, dt);
    }
    return { mult, label: effLabel(mult), text: effText(mult) };
  } catch {
    return null;
  }
}

/**
 * Whether a move can cause flinch on THIS hit — only true for moves with a flinch
 * secondary, or any damaging move when the attacker holds King's Rock / Razor Fang
 * or has the Stench ability. Used to show the flinch option only where it applies.
 */
export function moveCanFlinch(move: string, attackerItem?: string, attackerAbility?: string): boolean {
  try {
    const m = Dex.moves.get(move);
    if (!m.exists || m.category === 'Status') return false;
    const secs = [m.secondary, ...((m as { secondaries?: Array<{ volatileStatus?: string }> | null }).secondaries ?? [])];
    if (secs.some((s) => s && (s as { volatileStatus?: string }).volatileStatus === 'flinch')) return true;
    if (attackerItem === "King's Rock" || attackerItem === 'Razor Fang') return true;
    if (attackerAbility === 'Stench') return true;
    return false;
  } catch {
    return false;
  }
}

export function slotPosition(slot: string): { side: Side; position: Position } {
  return { side: sideOfSlot(slot), position: slot.endsWith('a') ? 0 : 1 };
}

export const BRING_COUNT = 4; // Champions: bring 4 of 6 (resolved decision)

export interface BroughtInfo {
  /** mon ids known to be brought (leads + everything switched in) */
  brought: string[];
  /** mon ids deduced NOT brought (only once the full bring is known) */
  notBrought: string[];
  /** mon ids still unknown (could be brought) */
  unknown: string[];
  /** true once 4 distinct mons have been seen → the bring is fully determined */
  confirmed: boolean;
}

/**
 * Process of elimination for the bring (DATA_MODEL §2.3). A mon is "brought" once
 * it appears (lead or switch-in). Once 4 distinct mons are seen for a side, the
 * remaining roster mons are deduced NOT brought — and conversely, if only 2
 * roster mons are left unseen they may still be the missing brought pair.
 */
export function broughtInfo(ws: Workspace, side: Side): BroughtInfo {
  const sideState = side === 'A' ? ws.sideA : ws.sideB;
  const leads = leadMonIds(sideState);
  const switchedIn = ws.events
    .filter((e): e is Extract<MatchEvent, { type: 'switch' }> => e.type === 'switch' && e.side === side)
    .map((e) => e.in);
  const broughtSet = new Set([...leads, ...switchedIn].filter((id) => sideState.mons.some((m) => m.monId === id)));
  const brought = sideState.mons.filter((m) => broughtSet.has(m.monId)).map((m) => m.monId);
  const confirmed = brought.length >= BRING_COUNT;
  const rest = sideState.mons.filter((m) => !broughtSet.has(m.monId)).map((m) => m.monId);
  return {
    brought,
    notBrought: confirmed ? rest : [],
    unknown: confirmed ? [] : rest,
    confirmed,
  };
}
