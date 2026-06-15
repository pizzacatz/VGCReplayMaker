/**
 * Damage engine — the single shared damage authority for the solver (Part 2) and
 * replay (Part 3) (Constitution §A4, §A1; Validation U6.5 — they must never
 * disagree on a shared hit).
 *
 * Wraps @smogon/calc configured for Champions (Gen 9 + the champions.ts ruleset):
 * given an attacker, defender, move, and candidate Stat Points, it returns the
 * 15 Champions damage rolls for that hit. Stats are obtained from the conversion
 * module (T2.1 — the single stat-math source, R5); the calc's own stat is
 * cross-checked against it and a divergence is raised, never silently accepted.
 */

import { Field, Generations, Move, Pokemon, Side, calculate, toID } from '@smogon/calc';
import { spToEv, spToFinal, type AlignmentRole } from '../conversion';
import type { StatKey } from '../conversion';
import {
  championsExceptions,
  CHAMPIONS_GEN,
  type ExceptionContext,
  type ExceptionRegistry,
  toChampionsRolls,
} from './champions';

/** The @smogon/calc generation object type, derived to avoid guessing exports. */
export type Gen = ReturnType<typeof Generations.get>;

/** A mon's alignment: a boosted (×1.1) and reduced (×0.9) stat, or fully neutral. */
export type MonAlignment = { up: StatKey; down: StatKey } | 'neutral';

export interface MonSpec {
  species: string;
  alignment: MonAlignment;
  item?: string | undefined;
  ability?: string | undefined;
  level?: number | undefined; // default 50
}

/**
 * Reconstructed board state at the moment of a hit (Event Schema v2 §6). Always
 * Doubles. Boosts/burn/field don't change the raw stat (R5 guard stays valid) —
 * they apply inside the damage calc. Threaded from the event log by extraction.
 */
export interface HitContext {
  /** calc weather name: 'Sun' | 'Rain' | 'Sand' | 'Snow' | 'Hail' */
  weather?: string | undefined;
  /** calc terrain name: 'Grassy' | 'Electric' | 'Psychic' | 'Misty' */
  terrain?: string | undefined;
  reflect?: boolean | undefined;
  lightScreen?: boolean | undefined;
  auroraVeil?: boolean | undefined;
  /** full boost record per mon (calc uses the relevant stat for this hit) */
  attackerBoosts?: Record<string, number> | undefined;
  defenderBoosts?: Record<string, number> | undefined;
  /** attacker burned → physical attack halved */
  attackerBurned?: boolean | undefined;
  /** Paradox boost (Protosynthesis/Quark Drive) active stat — ×1.3 (×1.5 Speed) on that mon */
  attackerBoostedStat?: string | undefined;
  defenderBoostedStat?: string | undefined;
  /** attacker's move was boosted by an ally's Helping Hand (×1.5) */
  helpingHand?: boolean | undefined;
  /** a spread move that hit only ONE target → drop the Doubles 0.75 spread reduction */
  singleTargetSpread?: boolean | undefined;
  /** false → defender was below full HP (suppresses Multiscale / Shadow Shield) */
  defenderFullHp?: boolean | undefined;
  /** defender's ally has Friend Guard → ×0.75 damage taken */
  friendGuard?: boolean | undefined;
}

export interface HitInput {
  attacker: MonSpec;
  /** candidate SP in the move's relevant offensive stat (atk for physical, spa for special) */
  attackerSp: number;
  defender: MonSpec;
  /** candidate SP in the move's relevant defensive stat (def for physical, spd for special) */
  defenderSp: number;
  move: string;
  crit?: boolean | undefined;
  /** reconstructed field/boosts/burn at hit time; absent → no field (Singles, unmodified). */
  context?: HitContext | undefined;
}

/** Standard nature table (game-universal, not Champions-specific): up → down → name. */
const NATURE_TABLE: Record<Exclude<StatKey, 'hp'>, Partial<Record<Exclude<StatKey, 'hp'>, string>>> = {
  atk: { def: 'Lonely', spa: 'Adamant', spd: 'Naughty', spe: 'Brave' },
  def: { atk: 'Bold', spa: 'Impish', spd: 'Lax', spe: 'Relaxed' },
  spa: { atk: 'Modest', def: 'Mild', spd: 'Rash', spe: 'Quiet' },
  spd: { atk: 'Calm', def: 'Gentle', spa: 'Careful', spe: 'Sassy' },
  spe: { atk: 'Timid', def: 'Hasty', spa: 'Jolly', spd: 'Naive' },
};

