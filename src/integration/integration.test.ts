/**
 * Integration tests (T3.5) — Validation §6 (end-to-end) + §D3 (clean-only).
 * One transcribed log → extract clean hits → solve → recover the generating
 * spread; composite/unresolved never enter the solver; speed facts are derived
 * soundly from move order.
 */

import { describe, it, expect } from 'vitest';
import { championsGen, predictHit, type MonSpec } from '../engine';
import { ConstraintSystem } from '../solver';
import type { MatchEvent, MatchLog } from '../log';
import { extractCleanHits, extractSpeedFacts, logToGame } from './index';

const gen = championsGen();
const SLOW = 30_000;

const incSpec: MonSpec = { species: 'Incineroar', alignment: { up: 'atk', down: 'spa' } };
const garSpec: MonSpec = { species: 'Garchomp', alignment: { up: 'spe', down: 'spa' } };
const zapSpec: MonSpec = { species: 'Zapdos', alignment: { up: 'spa', down: 'atk' } };

const INC_SPREAD = { hp: 0, atk: 20, def: 12, spa: 0, spd: 12, spe: 22 } as const;
const TRUE_GAR_DEF = 8;

const rolls = predictHit(gen, { attacker: incSpec, attackerSp: INC_SPREAD.atk, defender: garSpec, defenderSp: TRUE_GAR_DEF, move: 'Flare Blitz' }).rolls;

/** A transcribed match: three clean Flare Blitz hits on Garchomp + one composite drop. */
function buildRoundTripLog(): MatchLog {
  const d = [rolls[3]!, rolls[7]!, rolls[11]!];
  let hp = 203; // Garchomp max HP (SP_hp 20)
  const dmg = (seq: number, turn: number, amount: number, status: 'clean' | 'composite', attacker: string): MatchEvent => {
    const before = hp;
    hp -= amount;
    return { eventId: `d${seq}`, seq, turn, type: 'damage', attacker, move: attacker === 'inc' ? 'Flare Blitz' : 'Make It Rain', defender: 'gar', hpBefore: before, hpAfter: hp, crit: false, status };
  };
  return {
    matchId: 'rt', format: 'Champions Reg M-A',
    sideA: { player: 'W', mons: [{ monId: 'inc', species: 'Incineroar', maxHp: 170 }, { monId: 'zap', species: 'Zapdos', maxHp: 160 }] },
    sideB: { player: 'O', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 203 }] },
    leads: [{ side: 'A', position: 0, monId: 'inc' }, { side: 'A', position: 1, monId: 'zap' }, { side: 'B', position: 0, monId: 'gar' }],
    events: [
      { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
      { eventId: 'm1', seq: 2, turn: 1, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
      dmg(3, 1, d[0]!, 'clean', 'inc'),
      { eventId: 'm2', seq: 4, turn: 1, type: 'move_used', user: 'zap', move: 'Make It Rain', targets: ['gar'] },
      dmg(5, 1, 30, 'composite', 'zap'), // a drop the solver must ignore
      { eventId: 't2', seq: 6, turn: 2, type: 'turn_start' },
      { eventId: 'm3', seq: 7, turn: 2, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
      dmg(8, 2, d[1]!, 'clean', 'inc'),
      { eventId: 't3', seq: 9, turn: 3, type: 'turn_start' },
      { eventId: 'm4', seq: 10, turn: 3, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
      dmg(11, 3, d[2]!, 'clean', 'inc'),
    ],
  };
}

describe('§D3 — only clean hits reach the solver', () => {
  it('extracts the three clean hits and excludes the composite drop', () => {
    const hits = extractCleanHits(buildRoundTripLog());
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.attackerId === 'inc' && h.defenderId === 'gar')).toBe(true);
    expect(hits.some((h) => h.move === 'Make It Rain')).toBe(false);
    expect(hits[0]!.observedDamage).toBe(rolls[3]); // hp_before − hp_after
  });
});

