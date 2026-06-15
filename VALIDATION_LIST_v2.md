# Validation List v2 — Champions Match Analysis Tool

**Document role:** How each piece is proven correct. **Supersedes v1.** Per-task acceptance criteria plus the complete unit-test enumeration. Tests reference Constitution sections so a failing test points at the rule it violates.

**v2 changes:** U1.2.3 reworded (boosted vs reduced alignment, per Conversion Module §4.3); new tests folded in from the conversion, constraint-model, schema-v2, and replay specs (marked **▲ v2**).

**Legend:** `[anchor]` = confirmed real value; `[property]` = invariant/behavior; `[guard]` = protects a known silent-failure mode.

---

## 1. SP ⇄ stat conversion (Constitution §B) — T2.1 / T3.1

### 1.1 Forward conversion (SP → stat)
- **U1.1.1** `[anchor]` Base-90 SpD, neutral, perfect IV, SP 0 → **110**.
- **U1.1.2** `[anchor]` Base-90 SpD, neutral, perfect IV, SP 32 → **142**.
- **U1.1.3** `[property]` Neutral stat increases by exactly **1 per SP** across SP 0→32 (33 strictly increasing values, no gaps).
- **U1.1.4** `[property]` SP → EV-equivalent = **8 × SP**; SP 0 → 0, SP 32 → 256.
- **U1.1.5** `[property]` Conversion defined and monotonic for every integer SP 0–32; SP outside 0–32 rejected.
- **U1.1.6** `[property]` Closed form `neutral = Base + 20 + SP` holds for a second, different base stat (not Incineroar-specific).

### 1.2 Alignment (§B4)
- **U1.2.1** Boost = `floor(neutral × 110 / 100)`; reduce = `floor(neutral × 90 / 100)`; neutral ×1.0.
- **U1.2.2** Alignment applied **after** the SP→stat step, never before.
- **U1.2.3** `[property]` **▲ v2 (reworded):** On a **reduced (×0.9)** stat, two adjacent SP values map to the **same** final stat (collision) — assert at least one collision exists in a reduced run.
- **U1.2.4** `[property]` **▲ v2:** On a **boosted (×1.1)** stat, some final values are **unreachable** (gaps), and every reachable value maps from exactly one SP — assert a gap exists and inverses are unique.
- **U1.2.5** `[guard]` **▲ v2 (R1 — integer math):** the alignment step uses integer arithmetic and matches a known-correct reference at values where float would diverge (e.g. neutral 110 boosted → **121**, not 120). Float `neutral × 1.1` is forbidden.

### 1.3 HP (§B5)
- **U1.3.1** `[property]` MaxHP = Base + 75 + SP_hp; round-trips with `SP_hp = MaxHP − Base − 75`.
- **U1.3.2** `[anchor]` Base-90 HP: SP_hp 0 → **165**, SP_hp 32 → **197**.
- **U1.3.3** `[guard]` Alignment multiplier is **not** applied to HP.

### 1.4 Inverse conversion (observed stat → SP candidates)
- **U1.4.1** `[property]` On a neutral stat, an observed stat maps to **exactly one** SP.
- **U1.4.2** `[guard]` On a reduced stat at a collision, the inverse returns **≥2 SP** and is tagged **bounded**, never **locked**.
- **U1.4.3** `[guard]` An observed stat with no valid SP preimage raises an error, never silently snaps to nearest.

### 1.5 Budget (§B1)
- **U1.5.1** `[guard]` Six SP not summing to exactly **66** is rejected.
- **U1.5.2** `[property]` Five known SP force the sixth to `66 − sum`; reject if outside 0–32.
- **U1.5.3** `[property]` Each stat's SP in 0–32.

---

## 2. Damage and randomness (§C) — T2.2

### 2.1 Roll table
- **U2.1.1** `[anchor]` Exactly **15 values**, integer percentages **86–100 inclusive**.
- **U2.1.2** `[property]` Uniform — each value weight 1/15.
- **U2.1.3** `[guard]` A 16-value (85–100) table is rejected.

### 2.2 Damage arithmetic
- **U2.2.1** `[property]` `damage = HP_before − HP_after`, exact integer.
- **U2.2.2** `[guard]` Damage math floors at every step; no round-half-up path exists.
- **U2.2.3** `[property]` Recomputing a known-spread hit reproduces an integer within the 15-roll band.