/** The alignment role of one stat for this mon (drives the conversion's ×1.1/×0.9). */
export function roleOf(alignment: MonAlignment, stat: StatKey): AlignmentRole {
  if (alignment === 'neutral') return 'neutral';
  if (stat === alignment.up) return 'up';
  if (stat === alignment.down) return 'down';
  return 'neutral';
}

/** Natures with no stat effect → neutral alignment. */
const NEUTRAL_NATURES = new Set(['Hardy', 'Docile', 'Bashful', 'Quirky', 'Serious']);

const NATURE_TO_ALIGNMENT = new Map<string, MonAlignment>();
for (const up of Object.keys(NATURE_TABLE) as Array<Exclude<StatKey, 'hp'>>) {
  for (const [down, name] of Object.entries(NATURE_TABLE[up])) {
    if (name) NATURE_TO_ALIGNMENT.set(name, { up, down: down as StatKey });
  }
}

/** Map a Nature name to a Champions alignment (Constitution §B4; pokepaste §5). */
export function alignmentForNature(nature: string): MonAlignment {
  const name = nature.trim().replace(/^(.)(.*)$/, (_m, a: string, b: string) => a.toUpperCase() + b.toLowerCase());
  if (NEUTRAL_NATURES.has(name)) return 'neutral';
  const alignment = NATURE_TO_ALIGNMENT.get(name);
  if (!alignment) throw new Error(`unknown nature: ${nature}`);
  return alignment;
}

/** The nature name encoding a mon's alignment (Hardy = neutral). */
export function natureFor(alignment: MonAlignment): string {
  if (alignment === 'neutral') return 'Hardy';
  const { up, down } = alignment;
  if (up === 'hp' || down === 'hp') throw new Error(`alignment cannot touch HP (got up=${up}, down=${down})`);
  if (up === down) throw new Error(`alignment up and down must differ (got ${up})`);
  const name = NATURE_TABLE[up as Exclude<StatKey, 'hp'>]?.[down as Exclude<StatKey, 'hp'>];
  if (!name) throw new Error(`no nature for alignment up=${up}, down=${down}`);
  return name;
}

/** Base value of one stat for a species, from the Champions-configured dex. */
export function baseStatOf(gen: Gen, species: string, stat: StatKey): number {
  const data = gen.species.get(toID(species));
  if (!data) throw new Error(`species not found in dex: ${species}`);
  return data.baseStats[stat];
}

function baseStat(gen: Gen, species: string, stat: StatKey): number {
  return baseStatOf(gen, species, stat);
}

/** A species' primary (slot-0) ability — e.g. a Mega forme's fixed ability (Huge Power). */
export function primaryAbilityOf(gen: Gen, species: string): string | undefined {
  const data = gen.species.get(toID(species));
  return (data?.abilities as Record<string, string> | undefined)?.['0'];
}

/**
 * Build a calc Pokemon for a candidate stat, then ENFORCE that the calc's
 * computed stat equals the conversion module's (R5 / Validation U6.5). A
 * mismatch means a Champions stat-formula deviation — surfaced, not absorbed.
 */
function buildMon(
  gen: Gen,
  spec: MonSpec,
  statKey: Exclude<StatKey, 'hp'>,
  sp: number,
  extra?: { boosts?: Record<string, number> | undefined; status?: string | undefined; boostedStat?: string | undefined; curHP?: number | undefined },
): Pokemon {
  const base = baseStat(gen, spec.species, statKey);
  const role = roleOf(spec.alignment, statKey);
  const mon = new Pokemon(gen, spec.species, {
    level: spec.level ?? 50,
    nature: natureFor(spec.alignment),
    evs: { [statKey]: spToEv(sp) },
    ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
    ...(spec.item ? { item: spec.item } : {}),
    ...(spec.ability ? { ability: spec.ability } : {}),
    ...(extra?.boosts ? { boosts: extra.boosts } : {}),
    ...(extra?.status ? { status: extra.status as never } : {}),
    ...(extra?.boostedStat ? { boostedStat: extra.boostedStat as never } : {}),
    ...(extra?.curHP !== undefined ? { curHP: extra.curHP } : {}),
  });
  const expected = spToFinal(base, sp, role);
  const got = mon.stats[statKey];
  if (got !== expected) {
    throw new Error(
      `stat divergence: ${spec.species} ${statKey} calc=${got} vs conversion=${expected} ` +
        `(sp=${sp}, role=${role}). Flag a Champions stat-formula exception.`,
    );
  }
  return mon;
}