describe('§6 — end-to-end round trip: transcribe → extract → solve → recover', () => {
  it(
    'recovers the generating defense from the transcribed log',
    () => {
      const hits = extractCleanHits(buildRoundTripLog());
      const system = new ConstraintSystem(gen, [
        { id: 'inc', spec: incSpec, observedMaxHp: 170 },
        { id: 'gar', spec: garSpec, observedMaxHp: 203 },
      ], hits);
      // open sheets: Incineroar known; Garchomp leaves def & spe free.
      for (const [s, v] of Object.entries(INC_SPREAD)) if (s !== 'hp') system.restrictDomain('inc', s as 'atk', [v]);
      system.restrictDomain('gar', 'atk', [0]);
      system.restrictDomain('gar', 'spa', [0]);
      system.restrictDomain('gar', 'spd', [18]); // def + spe = 28

      const report = system.solve({ method: 'exact' }).mons.find((m) => m.monId === 'gar')!;
      const def = report.perStat.find((r) => r.stat === 'def')!;
      expect(report.contradiction).toBeUndefined();
      expect(def.tag).toBe('bounded');
      expect(Math.abs(def.best - TRUE_GAR_DEF)).toBeLessThanOrEqual(4);
      expect(def.distribution.some((x) => x.sp === TRUE_GAR_DEF)).toBe(true);
    },
    SLOW,
  );
});

