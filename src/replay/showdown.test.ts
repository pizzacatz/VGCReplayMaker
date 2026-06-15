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

  it('renders a faint HP as "0 fnt"', () => {
    const koLog = toShowdownLog({ ...LOG, events: [{ eventId: 'd', seq: 1, turn: 1, type: 'damage', attacker: 'inc', move: 'Flare Blitz', defender: 'gar', hpBefore: 183, hpAfter: 0, crit: false, status: 'clean' }] });
    expect(koLog.includes('|-damage|p2a: Garchomp|0 fnt')).toBe(true);
  });
});