const OFFENSIVE: Record<'Physical' | 'Special', Exclude<StatKey, 'hp'>> = { Physical: 'atk', Special: 'spa' };
const DEFENSIVE: Record<'Physical' | 'Special', Exclude<StatKey, 'hp'>> = { Physical: 'def', Special: 'spd' };

export interface PredictResult {
  rolls: number[]; // the 15 Champions rolls (ascending), floored integers
  category: 'Physical' | 'Special';
  offensiveStat: Exclude<StatKey, 'hp'>;
  defensiveStat: Exclude<StatKey, 'hp'>;
}

/**
 * Predict the 15 Champions damage rolls for a candidate stat pair. This is THE
 * forward damage prediction; the solver's likelihood and replay's any-derived
 * display both call it, guaranteeing they agree (Constitution §A4).
 */
export function predictHit(
  gen: Gen,
  input: HitInput,
  registry: ExceptionRegistry = championsExceptions,
): PredictResult {
  const hctx = input.context;
  const move = new Move(gen, input.move, {
    ...(input.crit ? { isCrit: true } : {}),
    ...(hctx?.singleTargetSpread ? { overrides: { target: 'normal' } } : {}), // spread move that hit one mon → no 0.75
  });
  if (move.category === 'Status') {
    throw new Error(`move ${input.move} is Status — no damage to predict`);
  }
  const category = move.category as 'Physical' | 'Special';
  const offensiveStat = OFFENSIVE[category];
  const defensiveStat = DEFENSIVE[category];

  const attacker = buildMon(gen, input.attacker, offensiveStat, input.attackerSp, {
    ...(hctx?.attackerBoosts ? { boosts: hctx.attackerBoosts } : {}),
    ...(hctx?.attackerBurned ? { status: 'brn' } : {}),
    ...(hctx?.attackerBoostedStat ? { boostedStat: hctx.attackerBoostedStat } : {}),
  });
  const defender = buildMon(gen, input.defender, defensiveStat, input.defenderSp, {
    ...(hctx?.defenderBoosts ? { boosts: hctx.defenderBoosts } : {}),
    ...(hctx?.defenderBoostedStat ? { boostedStat: hctx.defenderBoostedStat } : {}),
    ...(hctx?.defenderFullHp === false ? { curHP: 1 } : {}), // below full → Multiscale / Shadow Shield off
  });

  // Champions is always Doubles; the field is applied only for real (reconstructed)
  // hits, so synthetic ground-truth hits without context keep the unmodified form.
  const field = hctx
    ? new Field({
        gameType: 'Doubles',
        ...(hctx.weather ? { weather: hctx.weather as never } : {}),
        ...(hctx.terrain ? { terrain: hctx.terrain as never } : {}),
        defenderSide: new Side({ isReflect: !!hctx.reflect, isLightScreen: !!hctx.lightScreen, isAuroraVeil: !!hctx.auroraVeil, isFriendGuard: !!hctx.friendGuard }),
        ...(hctx.helpingHand ? { attackerSide: new Side({ isHelpingHand: true }) } : {}),
      })
    : undefined;

  const damage = (field ? calculate(gen, attacker, defender, move, field) : calculate(gen, attacker, defender, move)).damage;
  if (Array.isArray(damage) && Array.isArray(damage[0])) {
    // 2-D damage = multi-hit / parental-bond style. The HP delta is a sum of
    // sub-hits → inherently composite; not a single clean factor (Constraint §11).
    throw new Error(`move ${input.move} produced multi-hit (2-D) damage — treat as composite, not a clean factor`);
  }
  const rolls = toChampionsRolls(damage as number | number[]);

  const ctx: ExceptionContext = {
    move: input.move,
    attackerSpecies: input.attacker.species,
    defenderSpecies: input.defender.species,
    attackerAbility: input.attacker.ability,
    defenderAbility: input.defender.ability,
    attackerItem: input.attacker.item,
    defenderItem: input.defender.item,
    category,
    crit: input.crit,
  };
  return { rolls: registry.apply(rolls, ctx), category, offensiveStat, defensiveStat };
}

