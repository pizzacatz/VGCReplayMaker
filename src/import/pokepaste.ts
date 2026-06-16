/**
 * Pokepaste import (T1.4) — parse standard Showdown/pokepaste text into Champions
 * team sheets. Governed by Constitution §A2 (validate against official data) and
 * §B (the SP system). See POKEPASTE_IMPORT.md.
 *
 * Two modes (§6): a paste WITH a valid spread is "known-spread" (e.g. your own
 * team / validation ground truth); WITHOUT one it is "sheet-only" and the mon is
 * left for the solver to reverse-engineer.
 *
 * Champions spreads are RAW Stat Points (§4): each stat 0–32, the six summing to
 * exactly 66 — no EV↔SP conversion at this boundary.
 */

import { toID } from '@smogon/calc';
import { alignmentForNature, championsGen, type Gen, type MonAlignment } from '../engine';
import { validateSpread, type SpSpread, type StatKey } from '../conversion';

export interface ParsedMon {
  species: string;
  nickname?: string;
  item?: string;
  ability?: string;
  gender?: 'M' | 'F';
  level: number;
  moves: string[];
  alignment: MonAlignment;
  /** present only in known-spread mode */
  spSpread?: SpSpread;
  spreadKnown: boolean;
  /** soft issues (Tera present, non-50 level, non-perfect IV) — not errors */
  flags: string[];
}

export interface ParseResult {
  mons: ParsedMon[];
  flags: string[];
}

const STAT_KEYS: Record<string, StatKey> = { hp: 'hp', atk: 'atk', def: 'def', spa: 'spa', spd: 'spd', spe: 'spe' };

/** Parse a full pokepaste (one or more blocks separated by blank lines). */
export function parsePokepaste(text: string, gen: Gen = championsGen()): ParseResult {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length === 0) throw new Error('no Pokémon found in paste');

  const mons = blocks.map((block) => parseBlock(block, gen));
  const flags: string[] = [];
  if (mons.length > 6) flags.push(`paste has ${mons.length} Pokémon (a roster holds ≤6)`);
  return { mons, flags };
}

function parseBlock(block: string, gen: Gen): ParsedMon {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  const flags: string[] = [];
  const head = parseSpeciesLine(lines[0]!);

  if (!gen.species.get(toID(head.species))) throw new Error(`unknown species: "${head.species}"`);
  const mon: ParsedMon = {
    species: head.species,
    level: 50,
    moves: [],
    alignment: 'neutral',
    spreadKnown: false,
    flags,
    ...(head.nickname ? { nickname: head.nickname } : {}),
    ...(head.gender ? { gender: head.gender } : {}),
  };
  if (head.item) {
    if (!gen.items.get(toID(head.item))) throw new Error(`unknown item: "${head.item}" (on ${head.species})`);
    mon.item = head.item;
  }

  let spreadLine: string | undefined;
  for (const line of lines.slice(1)) {
    if (line.startsWith('-')) {
      const move = line.slice(1).trim();
      if (!move) continue;
      if (!gen.moves.get(toID(move))) throw new Error(`unknown move: "${move}" (on ${head.species})`);
      mon.moves.push(move);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      const natureMatch = line.match(/^([A-Za-z]+)\s+Nature$/);
      if (natureMatch) mon.alignment = alignmentForNature(natureMatch[1]!);
      continue; // other bare lines (rare) are ignored
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    switch (key) {
      case 'ability':
        if (!gen.abilities.get(toID(value))) throw new Error(`unknown ability: "${value}" (on ${head.species})`);
        mon.ability = value;
        break;
      case 'level': {
        const level = Number(value);
        mon.level = level;
        if (level !== 50) flags.push(`level ${value} (Champions is pinned to level 50)`);
        break;
      }
      case 'tera type':
        flags.push(`Tera Type "${value}" present — ignored (no Tera in Reg M-A); check the paste is Champions`);
        break;
      case 'ivs':
        flagNonPerfectIvs(value, flags);
        break;
      case 'sp':
      case 'evs':
        spreadLine = value;
        break;
      default:
        break; // Shiny / Happiness / Gigantamax / Ball / etc. — ignored
    }
  }

  if (spreadLine !== undefined) {
    const spread = parseSpread(spreadLine);
    try {
      validateSpread(spread);
    } catch (e) {
      const hint = looksLikeEvEquivalents(spread)
        ? ' — values look like EV-equivalents (8×SP); Champions pastes use raw SP (0–32, summing to 66)'
        : '';
      throw new Error(`invalid spread on ${head.species}: ${(e as Error).message}${hint}`);
    }
    mon.spSpread = spread;
    mon.spreadKnown = true;
  }
  return mon;
}

function parseSpeciesLine(line: string): { species: string; item?: string; nickname?: string; gender?: 'M' | 'F' } {
  let rest = line;
  let item: string | undefined;
  const at = rest.lastIndexOf(' @ ');
  if (at >= 0) {
    item = rest.slice(at + 3).trim();
    rest = rest.slice(0, at).trim();
  }
  let gender: 'M' | 'F' | undefined;
  const gm = rest.match(/\((M|F)\)\s*$/); // capture the gender marker before stripping it
  if (gm) {
    gender = gm[1] as 'M' | 'F';
    rest = rest.replace(/\s*\((?:M|F)\)\s*$/, '').trim();
  }
  const named = rest.match(/^(.*?)\s*\(([^)]+)\)\s*$/); // Nickname (Species)
  const base = named ? { species: named[2]!.trim(), nickname: named[1]!.trim() } : { species: rest.trim() };
  return { ...base, ...(item ? { item } : {}), ...(gender ? { gender } : {}) };
}

function parseSpread(value: string): SpSpread {
  const spread: SpSpread = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  for (const part of value.split('/')) {
    const seg = part.trim();
    if (!seg) continue;
    const m = seg.match(/^(\d+)\s+(HP|Atk|Def|SpA|SpD|Spe)$/i);
    if (!m) throw new Error(`unparseable spread segment: "${seg}"`);
    spread[STAT_KEYS[m[2]!.toLowerCase()]!] = Number(m[1]);
  }
  return spread;
}

function flagNonPerfectIvs(value: string, flags: string[]): void {
  for (const part of value.split('/')) {
    const m = part.trim().match(/^(\d+)\s+\w+$/);
    if (m && Number(m[1]) !== 31) {
      flags.push(`non-perfect IVs in paste (${value}) — ignored; Champions uses perfect IVs`);
      return;
    }
  }
}

function looksLikeEvEquivalents(spread: SpSpread): boolean {
  const values = Object.values(spread);
  const sum = values.reduce((a, b) => a + b, 0);
  return values.every((v) => v % 8 === 0) && sum === 66 * 8;
}
