# SP ⇄ Stat Conversion Module (T2.1) — Champions Match Analysis Tool

**Document role:** The isolated, fully-specified conversion between Stat Points and final stats. Every other module calls this and nothing else does stat math. Governed by Constitution §B. The conversion's correctness is load-bearing for the entire solver, so this spec is exhaustive.

**Status:** Draft for review. Math specification, not implementation. Formulas are the spec; they are exact and must be reproduced as written.

---

## 1. The headline result: the conversion is linear

Working the standard level-50 formula with perfect IVs all the way through, the non-HP neutral stat collapses to a clean closed form:

> **`neutral_stat = Base + 20 + SP`**  (non-HP, level 50, perfect IV)

> **`max_hp = Base + 75 + SP_hp`**  (HP, level 50, perfect IV)

Each Stat Point is **exactly +1** to the neutral stat, with a fixed offset of +20 (non-HP) or +75 (HP) from the species base. There is no curve. The only nonlinearity in the whole system is the alignment floor (§4).

**Verification against the anchors (Constitution §B3, [observed]):** base-90 SpD → `90 + 20 + 0 = 110` at SP 0, `90 + 20 + 32 = 142` at SP 32. Both match.

### 1.1 Why it's exactly linear (not luck)
The level-50 formula is `floor((2·Base + IV + floor(EV/4))/2) + 5`, with `EV = 8·SP` so `floor(EV/4) = 2·SP`. The inner sum `2·Base + 31 + 2·SP` is **always odd** (even + odd + even), so the `/2` floor always drops exactly 0.5 — the same amount at every SP. That constant drop is what makes each SP worth exactly +1 with no rounding wobble. This holds for **every** base stat, which is why the relation isn't Incineroar-specific (Validation U1.1.6).

---

## 2. Inputs the module needs

| Input | Source | Notes |
|---|---|---|
| `base` | Dex, keyed by species (loaded from official source, §A2) | per stat |
| `SP` | 0–32 | the value being converted |
| `alignment_role` | Sheet: `up` (×1.1) / `down` (×0.9) / `neutral` (×1.0) | known, never inferred |

HP ignores `alignment_role` entirely (§4.4).

---

## 3. Forward conversion (SP → final stat), non-HP

Two steps, **in this order** (Constitution §B4 — alignment is applied last):

1. **Neutral stat:** `neutral = Base + 20 + SP`
2. **Alignment:** `final = apply_alignment(neutral, role)`

where:
- `neutral` role → `final = neutral`
- `up` role → `final = floor(neutral × 110 / 100)`  *(integer math — see §6)*
- `down` role → `final = floor(neutral × 90 / 100)`

---

## 4. The alignment floor — the only nonlinearity, analyzed exactly

This is the one place the clean +1-per-SP relation breaks, and the analysis differs by direction. **Getting this right is the whole reason the conversion needs a careful spec.**

### 4.1 Boosted stat (×1.1): produces *gaps*, inverse stays unique
Stepping neutral by +1 multiplies out to +1.1, which floors to a jump of **+1 or +2** — never 0. So as SP climbs, the boosted final stat occasionally **skips** a value (e.g. … 119, 121 — 120 is unreachable). Consequence: some final-stat values can't occur on a boosted stat, but each value that *does* occur came from **exactly one** SP. The inverse is unique.

### 4.2 Reduced stat (×0.9): produces *collisions*, inverse is ambiguous
Stepping neutral by +1 multiplies to +0.9, which floors to a jump of **+1 or 0**. A 0-jump means **two adjacent SP values produce the identical final stat** (e.g. neutral 100 and 101 both → 90). Consequence: on a reduced stat, an observed final value can correspond to **two** SP values → the inverse returns a set → the result is tagged **bounded**, never **locked** (Constitution §E4).

### 4.3 Correction to earlier docs — APPLIED
This refined Validation List **U1.2.3**, which loosely said a boosted stat could collide *or* skip. Precisely: **boosted (×1.1) skips (unique inverse); reduced (×0.9) collides (ambiguous inverse).** The ±1-SP ambiguity the output contract attributes to alignment lives specifically on the **reduced** stat. **Applied in Validation List v2** (U1.2.3 reworded accordingly).

### 4.4 HP has no alignment
HP never takes an alignment multiplier (Constitution §B5), so HP is perfectly linear with no collisions or gaps.

---

## 5. Forward and inverse for each path

