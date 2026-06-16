/** Showdown battle-log generation — format matched to a real Champions replay. */

import { describe, it, expect } from 'vitest';
import type { MatchLog } from '../log';
import { toShowdownLog } from './showdown';

const LOG: MatchLog = {
  matchId: 'm', format: '[Gen 9 Champions] VGC 2026 Reg M-A',
  sideA: { player: 'very_beeg_rat', mons: [{ monId: 'inc', species: 'Incineroar', maxHp: 172 }, { monId: 'cha', species: 'Charizard', maxHp: 153 }] },
  sideB: { player: 'AgentUpig', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 183 }, { monId: 'tal', species: 'Talonflame', maxHp: 155 }] },
  leads: [
    { side: 'A', position: 0, monId: 'inc' },
    { side: 'A', position: 1, monId: 'cha' },
    { side: 'B', position: 0, monId: 'gar' },
    { side: 'B', position: 1, monId: 'tal' },
  ],
  events: [
    { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
    { eventId: 'm1', seq: 2, turn: 1, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
    { eventId: 'd1', seq: 3, turn: 1, type: 'damage', attacker: 'inc', move: 'Flare Blitz', defender: 'gar', hpBefore: 183, hpAfter: 150, crit: false, status: 'clean', observedEffectiveness: '2x' },
    { eventId: 'me', seq: 4, turn: 1, type: 'mega_evolution', mon: 'cha', megaSpecies: 'Charizard-Mega-Y' },
    { eventId: 'w', seq: 5, turn: 1, type: 'field_change', field: 'Sun', action: 'set' },
    { eventId: 'f', seq: 6, turn: 1, type: 'faint', target: 'gar' },
  ],
};

describe('toShowdownLog', () => {
  const log = toShowdownLog(LOG);
  const has = (s: string) => expect(log.includes(s), s).toBe(true);

  it('emits a valid Showdown header + team preview', () => {
    has('|gametype|doubles');
    has('|player|p1|very_beeg_rat|1|');
    has('|player|p2|AgentUpig|1|');
    has('|gen|9');
    has('|tier|[Gen 9 Champions] VGC 2026 Reg M-A');
    has('|poke|p1|Incineroar, L50|');
    has('|poke|p2|Garchomp, L50|');
    has('|start');
  });

  it('emits the leads as switches with current/max HP', () => {
    has('|switch|p1a: Incineroar|Incineroar, L50|172/172');
    has('|switch|p2a: Garchomp|Garchomp, L50|183/183');
  });

  it('emits moves, effectiveness, damage, mega, weather, faint in Showdown format', () => {
    has('|turn|1');
    has('|move|p1a: Incineroar|Flare Blitz|p2a: Garchomp');
    has('|-supereffective|p2a: Garchomp');
    has('|-damage|p2a: Garchomp|150/183');
    has('|detailschange|p1b: Charizard|Charizard-Mega-Y, L50');
    has('|-weather|SunnyDay');
    has('|faint|p2a: Garchomp');
  });

  it('communicates a forfeit (message before the win), not a silent win', () => {
    const won = toShowdownLog({ ...LOG, result: { winnerSide: 'B', reason: 'forfeit' } });
    expect(won).toContain('|-message|very_beeg_rat forfeited.'); // the loser (side A) conceded
    expect(won).toContain('|win|AgentUpig');
    expect(won.indexOf('forfeited.')).toBeLessThan(won.indexOf('|win|')); // message precedes the win
  });

  it('a normal KO win carries no forfeit message', () => {
    const ko = toShowdownLog({ ...LOG, result: { winnerSide: 'A', reason: 'ko' } });
    expect(ko).not.toContain('forfeited');
    expect(ko).toContain('|win|very_beeg_rat');
  });

  it('renders protection: -singleturn when used, -activate when an attack is blocked', () => {
    const out = toShowdownLog({
      ...LOG,
      events: [
        { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
        { eventId: 'pr', seq: 2, turn: 1, type: 'move_used', user: 'gar', move: 'Protect', targets: ['gar'] },
        { eventId: 'mv', seq: 3, turn: 1, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
        { eventId: 'bl', seq: 4, turn: 1, type: 'random_outcome', mon: 'gar', eventKind: 'blocked', outcome: 'Protect' },
      ],
    });
    expect(out).toContain('|-singleturn|p2a: Garchomp|Protect'); // "Garchomp protected itself!"
    expect(out).toContain('|-activate|p2a: Garchomp|move: Protect'); // the blocked attack is shown, not a silent miss
  });

  it('renders a real accuracy miss as |-miss| (source → target)', () => {
    const out = toShowdownLog({
      ...LOG,
      events: [
        { eventId: 'mv', seq: 1, turn: 1, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
        { eventId: 'ms', seq: 2, turn: 1, type: 'random_outcome', mon: 'gar', eventKind: 'miss', outcome: 'yes' },
      ],
    });
    expect(out).toContain('|-miss|p1a: Incineroar|p2a: Garchomp');
  });

  it('tags a spread move with [spread] and the hit slots', () => {
    const out = toShowdownLog({ ...LOG, events: [{ eventId: 'm', seq: 1, turn: 1, type: 'move_used', user: 'inc', move: 'Rock Slide', targets: ['gar', 'tal'], isSpread: true }] });
    expect(out).toContain('|move|p1a: Incineroar|Rock Slide|p2a: Garchomp|[spread] p2a,p2b');
  });

  it('writes proper [from] attribution (item: / status)', () => {
    const out = toShowdownLog({
      ...LOG,
      events: [
        { eventId: 'h', seq: 1, turn: 1, type: 'heal', target: 'gar', source: 'Leftovers', hpBefore: 150, hpAfter: 161 },
        { eventId: 'p', seq: 2, turn: 1, type: 'passive_hp_change', target: 'gar', source: 'Burn', hpBefore: 161, hpAfter: 150 },
        { eventId: 's', seq: 3, turn: 1, type: 'heal', target: 'gar', source: 'Sitrus Berry', hpBefore: 50, hpAfter: 90 },
      ],
    });
    expect(out).toContain('[from] item: Leftovers');
    expect(out).toContain('[from] brn');
    expect(out).toContain('[from] item: Sitrus Berry');
  });

  it('announces a self-boost ability before the boost', () => {
    const out = toShowdownLog({ ...LOG, events: [{ eventId: 'd', seq: 1, turn: 1, type: 'stat_stage_change', target: 'gar', stat: 'atk', stages: 2, source: 'Defiant' }] });
    expect(out).toContain('|-ability|p2a: Garchomp|Defiant');
    expect(out.indexOf('|-ability|p2a: Garchomp|Defiant')).toBeLessThan(out.indexOf('|-boost|p2a: Garchomp|atk|2'));
  });

  it('emits -hitcount, |upkeep| before a turn, and berry [eat]', () => {
    const out = toShowdownLog({
      ...LOG,
      events: [
        { eventId: 'm', seq: 1, turn: 1, type: 'move_used', user: 'inc', move: 'Bullet Seed', targets: ['gar'] },
        { eventId: 'dd', seq: 2, turn: 1, type: 'damage', attacker: 'inc', move: 'Bullet Seed', defender: 'gar', hpBefore: 183, hpAfter: 150, crit: false, status: 'clean', hits: 3 },
        { eventId: 'ee', seq: 3, turn: 1, type: 'item_or_ability_event', mon: 'gar', kind: 'enditem', name: 'Sitrus Berry' },
        { eventId: 't2', seq: 4, turn: 2, type: 'turn_start' },
      ],
    });
    expect(out).toContain('|-hitcount|p2a: Garchomp|3');
    expect(out).toContain('|-enditem|p2a: Garchomp|Sitrus Berry|[eat]');
    expect(out.indexOf('|upkeep|')).toBeLessThan(out.indexOf('|turn|2'));
  });

  it('does not emit an invalid line for the solver-only paradox marker', () => {
    const out = toShowdownLog({ ...LOG, events: [{ eventId: 'q', seq: 1, turn: 1, type: 'item_or_ability_event', mon: 'gar', kind: 'paradox', name: 'atk' }] });
    expect(out).not.toContain('paradox');
  });

  it('threads gender, mega stone, Intimidate -ability, and status [from]', () => {
    const rich: MatchLog = {
      matchId: 'r', format: '[Gen 9 Champions] Reg M-A',
      sideA: { player: 'W', mons: [
        { monId: 'inc', species: 'Incineroar', maxHp: 202, gender: 'F', ability: 'Intimidate' },
        { monId: 'aero', species: 'Aerodactyl', maxHp: 157, gender: 'M', item: 'Aerodactylite' },
      ] },
      sideB: { player: 'O', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 183, gender: 'M' }] },
      leads: [{ side: 'A', position: 0, monId: 'inc' }, { side: 'A', position: 1, monId: 'aero' }, { side: 'B', position: 0, monId: 'gar' }],
      events: [
        { eventId: 'ab', seq: 1, turn: 1, type: 'item_or_ability_event', mon: 'inc', kind: 'ability', name: 'Intimidate' },
        { eventId: 'dr', seq: 2, turn: 1, type: 'stat_stage_change', target: 'gar', stat: 'atk', stages: -1, source: 'Intimidate' },
        { eventId: 'me', seq: 3, turn: 1, type: 'mega_evolution', mon: 'aero', megaSpecies: 'Aerodactyl-Mega' },
        { eventId: 'st', seq: 4, turn: 1, type: 'status_applied', target: 'gar', status: 'brn', source: 'Will-O-Wisp' },
      ],
    };
    const out = toShowdownLog(rich);
    expect(out).toContain('|switch|p1a: Incineroar|Incineroar, L50, F|202/202'); // gender in details
    expect(out).toContain('|-ability|p1a: Incineroar|Intimidate|boost'); // ability announced on the holder
    expect(out).toContain('|detailschange|p1b: Aerodactyl|Aerodactyl-Mega, L50, M');
    expect(out).toContain('|-mega|p1b: Aerodactyl|Aerodactyl|Aerodactylite'); // base species + the stone
    expect(out).toContain('|-status|p2a: Garchomp|brn|[from] move: Will-O-Wisp');
  });

  it('re-shows weather each turn with |-weather| … |[upkeep]', () => {
    const out = toShowdownLog({
      ...LOG,
      events: [
        { eventId: 'w', seq: 1, turn: 1, type: 'field_change', field: 'Sand', action: 'set' },
        { eventId: 't2', seq: 2, turn: 2, type: 'turn_start' },
      ],
    });
    expect(out).toContain('|-weather|Sandstorm\n'); // initial set
    expect(out).toContain('|-weather|Sandstorm|[upkeep]'); // re-shown on turn 2
  });

  it('renders volatiles (-start/-end), a hazard (-sidestart), and can’t-move (|cant|)', () => {
    const out = toShowdownLog({
      ...LOG,
      events: [
        { eventId: 'v1', seq: 1, turn: 1, type: 'volatile', mon: 'gar', effect: 'Encore', action: 'start' },
        { eventId: 'v2', seq: 2, turn: 1, type: 'volatile', mon: 'inc', effect: 'move: Taunt', action: 'start' },
        { eventId: 'v3', seq: 3, turn: 1, type: 'volatile', mon: 'gar', effect: 'Encore', action: 'end' },
        { eventId: 'h', seq: 4, turn: 1, type: 'field_change', field: 'Sticky Web', action: 'set', side: 'B' },
        { eventId: 'c', seq: 5, turn: 1, type: 'random_outcome', mon: 'inc', eventKind: 'cant', outcome: 'slp' },
      ],
    });
    expect(out).toContain('|-start|p2a: Garchomp|Encore');
    expect(out).toContain('|-start|p1a: Incineroar|move: Taunt');
    expect(out).toContain('|-end|p2a: Garchomp|Encore');
    expect(out).toContain('|-sidestart|p2: AgentUpig|move: Sticky Web');
    expect(out).toContain('|cant|p1a: Incineroar|slp');
  });

  it('keeps the status on the HP condition string and attributes poison/toxic damage to psn', () => {
    const out = toShowdownLog({
      ...LOG,
      events: [
        { eventId: 'st', seq: 1, turn: 1, type: 'status_applied', target: 'gar', status: 'tox' },
        { eventId: 't2', seq: 2, turn: 2, type: 'turn_start' },
        { eventId: 'dmg', seq: 3, turn: 2, type: 'passive_hp_change', target: 'gar', source: 'Toxic', hpBefore: 183, hpAfter: 160 },
      ],
    });
    expect(out).toContain('|-status|p2a: Garchomp|tox'); // "badly poisoned!"
    expect(out).toContain('|-damage|p2a: Garchomp|160/183 tox|[from] psn'); // HP carries the status, damage is from psn
  });

  it('clears the status suffix once cured', () => {
    const out = toShowdownLog({
      ...LOG,
      events: [
        { eventId: 's', seq: 1, turn: 1, type: 'status_applied', target: 'gar', status: 'brn' },
        { eventId: 'c', seq: 2, turn: 1, type: 'status_cured', target: 'gar', status: 'brn' },
        { eventId: 'd', seq: 3, turn: 1, type: 'damage', attacker: 'inc', move: 'Flare Blitz', defender: 'gar', hpBefore: 183, hpAfter: 150, crit: false, status: 'clean' },
      ],
    });
    expect(out).toContain('|-damage|p2a: Garchomp|150/183'); // no status suffix after cure
    expect(out).not.toContain('150/183 brn');
  });

  it('Infestation: trap starts on use, ends when the trapper switches out, chip is [from] move:', () => {
    const out = toShowdownLog({
      ...LOG,
      events: [
        { eventId: 'm', seq: 1, turn: 1, type: 'move_used', user: 'inc', move: 'Infestation', targets: ['gar'] },
        { eventId: 'd', seq: 2, turn: 1, type: 'damage', attacker: 'inc', move: 'Infestation', defender: 'gar', hpBefore: 183, hpAfter: 170, crit: false, status: 'clean' },
        { eventId: 'tick', seq: 3, turn: 1, type: 'passive_hp_change', target: 'gar', source: 'Infestation', hpBefore: 170, hpAfter: 159 },
        { eventId: 'sw', seq: 4, turn: 2, type: 'switch', side: 'A', position: 0, out: 'inc', in: 'cha' },
      ],
    });
    expect(out).toContain('|-start|p2a: Garchomp|move: Infestation'); // trap begins
    expect(out).toContain('|-damage|p2a: Garchomp|159/183|[from] move: Infestation'); // tick attributed to the move
    expect(out).toContain('|-end|p2a: Garchomp|move: Infestation'); // undone when Incineroar leaves
    expect(out.indexOf('|-end|p2a: Garchomp|move: Infestation')).toBeLessThan(out.indexOf('|switch|p1a: Charizard'));
  });

  it('a failed move renders |-fail|', () => {
    const out = toShowdownLog({
      ...LOG,
      events: [
        { eventId: 'm', seq: 1, turn: 1, type: 'move_used', user: 'inc', move: 'Fake Out', targets: ['gar'] },
        { eventId: 'f', seq: 2, turn: 1, type: 'random_outcome', mon: 'inc', eventKind: 'fail', outcome: 'yes' },
      ],
    });
    expect(out).toContain('|-fail|p1a: Incineroar');
  });

  it('renders a faint HP as "0 fnt"', () => {
    const koLog = toShowdownLog({ ...LOG, events: [{ eventId: 'd', seq: 1, turn: 1, type: 'damage', attacker: 'inc', move: 'Flare Blitz', defender: 'gar', hpBefore: 183, hpAfter: 0, crit: false, status: 'clean' }] });
    expect(koLog.includes('|-damage|p2a: Garchomp|0 fnt')).toBe(true);
  });
});
