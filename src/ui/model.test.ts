/** UI model tests — smart targeting + mega forme lookup (the new UX helpers). */

import { describe, it, expect } from 'vitest';
import type { MatchEvent, MatchLog } from '../log';
import type { ParsedMon } from '../import';
import { ReplayPlayer, toProtocol } from '../replay';
import { broughtInfo, buildLog, endOfTurnEvents, entryEffectEvents, estimateDamage, leadMonIds, leadSlots, megaFormeAbility, megaFormeFromItem, moveCanFlinch, moveMakesContact, moveRecoilDrain, planTargets, protectionBlocking, typeEffectiveness, type MonEntry, type Workspace } from './model';

const board = (() => {
  const log: MatchLog = {
    matchId: 't', format: 'Champions Reg M-A',
    sideA: { player: 'W', mons: [{ monId: 'inc', species: 'Incineroar', maxHp: 175 }, { monId: 'zap', species: 'Zapdos', maxHp: 160 }] },
    sideB: { player: 'O', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 183 }, { monId: 'ape', species: 'Annihilape', maxHp: 175 }] },
    leads: [{ side: 'A', position: 0, monId: 'inc' }, { side: 'A', position: 1, monId: 'zap' }, { side: 'B', position: 0, monId: 'gar' }, { side: 'B', position: 1, monId: 'ape' }],
    events: [],
  };
  const p = new ReplayPlayer(toProtocol(log));
  return p.stateAt(p.length - 1);
})();

describe('planTargets — legal targets, foes first', () => {
  it('a spread move auto-targets all foes', () => {
    const plan = planTargets('Rock Slide', 'inc', board); // allAdjacentFoes
    expect(plan.spread).toBe(true);
    expect(plan.candidates.sort()).toEqual(['ape', 'gar']);
    expect(plan.isDamaging).toBe(true);
  });

  it('a single-target move lists foes before allies', () => {
    const plan = planTargets('Flare Blitz', 'inc', board); // normal
    expect(plan.spread).toBe(false);
    expect(plan.candidates.slice(0, 2).sort()).toEqual(['ape', 'gar']); // foes first
    expect(plan.candidates).toContain('zap'); // ally available but after foes
    expect(plan.candidates.indexOf('zap')).toBeGreaterThan(plan.candidates.indexOf('gar'));
  });

  it('a self/status move targets the user and is non-damaging', () => {
    const plan = planTargets('Swords Dance', 'inc', board);
    expect(plan.scope).toBe('self');
    expect(plan.candidates).toEqual(['inc']);
    expect(plan.isDamaging).toBe(false);
  });
});

describe('megaFormeFromItem — forme dictated by the held stone', () => {
  it('resolves the forme from the mega stone', () => {
    expect(megaFormeFromItem('Aerodactylite', 'Aerodactyl')).toBe('Aerodactyl-Mega');
    expect(megaFormeFromItem('Charizardite X', 'Charizard')).toBe('Charizard-Mega-X');
    expect(megaFormeFromItem('Charizardite Y', 'Charizard')).toBe('Charizard-Mega-Y');
  });
  it('returns null without a mega stone', () => {
    expect(megaFormeFromItem(undefined, 'Garchomp')).toBeNull();
    expect(megaFormeFromItem('Leftovers', 'Garchomp')).toBeNull();
  });
});

describe('moveCanFlinch — only where flinch is actually possible', () => {
  it('true for flinch moves and King’s Rock / Stench', () => {
    expect(moveCanFlinch('Rock Slide')).toBe(true); // 30% flinch secondary
    expect(moveCanFlinch('Fake Out')).toBe(true);
    expect(moveCanFlinch('Earthquake', "King's Rock")).toBe(true);
    expect(moveCanFlinch('Earthquake', undefined, 'Stench')).toBe(true);
  });
  it('false otherwise', () => {
    expect(moveCanFlinch('Flare Blitz')).toBe(false); // burn, not flinch
    expect(moveCanFlinch('Earthquake')).toBe(false);
    expect(moveCanFlinch('Swords Dance')).toBe(false); // status
  });
});

