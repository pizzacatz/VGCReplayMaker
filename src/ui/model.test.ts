/** UI model tests — smart targeting + mega forme lookup (the new UX helpers). */

import { describe, it, expect } from 'vitest';
import type { MatchEvent, MatchLog } from '../log';
import type { ParsedMon } from '../import';
import { ReplayPlayer, toProtocol } from '../replay';
import { backfillDerivedEvents, broughtInfo, buildLog, endOfTurnEvents, entryEffectEvents, estimateDamage, fieldExpiryEvents, holdsEjectPack, leadMonIds, leadSlots, megaFormeAbility, megaFormeFromItem, moveCanFlinch, moveMakesContact, moveRecoilDrain, moveStatChangeEvents, moveStatus, moveType, oneHitSurvivor, planTargets, protectionBlocking, reactiveDefenderEvents, switchForcingOnHit, typeEffectiveness, type MonEntry, type Workspace } from './model';

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
    expect(intim.some((e) => e.type === 'item_or_ability_event' && e.mon === 'A0' && e.name === 'Intimidate')).toBe(true); // ability announced
    const drops = intim.filter((e): e is Extract<MatchEvent, { type: 'stat_stage_change' }> => e.type === 'stat_stage_change');
    expect(drops).toHaveLength(2); // both foes
    expect(drops.every((e) => e.stat === 'atk' && e.stages === -1)).toBe(true);
    expect(drops.map((e) => e.target).sort()).toEqual(['B0', 'B1']);

    const sun = entryEffectEvents(ws, 'A0', 'Drought', board, false).map((b, i) => b(i + 1, 1));
    expect(sun).toHaveLength(1);
    expect(sun[0]).toMatchObject({ type: 'field_change', field: 'Sun', action: 'set' });
  });

  it('Intimidate respects the foe’s ability: Defiant (+2 Atk), Guard Dog (+1), Clear Body / immunity (none)', () => {
    const inc = entry('A', 0, 'Incineroar');
    inc.parsed.ability = 'Intimidate';
    const make = (ability?: string) => {
      const kg = entry('B', 0, 'Kingambit');
      if (ability) kg.parsed.ability = ability;
      const ws: Workspace = {
        sideA: { player: 'A', rawPaste: '', mons: [inc], leads: ['A0'] },
        sideB: { player: 'B', rawPaste: '', mons: [kg], leads: ['B0'] },
        events: [],
      };
      const board = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
      return entryEffectEvents(ws, 'A0', 'Intimidate', board, true)
        .map((b, i) => b(i + 1, 1))
        .filter((e): e is Extract<MatchEvent, { type: 'stat_stage_change' }> => e.type === 'stat_stage_change');
    };
    expect(make('Defiant').map((e) => [e.stat, e.stages, e.source])).toEqual([['atk', -1, 'Intimidate'], ['atk', 2, 'Defiant']]); // net +1 Kingambit
    expect(make('Competitive').map((e) => [e.stat, e.stages])).toEqual([['atk', -1], ['spa', 2]]);
    expect(make('Guard Dog').map((e) => [e.stat, e.stages, e.source])).toEqual([['atk', 1, 'Guard Dog']]);
    expect(make('Clear Body')).toHaveLength(0); // drop blocked
    expect(make('Inner Focus')).toHaveLength(0); // immune
    expect(make(undefined).map((e) => e.stages)).toEqual([-1]); // plain Intimidate
  });

  it('fieldExpiryEvents: weather fades after 5 turns (8 with the rock); Tailwind after 4', () => {
    const make = (events: MatchEvent[]) => {
      const ws: Workspace = {
        sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
        sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
        events,
      };
      const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
      return fieldExpiryEvents(ws, b).map((bld, i) => bld(i + 1, 1));
    };
    const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ eventId: `t${i + 1}`, seq: i + 1, turn: i + 1, type: 'turn_start' } as MatchEvent));
    // Sun set on turn 1, now turn 4 → still up; turn 5 → fades.
    const sunSet: MatchEvent = { eventId: 'w', seq: 0, turn: 1, type: 'field_change', field: 'Sun', action: 'set' };
    expect(make([sunSet, ...turns(4)])).toHaveLength(0);
    const faded = make([sunSet, ...turns(5)]);
    expect(faded).toHaveLength(1);
    expect(faded[0]).toMatchObject({ type: 'field_change', field: 'Sun', action: 'end' });
    // Rock-extended Sun lasts 8 turns.
    const sunRock: MatchEvent = { ...sunSet, turnsKnown: 8 };
    expect(make([sunRock, ...turns(5)])).toHaveLength(0);
    expect(make([sunRock, ...turns(8)])).toHaveLength(1);
    // Tailwind (side condition) is 4 turns.
    const tw: MatchEvent = { eventId: 'tw', seq: 0, turn: 1, type: 'field_change', field: 'Tailwind', action: 'set', side: 'A' };
    expect(make([tw, ...turns(3)])).toHaveLength(0);
    const twEnd = make([tw, ...turns(4)]);
    expect(twEnd).toHaveLength(1);
    expect(twEnd[0]).toMatchObject({ type: 'field_change', field: 'Tailwind', action: 'end', side: 'A' });
  });

  it('fieldExpiryEvents: entry hazards never expire; a re-set restarts the clock', () => {
    const make = (events: MatchEvent[]) => {
      const ws: Workspace = {
        sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
        sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
        events,
      };
      const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
      return fieldExpiryEvents(ws, b).map((bld, i) => bld(i + 1, 1));
    };
    const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ eventId: `t${i + 1}`, seq: i + 1, turn: i + 1, type: 'turn_start' } as MatchEvent));
    // Stealth Rock is permanent — never auto-expires even far past 5 turns.
    const sr: MatchEvent = { eventId: 'sr', seq: 0, turn: 1, type: 'field_change', field: 'Stealth Rock', action: 'set', side: 'B' };
    expect(make([sr, ...turns(9)])).toHaveLength(0);
    // Re-setting Trick Room on turn 4 means it shouldn't expire at turn 5 (clock restarts from 4).
    const tr1: MatchEvent = { eventId: 'tr1', seq: 0, turn: 1, type: 'field_change', field: 'Trick Room', action: 'set' };
    const trEnd: MatchEvent = { eventId: 'tre', seq: 10, turn: 5, type: 'field_change', field: 'Trick Room', action: 'end' };
    const tr2: MatchEvent = { eventId: 'tr2', seq: 11, turn: 5, type: 'field_change', field: 'Trick Room', action: 'set' };
    expect(make([tr1, ...turns(5), trEnd, tr2])).toHaveLength(0); // freshly re-set this turn → still up
  });

  it('moveStatChangeEvents: Parting Shot drops the foe Atk/SpA; Defiant retaliates; Clear Body blocks', () => {
    const make = (targetAbility?: string, targetItem?: string) => {
      const kg = entry('B', 0, 'Kingambit');
      if (targetAbility) kg.parsed.ability = targetAbility;
      if (targetItem) kg.parsed.item = targetItem;
      const ws: Workspace = {
        sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
        sideB: { player: 'B', rawPaste: '', mons: [kg], leads: ['B0'] },
        events: [],
      };
      const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
      return moveStatChangeEvents(ws, b, 'A0', 'Parting Shot', ['B0'])
        .map((bld, i) => bld(i + 1, 1))
        .filter((e): e is Extract<MatchEvent, { type: 'stat_stage_change' }> => e.type === 'stat_stage_change');
    };
    expect(make().map((e) => [e.target, e.stat, e.stages])).toEqual([['B0', 'atk', -1], ['B0', 'spa', -1]]);
    // Defiant retaliates once (+2 Atk) after the foe-induced drop.
    expect(make('Defiant').map((e) => [e.stat, e.stages, e.source])).toContainEqual(['atk', 2, 'Defiant']);
    // Competitive retaliates with +2 SpA.
    expect(make('Competitive').some((e) => e.stat === 'spa' && e.stages === 2 && e.source === 'Competitive')).toBe(true);
    // Clear Body / Clear Amulet block the drops entirely (and so no retaliation).
    expect(make('Clear Body')).toHaveLength(0);
    expect(make(undefined, 'Clear Amulet')).toHaveLength(0);
  });

  it('moveStatChangeEvents: self-boosts — Swords Dance +2 Atk on the user, Contrary inverts', () => {
    const make = (ability?: string) => {
      const mon = entry('A', 0, 'Incineroar');
      if (ability) mon.parsed.ability = ability;
      const ws: Workspace = {
        sideA: { player: 'A', rawPaste: '', mons: [mon], leads: ['A0'] },
        sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
        events: [],
      };
      const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
      return moveStatChangeEvents(ws, b, 'A0', 'Swords Dance', [])
        .map((bld, i) => bld(i + 1, 1))
        .filter((e): e is Extract<MatchEvent, { type: 'stat_stage_change' }> => e.type === 'stat_stage_change');
    };
    expect(make().map((e) => [e.target, e.stat, e.stages])).toEqual([['A0', 'atk', 2]]);
    expect(make('Contrary').map((e) => [e.target, e.stat, e.stages])).toEqual([['A0', 'atk', -2]]); // Contrary flips it
  });

  it('moveStatChangeEvents: a damaging self-drop move (Close Combat) lowers the user Def/SpD', () => {
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [],
    };
    const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const ev = moveStatChangeEvents(ws, b, 'A0', 'Close Combat', ['B0'])
      .map((bld, i) => bld(i + 1, 1))
      .filter((e): e is Extract<MatchEvent, { type: 'stat_stage_change' }> => e.type === 'stat_stage_change');
    expect(ev.map((e) => [e.target, e.stat, e.stages]).sort()).toEqual([['A0', 'def', -1], ['A0', 'spd', -1]]);
  });

  it('backfillDerivedEvents: inserts a missing Regenerator heal on switch-out, idempotently', () => {
    const tox = entry('A', 0, 'Toxapex');
    tox.parsed.ability = 'Regenerator';
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [tox, entry('A', 1, 'Aerodactyl')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [
        { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
        { eventId: 'd', seq: 2, turn: 1, type: 'damage', attacker: 'B0', move: 'Earthquake', defender: 'A0', hpBefore: 175, hpAfter: 100, crit: false, status: 'clean' },
        // old transcript: the Regenerator heal was never logged.
        { eventId: 's', seq: 3, turn: 1, type: 'switch', side: 'A', position: 0, out: 'A0', in: 'A1' },
      ],
    };
    const { events, added } = backfillDerivedEvents(ws);
    expect(added).toBe(1);
    const heal = events.find((e) => e.type === 'heal' && e.source === 'Regenerator');
    expect(heal).toMatchObject({ target: 'A0', hpBefore: 100, hpAfter: 158 }); // 100 + floor(175/3)
    // the heal must precede the switch
    const healIdx = events.findIndex((e) => e.type === 'heal');
    const switchIdx = events.findIndex((e) => e.type === 'switch');
    expect(healIdx).toBeLessThan(switchIdx);
    // running again over the backfilled log adds nothing.
    expect(backfillDerivedEvents({ ...ws, events }).added).toBe(0);
  });

  it('backfillDerivedEvents: a full-HP or fainted Regenerator mon gets no heal', () => {
    const tox = entry('A', 0, 'Toxapex');
    tox.parsed.ability = 'Regenerator';
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [tox, entry('A', 1, 'Aerodactyl')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [
        { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
        { eventId: 's', seq: 2, turn: 1, type: 'switch', side: 'A', position: 0, out: 'A0', in: 'A1' }, // A0 at full HP
      ],
    };
    expect(backfillDerivedEvents(ws).added).toBe(0);
  });

  it('backfillDerivedEvents: inserts a missing Natural Cure status-cure on switch-out', () => {
    const mon = entry('A', 0, 'Blissey');
    mon.parsed.ability = 'Natural Cure';
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [mon, entry('A', 1, 'Aerodactyl')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [
        { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
        { eventId: 'st', seq: 2, turn: 1, type: 'status_applied', target: 'A0', status: 'brn' },
        { eventId: 's', seq: 3, turn: 1, type: 'switch', side: 'A', position: 0, out: 'A0', in: 'A1' },
      ],
    };
    const { events, added } = backfillDerivedEvents(ws);
    expect(added).toBe(1);
    expect(events.find((e) => e.type === 'status_cured')).toMatchObject({ target: 'A0', status: 'brn' });
    expect(backfillDerivedEvents({ ...ws, events }).added).toBe(0); // idempotent
  });

  it('backfillDerivedEvents: inserts missing weather expiry at the end of its turn', () => {
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [
        { eventId: 'w', seq: 1, turn: 1, type: 'field_change', field: 'Sun', action: 'set' },
        ...Array.from({ length: 6 }, (_, i) => ({ eventId: `t${i + 1}`, seq: i + 2, turn: i + 1, type: 'turn_start' } as MatchEvent)),
      ],
    };
    const { events, added } = backfillDerivedEvents(ws);
    expect(added).toBe(1);
    const fade = events.find((e) => e.type === 'field_change' && e.action === 'end' && e.field === 'Sun');
    expect(fade).toBeTruthy();
    expect((fade as Extract<MatchEvent, { type: 'field_change' }>).turn).toBe(5); // faded at end of turn 5
    // it must sit before turn 6's start
    const fadeIdx = events.findIndex((e) => e.type === 'field_change' && e.action === 'end');
    const t6Idx = events.findIndex((e) => e.type === 'turn_start' && e.turn === 6);
    expect(fadeIdx).toBeLessThan(t6Idx);
    expect(backfillDerivedEvents({ ...ws, events }).added).toBe(0); // idempotent
  });

  it('backfillDerivedEvents: expires weather on the final turn once the game is over', () => {
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      result: { winner: 'A', reason: 'ko' },
      events: [
        { eventId: 'w', seq: 1, turn: 1, type: 'field_change', field: 'Sun', action: 'set' },
        ...Array.from({ length: 5 }, (_, i) => ({ eventId: `t${i + 1}`, seq: i + 2, turn: i + 1, type: 'turn_start' } as MatchEvent)),
      ],
    };
    const { events, added } = backfillDerivedEvents(ws);
    expect(added).toBe(1); // game over → final turn's upkeep counts, Sun fades
    expect(events.some((e) => e.type === 'field_change' && e.action === 'end' && e.field === 'Sun')).toBe(true);
  });

  it('oneHitSurvivor: Focus Sash / Sturdy save from full HP on a single hit only', () => {
    const make = (item?: string, ability?: string, consumed = false) => {
      const mon = entry('A', 0, 'Garchomp');
      if (item) mon.parsed.item = item;
      if (ability) mon.parsed.ability = ability;
      const ws: Workspace = {
        sideA: { player: 'A', rawPaste: '', mons: [mon], leads: ['A0'] },
        sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Incineroar')], leads: ['B0'] },
        events: consumed ? [{ eventId: 'x', seq: 1, turn: 1, type: 'item_or_ability_event', mon: 'A0', kind: 'enditem', name: item ?? '' }] : [],
      };
      return ws;
    };
    expect(oneHitSurvivor(make('Focus Sash'), 'A0', true, true, true)).toBe('Focus Sash');
    expect(oneHitSurvivor(make(undefined, 'Sturdy'), 'A0', true, true, true)).toBe('Sturdy');
    expect(oneHitSurvivor(make('Focus Sash'), 'A0', false, true, true)).toBeNull(); // not full HP
    expect(oneHitSurvivor(make('Focus Sash'), 'A0', true, false, true)).toBeNull(); // wouldn't faint anyway
    expect(oneHitSurvivor(make('Focus Sash'), 'A0', true, true, false)).toBeNull(); // multi-hit breaks the Sash
    expect(oneHitSurvivor(make('Focus Sash', undefined, true), 'A0', true, true, true)).toBeNull(); // already consumed
  });

  it('reactiveDefenderEvents: Weakness Policy (SE) and type-charge items boost + break; Air Balloon pops', () => {
    const make = (item: string) => {
      const mon = entry('A', 0, 'Garchomp');
      mon.parsed.item = item;
      return { sideA: { player: 'A', rawPaste: '', mons: [mon], leads: ['A0'] }, sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Incineroar')], leads: ['B0'] }, events: [] } as Workspace;
    };
    const evs = (ws: Workspace, move: string, mult: number) => reactiveDefenderEvents(ws, 'A0', move, mult, 40, true).map((b, i) => b(i + 1, 1));
    // Weakness Policy: +2 Atk, +2 SpA, and breaks — only on a super-effective hit.
    const wp = evs(make('Weakness Policy'), 'Ice Beam', 2);
    expect(wp.filter((e) => e.type === 'stat_stage_change').map((e) => [(e as { stat: string }).stat, (e as { stages: number }).stages])).toEqual([['atk', 2], ['spa', 2]]);
    expect(wp.some((e) => e.type === 'item_or_ability_event' && e.kind === 'enditem' && e.name === 'Weakness Policy')).toBe(true);
    expect(evs(make('Weakness Policy'), 'Ice Beam', 1)).toHaveLength(0); // not super-effective → no trigger
    // Cell Battery: +1 Atk on an Electric hit, and breaks.
    const cb = evs(make('Cell Battery'), 'Thunderbolt', 2);
    expect(cb.find((e) => e.type === 'stat_stage_change')).toMatchObject({ stat: 'atk', stages: 1 });
    expect(evs(make('Cell Battery'), 'Flamethrower', 1)).toHaveLength(0); // wrong type
    // Air Balloon just pops (enditem, no boost).
    const ab = evs(make('Air Balloon'), 'Flamethrower', 1);
    expect(ab).toHaveLength(1);
    expect(ab[0]).toMatchObject({ type: 'item_or_ability_event', kind: 'enditem', name: 'Air Balloon' });
    // No damage dealt → nothing fires.
    expect(reactiveDefenderEvents(make('Weakness Policy'), 'A0', 'Ice Beam', 2, 0, true)).toHaveLength(0);
  });

  it('moveType reads the dex move type', () => {
    expect(moveType('Thunderbolt')).toBe('Electric');
    expect(moveType('Surf')).toBe('Water');
  });

  it('switchForcingOnHit / holdsEjectPack identify the item, respecting prior consumption', () => {
    const make = (item: string, consumed = false) => {
      const mon = entry('A', 0, 'Garchomp');
      mon.parsed.item = item;
      return {
        sideA: { player: 'A', rawPaste: '', mons: [mon], leads: ['A0'] },
        sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Incineroar')], leads: ['B0'] },
        events: consumed ? [{ eventId: 'x', seq: 1, turn: 1, type: 'item_or_ability_event', mon: 'A0', kind: 'enditem', name: item }] : [],
      } as Workspace;
    };
    expect(switchForcingOnHit(make('Eject Button'), 'A0')).toBe('Eject Button');
    expect(switchForcingOnHit(make('Red Card'), 'A0')).toBe('Red Card');
    expect(switchForcingOnHit(make('Leftovers'), 'A0')).toBeNull();
    expect(switchForcingOnHit(make('Eject Button', true), 'A0')).toBeNull(); // already used
    expect(holdsEjectPack(make('Eject Pack'), 'A0')).toBe(true);
    expect(holdsEjectPack(make('Eject Pack', true), 'A0')).toBe(false);
    expect(holdsEjectPack(make('Focus Sash'), 'A0')).toBe(false);
  });

  it('entryEffectEvents announces Air Balloon on entry (until it has popped)', () => {
    const make = (events: MatchEvent[]) => {
      const mon = entry('A', 0, 'Gholdengo');
      mon.parsed.item = 'Air Balloon';
      const ws: Workspace = {
        sideA: { player: 'A', rawPaste: '', mons: [mon], leads: ['A0'] },
        sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
        events,
      };
      const board = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
      return entryEffectEvents(ws, 'A0', 'Good as Gold', board, true).map((b, i) => b(i + 1, 1));
    };
    expect(make([]).some((e) => e.type === 'item_or_ability_event' && e.kind === 'item' && e.name === 'Air Balloon')).toBe(true);
    // once it has popped (enditem logged), it isn't re-announced.
    expect(make([{ eventId: 'pop', seq: 1, turn: 1, type: 'item_or_ability_event', mon: 'A0', kind: 'enditem', name: 'Air Balloon' }]).length).toBe(0);
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

  it('Toxic damage ramps n/16 with the toxic counter', () => {
    const ws: Workspace = {
      sideA: { player: 'A', rawPaste: '', mons: [entry('A', 0, 'Incineroar')], leads: ['A0'] },
      sideB: { player: 'B', rawPaste: '', mons: [entry('B', 0, 'Garchomp')], leads: ['B0'] },
      events: [
        { eventId: 's', seq: 1, turn: 1, type: 'status_applied', target: 'A0', status: 'tox' },
        { eventId: 't3', seq: 2, turn: 3, type: 'turn_start' }, // now the 3rd toxic end-of-turn
      ],
    };
    const b = new ReplayPlayer(toProtocol(buildLog(ws))).stateAt(99);
    const tox = endOfTurnEvents(ws, b)
      .map((bld, i) => bld(i + 1, 3))
      .find((e) => e.type === 'passive_hp_change' && e.source === 'Toxic' && e.target === 'A0');
    expect(tox).toBeDefined();
    if (tox && tox.type === 'passive_hp_change') expect(tox.hpBefore - tox.hpAfter).toBe(Math.floor((175 * 3) / 16)); // 3/16, not flat 1/8
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

describe('moveStatus — guaranteed status from a move', () => {
  it('reads guaranteed statuses; ignores chance-based secondaries', () => {
    expect(moveStatus('Toxic')).toBe('tox');
    expect(moveStatus('Will-O-Wisp')).toBe('brn');
    expect(moveStatus('Thunder Wave')).toBe('par');
    expect(moveStatus('Spore')).toBe('slp');
    expect(moveStatus('Flare Blitz')).toBeUndefined(); // burn is a 10% secondary
    expect(moveStatus('Sludge Bomb')).toBeUndefined(); // 30% poison secondary
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

describe('typeEffectiveness — ability immunities (open sheets give us the ability)', () => {
  it('Levitate makes a Ground move immune; the same mon without it is not', () => {
    expect(typeEffectiveness('Earthquake', 'Garchomp', 'Levitate')?.mult).toBe(0);
    expect(typeEffectiveness('Earthquake', 'Garchomp', 'Levitate')?.text).toMatch(/Levitate/);
    expect(typeEffectiveness('Earthquake', 'Garchomp')?.mult).toBe(1); // Ground vs Dragon/Ground = neutral 
  });
  it('the absorbs and Sap Sipper grant immunity to their type', () => {
    expect(typeEffectiveness('Surf', 'Incineroar', 'Water Absorb')?.mult).toBe(0);
    expect(typeEffectiveness('Thunderbolt', 'Garchomp', 'Volt Absorb')?.mult).toBe(0);
    expect(typeEffectiveness('Energy Ball', 'Garchomp', 'Sap Sipper')?.mult).toBe(0);
  });
  it('an unrelated ability leaves the type chart untouched', () => {
    expect(typeEffectiveness('Ice Beam', 'Garchomp', 'Rough Skin')?.mult).toBe(4);
  });
});
