/**
 * SP ⇄ Stat Conversion Module (T2.1).
 *
 * The isolated, single source of all SP↔stat arithmetic (Constitution §B,
 * CONVERSION_MODULE.md R5 — no other module reimplements any of this).
 *
 * Closed forms (level 50, perfect IVs):
 *   non-HP neutral stat : neutral = Base + 20 + SP
 *   HP                  : max_hp  = Base + 75 + SP_hp
 *   alignment (last)    : up → floor(neutral × 110 / 100), down → floor(× 90 / 100)
 *
 * Correctness rules enforced here:
 *   R1 — integer math only for alignment (float `× 1.1` is forbidden, §6/R1).
 *   R2 — neutral first, alignment last (§B4).
 *   R3 — SP / SP_hp outside 0..32 is rejected (surfaced, never clamped).
 *   R4 — a non-HP conversion requires a known alignment role (never assume neutral).
 */

export type AlignmentRole = 'neutral' | 'up' | 'down';

export const SP_MIN = 0;
export const SP_MAX = 32;

/** Non-HP neutral-stat offset, and HP offset (level 50, perfect IV). */
const NEUTRAL_OFFSET = 20;
const HP_OFFSET = 75;

// ── guards (R3, R4) ──────────────────────────────────────────────────────────

function assertSP(sp: number, name = 'SP'): void {
  if (!Number.isInteger(sp)) throw new RangeError(`${name} must be an integer, got ${sp}`);
  if (sp < SP_MIN || sp > SP_MAX) throw new RangeError(`${name} must be in ${SP_MIN}..${SP_MAX}, got ${sp}`);
}

function assertBase(base: number): void {
  if (!Number.isInteger(base) || base <= 0) throw new RangeError(`base must be a positive integer, got ${base}`);
}

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be an integer, got ${value}`);
}

function assertRole(role: AlignmentRole): void {
  if (role !== 'neutral' && role !== 'up' && role !== 'down') {
    // R4: refuse rather than assume neutral.
    throw new TypeError(`alignment role is required and must be 'neutral' | 'up' | 'down', got ${String(role)}`);
  }
}

// ── non-HP forward path (§3) ─────────────────────────────────────────────────

/** Neutral (pre-alignment) non-HP stat: `Base + 20 + SP`. */
export function neutralStat(base: number, sp: number): number {
  assertBase(base);
  assertSP(sp);
  return base + NEUTRAL_OFFSET + sp;
}

/**
 * Apply the alignment multiplier to an already-computed neutral stat.
 * R1: integer arithmetic only — `floor(neutral × 110 / 100)` / `floor(× 90 / 100)`.
 * Floating-point `× 1.1` / `× 0.9` is forbidden (it can floor a true 121 to 120).
 */
export function applyAlignment(neutral: number, role: AlignmentRole): number {
  assertRole(role);
  switch (role) {
    case 'neutral':
      return neutral;
    case 'up':
      return Math.floor((neutral * 110) / 100);
    case 'down':
      return Math.floor((neutral * 90) / 100);
  }
}

/** Forward conversion SP → final non-HP stat (R2: neutral first, alignment last). */
export function spToFinal(base: number, sp: number, role: AlignmentRole): number {
  assertRole(role);
  return applyAlignment(neutralStat(base, sp), role);
}

// ── non-HP inverse path (§5) ─────────────────────────────────────────────────

/**
 * Inverse: observed final non-HP stat → the SP value(s) that produce it.
 * Returns a set of size 0, 1, or 2 (CONVERSION_MODULE §5):
 *   - neutral role: 0 or 1.
 *   - up (×1.1):    0 or 1 — gaps make some finals unreachable (→ 0), reachable finals are unique.
 *   - down (×0.9):  1 or 2 — collisions make two adjacent SP share a final (→ 2) ⇒ caller tags `bounded`.
 * An empty result means the final is impossible for this base+role — it NEVER snaps to nearest (U1.4.3).
 */
export function finalToSp(base: number, final: number, role: AlignmentRole): number[] {
  assertBase(base);
  assertRole(role);
  assertInteger(final, 'final stat');
  const out: number[] = [];
  for (let sp = SP_MIN; sp <= SP_MAX; sp++) {
    if (spToFinal(base, sp, role) === final) out.push(sp);
  }
  return out;
}

/** The ≤33 distinct final values reachable across SP 0..32 (gaps under ×1.1 reduce the count). */
export function reachableFinals(base: number, role: AlignmentRole): number[] {
  assertBase(base);
  assertRole(role);
  const set = new Set<number>();
  for (let sp = SP_MIN; sp <= SP_MAX; sp++) set.add(spToFinal(base, sp, role));
  return [...set].sort((a, b) => a - b);
}

// ── HP (read, never solved — §5.1) ───────────────────────────────────────────

/** Forward: `max_hp = Base + 75 + SP_hp`. HP takes no alignment (§B5). */
export function spHpToMaxHp(base: number, spHp: number): number {
  assertBase(base);
  assertSP(spHp, 'SP_hp');
  return base + HP_OFFSET + spHp;
}

/**
 * Inverse: `SP_hp = max_hp − Base − 75`. Exact and unique → tagged `read`.
 * A result outside 0..32 means a bad observation or base: raised, never clamped (R3, U1.4.3).
 */
export function maxHpToSpHp(base: number, maxHp: number): number {
  assertBase(base);
  assertInteger(maxHp, 'max HP');
  const spHp = maxHp - base - HP_OFFSET;
  if (spHp < SP_MIN || spHp > SP_MAX) {
    throw new RangeError(
      `derived SP_hp ${spHp} is outside ${SP_MIN}..${SP_MAX} (maxHp ${maxHp}, base ${base}) — ` +
        `bad observed HP or base; not clamped`,
    );
  }
  return spHp;
}

// ── EV-equivalent for the calc boundary (Constitution §F4) ───────────────────

/** SP → EV-equivalent (`8 × SP`) for feeding the Showdown calc. Lives here (R5), not in the calc layer. */
export function spToEv(sp: number): number {
  assertSP(sp);
  return 8 * sp;
}