describe('§4 — sound speed-fact extraction from move order', () => {
  const specs = new Map<string, MonSpec>([['inc', incSpec], ['gar', garSpec], ['zap', zapSpec]]);
  const baseLog = (events: MatchEvent[]): MatchLog => ({
    matchId: 's', format: 'Champions Reg M-A',
    sideA: { player: 'W', mons: [{ monId: 'inc', species: 'Incineroar', maxHp: 170 }] },
    sideB: { player: 'O', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 203 }] },
    leads: [{ side: 'A', position: 0, monId: 'inc' }, { side: 'B', position: 0, monId: 'gar' }],
    events,
  });

  it('emits a fact for a same-bracket order and skips a cross-bracket one (the guard)', () => {
    const log = baseLog([
      { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
      { eventId: 'a', seq: 2, turn: 1, type: 'move_used', user: 'inc', move: 'Fake Out', targets: ['gar'] }, // priority +3
      { eventId: 'b', seq: 3, turn: 1, type: 'move_used', user: 'gar', move: 'Earthquake', targets: ['inc'] }, // priority 0
      { eventId: 't2', seq: 4, turn: 2, type: 'turn_start' },
      { eventId: 'c', seq: 5, turn: 2, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] }, // 0
      { eventId: 'd', seq: 6, turn: 2, type: 'move_used', user: 'gar', move: 'Earthquake', targets: ['inc'] }, // 0
    ]);
    const { facts } = extractSpeedFacts(log, gen, specs);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ first: 'inc', second: 'gar', samePriorityBracket: true });
  });

  it('models Tailwind (×2) on the mover rather than discarding the order', () => {
    const log = baseLog([
      { eventId: 'tw', seq: 1, turn: 1, type: 'field_change', field: 'Tailwind', action: 'set', side: 'A' },
      { eventId: 't1', seq: 2, turn: 1, type: 'turn_start' },
      { eventId: 'c', seq: 3, turn: 1, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
      { eventId: 'd', seq: 4, turn: 1, type: 'move_used', user: 'gar', move: 'Earthquake', targets: ['inc'] },
    ]);
    const { facts } = extractSpeedFacts(log, gen, specs);
    expect(facts).toHaveLength(1); // the open sheet pins the magnitude → usable, not skipped
    expect(facts[0]).toMatchObject({ first: 'inc', second: 'gar', firstControl: { num: 2, den: 1 } });
    expect(facts[0]!.secondControl).toBeUndefined(); // gar (side B) has no Tailwind
  });

  it('still skips an order when a mover is UNSHEETED (could hold a Choice Scarf)', () => {
    const log = baseLog([
      { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
      { eventId: 'c', seq: 2, turn: 1, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
      { eventId: 'd', seq: 3, turn: 1, type: 'move_used', user: 'gar', move: 'Earthquake', targets: ['inc'] },
    ]);
    const partial = new Map<string, MonSpec>([['inc', incSpec]]); // gar unsheeted
    const { facts, skipped } = extractSpeedFacts(log, gen, partial);
    expect(facts).toHaveLength(0);
    expect(skipped.some((s) => /unsheeted/i.test(s.reason))).toBe(true);
  });
});

describe('bridge — log → aggregation Game', () => {
  it('resolves mon ids to the right instances', () => {
    const specs = new Map<string, MonSpec>([['inc', incSpec], ['zap', zapSpec], ['gar', garSpec]]);
    const game = logToGame(
      buildRoundTripLog(),
      { gameId: 'G1', tournamentId: 'T1', sideA: { playerId: 'W', instanceId: 'X' }, sideB: { playerId: 'O', instanceId: 'Y' } },
      gen,
      specs,
    );
    expect(game.cleanHits).toHaveLength(3);
    expect(game.cleanHits[0]!.attacker).toEqual({ instanceId: 'X', monId: 'inc' });
    expect(game.cleanHits[0]!.defender).toEqual({ instanceId: 'Y', monId: 'gar' });
  });
});

describe('Evidence drill-down — exactly which hits derive a stat', () => {
  it('lists the contributing clean hits with move, damage, opponent and source', () => {
    const hits = extractCleanHits(buildRoundTripLog());
    const report = new ConstraintSystem(gen, [
      { id: 'inc', spec: incSpec, observedMaxHp: 170 },
      { id: 'gar', spec: garSpec, observedMaxHp: 203 },
    ], hits).solve({ method: 'exact' }).mons.find((m) => m.monId === 'gar')!;

    const taken = report.evidence.hits.filter((h) => h.role === 'taken');
    expect(taken).toHaveLength(3); // Garchomp took three clean Flare Blitz
    expect(taken.every((h) => h.stat === 'def')).toBe(true); // physical → constrains Def
    expect(taken.every((h) => h.move === 'Flare Blitz' && h.opponentSpecies === 'Incineroar')).toBe(true);
    expect(taken.every((h) => typeof h.observedDamage === 'number' && h.observedDamage > 0)).toBe(true);
    expect(taken.every((h) => /^T\d+$/.test(h.source ?? ''))).toBe(true); // turn-tagged provenance
  });
});

describe('Mega forme — post-Mega hits use the Mega forme stats (extraction)', () => {
  // A log where Mawile Mega-Evolves on turn 1, then lands a clean Iron Head.
  function megaLog(observedDamage: number): MatchLog {
    return {
      matchId: 'mega', format: 'Champions Reg M-A',
      sideA: { player: 'W', mons: [{ monId: 'maw', species: 'Mawile', maxHp: 125 }] },
      sideB: { player: 'O', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 183 }] },
      leads: [{ side: 'A', position: 0, monId: 'maw' }, { side: 'B', position: 0, monId: 'gar' }],
      events: [
        { eventId: 't1', seq: 1, turn: 1, type: 'turn_start' },
        { eventId: 'mega', seq: 2, turn: 1, type: 'mega_evolution', mon: 'maw', megaSpecies: 'Mawile-Mega' },
        { eventId: 'm1', seq: 3, turn: 1, type: 'move_used', user: 'maw', move: 'Iron Head', targets: ['gar'] },
        { eventId: 'd1', seq: 4, turn: 1, type: 'damage', attacker: 'maw', move: 'Iron Head', defender: 'gar', hpBefore: 183, hpAfter: 183 - observedDamage, crit: false, status: 'clean' },
      ],
    };
  }

  it('tags the clean hit with the attacker’s Mega forme', () => {
    const hits = extractCleanHits(megaLog(60));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.attackerSpecies).toBe('Mawile-Mega'); // forme-at-hit-time captured
  });
});

describe('Field/boosts reconstruction (extraction)', () => {
  it('tags a hit with the weather, screen, and attacker boosts active at that moment', () => {
    const log: MatchLog = {
      matchId: 'ctx', format: 'Champions Reg M-A',
      sideA: { player: 'W', mons: [{ monId: 'inc', species: 'Incineroar', maxHp: 170 }] },
      sideB: { player: 'O', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 183 }] },
      leads: [{ side: 'A', position: 0, monId: 'inc' }, { side: 'B', position: 0, monId: 'gar' }],
      events: [
        { eventId: 'w', seq: 1, turn: 1, type: 'field_change', field: 'Sun', action: 'set' },
        { eventId: 'r', seq: 2, turn: 1, type: 'field_change', field: 'Reflect', action: 'set', side: 'B' },
        { eventId: 'sd', seq: 3, turn: 1, type: 'stat_stage_change', target: 'inc', stat: 'atk', stages: 2 },
        { eventId: 'm', seq: 4, turn: 1, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
        { eventId: 'd', seq: 5, turn: 1, type: 'damage', attacker: 'inc', move: 'Flare Blitz', defender: 'gar', hpBefore: 183, hpAfter: 120, crit: false, status: 'clean' },
      ],
    };
    const hit = extractCleanHits(log)[0]!;
    expect(hit.context?.weather).toBe('Sun');
    expect(hit.context?.reflect).toBe(true); // Reflect on the DEFENDER's side
    expect(hit.context?.attackerBoosts).toEqual({ atk: 2 });
  });
});