### 2.3 Band semantics
- **U2.3.1** `[property]` A single clean hit yields a **band** of consistent stat pairs, not a point.
- **U2.3.2** `[property]` The 15-roll band is **narrower** than the old 16-roll band for the same hit (correct table loaded).

---

## 3. Event log (§D) — T1.1 (Schema v2) / T3.3

- **U3.1** `[property]` Every damage event has exactly one status: `clean | composite | unresolved`.
- **U3.2** `[guard]` Only `clean` events reach the solver; `composite`/`unresolved` filtered.
- **U3.3** `[guard]` Every event of every status is retained for replay; nothing dropped.
- **U3.4** `[property]` **▲ v2:** Every damage event carries the observed-only fields (HP before/after, `crit`, `observed_effectiveness`); modifier state is **not** stored on the event.
- **U3.5** `[property]` Turn order recorded per turn; Speed ordering recoverable.
- **U3.6** `[property]` A missing required field is rejected at log time, not defaulted.
- **U3.7** `[property]` A full sample match round-trips (serialize/deserialize) without loss.
- **U3.8** `[guard]` Reclassifying `unresolved` → `clean` makes the event newly visible to the solver.
- **U3.9** `[property]` **▲ v2:** Reconstructed per-hit state matches a hand-verified expected context on a fixture match (boosts, field, screens, status, ally composition).
- **U3.10** `[guard]` **▲ v2:** A deliberately omitted boost/field/switch event makes the affected hit's reconstruction wrong **and** the discrepancy is surfaced by the reconstructed-state confirmation (Schema v2 §6.3).
- **U3.11** `[property]` **▲ v2:** Aurora Veil and the **doubles** screen fraction (≈⅔) and spread ×0.75 are applied correctly via reconstruction.
- **U3.12** `[property]` **▲ v2:** Ally effects (Friend Guard, Helping Hand) apply **only** when the relevant ally is active per the timeline.

---

## 4. Solver (§E) — T2.2 / T3.2

### 4.1 Recovery (synthetic ground truth)
- **U4.1.1** `[property]` Given a synthetic match from known spreads, recovered spreads match truth within tolerance on every stat with a relevant observation.
- **U4.1.2** `[property]` Recovery tightens monotonically as more clean hits vs the same team are added.
- **U4.1.3** `[property]` A diverse observation (new attacker vs a known defender) tightens more than repeating an identical hit (global coupling).

