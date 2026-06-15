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
  sideA: SideState;
  sideB: SideState;
  events: MatchEvent[];
}

export function emptyWorkspace(): Workspace {
  return {
    sideA: { player: 'You', rawPaste: '', mons: [], leads: [] },
    sideB: { player: 'Opponent', rawPaste: '', mons: [], leads: [] },
    events: [],
  };
}

/** The two starting mon ids for a side (selected leads, or the first two as a fallback). */
export function leadMonIds(side: SideState): string[] {
  const valid = (side.leads ?? []).filter((id) => side.mons.some((m) => m.monId === id));
  return valid.length ? valid.slice(0, 2) : side.mons.slice(0, 2).map((m) => m.monId);
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
  const leads = [
    ...leadMonIds(ws.sideA).map((monId, i) => ({ side: 'A' as const, position: i as Position, monId })),
    ...leadMonIds(ws.sideB).map((monId, i) => ({ side: 'B' as const, position: i as Position, monId })),
  ];
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
  const data = Dex.moves.get(move);
  const targetType = data.exists ? data.target : 'normal';
  const isDamaging = data.category !== 'Status';

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

/** Mega formes available for a species (dex-validated; no invented data). */
export function megaFormesFor(species: string): string[] {
  const gen = championsGen();
  return [`${species}-Mega`, `${species}-Mega-X`, `${species}-Mega-Y`].filter((c) => gen.species.get(toID(c)));
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