const pm = (species: string): ParsedMon => ({ species, level: 50, moves: [], alignment: 'neutral', spreadKnown: false, flags: [] });
const entry = (side: string, i: number, species: string): MonEntry => ({ monId: `${side}${i}`, parsed: pm(species), observedMaxHp: 175 });
const sixMon = (side: string): MonEntry[] => ['Garchomp', 'Annihilape', 'Zapdos', 'Giratina', 'Incineroar', 'Dragonite'].map((s, i) => entry(side, i, s));
const wsWith = (leadsB: string[], events: MatchEvent[]): Workspace => ({
  sideA: { player: 'W', rawPaste: '', mons: sixMon('A'), leads: ['A0', 'A1'] },
  sideB: { player: 'O', rawPaste: '', mons: sixMon('B'), leads: leadsB },
  events,
});

describe('leadMonIds / leadSlots — explicit selection respected, positions preserved', () => {
  it('respects explicit leads; empty stays empty; only undefined falls back', () => {
    expect(leadMonIds(wsWith(['B2', 'B4'], []).sideB)).toEqual(['B2', 'B4']);
    expect(leadMonIds(wsWith([], []).sideB)).toEqual([]);
    expect(leadMonIds({ player: 'O', rawPaste: '', mons: sixMon('B') })).toEqual(['B0', 'B1']);
  });
  it('leadSlots keeps left/right positions (empties as "")', () => {
    expect(leadSlots(wsWith(['B2', 'B4'], []).sideB)).toEqual(['B2', 'B4']);
    expect(leadSlots(wsWith([], []).sideB)).toEqual(['', '']);
    expect(leadSlots({ player: 'O', rawPaste: '', mons: sixMon('B') })).toEqual(['B0', 'B1']);
  });
});

describe('typeEffectiveness — derived from the type chart, not entered', () => {
  it('computes SE / immune / 4x / neutral, and null for status moves', () => {
    expect(typeEffectiveness('Rock Slide', 'Incineroar')?.mult).toBe(2); // Rock vs Fire/Dark
    expect(typeEffectiveness('Earthquake', 'Zapdos')?.mult).toBe(0); // Ground vs Flying = immune
    expect(typeEffectiveness('Ice Beam', 'Garchomp')?.mult).toBe(4); // Ice vs Dragon + Ground
    expect(typeEffectiveness('Surf', 'Garchomp')?.mult).toBe(1); // Water: ×2 Ground, ×0.5 Dragon → neutral
    expect(typeEffectiveness('Swords Dance', 'Garchomp')).toBeNull();
  });
  it('uses the requested phrasing', () => {
    expect(typeEffectiveness('Rock Slide', 'Incineroar')?.text).toBe('Super Effective (2x)');
    expect(typeEffectiveness('Ice Beam', 'Garchomp')?.text).toBe('Extremely Effective (4x)');
    expect(typeEffectiveness('Earthquake', 'Zapdos')?.text).toBe('Immune (0x)');
  });
});

describe('protectionBlocking — derive blocked hits from Protect / Wide Guard', () => {
  const protectWs = (moves: Array<{ user: string; move: string }>): Workspace => ({
    sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
    sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp'), entry('B', 1, 'Annihilape')], leads: ['B0', 'B1'] },
    events: moves.map((mv, i) => ({ eventId: `m${i}`, seq: i + 1, turn: 1, type: 'move_used' as const, user: mv.user, move: mv.move, targets: [] })),
  });

  it('Protect blocks a single-target move on the protector only', () => {
    const ws = protectWs([{ user: 'B0', move: 'Protect' }]);
    expect(protectionBlocking(ws, 'B0', 'Flare Blitz', 1)).toBe('Protect');
    expect(protectionBlocking(ws, 'B1', 'Flare Blitz', 1)).toBeNull();
  });
  it('Wide Guard blocks spread moves for the whole side, not single-target', () => {
    const ws = protectWs([{ user: 'B0', move: 'Wide Guard' }]);
    expect(protectionBlocking(ws, 'B1', 'Rock Slide', 1)).toBe('Wide Guard');
    expect(protectionBlocking(ws, 'B1', 'Flare Blitz', 1)).toBeNull();
  });
  it('Feint bypasses protection', () => {
    const ws = protectWs([{ user: 'B0', move: 'Protect' }]);
    expect(protectionBlocking(ws, 'B0', 'Feint', 1)).toBeNull();
  });
});