export interface MultiHitResult {
  /** each sub-hit's Champions rolls (15 each); the observed total is a sum across these */
  perHitRolls: number[][];
  category: 'Physical' | 'Special';
  offensiveStat: Exclude<StatKey, 'hp'>;
  defensiveStat: Exclude<StatKey, 'hp'>;
}

/**
 * Predict the per-sub-hit Champions rolls for a multi-hit move (Bullet Seed,
 * Population Bomb, Triple Axel's escalating power, …). The calc returns one roll
 * array per sub-hit when given the observed hit count; the convolution of these
 * (the solver's likelihood) is what matches the observed TOTAL. (Constraint §11.)
 */
export function predictMultiHit(
  gen: Gen,
  input: HitInput,
  hits: number,
  registry: ExceptionRegistry = championsExceptions,
): MultiHitResult {
  const move = new Move(gen, input.move, { ...(input.crit ? { isCrit: true } : {}), hits });
  if (move.category === 'Status') throw new Error(`move ${input.move} is Status — no damage to predict`);
  const category = move.category as 'Physical' | 'Special';
  const offensiveStat = OFFENSIVE[category];
  const defensiveStat = DEFENSIVE[category];

  const hctx = input.context;
  const attacker = buildMon(gen, input.attacker, offensiveStat, input.attackerSp, {
    ...(hctx?.attackerBoosts ? { boosts: hctx.attackerBoosts } : {}),
    ...(hctx?.attackerBurned ? { status: 'brn' } : {}),
    ...(hctx?.attackerBoostedStat ? { boostedStat: hctx.attackerBoostedStat } : {}),
  });
  const defender = buildMon(gen, input.defender, defensiveStat, input.defenderSp, {
    ...(hctx?.defenderBoosts ? { boosts: hctx.defenderBoosts } : {}),
    ...(hctx?.defenderBoostedStat ? { boostedStat: hctx.defenderBoostedStat } : {}),
    ...(hctx?.defenderFullHp === false ? { curHP: 1 } : {}),
  });
  const field = hctx
    ? new Field({
        gameType: 'Doubles',
        ...(hctx.weather ? { weather: hctx.weather as never } : {}),
        ...(hctx.terrain ? { terrain: hctx.terrain as never } : {}),
        defenderSide: new Side({ isReflect: !!hctx.reflect, isLightScreen: !!hctx.lightScreen, isAuroraVeil: !!hctx.auroraVeil, isFriendGuard: !!hctx.friendGuard }),
        ...(hctx.helpingHand ? { attackerSide: new Side({ isHelpingHand: true }) } : {}),
      })
    : undefined;

  const damage = (field ? calculate(gen, attacker, defender, move, field) : calculate(gen, attacker, defender, move)).damage;
  const ctx: ExceptionContext = {
    move: input.move,
    attackerSpecies: input.attacker.species,
    defenderSpecies: input.defender.species,
    attackerAbility: input.attacker.ability,
    defenderAbility: input.defender.ability,
    attackerItem: input.attacker.item,
    defenderItem: input.defender.item,
    category,
    crit: input.crit,
  };
  // 2-D = one roll array per sub-hit; 1-D = the move resolved as a single hit.
  const perHitRolls =
    Array.isArray(damage) && Array.isArray(damage[0])
      ? (damage as number[][]).map((sub) => registry.apply(toChampionsRolls(sub), ctx))
      : [registry.apply(toChampionsRolls(damage as number | number[]), ctx)];
  return { perHitRolls, category, offensiveStat, defensiveStat };
}

/** Convenience: the Champions-configured Gen 9 generation. */
export function championsGen(): Gen {
  return Generations.get(CHAMPIONS_GEN);
}