describe('Speed-dependent moves are excluded from the clean factor set', () => {
  it('drops a Gyro Ball hit (its power couples to unknown Speed) rather than mis-model it', () => {
    const log: MatchLog = {
      matchId: 'gb', format: 'Champions Reg M-A',
      sideA: { player: 'W', mons: [{ monId: 'fer', species: 'Ferrothorn', maxHp: 175 }] },
      sideB: { player: 'O', mons: [{ monId: 'dnite', species: 'Dragonite', maxHp: 180 }] },
      leads: [{ side: 'A', position: 0, monId: 'fer' }, { side: 'B', position: 0, monId: 'dnite' }],
      events: [
        { eventId: 'm', seq: 1, turn: 1, type: 'move_used', user: 'fer', move: 'Gyro Ball', targets: ['dnite'] },
        { eventId: 'd', seq: 2, turn: 1, type: 'damage', attacker: 'fer', move: 'Gyro Ball', defender: 'dnite', hpBefore: 180, hpAfter: 120, crit: false, status: 'clean' },
        { eventId: 'm2', seq: 3, turn: 1, type: 'move_used', user: 'dnite', move: 'Earthquake', targets: ['fer'] },
        { eventId: 'd2', seq: 4, turn: 1, type: 'damage', attacker: 'dnite', move: 'Earthquake', defender: 'fer', hpBefore: 175, hpAfter: 150, crit: false, status: 'clean' },
      ],
    };
    const hits = extractCleanHits(log);
    expect(hits.map((h) => h.move)).toEqual(['Earthquake']); // Gyro Ball excluded, the normal hit kept
  });
});

describe('Paradox boost (Protosynthesis/Quark Drive) in the damage factor', () => {
  it('a hit dealt under a recorded Atk Paradox boost solves with the ×1.3, not without it', () => {
    const ironHands: MonSpec = { species: 'Iron Hands', alignment: 'neutral' };
    // ground truth: Iron Hands Atk SP 8, Quark Drive boosting Atk, into Garchomp.
    const rolls = predictHit(gen, { attacker: ironHands, attackerSp: 8, defender: garSpec, defenderSp: 0, move: 'Drain Punch', context: { attackerBoostedStat: 'atk' } }).rolls;
    const observed = rolls[7]!;
    const log: MatchLog = {
      matchId: 'qd', format: 'Champions Reg M-A',
      sideA: { player: 'W', mons: [{ monId: 'ih', species: 'Iron Hands', maxHp: 229 }] },
      sideB: { player: 'O', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 183 }] },
      leads: [{ side: 'A', position: 0, monId: 'ih' }, { side: 'B', position: 0, monId: 'gar' }],
      events: [
        { eventId: 'qd', seq: 1, turn: 1, type: 'item_or_ability_event', mon: 'ih', kind: 'paradox', name: 'atk' },
        { eventId: 'm', seq: 2, turn: 1, type: 'move_used', user: 'ih', move: 'Drain Punch', targets: ['gar'] },
        { eventId: 'd', seq: 3, turn: 1, type: 'damage', attacker: 'ih', move: 'Drain Punch', defender: 'gar', hpBefore: 183, hpAfter: 183 - observed, crit: false, status: 'clean' },
      ],
    };
    const hit = extractCleanHits(log)[0]!;
    expect(hit.context?.attackerBoostedStat).toBe('atk'); // reconstructed from the log
    const sys = (ctx: boolean) => new ConstraintSystem(gen, [
      { id: 'ih', spec: ironHands, observedMaxHp: 229 },
      { id: 'gar', spec: garSpec, observedMaxHp: 183 },
    ], [{ attackerId: 'ih', defenderId: 'gar', move: 'Drain Punch', observedDamage: observed, ...(ctx ? { context: { attackerBoostedStat: 'atk' } } : {}) }]);
    expect(sys(true).propagate().domains.get('ih')!.get('atk')!).toContain(8); // boost explains it at low SP
    expect(sys(false).propagate().domains.get('ih')!.get('atk')!).not.toContain(8); // ignoring it demands more
  });
});

