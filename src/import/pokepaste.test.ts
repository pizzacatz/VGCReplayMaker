/** Pokepaste import tests — Validation List v2 §7.2 (U7.2.1–7). */

import { describe, it, expect } from 'vitest';
import { alignmentForNature } from '../engine';
import { parsePokepaste } from './pokepaste';

const KNOWN_SPREAD = `Incineroar @ Assault Vest
Ability: Intimidate
Level: 50
Tera Type: Grass
SP: 20 HP / 4 Def / 20 SpD / 22 Spe
Adamant Nature
IVs: 0 Spe
- Fake Out
- Knock Off
- Flare Blitz
- Parting Shot`;

const SHEET_ONLY = `Incineroar @ Assault Vest
Ability: Intimidate
Adamant Nature
- Fake Out
- Knock Off
- Flare Blitz
- Parting Shot`;

describe('U7.2.1 — a known paste parses to the correct sheet', () => {
  it('maps species/item/ability/moves/alignment', () => {
    const mon = parsePokepaste(KNOWN_SPREAD).mons[0]!;
    expect(mon.species).toBe('Incineroar');
    expect(mon.item).toBe('Assault Vest');
    expect(mon.ability).toBe('Intimidate');
    expect(mon.moves).toEqual(['Fake Out', 'Knock Off', 'Flare Blitz', 'Parting Shot']);
    expect(mon.alignment).toEqual({ up: 'atk', down: 'spa' }); // Adamant
  });
});

describe('U7.2.2 — nature → alignment for boosted, reduced, neutral', () => {
  it('maps representative natures', () => {
    expect(alignmentForNature('Adamant')).toEqual({ up: 'atk', down: 'spa' });
    expect(alignmentForNature('Bold')).toEqual({ up: 'def', down: 'atk' });
    expect(alignmentForNature('Timid')).toEqual({ up: 'spe', down: 'atk' });
    expect(alignmentForNature('Serious')).toBe('neutral');
    expect(() => alignmentForNature('Notanature')).toThrow();
  });
});

describe('U7.2.3 — Tera Type and IVs ignored; Tera raises a soft flag', () => {
  it('ignores Tera/IVs but records soft flags', () => {
    const mon = parsePokepaste(KNOWN_SPREAD).mons[0]!;
    expect(mon.flags.some((f) => /Tera/i.test(f))).toBe(true);
    expect(mon.flags.some((f) => /IV/i.test(f))).toBe(true);
  });
});

describe('U7.2.4 / U7.2.5 — sheet-only vs known-spread modes', () => {
  it('sheet-only paste leaves the spread blank (solver-eligible)', () => {
    const mon = parsePokepaste(SHEET_ONLY).mons[0]!;
    expect(mon.spreadKnown).toBe(false);
    expect(mon.spSpread).toBeUndefined();
  });

  it('known-spread paste fills and marks the spread', () => {
    const mon = parsePokepaste(KNOWN_SPREAD).mons[0]!;
    expect(mon.spreadKnown).toBe(true);
    expect(mon.spSpread).toEqual({ hp: 20, atk: 0, def: 4, spa: 0, spd: 20, spe: 22 });
  });
});

describe('U7.2.6 — illegal data is rejected, not silently accepted', () => {
  it('rejects unknown species/item/ability/move', () => {
    expect(() => parsePokepaste('Notamon\nAbility: Intimidate')).toThrow(/species/i);
    expect(() => parsePokepaste('Incineroar @ Fakeitem')).toThrow(/item/i);
    expect(() => parsePokepaste('Incineroar\nAbility: Fakeability')).toThrow(/ability/i);
    expect(() => parsePokepaste('Incineroar\n- Notamove')).toThrow(/move/i);
  });
});

describe('U7.2.7 — the SP spread must be valid (each 0–32, sum 66)', () => {
  it('rejects a spread that does not sum to 66', () => {
    expect(() => parsePokepaste('Incineroar\nSP: 20 HP / 4 Def')).toThrow(/66/);
  });

  it('rejects out-of-range SP', () => {
    expect(() => parsePokepaste('Incineroar\nSP: 40 HP / 26 Def')).toThrow(/0\.\.32|0-32/);
  });

  it('hints when the spread looks like EV-equivalents (8×SP)', () => {
    const evLike = 'Incineroar\nEVs: 160 HP / 32 Atk / 96 Def / 0 SpA / 160 SpD / 80 Spe';
    expect(() => parsePokepaste(evLike)).toThrow(/EV-equivalent/i);
  });
});

describe('multi-mon paste', () => {
  it('parses each block', () => {
    const result = parsePokepaste(`${SHEET_ONLY}\n\n${KNOWN_SPREAD}`);
    expect(result.mons).toHaveLength(2);
    expect(result.mons.every((m) => m.species === 'Incineroar')).toBe(true);
  });
});

describe('gender marker is captured (for replay sprites/details)', () => {
  it('reads (M)/(F) on the species line, with or without a nickname', () => {
    expect(parsePokepaste('Incineroar (F) @ Sitrus Berry\nAbility: Intimidate\n- Fake Out').mons[0]!).toMatchObject({ species: 'Incineroar', gender: 'F', item: 'Sitrus Berry' });
    expect(parsePokepaste('Spicy (Garchomp) (M) @ Life Orb\nAbility: Rough Skin\n- Earthquake').mons[0]!).toMatchObject({ species: 'Garchomp', nickname: 'Spicy', gender: 'M', item: 'Life Orb' });
    expect(parsePokepaste('Garchomp\nAbility: Rough Skin\n- Earthquake').mons[0]!.gender).toBeUndefined();
  });
});
