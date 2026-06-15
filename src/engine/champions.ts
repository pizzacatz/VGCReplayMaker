/**
 * Champions ruleset layer (Constitution §A4).
 *
 * Champions damage resolution = Gen 9 mechanics (confirmed: @pkmn/dex ships the
 * "[Gen 9 Champions]" formats) + the two Champions-specific deviations this layer
 * owns:
 *   1. the 15-roll damage table (86–100%), vs the calc's 16-roll (85–100%);
 *   2. a registry of ability/odds damage-resolution EXCEPTIONS, discovered over
 *      time and slotted in here ONCE so every consumer — solver and replay alike —
 *      inherits them through the shared damage engine.
 *
 * Nothing else in the codebase decides Champions damage resolution; this is the
 * single configured-calculator authority both Part 2 and Part 3 read.
 */

/** Champions runs on Gen 9 mechanics. */
export const CHAMPIONS_GEN = 9;

/** The 15 uniform damage rolls, 86–100% inclusive (Constitution §C2). */
export const CHAMPIONS_ROLL_PERCENTS: readonly number[] = Array.from({ length: 15 }, (_, i) => 86 + i);

/**
 * Convert @smogon/calc's damage output into the Champions 15-roll table.
 * The calc emits 16 rolls (85–100%); Champions drops the 85% roll → index 0
 * (Spike 1 finding). A scalar (variance-free move, e.g. fixed damage) is widened
 * to 15 identical rolls so downstream code always sees the 15-roll shape.
 */
export function toChampionsRolls(calcDamage: number | readonly number[]): number[] {
  const arr = Array.isArray(calcDamage) ? calcDamage : [calcDamage as number];
  if (arr.length === 16) return arr.slice(1); // drop the 85% roll
  if (arr.length === 15) return [...arr]; // already a Champions-shaped table
  if (arr.length === 1) return Array<number>(15).fill(arr[0]!); // fixed / variance-free
  throw new Error(
    `unexpected calc damage array length ${arr.length}; expected 16 (mainline), 15 (Champions), or 1 (fixed)`,
  );
}

// ── Exception registry — the slot-in point for discovered deviations ─────────

/**
 * The minimal context an exception matches against. Kept loose on purpose: as
 * real exceptions surface, this can grow without forcing existing code to change.
 */
export interface ExceptionContext {
  move: string;
  attackerSpecies: string;
  defenderSpecies: string;
  attackerAbility?: string | undefined;
  defenderAbility?: string | undefined;
  attackerItem?: string | undefined;
  defenderItem?: string | undefined;
  category: 'Physical' | 'Special';
  crit?: boolean | undefined;
}

/**
 * A single Champions damage-resolution exception. `matches` decides whether it
 * applies to a hit; `apply` transforms the 15 Champions rolls for that hit
 * (e.g. an ability that halves, an odds change that alters which rolls occur).
 */
export interface DamageException {
  id: string;
  description: string;
  matches(ctx: ExceptionContext): boolean;
  apply(rolls: number[], ctx: ExceptionContext): number[];
}

/**
 * Holds the discovered exceptions. One instance is shared by the damage engine,
 * so registering an exception reaches the solver and replay simultaneously.
 */
export class ExceptionRegistry {
  private readonly exceptions: DamageException[] = [];

  register(exception: DamageException): void {
    if (this.exceptions.some((e) => e.id === exception.id)) {
      throw new Error(`duplicate exception id: ${exception.id}`);
    }
    this.exceptions.push(exception);
  }

  /** Exceptions that apply to this hit, in registration order. */
  applicable(ctx: ExceptionContext): DamageException[] {
    return this.exceptions.filter((e) => e.matches(ctx));
  }

  /** Fold every applicable exception over the rolls. No-op when none match. */
  apply(rolls: number[], ctx: ExceptionContext): number[] {
    return this.applicable(ctx).reduce((acc, e) => e.apply(acc, ctx), rolls);
  }

  get size(): number {
    return this.exceptions.length;
  }
}

/**
 * The default Champions exception set: EMPTY (standard Gen 9). As the user
 * surfaces real ability/odds deviations from footage, register them here (or via
 * a dedicated module) and every consumer picks them up automatically.
 */
export const championsExceptions = new ExceptionRegistry();