describe('Damage context: Helping Hand, single-target spread, Multiscale', () => {
  const ttar: MonSpec = { species: 'Tyranitar', alignment: 'neutral' };
  const dnite: MonSpec = { species: 'Dragonite', alignment: 'neutral', ability: 'Multiscale' };

  it('predictHit applies each modifier (vs the unmodified Doubles baseline)', () => {
    const base = predictHit(gen, { attacker: ttar, attackerSp: 0, defender: garSpec, defenderSp: 0, move: 'Rock Slide', context: {} }).rolls[7]!;
    const hh = predictHit(gen, { attacker: ttar, attackerSp: 0, defender: garSpec, defenderSp: 0, move: 'Rock Slide', context: { helpingHand: true } }).rolls[7]!;
    const single = predictHit(gen, { attacker: ttar, attackerSp: 0, defender: garSpec, defenderSp: 0, move: 'Rock Slide', context: { singleTargetSpread: true } }).rolls[7]!;
    expect(hh).toBeGreaterThan(base); // Helping Hand ×1.5
    expect(single).toBeGreaterThan(base); // dropping the 0.75 spread reduction
    const msFull = predictHit(gen, { attacker: garSpec, attackerSp: 0, defender: dnite, defenderSp: 0, move: 'Ice Beam', context: {} }).rolls[7]!;
    const msHurt = predictHit(gen, { attacker: garSpec, attackerSp: 0, defender: dnite, defenderSp: 0, move: 'Ice Beam', context: { defenderFullHp: false } }).rolls[7]!;
    expect(msHurt).toBeGreaterThan(msFull); // Multiscale off below full HP
  });

  it('extraction reconstructs the modifiers from the log', () => {
    const log: MatchLog = {
      matchId: 'ctx2', format: 'Champions Reg M-A',
      sideA: { player: 'W', mons: [{ monId: 'inc', species: 'Incineroar', maxHp: 170 }, { monId: 'zap', species: 'Zapdos', maxHp: 160 }] },
      sideB: { player: 'O', mons: [{ monId: 'gar', species: 'Garchomp', maxHp: 183 }, { monId: 'ape', species: 'Annihilape', maxHp: 175 }] },
      leads: [{ side: 'A', position: 0, monId: 'inc' }, { side: 'A', position: 1, monId: 'zap' }, { side: 'B', position: 0, monId: 'gar' }, { side: 'B', position: 1, monId: 'ape' }],
      events: [
        { eventId: 'hh', seq: 1, turn: 1, type: 'move_used', user: 'zap', move: 'Helping Hand', targets: ['inc'] },
        { eventId: 'm1', seq: 2, turn: 1, type: 'move_used', user: 'inc', move: 'Flare Blitz', targets: ['gar'] },
        { eventId: 'd1', seq: 3, turn: 1, type: 'damage', attacker: 'inc', move: 'Flare Blitz', defender: 'gar', hpBefore: 183, hpAfter: 120, crit: false, status: 'clean' },
        // a spread Rock Slide that hit only ONE foe (the other already gone)
        { eventId: 'm2', seq: 4, turn: 1, type: 'move_used', user: 'gar', move: 'Rock Slide', targets: ['inc'], isSpread: true },
        { eventId: 'd2', seq: 5, turn: 1, type: 'damage', attacker: 'gar', move: 'Rock Slide', defender: 'inc', hpBefore: 100, hpAfter: 60, crit: false, status: 'clean' },
      ],
    };
    const [h1, h2] = extractCleanHits(log);
    expect(h1!.context?.helpingHand).toBe(true);
    expect(h1!.context?.defenderFullHp).toBeUndefined(); // gar was at full HP
    expect(h2!.context?.singleTargetSpread).toBe(true); // spread move, one target
    expect(h2!.context?.defenderFullHp).toBe(false); // inc was at 100/170
  });
});