### 4.2 Honest tagging (§E4) — guards
- **U4.2.1** `[guard]` A stat with no relevant observation is **guessed**, never **locked**; value from prior.
- **U4.2.2** `[guard]` A stat narrowed to a range is **bounded**, never **locked**.
- **U4.2.3** `[guard]` No path emits **locked** without a Phase-A constraint pinning the stat (attempt to coax locked from zero relevant hits → fails).
- **U4.2.4** `[property]` Every **guessed**/**bounded** stat carries a missing-evidence note.

### 4.3 Structural behavior
- **U4.3.1** `[guard]` A `composite` hit fed in by mistake is rejected, not solved.
- **U4.3.2** `[property]` One attacker vs one defender, repeated, leaves the two stats **fused**, not falsely separated.
- **U4.3.3** `[property]` A second matchup sharing one mon **separates** them.
- **U4.3.4** `[property]` HP Stat Points are read from max HP, never a solved unknown.
- **U4.3.5** `[property]` Budget equality propagates: pinning four of five non-HP stats forces the fifth's candidate set.
- **U4.3.6** `[property]` Speed from turn order is consistent with later speed-relevant evidence; contradiction flags rather than silently choosing.
- **U4.3.7** `[guard]` **▲ v2:** A **fixed-damage** move (Seismic Toss / Night Shade equivalent) contributes **no** damage factor to the solver, while still appearing in the HP timeline.
- **U4.3.8** `[guard]` **▲ v2:** When clean constraints admit **no** valid 66-spread, Phase A yields an **empty** feasible set and the result raises a contradiction **flag** naming suspect hits — never a force-fit answer.

### 4.4 Prior behavior (§E5)
- **U4.4.1** `[property]` With zero clean hits, output equals the prior, fully tagged **guessed**.
- **U4.4.2** `[property]` A synthetic **unusual** spread is recovered once enough clean hits accumulate (prior doesn't permanently mask it).
- **U4.4.3** `[property]` The prior is weak enough that one strong contradicting observation visibly moves the estimate.

---

## 5. Replay (§F) — T2.3 / T3.4

- **U5.1** `[property]` A transcribed match converts to a valid battle-protocol log covering every event type.
- **U5.2** `[property]` Forward and backward stepping work by turn **and** by action.
- **U5.3** `[property]` HP shown at every step equals the logged integers.
- **U5.4** `[property]` `composite`/`unresolved` HP changes render, not skipped.
- **U5.5** `[property]` Stat data passed to any calculator is SP→EV-equivalent (8×SP) first.
- **U5.6** `[guard]` Replay never regenerates an outcome from a seed.
- **U5.7** `[property]` **▲ v2 (deterministic rebuild):** Replaying to the same index twice yields **identical** state — the property backward-stepping relies on.
- **U5.8** `[property]` **▲ v2:** A **spread-hit** fixture renders **two** correct per-target `|-damage|` messages with each target's own logged HP.

---

## 6. Cross-cutting / integration

- **U6.1** `[property]` End-to-end: a real recorded match transcribes, solves, and replays without manual patching.
- **U6.2** `[guard]` No format data (legal lists, regulation rules) hardcoded from memory; all loads from an external authoritative source.
- **U6.3** `[guard]` Every external library/engine call is backed by a current-docs verification note; unverified calls fail review.
- **U6.4** `[property]` Round-trip: synthetic match → transcribe → solve → compare to generating spreads closes within tolerance (exercises Parts 1–3).
- **U6.5** `[property]` **▲ v2:** The solver's damage predictions and replay's rendered damage use the **same** Champions-configured calculator and never disagree on a shared hit (Constitution A4).

---

## 7. Player/tournament aggregation & pokepaste import — ▲ v2 (T1.3 / T1.4)

### 7.1 Aggregation (Data Model T1.3)
- **U7.1.1** `[property]` Games group correctly by TeamInstance; one game feeds **both** sides' instances.
- **U7.1.2** `[property]` Adding a game tightens only the intended instance(s).
- **U7.1.3** `[guard]` A spread-change **split** prevents cross-instance contamination — aggregating across the boundary would corrupt; the boundary blocks it.
- **U7.1.4** `[property]` A **merge** across tournaments widens aggregation only when explicitly set by the user.
- **U7.1.5** `[guard]` The solver **never** aggregates across a TeamInstance boundary without an explicit merge.
- **U7.1.6** `[property]` A **partially-sheeted** game is flagged, and its weakened hits (untracked-opponent unknowns) are tagged accordingly, not treated as fully clean.
- **U7.1.7** `[property]` Global coupling: a hit shared between two instances links their stats (solving one improves the other).

### 7.2 Pokepaste import (T1.4)
- **U7.2.1** `[property]` A known paste parses to the correct sheet (species/item/ability/moves/alignment).
- **U7.2.2** `[property]` Nature → alignment maps correctly for boosted, reduced, and neutral natures.
- **U7.2.3** `[guard]` `Tera Type` and `IVs` lines are ignored; a `Tera Type` line raises a soft flag.
- **U7.2.4** `[property]` **Sheet-only** paste → `sp_spread` blank → mon is solver-eligible.
- **U7.2.5** `[guard]` **Known-spread** paste → `sp_spread` filled and marked known, not re-solved; a contradicting observation flags.
- **U7.2.6** `[guard]` Illegal species/item/ability/move (not in official data) is rejected, not silently accepted.
- **U7.2.7** `[property]` (After spread-form decided, §4 of T1.4) the spread line parses to a valid 66-sum SP spread.

---

## Acceptance gates (per phase)
- **Phase 1 locks** when T1.1 (Schema v2) and T1.2 pass §3 and §4.2 tag-semantics, and the user signs off on the output contract.
- **Phase 2 locks** when conversion (§1) and constraint model (§2, §4) pass on synthetic data, including the §10 algorithm validation (exact vs sampling agreement on small cases).
- **Phase 3 ships** when §5 and §6 integration checks pass over a real match.
