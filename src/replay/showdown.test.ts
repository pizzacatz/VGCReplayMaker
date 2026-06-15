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

  it('appends |win| when a result (e.g. forfeit) is recorded', () => {
    const won = toShowdownLog({ ...LOG, result: { winnerSide: 'B', reason: 'forfeit' } });
    expect(won.includes('|win|AgentUpig')).toBe(true);
  });

  it('renders a faint HP as "0 fnt"', () => {
    const koLog = toShowdownLog({ ...LOG, events: [{ eventId: 'd', seq: 1, turn: 1, type: 'damage', attacker: 'inc', move: 'Flare Blitz', defender: 'gar', hpBefore: 183, hpAfter: 0, crit: false, status: 'clean' }] });
    expect(koLog.includes('|-damage|p2a: Garchomp|0 fnt')).toBe(true);
  });
});
