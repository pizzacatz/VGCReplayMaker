/**
 * UI ↔ engine bridge. The React app holds a Workspace (teams + event log) and
 * calls these helpers, which reuse the tested src/ modules (no logic here).
 */

import { toID, Pokemon as CalcPokemon, Move as CalcMove, Field as CalcField, Side as CalcSide, calculate } from '@smogon/calc';
import { Dex } from '@pkmn/dex';
import { championsGen, natureFor, type MonSpec } from '../engine';
import type { SpSpread } from '../conversion';
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

// ── Deterministic resolver: auto-derive the consequences the engine knows ────

/** Game-universal ability → weather (constants, not Champions-specific). */
const WEATHER_ABILITIES: Record<string, string> = {
  Drought: 'Sun', 'Orichalcum Pulse': 'Sun', 'Desolate Land': 'Sun',
  Drizzle: 'Rain', 'Primordial Sea': 'Rain',
  'Sand Stream': 'Sand', 'Snow Warning': 'Snow',
};
const TERRAIN_ABILITIES: Record<string, string> = {
  'Electric Surge': 'Electric Terrain', 'Hadron Engine': 'Electric Terrain',
  'Grassy Surge': 'Grassy Terrain', 'Psychic Surge': 'Psychic Terrain', 'Misty Surge': 'Misty Terrain',
};

export type EventBuilder = (seq: number, turn: number) => MatchEvent;

/** A mon's ability from its sheet. */
export function monAbility(ws: Workspace, monId: string): string | undefined {
  return allMons(ws).find((m) => m.monId === monId)?.parsed.ability;
}

/** The ability a mega forme gains (e.g. Charizard-Mega-Y → Drought). */
export function megaFormeAbility(forme: string): string | undefined {
  try {
    const a = Dex.species.get(forme).abilities as unknown as Record<string, string>;
    return a?.['0'];
  } catch {
    return undefined;
  }
}

/**
 * Events the engine derives when a mon ENTERS the field (lead, switch-in, or mega):
 * Intimidate drops every opposing active mon's Attack; weather/terrain-setting
 * abilities set the field. `includeIntimidate` is false for mega (the mon was
 * already on the field, so only the new ability's weather/terrain fires).
 */
export function entryEffectEvents(ws: Workspace, monId: string, ability: string | undefined, board: ReplayState, includeIntimidate: boolean): EventBuilder[] {
  const out: EventBuilder[] = [];
  if (!ability) return out;
  if (includeIntimidate && ability === 'Intimidate') {
    const side = rosterSideOf(ws, monId);
    for (const foe of activeMonIds(board).filter((m) => m.side !== side && !m.fainted)) {
      const target = foe.monId;
      out.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'stat_stage_change', target, stat: 'atk', stages: -1, source: 'Intimidate' }));
    }
  }
  const weather = WEATHER_ABILITIES[ability];
  if (weather) out.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'field_change', field: weather, action: 'set' }));
  const terrain = TERRAIN_ABILITIES[ability];
  if (terrain) out.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: 'field_change', field: terrain, action: 'set' }));
  return out;
}

export function monItem(ws: Workspace, monId: string): string | undefined {
  return allMons(ws).find((m) => m.monId === monId)?.parsed.item;
}
export function monMaxHp(ws: Workspace, monId: string): number {
  return allMons(ws).find((m) => m.monId === monId)?.observedMaxHp ?? 0;
}
export function moveMakesContact(move: string): boolean {
  try {
    return !!(Dex.moves.get(move) as { flags?: { contact?: number } }).flags?.contact;
  } catch {
    return false;
  }
}
function speciesTypes(species: string): string[] {
  try {
    return [...Dex.species.get(species).types];
  } catch {
    return [];
  }
}

const WEATHER_CALC: Record<string, string> = { Sun: 'Sun', Rain: 'Rain', Sand: 'Sand', Snow: 'Snow', Hail: 'Hail' };
const TERRAIN_CALC: Record<string, string> = { 'Grassy Terrain': 'Grassy', 'Electric Terrain': 'Electric', 'Psychic Terrain': 'Psychic', 'Misty Terrain': 'Misty' };

function evsFromSpread(s?: SpSpread): Record<string, number> | undefined {
  return s ? { hp: s.hp * 8, atk: s.atk * 8, def: s.def * 8, spa: s.spa * 8, spd: s.spd * 8, spe: s.spe * 8 } : undefined;
}

/**
 * Estimate a move's damage with @smogon/calc, applying the reconstructed field
 * (weather/terrain/screens) and current boosts/burn — to PRE-FILL HP-after. Uses
 * each mon's known spread if present, else neutral defaults. It's a starting
 * estimate (especially for unknown opponents); the transcriber corrects it.
 */
