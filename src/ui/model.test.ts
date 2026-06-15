/** UI model tests — smart targeting + mega forme lookup (the new UX helpers). */

import { describe, it, expect } from 'vitest';
import type { MatchEvent, MatchLog } from '../log';
import type { ParsedMon } from '../import';
import { ReplayPlayer, toProtocol } from '../replay';
import { broughtInfo, leadMonIds, megaFormeFromItem, moveCanFlinch, planTargets, type MonEntry, type Workspace } from './model';

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

describe('leadMonIds — explicit selection is respected, no surprise fill', () => {
  it('uses explicit leads; empty stays empty; only undefined falls back to first two', () => {
    expect(leadMonIds(wsWith(['B2', 'B4'], []).sideB)).toEqual(['B2', 'B4']);
    expect(leadMonIds(wsWith([], []).sideB)).toEqual([]); // explicit empty → empty (predictable)
    expect(leadMonIds({ player: 'O', rawPaste: '', mons: sixMon('B') })).toEqual(['B0', 'B1']); // undefined → default
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