### 5.1 HP (read, never solved)
- Forward: `max_hp = Base + 75 + SP_hp`
- Inverse: `SP_hp = max_hp − Base − 75` — **exact and unique.** Tagged `read`.
- Validity: result must be 0–32; otherwise the observed HP or base is wrong → raise (don't clamp).

### 5.2 Non-HP, neutral role
- Forward: `final = Base + 20 + SP`
- Inverse: `SP = final − Base − 20` — exact and unique. Can be `locked`.

### 5.3 Non-HP, boosted role (×1.1)
- Forward: `final = floor((Base + 20 + SP) × 110 / 100)`
- Inverse: find SP in 0–32 with matching forward value. **Zero or one** result. If zero, the final value is unreachable for this base under boost → the candidate is impossible (useful: it *rules out* hypotheses). If one, can be `locked`.

### 5.4 Non-HP, reduced role (×0.9)
- Forward: `final = floor((Base + 20 + SP) × 90 / 100)`
- Inverse: find all SP in 0–32 with matching forward value. **One or two** results. Two → tag `bounded`.

---

## 6. Correctness requirements (mandatory)

- **R1 — Integer math only.** The alignment step must use integer arithmetic: `floor(neutral × 110 / 100)` and `floor(neutral × 90 / 100)` computed as integer multiply then integer division. **Floating-point `neutral × 1.1` is forbidden** — `1.1` is inexact in binary and can floor a true 121 down to 120, silently producing an off-by-one stat that corrupts every damage prediction using it. This is a real, known failure mode, not a style preference.
- **R2 — Order is fixed.** Neutral first, alignment last (§B4). Never multiply before adding the SP.
- **R3 — Range enforcement.** SP outside 0–32 is rejected. `SP_hp` outside 0–32 from an HP read is an error, surfaced, not clamped.
- **R4 — Alignment role required.** A non-HP conversion with unknown `alignment_role` must refuse rather than assume neutral. (On open sheets the role is always known, so this should never fire — but assuming neutral when the true role is ×0.9/×1.1 mislabels the stat.)
- **R5 — One source of stat math.** No other module reimplements any of this. Damage prediction, the solver, and replay all obtain stats through this module so a fix lands in exactly one place.

---

## 7. Module interface (conceptual — names/inputs/outputs, not implementation)

| Operation | Inputs | Output |
|---|---|---|
| `sp_to_final` | base, SP, role | final stat (integer) |
| `final_to_sp` | base, final, role | set of SP (size 0, 1, or 2) |
| `sp_hp_to_maxhp` | base, SP_hp | max HP (integer) |
| `maxhp_to_sp_hp` | base, max_hp | SP_hp (integer) or error |
| `reachable_finals` | base, role | the 33-or-fewer final values reachable across SP 0–32 |

`reachable_finals` exists so the solver can quickly test whether a hypothesized stat is even possible for a given base+role (it isn't, for the gap values under boost).

---

## 8. How the solver uses this (so the interface makes sense)

The solver's workhorse direction is **forward**: it enumerates candidate SP (0–32) for a stat, converts to a final stat, predicts damage, and checks against the observed band. `final_to_sp` is used when a stat gets pinned via damage and must be reported back as Stat Points — and that's where the reduced-stat collision turns a pinned final value into a `bounded` (two-SP) readout. HP uses `maxhp_to_sp_hp` directly and skips the solver. This is why the conversion's *inverse ambiguity* and the output contract's `bounded` tag are the same phenomenon.

---

## 9. Validation hooks

Checked by Validation List §1: anchors 110/142 (U1.1.1–2), +1-per-SP across the range (U1.1.3), 8×SP EV-equivalent (U1.1.4), second-base spot check (U1.1.6), alignment floor behavior (U1.2.x — with the §4.3 correction), HP round-trip and anchors (U1.3.x), inverse uniqueness/ambiguity (U1.4.x). Add a test for **R1**: assert the alignment step gives identical results under integer math vs. a known-correct reference at every neutral value where float would diverge (the ×1.1 multiples near integers, e.g. neutral 110 → 121).

---

## 10. Open questions

1. **Confirm the alignment multiplier is exactly ×1.1 / ×0.9 with truncation** (standard Nature behavior), which I've assumed from "alignment = Nature." If Champions rounds alignment differently, §4 changes. Low risk, but it's the one alignment assumption I haven't seen a number for.
2. **No other open items** — the conversion is fully determined by the confirmed anchors and the standard formula.