describe('deterministic resolver — auto-derive engine consequences', () => {
  it('moveRecoilDrain reads recoil/drain from the dex', () => {
    expect(moveRecoilDrain('Flare Blitz')).toEqual({ recoil: [33, 100] });
    expect(moveRecoilDrain('Draining Kiss').drain).toEqual([3, 4]);
    expect(moveRecoilDrain('Earthquake')).toEqual({});
  });
  it('megaFormeAbility returns the forme ability', () => {
    expect(megaFormeAbility('Charizard-Mega-Y')).toBe('Drought');
    expect(megaFormeAbility('Charizard-Mega-X')).toBe('Tough Claws');
  });
  it('entryEffectEvents: Intimidate drops every opposing active Attack; Drought sets Sun', () => {
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp'), entry('B', 1, 'Annihilape')], leads: ['B0', 'B1'] },
      events: [],
    };
    const board = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const intim = entryEffectEvents(ws, 'A0', 'Intimidate', board, true).map((b, i) => b(i + 1, 1));
    expect(intim).toHaveLength(2); // both foes
    expect(intim.every((e) => e.type === 'stat_stage_change' && e.stat === 'atk' && e.stages === -1)).toBe(true);
    expect(intim.map((e) => (e.type === 'stat_stage_change' ? e.target : '')).sort()).toEqual(['B0', 'B1']);

    const sun = entryEffectEvents(ws, 'A0', 'Drought', board, false).map((b, i) => b(i + 1, 1));
    expect(sun).toHaveLength(1);
    expect(sun[0]).toMatchObject({ type: 'field_change', field: 'Sun', action: 'set' });
  });

  it('moveMakesContact reads the dex flag', () => {
    expect(moveMakesContact('Flare Blitz')).toBe(true);
    expect(moveMakesContact('Earthquake')).toBe(false);
  });

  it('estimateDamage returns a positive average for a super-effective hit', () => {
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [],
    };
    const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const est = estimateDamage(ws, b, 'A0', 'B0', 'Flare Blitz', false);
    expect(est).not.toBeNull();
    expect(est!.avg).toBeGreaterThan(0);
    expect(est!.min).toBeLessThanOrEqual(est!.max);
  });

  it('endOfTurnEvents: Sandstorm chips a non-immune mon, not a Ground type', () => {
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [{ eventId: 'w', seq: 1, turn: 1, type: 'field_change', field: 'Sand', action: 'set' }],
    };
    const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const sand = endOfTurnEvents(ws, b).map((bld, i) => bld(i + 1, 1)).filter((e) => e.type === 'passive_hp_change' && e.source === 'Sandstorm');
    const targets = sand.map((e) => (e.type === 'passive_hp_change' ? e.target : ''));
    expect(targets).toContain('A0'); // Incineroar (Fire/Dark) chipped
    expect(targets).not.toContain('B0'); // Garchomp (Ground) immune
  });

  it('endOfTurnEvents auto-faints a mon a residual reduces to 0', () => {
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [
        { eventId: 'p', seq: 1, turn: 1, type: 'passive_hp_change', target: 'A0', source: 'test', hpBefore: 175, hpAfter: 5 },
        { eventId: 'w', seq: 2, turn: 1, type: 'field_change', field: 'Sand', action: 'set' },
      ],
    };
    const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const eot = endOfTurnEvents(ws, b).map((bld, i) => bld(i + 1, 1));
    expect(eot.some((e) => e.type === 'faint' && e.target === 'A0')).toBe(true); // sand chip KO'd it
  });

  it('endOfTurnEvents: Infestation chips the trapped foe 1/8 (data-driven partial trap)', () => {
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [{ eventId: 'inf', seq: 1, turn: 1, type: 'move_used', user: 'A0', move: 'Infestation', targets: ['B0'] }],
    };
    const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const chip = endOfTurnEvents(ws, b)
      .map((bld, i) => bld(i + 1, 1))
      .filter((e) => e.type === 'passive_hp_change' && e.source === 'Infestation');
    expect(chip).toHaveLength(1);
    const e = chip[0]!;
    if (e.type !== 'passive_hp_change') throw new Error('unreachable');
    expect(e.target).toBe('B0'); // the trapped target, not the trapper
    expect(e.hpBefore - e.hpAfter).toBe(Math.floor(175 / 8)); // 1/8 max HP
  });

  it('Magic Guard suppresses the Sandstorm chip', () => {
    const maw = entry('A', 0, 'Clefable');
    maw.parsed.ability = 'Magic Guard';
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [maw], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [{ eventId: 'w', seq: 1, turn: 1, type: 'field_change', field: 'Sand', action: 'set' }],
    };
    const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const sand = endOfTurnEvents(ws, b).map((bld, i) => bld(i + 1, 1)).filter((e) => e.type === 'passive_hp_change' && e.source === 'Sandstorm');
    expect(sand).toHaveLength(0); // Magic Guard negates indirect damage
  });

  it('Poison Heal turns poison into a heal', () => {
    const gli = entry('A', 0, 'Gliscor');
    gli.parsed.ability = 'Poison Heal';
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [gli], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [{ eventId: 's', seq: 1, turn: 1, type: 'status_applied', target: 'A0', status: 'psn' }],
    };
    const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const eot = endOfTurnEvents(ws, b).map((bld, i) => bld(i + 1, 1));
    expect(eot.some((e) => e.type === 'heal' && e.source === 'Poison Heal')).toBe(true);
    expect(eot.some((e) => e.type === 'passive_hp_change' && e.source === 'Poison')).toBe(false); // no poison chip
  });

  it('Grassy Terrain heals a grounded mon', () => {
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [{ eventId: 'g', seq: 1, turn: 1, type: 'field_change', field: 'Grassy Terrain', action: 'set' }],
    };
    const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const eot = endOfTurnEvents(ws, b).map((bld, i) => bld(i + 1, 1));
    expect(eot.some((e) => e.type === 'heal' && e.source === 'Grassy Terrain' && e.target === 'A0')).toBe(true);
  });

  it('Flame Orb burns its holder at end of turn (when unstatused)', () => {
    const inc = entry('A', 0, 'Incineroar');
    inc.parsed.item = 'Flame Orb';
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [inc], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [],
    };
    const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const eot = endOfTurnEvents(ws, b).map((bld, i) => bld(i + 1, 1));
    expect(eot.some((e) => e.type === 'status_applied' && e.target === 'A0' && e.status === 'brn' && e.source === 'Flame Orb')).toBe(true);
  });

  it('endOfTurnEvents: the partial trap expires after ~5 turns and stops chipping', () => {
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [
        { eventId: 'inf', seq: 1, turn: 1, type: 'move_used', user: 'A0', move: 'Infestation', targets: ['B0'] },
        { eventId: 't6', seq: 2, turn: 6, type: 'move_used', user: 'A0', move: 'Fake Out', targets: ['B0'] },
      ],
    };
    const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const chip = endOfTurnEvents(ws, b)
      .map((bld, i) => bld(i + 1, 6))
      .filter((e) => e.type === 'passive_hp_change' && e.source === 'Infestation');
    expect(chip).toHaveLength(0); // turn 6 is outside the 4–5 turn window
  });
});

