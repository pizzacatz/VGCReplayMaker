/**
 * Verification spike — OPEN_QUESTIONS §C.
 *
 * Purpose: empirically answer, against the *actually installed* @smogon/calc and
 * @pkmn/dex (not docs from memory — Constitution §G4), the questions that gate
 * Parts 2 and 3:
 *
 *   1. Do the libraries load, and what do they expose?
 *   2. Are base stats present/correct for a known species? (premise of the
 *      conversion anchors, Constitution §B3)
 *   3. Does the stat formula reproduce the conversion anchors — base-90 neutral
 *      SpD = 110 at SP0 (0 EV) and 142 at SP32 (256 EV-equiv)? And how does the
 *      EV cap (252) interact with SP32's 256 EV-equivalent?
 *   4. THE BIG ONE: what does the damage roll array look like — how many rolls,
 *      and what implied percentage range? Mainline is 16 rolls @ 85–100%;
 *      Champions is 15 rolls @ 86–100% (Constitution §C2). This gap directly
 *      sets solver band width, so we must know exactly how to adapt.
 *   5. Is the damage integer/floor-based (Constitution §C1)?
 *
 * Each probe is guarded so one failure doesn't abort the rest. Findings print
 * at the end as a PASS/FAIL/NOTE summary.
 */

type Finding = { id: string; status: 'PASS' | 'FAIL' | 'NOTE'; detail: string };
const findings: Finding[] = [];
const add = (id: string, status: Finding['status'], detail: string) =>
  findings.push({ id, status, detail });

// ── Probe 1: load ──────────────────────────────────────────────────────────
let calcMod: any;
try {
  calcMod = await import('@smogon/calc');
  add('load', 'PASS', `@smogon/calc exports: ${Object.keys(calcMod).sort().join(', ')}`);
} catch (e) {
  add('load', 'FAIL', `could not import @smogon/calc: ${(e as Error).message}`);
}

const { calculate, Generations, Pokemon, Move } = calcMod ?? {};
let gen: any;
try {
  gen = Generations.get(9);
  add('gen9', 'PASS', `Generations.get(9) ok — gen num ${gen.num}`);
} catch (e) {
  add('gen9', 'FAIL', `Generations.get(9) failed: ${(e as Error).message}`);
}

// ── Probe 2: base stats for a known species ─────────────────────────────────
try {
  const incin = new Pokemon(gen, 'Incineroar', { level: 50 });
  const bs = incin.species.baseStats;
  const spdOk = bs.spd === 90;
  add(
    'basestats',
    spdOk ? 'PASS' : 'NOTE',
    `Incineroar baseStats = ${JSON.stringify(bs)} (anchor premise: base SpD 90 → ${spdOk ? 'matches' : 'DIFFERS'})`
  );
} catch (e) {
  add('basestats', 'FAIL', `species lookup failed: ${(e as Error).message}`);
}

// ── Probe 3: conversion anchors via the stat formula ────────────────────────
// Build a base-90-SpD mon, neutral nature, perfect IVs, and read computed SpD
// at EV-equivalents 0, 252, 256 (SP0, near-SP32, exact-SP32).
function computedSpD(ev: number, nature = 'Hardy'): number | string {
  try {
    const mon = new Pokemon(gen, 'Incineroar', {
      level: 50,
      nature, // Hardy = neutral
      evs: { spd: ev },
      ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    });
    return mon.stats.spd;
  } catch (e) {
    return `ERR(${(e as Error).message})`;
  }
}
{
  const at0 = computedSpD(0);
  const at252 = computedSpD(252);
  const at256 = computedSpD(256);
  const anchorLow = at0 === 110;
  const anchorHigh256 = at256 === 142;
  add(
    'anchor-sp0',
    anchorLow ? 'PASS' : 'FAIL',
    `base-90 neutral SpD @ 0 EV (SP0) = ${at0} (expected 110)`
  );
  add(
    'anchor-sp32',
    anchorHigh256 ? 'PASS' : 'NOTE',
    `base-90 neutral SpD @ 256 EV (SP32) = ${at256}, @ 252 EV = ${at252} (expected 142). ` +
      `EV-cap interaction: 8×32 = 256 EV-equiv vs the standard 252 cap — note whether the lib accepts 256 or clamps.`
  );
}

// ── Probe 4: the damage roll table (THE BIG ONE) ────────────────────────────
try {
  const attacker = new Pokemon(gen, 'Incineroar', {
    level: 50,
    nature: 'Adamant',
    evs: { atk: 252 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  });
  const defender = new Pokemon(gen, 'Garchomp', {
    level: 50,
    nature: 'Jolly',
    evs: { hp: 0 },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
  });
  const move = new Move(gen, 'Flare Blitz');
  const result = calculate(gen, attacker, defender, move);
  const dmg = result.damage;
  const arr: number[] = Array.isArray(dmg) ? (dmg as number[]) : [dmg as number];
  const n = arr.length;
  const allInt = arr.every((d) => Number.isInteger(d));
  // Reverse-engineer the implied roll percentages from min damage:
  // mainline maps array index i (0..15) to roll (85+i)%. Confirm by ratio to max.
  const min = arr[0] ?? 0;
  const max = arr[n - 1] ?? 0;
  add(
    'roll-count',
    n === 16 ? 'NOTE' : n === 15 ? 'PASS' : 'NOTE',
    `damage array length = ${n}. Mainline = 16 (rolls 85–100%); Champions wants 15 (86–100%, Constitution §C2). ` +
      (n === 16
        ? 'ADAPTATION: drop index 0 (the 85% roll) to get the Champions 15-roll 86–100% table.'
        : n === 15
          ? 'Already 15 — confirm it is 86–100% not 85–99%.'
          : 'Unexpected length — investigate.')
  );
  add(
    'roll-values',
    'NOTE',
    `damage rolls = [${arr.join(', ')}] · min ${min} / max ${max} · ratio min/max = ${(min / max).toFixed(4)} ` +
      `(85/100 = 0.8500, 86/100 = 0.8600 — tells us which roll index 0 is)`
  );
  add(
    'floor-math',
    allInt ? 'PASS' : 'FAIL',
    `all ${n} damage rolls integer (floor-based, Constitution §C1): ${allInt}`
  );
  add('calc-desc', 'NOTE', `sample calc: ${result.desc?.() ?? '(no desc)'}`);
} catch (e) {
  add('damage', 'FAIL', `damage calc failed: ${(e as Error).message}`);
}

// ── Summary ─────────────────────────────────────────────────────────────────
const order = { FAIL: 0, NOTE: 1, PASS: 2 } as const;
console.log('\n══════════ VERIFICATION SPIKE FINDINGS ══════════\n');
for (const f of findings.sort((a, b) => order[a.status] - order[b.status])) {
  const mark = f.status === 'PASS' ? '✓' : f.status === 'FAIL' ? '✗' : '•';
  console.log(`${mark} [${f.status}] ${f.id}\n    ${f.detail}\n`);
}
const fails = findings.filter((f) => f.status === 'FAIL').length;
console.log(`─────────────────────────────────────────────────`);
console.log(`${findings.length} findings · ${fails} FAIL · see NOTEs for adaptations needed.\n`);

export {}; // mark as a module so top-level await is permitted under tsc
