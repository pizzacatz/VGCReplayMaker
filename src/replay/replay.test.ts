/** Replay tests — Replay Spec T2.3, Validation List v2 §5. */

import { describe, it, expect } from 'vitest';
import type { MatchLog } from '../log';
import { ReplayPlayer, toProtocol } from './index';

/** A doubles fixture exercising every event type, a spread hit, and a switch. */
const LOG: MatchLog = {
  matchId: 'm1',
  format: 'Champions Reg M-A',
  sideA: {
    player: 'W',
    mons: [
      { monId: 'inc', species: 'Incineroar', maxHp: 175 },
      { monId: 'zap', species: 'Zapdos', maxHp: 160 },
      { monId: 'tina', species: 'Giratina', maxHp: 200 },
    ],
  },
  sideB: {
    player: 'O',
    mons: [
      { monId: 'gar', species: 'Garchomp', maxHp: 183 },
      { monId: 'ape', species: 'Annihilape', maxHp: 175 },
    ],
  },
  leads: [
    { side: 'A', position: 0, monId: 'inc' },
    { side: 'A', position: 1, monId: 'zap' },
    { side: 'B', position: 0, monId: 'gar' },
    { side: 'B', position: 1, monId: 'ape' },
  ],
  events: [
    { eventId: 'e1', seq: 1, turn: 1, type: 'turn_start' },
    { eventId: 'e2', seq: 2, turn: 1, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
    { eventId: 'e3', seq: 3, turn: 1, type: 'damage', attacker: 'inc', move: 'Flare Blitz', defender: 'gar', hpBefore: 183, hpAfter: 150, crit: false, status: 'clean', observedEffectiveness: '2x' },
    { eventId: 'e4', seq: 4, turn: 1, type: 'move_used', user: 'zap', move: 'Make It Rain', targets: ['gar', 'ape'], isSpread: true },
    { eventId: 'e5', seq: 5, turn: 1, type: 'damage', attacker: 'zap', move: 'Make It Rain', defender: 'gar', hpBefore: 150, hpAfter: 120, crit: false, status: 'composite' },
    { eventId: 'e6', seq: 6, turn: 1, type: 'damage', attacker: 'zap', move: 'Make It Rain', defender: 'ape', hpBefore: 175, hpAfter: 140, crit: false, status: 'composite' },
    { eventId: 'e7', seq: 7, turn: 1, type: 'stat_stage_change', target: 'inc', stat: 'atk', stages: 1, source: 'Swords Dance' },
    { eventId: 'e8', seq: 8, turn: 1, type: 'field_change', field: 'Light Screen', action: 'set', side: 'B' },
    { eventId: 'e9', seq: 9, turn: 1, type: 'field_change', field: 'Sun', action: 'set' },
    { eventId: 'e10', seq: 10, turn: 1, type: 'field_change', field: 'Grassy Terrain', action: 'set' },
    { eventId: 'e11', seq: 11, turn: 1, type: 'status_applied', target: 'gar', status: 'brn' },
    { eventId: 'e12', seq: 12, turn: 1, type: 'status_cured', target: 'gar', status: 'brn' },
    { eventId: 'e13', seq: 13, turn: 1, type: 'switch', side: 'A', position: 1, out: 'zap', in: 'tina' },
    { eventId: 'e14', seq: 14, turn: 1, type: 'passive_hp_change', target: 'ape', source: 'Life Orb', hpBefore: 140, hpAfter: 120 },
    { eventId: 'e15', seq: 15, turn: 1, type: 'heal', target: 'ape', source: 'Grassy Terrain', hpBefore: 120, hpAfter: 140 },
    { eventId: 'e16', seq: 16, turn: 1, type: 'item_or_ability_event', mon: 'gar', kind: 'enditem', name: 'Sitrus Berry' },
    { eventId: 'e17', seq: 17, turn: 1, type: 'random_outcome', mon: 'inc', eventKind: 'secondary-burn', outcome: 'no' },
    { eventId: 'e18', seq: 18, turn: 1, type: 'damage', attacker: 'inc', move: 'Flare Blitz', defender: 'gar', hpBefore: 120, hpAfter: 0, crit: false, status: 'unresolved' },
    { eventId: 'e19', seq: 19, turn: 1, type: 'faint', target: 'gar' },
    { eventId: 'e20', seq: 20, turn: 2, type: 'turn_start' },
  ],
};

const proto = toProtocol(LOG);
const linesAt = (seq: number) => proto.filter((m) => m.seq === seq).map((m) => m.line);

describe('U5.1 — protocol covers every event type', () => {
  it('emits a message for each event type (random_outcome is intentionally implied)', () => {
    const has = (prefix: string) => proto.some((m) => m.line.startsWith(prefix));
    for (const prefix of ['|turn|', '|move|', '|-damage|', '|-heal|', '|switch|', '|faint|', '|-status|', '|-curestatus|', '|-boost|', '|-sidestart|', '|-weather|', '|-fieldstart|', '|-enditem|', '|-supereffective|']) {
      expect(has(prefix)).toBe(true);
    }
    // random_outcome (seq 17) produces no standalone message
    expect(proto.some((m) => m.seq === 17)).toBe(false);
  });
});

describe('U5.8 — a spread hit renders two per-target damage messages', () => {
  it('the spread move produces two |-damage| with each target’s own HP', () => {
    const dmg = [...linesAt(5), ...linesAt(6)].filter((l) => l.startsWith('|-damage|'));
    expect(dmg).toEqual(['|-damage|p2a|120/183', '|-damage|p2b|140/175']);
  });
});

describe('U5.3 / U5.6 — displayed HP equals the logged integers; never recomputed', () => {
  it('rebuilding to a damage shows exactly the logged hp_after', () => {
    const player = new ReplayPlayer(proto);
    const dmg3 = proto.find((m) => m.seq === 3 && m.line.startsWith('|-damage|'))!;
    expect(player.toAction(dmg3.index).slots['p2a']!.hp).toBe(150); // logged, verbatim
    const dmg18 = proto.find((m) => m.seq === 18)!;
    expect(player.toAction(dmg18.index).slots['p2a']!.hp).toBe(0);
  });
});

describe('U5.4 — composite/unresolved HP changes render, not skipped', () => {
  it('renders composite and unresolved damage', () => {
    expect(linesAt(5).some((l) => l.startsWith('|-damage|'))).toBe(true); // composite
    expect(linesAt(18).some((l) => l.startsWith('|-damage|'))).toBe(true); // unresolved
  });
});

describe('U5.2 — forward/backward stepping by turn and by action', () => {
  it('steps and jumps coherently', () => {
    const player = new ReplayPlayer(proto);
    expect(player.toTurn(1).turn).toBe(1);
    expect(player.toTurn(2).turn).toBe(2);
    // a backward action step from turn 2 returns to before the turn-2 marker
    const before = player.stepBackward();
    expect(before.turn).toBe(1);
    // forward by single action advances exactly one message
    const i = player.index;
    player.stepForward();
    expect(player.index).toBe(i + 1);
  });

  it('exposes turn markers for by-turn navigation', () => {
    expect(new ReplayPlayer(proto).turnIndices().length).toBe(2);
  });
});

describe('U5.7 — deterministic rebuild', () => {
  it('rebuilding to the same index twice yields identical state', () => {
    const player = new ReplayPlayer(proto);
    const k = Math.floor(proto.length / 2);
    expect(player.stateAt(k)).toEqual(player.stateAt(k));
  });

  it('incremental stepping equals a full rebuild to the end', () => {
    const player = new ReplayPlayer(proto);
    let state = player.toAction(-1);
    for (let i = 0; i < proto.length; i++) state = player.stepForward();
    expect(state).toEqual(player.stateAt(proto.length - 1));
  });
});

describe('Mega Evolution renders a forme change', () => {
  const megaLog: MatchLog = {
    matchId: 'mega', format: 'Champions Reg M-A',
    sideA: { player: 'W', mons: [{ monId: 'cha', species: 'Charizard', maxHp: 153 }] },
    sideB: { player: 'O', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 183 }] },
    leads: [{ side: 'A', position: 0, monId: 'cha' }, { side: 'B', position: 0, monId: 'gar' }],
    events: [
      { eventId: 't', seq: 1, turn: 1, type: 'turn_start' },
      { eventId: 'mega', seq: 2, turn: 1, type: 'mega_evolution', mon: 'cha', megaSpecies: 'Charizard-Mega-X' },
    ],
  };

  it('emits |detailschange| and updates the slot species', () => {
    const p = toProtocol(megaLog);
    expect(p.some((m) => m.line.startsWith('|detailschange|') && m.line.includes('Charizard-Mega-X'))).toBe(true);
    const end = new ReplayPlayer(p).stateAt(p.length - 1);
    expect(end.slots['p1a']!.species).toBe('Charizard-Mega-X');
  });
});

describe('state reconstruction', () => {
  it('tracks board, switches, statuses, field and side conditions', () => {
    const end = new ReplayPlayer(proto).stateAt(proto.length - 1);
    expect(end.slots['p1b']!.species).toBe('Giratina'); // zap switched out for tina
    expect(end.slots['p2a']!.fainted).toBe(true); // gar fainted
    expect(end.weather).toBe('Sun');
    expect(end.field).toContain('Grassy Terrain');
    expect(end.sides.B).toContain('Light Screen');
    expect(end.boosts['inc']).toEqual({ atk: 1 });
    expect(end.status['gar']).toBeUndefined(); // burn was cured
  });
});
