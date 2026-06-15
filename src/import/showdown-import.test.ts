import { describe, it, expect } from 'vitest';
import { parseShowdownReplay } from './showdown-import';

const LOG = `|player|p1|Alice
|player|p2|Bob
|start
|switch|p1a: Incin|Incineroar, L50, M|175/175
|switch|p2a: Chomp|Garchomp, L50, F|100/100
|turn|1
|-weather|SunnyDay
|move|p1a: Incin|Flare Blitz|p2a: Chomp
|-crit|p2a: Chomp
|-damage|p2a: Chomp|40/100
|move|p2a: Chomp|Earthquake|p1a: Incin
|-damage|p1a: Incin|120/175
|-boost|p2a: Chomp|atk|1
|turn|2
|move|p1a: Incin|Flare Blitz|p2a: Chomp
|-damage|p2a: Chomp|0 fnt
|faint|p2a: Chomp
|win|Alice`;

describe('parseShowdownReplay', () => {
  const { log, warnings } = parseShowdownReplay(LOG);

  it('builds rosters with species, nicknames and absolute max HP', () => {
    expect(log.sideA.player).toBe('Alice');
    expect(log.sideB.player).toBe('Bob');
    expect(log.sideA.mons[0]).toMatchObject({ monId: 'A0', species: 'Incineroar', maxHp: 175, nickname: 'Incin' });
    expect(log.sideB.mons[0]).toMatchObject({ monId: 'B0', species: 'Garchomp', maxHp: 100 }); // percent replay
  });

  it('records the leads before turn 1', () => {
    expect(log.leads).toEqual([
      { side: 'A', position: 0, monId: 'A0' },
      { side: 'B', position: 0, monId: 'B0' },
    ]);
  });

  it('maps moves, damage (with crit), weather, boosts, faint and the winner', () => {
    const types = log.events.map((e) => e.type);
    expect(types).toContain('turn_start');
    expect(types).toContain('move_used');
    expect(types).toContain('damage');
    expect(types).toContain('faint');
    expect(log.events.some((e) => e.type === 'field_change' && e.field === 'Sun')).toBe(true);
    expect(log.events.some((e) => e.type === 'stat_stage_change' && e.target === 'B0' && e.stages === 1)).toBe(true);
    const dmgs = log.events.filter((e): e is Extract<typeof e, { type: 'damage' }> => e.type === 'damage');
    const incHit = dmgs.find((d) => d.attacker === 'A0' && d.defender === 'B0')!;
    expect(incHit.crit).toBe(true);
    expect(incHit.status).toBe('unresolved'); // Garchomp HP was percent → not exact
    const garHit = dmgs.find((d) => d.attacker === 'B0' && d.defender === 'A0')!;
    expect(garHit.status).toBe('clean'); // Incineroar HP was absolute (175)
    expect(garHit.hpBefore - garHit.hpAfter).toBe(55); // 175 → 120
    expect(log.result).toEqual({ winnerSide: 'A', reason: 'ko' });
  });

  it('warns that percent HP was imported as unresolved', () => {
    expect(warnings.some((w) => /percent/i.test(w))).toBe(true);
  });
});