export function estimateDamage(ws: Workspace, board: ReplayState, attackerId: string, defenderId: string, move: string, crit: boolean): { min: number; max: number; avg: number } | null {
  try {
    const gen = championsGen();
    const aEntry = allMons(ws).find((m) => m.monId === attackerId);
    const dEntry = allMons(ws).find((m) => m.monId === defenderId);
    if (!aEntry || !dEntry) return null;
    const aSpec = toSpec(aEntry.parsed);
    const dSpec = toSpec(dEntry.parsed);
    const aEvs = evsFromSpread(aEntry.parsed.spSpread);
    const dEvs = evsFromSpread(dEntry.parsed.spSpread);
    const attacker = new CalcPokemon(gen, board.slots[slotOfMon(board, attackerId) ?? '']?.species ?? aSpec.species, {
      level: 50, nature: natureFor(aSpec.alignment),
      ...(aEvs ? { evs: aEvs } : {}), ...(aSpec.item ? { item: aSpec.item } : {}), ...(aSpec.ability ? { ability: aSpec.ability } : {}),
      ...(board.boosts[attackerId] ? { boosts: board.boosts[attackerId] } : {}),
      ...(board.status[attackerId] === 'brn' ? { status: 'brn' as const } : {}),
    });
    const defender = new CalcPokemon(gen, board.slots[slotOfMon(board, defenderId) ?? '']?.species ?? dSpec.species, {
      level: 50, nature: natureFor(dSpec.alignment),
      ...(dEvs ? { evs: dEvs } : {}), ...(dSpec.item ? { item: dSpec.item } : {}), ...(dSpec.ability ? { ability: dSpec.ability } : {}),
      ...(board.boosts[defenderId] ? { boosts: board.boosts[defenderId] } : {}),
    });
    const m = new CalcMove(gen, move, crit ? { isCrit: true } : undefined);
    const defSide = ws.sideA.mons.some((x) => x.monId === defenderId) ? 'A' : 'B';
    const screens = board.sides[defSide];
    const terrain = board.field.map((f) => TERRAIN_CALC[f]).find(Boolean);
    const field = new CalcField({
      gameType: 'Doubles',
      ...(board.weather && WEATHER_CALC[board.weather] ? { weather: WEATHER_CALC[board.weather] as never } : {}),
      ...(terrain ? { terrain: terrain as never } : {}),
      defenderSide: new CalcSide({ isReflect: screens.includes('Reflect'), isLightScreen: screens.includes('Light Screen'), isAuroraVeil: screens.includes('Aurora Veil') }),
    });
    const dmg = calculate(gen, attacker, defender, m, field).damage;
    const nums = (Array.isArray(dmg) ? dmg.flat(Infinity) : [dmg]).filter((n): n is number => typeof n === 'number');
    if (nums.length === 0 || (nums.length === 1 && nums[0] === 0)) return nums.length ? { min: 0, max: 0, avg: 0 } : null;
    return { min: nums[0]!, max: nums[nums.length - 1]!, avg: Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) };
  } catch {
    return null;
  }
}

/**
 * End-of-turn residuals for all active mons: weather chip (Sandstorm),
 * Leftovers/Black Sludge heal, and status damage (burn/poison). Returns event
 * builders; the user adjusts HP if the screen differs.
 */
export function endOfTurnEvents(ws: Workspace, board: ReplayState): EventBuilder[] {
  const out: EventBuilder[] = [];
  for (const m of activeMonIds(board).filter((a) => !a.fainted)) {
    let hp = m.hp;
    const max = monMaxHp(ws, m.monId) || m.maxHp;
    const types = speciesTypes(m.species);
    const item = monItem(ws, m.monId);
    const push = (source: string, delta: number, kind: 'passive_hp_change' | 'heal') => {
      const before = hp;
      hp = Math.max(0, Math.min(max, hp + delta));
      const monId = m.monId;
      out.push((seq, turn) => ({ eventId: nextEventId(), seq, turn, type: kind, target: monId, source, hpBefore: before, hpAfter: hp }) as MatchEvent);
    };
    if (board.weather === 'Sand' && !types.some((t) => ['Rock', 'Ground', 'Steel'].includes(t))) push('Sandstorm', -Math.floor(max / 16), 'passive_hp_change');
    if (item === 'Leftovers') push('Leftovers', Math.floor(max / 16), 'heal');
    else if (item === 'Black Sludge') push('Black Sludge', types.includes('Poison') ? Math.floor(max / 16) : -Math.floor(max / 8), types.includes('Poison') ? 'heal' : 'passive_hp_change');
    const status = board.status[m.monId];
    if (status === 'brn') push('Burn', -Math.floor(max / 16), 'passive_hp_change');
    else if (status === 'psn') push('Poison', -Math.floor(max / 8), 'passive_hp_change');
    else if (status === 'tox') push('Poison', -Math.floor(max / 8), 'passive_hp_change');
  }
  return out;
}

/** Recoil/drain fractions of damage dealt for a move (from dex move data). */
export function moveRecoilDrain(move: string): { recoil?: [number, number]; drain?: [number, number] } {
  try {
    const m = Dex.moves.get(move) as { recoil?: [number, number]; drain?: [number, number] };
    return { ...(m.recoil ? { recoil: m.recoil } : {}), ...(m.drain ? { drain: m.drain } : {}) };
  } catch {
    return {};
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