describe('broughtInfo — process of elimination for the bring', () => {
  const sw = (seq: number, monId: string): MatchEvent => ({ eventId: `s${seq}`, seq, turn: 1, type: 'switch', side: 'B', position: 0, in: monId });

  it('leads alone leave the rest unknown (possibly brought)', () => {
    const info = broughtInfo(wsWith(['B0', 'B1'], []), 'B');
    expect(info.brought).toEqual(['B0', 'B1']);
    expect(info.confirmed).toBe(false);
    expect(info.unknown.sort()).toEqual(['B2', 'B3', 'B4', 'B5']);
    expect(info.notBrought).toEqual([]);
  });

  it('two switch-ins complete the bring → the other two are deduced NOT brought', () => {
    const info = broughtInfo(wsWith(['B0', 'B1'], [sw(2, 'B2'), sw(3, 'B3')]), 'B');
    expect(info.brought.sort()).toEqual(['B0', 'B1', 'B2', 'B3']);
    expect(info.confirmed).toBe(true);
    expect(info.notBrought.sort()).toEqual(['B4', 'B5']);
    expect(info.unknown).toEqual([]);
  });

  it('switching a lead back in does not double-count', () => {
    const info = broughtInfo(wsWith(['B0', 'B1'], [sw(2, 'B2'), sw(3, 'B0')]), 'B');
    expect(info.brought.sort()).toEqual(['B0', 'B1', 'B2']);
    expect(info.confirmed).toBe(false); // only 3 distinct seen
  });
});
