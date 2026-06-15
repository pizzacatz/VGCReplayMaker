# Constraint Model (T2.2) — Champions Match Analysis Tool

**Document role:** How the solver turns clean damage events into the tagged posterior defined by the output contract (T1.2). This is the novel, highest-risk part of the project — there is no known off-the-shelf tool for it — so the model is specified precisely enough to implement and to test against synthetic ground truth. Governed by Constitution §B, §C, §E.

**Status:** Draft for review. Model specification, not implementation. The inference *algorithm* has a stated default and a flagged tradeoff (§10); the *model* it computes is exact and fixed.

---

## 1. What the solver computes

A posterior distribution over each opposing Pokémon's Stat Point spread, given all `clean` events across all logged games versus the same team, plus the weak meta prior. From that posterior it derives everything in the output contract: headline spread, per-stat marginals, ranked candidates, tags, and missing-evidence notes.

The model has two layers, and keeping them separate is the integrity guarantee:

- **Phase A — hard constraints (exact).** What spreads are *possible*. Determines `locked` / `bounded` / `guessed`. The prior never touches this layer.
- **Phase B — soft posterior (modeled).** Among possible spreads, which are *more likely*. Produces the confidence percentages. The prior lives only here.

Tags come from Phase A; confidence comes from Phase B. So a stat is `locked` only when the **data alone** forces it — the prior can never manufacture certainty (Constitution §E4, Validation U4.2.3).

---

## 2. The model: variables and constraints

### 2.1 Variables
Per opposing Pokémon: five unknown non-HP Stat Points — `Atk, Def, SpA, SpD, Spe` — each an integer 0–32. HP is **read** directly (`SP_hp = MaxHP − Base − 75`) and is not a variable.

### 2.2 Budget constraint (hard, per mon)
`Atk + Def + SpA + SpD + Spe = 66 − SP_hp` (Constitution §B1, §E3). This couples a mon's five stats: narrowing four squeezes the fifth. If HP hasn't been observed yet, `SP_hp` is itself a variable in 0–32 and the equality is `sum of six = 66`.

### 2.3 Cross-mon coupling
Variables from different mons couple through shared hits (§3): an attacker's offense and a defender's defense appear in the same factor. The full model is therefore **one system across all observed mons**, not independent per-mon solves (Constitution §E2).

---

## 3. The damage factor (the heart of it)

Each `clean` damage event becomes one factor relating the attacker's relevant offensive stat and the defender's relevant defensive stat.

### 3.1 Forward prediction for a candidate stat pair
Given a candidate attacker offense and defender defense, the predicted **pre-roll** damage is computed by the standard damage formula using:
- the move (known from sheet: power, type, category, properties),
- the candidate stats (converted SP → final stat via the conversion module T2.1, then SP → EV-equivalent for the calc per §F4),
- every modifier from the hit's **reconstructed state** (Event Schema v2 §6 — crit, spread/0.75, weather, terrain, screens, boosts, attacker status, ally effects, conditional item/ability) and known sheet modifiers (STAB, item, ability), and observed type effectiveness.

This prediction **must come from the same damage engine replay uses** (Constitution A1, C1) so the solver and replay never disagree.

### 3.2 Applying the roll and forming the likelihood
The pre-roll value is multiplied by each of the **15 damage rolls (86–100%, uniform, floored)** (Constitution §C2), producing up to 15 candidate integer damages. Because flooring can map several rolls to the same integer:

> **P(observe `d` | attacker offense, defender defense) = (count of the 15 rolls that floor to exactly `d`) / 15.**

- If **zero** rolls reproduce the observed `d`, that stat pair is **impossible** for this hit — it leaves the feasible set (Phase A).
- If **one or more** rolls reproduce `d`, the pair is feasible, weighted by how many (Phase B).

This is exact and standard. The feasible set is the likelihood's support; the weights are the likelihood itself.

### 3.3 What each hit constrains
A physical hit constrains `{attacker.Atk, defender.Def}`; a special hit constrains `{attacker.SpA, defender.SpD}`. One hit is **one equation in two unknowns** — it pins neither alone, only their joint relationship (a band/curve in the 2-D pair space). Separation comes from *other* factors sharing one of the variables (§6).

---

## 4. The speed factor

Turn order yields inequalities, not damage. From a `move_used` ordering within a turn:

> If mon X moved before mon Y **in the same priority bracket** with speed-control state S, then `effective_speed(X, S) > effective_speed(Y, S)` (or reversed under Trick Room, scaled under Tailwind/paralysis/Choice Scarf — all read from the snapshot/sheet).

- **Guard (mandatory):** orderings across **different priority brackets** (a priority move going first) carry **no** speed information and must be excluded. Using them would fabricate a Speed constraint.
- Speed ties give near-equality information.
- Each valid ordering prunes the Spe domains of the two mons (or a mon's Spe against a known value). Speed is usually `bounded` (inequalities bracket it) unless a tie or tight bracket pins it.

---

## 5. Phase A — hard constraint propagation (exact, prior-free)

Maintain feasible domains for every variable and iteratively prune to a fixpoint (arc-consistency style):

1. **Damage factors:** drop any stat pair with zero consistent rolls (§3.2).
2. **Budget equality:** drop any per-mon combination not summing to `66 − SP_hp`.
3. **Speed inequalities:** drop Spe values violating any valid ordering (§4).
4. Repeat until nothing changes.

Outputs:
- Pruned feasible domains per stat (and the coupled joint feasible sets where stats remain entangled).
- **Contradiction detection:** if any mon's feasible set becomes **empty**, no spread satisfies the clean constraints → raise a `flag` naming the suspect hits (output contract §9, Validation U4.3.6). Never force-fit.

Phase A is exact — it makes no modeling assumptions, only applies the formula and the budget. Everything it rules out is genuinely impossible.

---

## 6. Global coupling and the "fused until separated" behavior

This behavior is a requirement, not an accident (Validation U4.3.2–3):

- **One attacker hitting one defender, repeated:** the feasible set stays a coupled band in `{Atk_A, Def_D}`. Neither marginal collapses. Both stats read `bounded`/`guessed` — correctly, because the data genuinely cannot separate them.
- **A second matchup sharing one variable** (A hits a different defender, or a different attacker hits D) injects a factor on the shared stat, and propagation separates them. Marginals tighten.

The practical lesson the output's missing-evidence notes encode: what unlocks a fused stat is a *different* matchup touching it, not more of the same hit.

> Reporting note: output is **per-mon marginal**. The joint posterior carries cross-mon correlations (A's offense and D's defense are linked), but the contract reports each mon separately. This is an accepted simplification — scouting reads stats per mon — and is worth stating so no one mistakes the marginals for independence.

---

## 7. Phase B — soft posterior (confidence)

Over the Phase-A feasible space only:

> **posterior(spread) ∝ prior(spread) × ∏ over clean hits P(d_hit | the spread's relevant stats)**

- The product runs over all clean hits touching the mon's stats; the likelihood per hit is §3.2.
- `prior(spread)` is §8.
- Normalize over the feasible space. Marginalize per stat for the per-stat distributions; rank full spreads by posterior mass for candidates; the top is the headline; uncovered mass is `remaining_mass`.

Phase B never revives a Phase-A-impossible spread (prior × 0 likelihood = 0). The prior only re-weights among the genuinely possible.

---

## 8. The prior (weak, honest, pluggable)

Constitution §E5 requires the prior to be **weak enough that accumulating clean hits override it**. Two honest constraints shape this spec:

- **I do not have Champions meta spread data, and will not invent it.** The format is new; fabricating "common spreads" would launder a guess into the output. So the *default* prior is **structural**, not empirical: a mild preference for (a) investment concentrated in a few stats rather than smeared across all five, and (b) the full budget being spent (already hard-enforced). No specific named spreads.
- **An empirical prior is a pluggable input, supplied or learned later.** When you have real Champions usage data (or accumulate it from your own logs), a catalog of observed spreads with frequencies can replace the structural prior. The interface takes a prior as input; it is never hardcoded from memory (Constitution §A2, §G3).

**Weakness is enforced and tested:** the prior's strength is a single tunable, set so that even a handful of clean hits dominate it. Validation U4.4.2–3 check that an unusual synthetic spread is recovered once enough hits accumulate, and that one strong contradicting observation visibly moves the estimate. If those fail, the prior is too strong and must be weakened.

---

## 9. Aggregation across games

All `clean` hits from every logged game in which a **TeamInstance** appears (Data Model T1.3) feed one model; the TeamInstance is the concrete "same team" aggregation key, and mon identity persists across its games. Aggregation is simply "more factors on the same variables" — it tightens estimates over time (Validation U4.1.2). The solver runs as **one global system across all TeamInstances that share games**, slicing output per instance (Data Model §5), since a shared hit couples one instance's offense with another's defense. A single-sighting instance has few factors, yielding mostly `bounded`/`guessed` output — correct, not a failure. **Aggregation never crosses a TeamInstance boundary** without your explicit merge (Data Model §4) — crossing a spread change would corrupt inference like a composite hit.

---

## 10. Inference algorithm — default and tradeoff

The *model* (Phases A and B) is fixed and exact. Computing Phase B's posterior over a coupled discrete space needs an algorithm; here the spec picks a default and names the tradeoff, per your preference not to hand choices back without reason:

**Default:** after Phase A pruning, handle each connected component of the factor graph separately. If a component's feasible space is small enough to enumerate (below a set size threshold), compute the posterior **exactly** by enumeration. If it's too large, estimate it by **Gibbs sampling** over feasible spreads that respect the budget. Record which method produced each result so confidence calibration is transparent.

**Tradeoff:** exact enumeration is correct but can blow up if many mons are tightly coupled with wide domains; sampling scales but introduces estimation noise in the confidence numbers (not in the tags, which are Phase-A/exact). The threshold is the knob.

**This is the single most important thing to validate** (Validation §4.1): run the chosen algorithm on synthetic matches with known spreads and confirm recovery within tolerance, correct tags, and that sampling (when used) agrees with exact enumeration on small cases. Both belief-propagation and sampling are established techniques; the spec does not assume any specific library implements them — whatever is used is verified against synthetic ground truth before trust.

---

## 11. Special move cases (must be handled, not assumed away)

- **Fixed-damage moves** (Seismic Toss / Night Shade equivalents): the damage carries **no** stat information. Such a hit is logged for the HP timeline and replay but contributes **no damage factor** to the solver. Flag in-model so it isn't mistaken for a constraint.
- **Multi-hit moves — ▲ now modeled (2026-06-15).** The HP delta is a sum of sub-hits. With the observed hit count recorded (`damage.hits`), the solver models the **total as the convolution** of each sub-hit's roll distribution (`predictMultiHit` + `multiHitLikelihood`) — a usable, if weaker, factor; the calc supplies per-sub-hit rolls (incl. escalating power, e.g. Triple Axel). Without a count, or if only the sum is visible, it stays `composite`.
- **Variable-power moves — ▲ partly modeled.** Weight/item/boost/weather-based power is computed by the shared engine from known/candidate values. **Speed-ratio moves (Gyro Ball, Electro Ball)** couple to both mons' unknown Speed, so they are **excluded** from the clean factor set (they still replay) rather than computed against default speeds — a Speed-coupled factor is deferred.
- **Reconstructed damage context — ▲ now applied (2026-06-15).** The factor is computed against the modifier state reconstructed from the timeline (EVENT_SCHEMA §1): weather/terrain/screens, per-mon stat boosts, attacker burn, **Helping Hand** (×1.5), **Paradox boosts** (Protosynthesis/Quark Drive, ×1.3 / ×1.5 Spe), **Multiscale/Shadow Shield** (only at full HP), single-target use of a spread move (drops the Doubles 0.75), and the **Mega forme**'s base stats + ability for post-Mega hits. Always Doubles.
- **Speed control — ▲ now modeled.** Move-order facts under Tailwind (×2), paralysis (×0.5), and Choice Scarf (×1.5, known from the open sheet) are emitted **with the magnitude** rather than discarded; only an unsheeted mover or stacked modifiers are skipped.
- **Confirm against the official move set** which of these categories each legal move falls into — loaded from the official data, not assumed (Constitution §A2).

---

## 12. Dependencies and integration risks

- **Conversion module (T2.1):** all SP↔stat math. No stat arithmetic happens here.
- **Damage predictor:** must reproduce cartridge damage exactly and be the same engine replay uses. **Integration risk to verify:** whether the chosen calculator (e.g. `@smogon/calc`) contains Champions' species, base stats, items, and moves, or whether that data must be supplied. Standard formula compatibility is necessary but not sufficient — the data tables must be Champions'. Verify against current docs/data before trusting any number (Constitution §G4).

---

## 13. Cross-document refinement — RESOLVED

**Event schema attacker-status gap (resolved in Event Schema v2).** This flag noted that the v1 snapshot omitted the attacker's status — a burned attacker deals **half** physical damage, so an unrecorded burn is a hidden ÷2 that corrupts inferred offense like an unrecorded crit. **Event Schema v2 resolves this:** attacker status is reconstructed from the `status_applied` / `status_cured` timeline (v2 §4.8, §6.1) and applied automatically by the damage engine. No per-hit field needed; the requirement is timeline completeness. Retained here as a record of the reconciliation.

---

## 14. Validation hooks

Checked by Validation List §4: recovery on synthetic ground truth (U4.1.1), tightening with more/diverse data (U4.1.2–3), honest tagging from Phase A (U4.2.x), composite rejection at the boundary (U4.3.1), fused-until-separated (U4.3.2–3), HP read not solved (U4.3.4), budget closure (U4.3.5), speed-from-order consistency (U4.3.6), and prior weakness/override (U4.4.x). Add: a test that fixed-damage hits contribute no factor (§11), and that a contradiction yields an empty feasible set and a flag (§5).

---

## 15. Open questions

1. **Speed-control specifics:** confirm Champions' Trick Room / Tailwind / paralysis / Choice Scarf behaviors match standard (the speed factor §4 assumes standard). If any differ, the inequalities change. *(Quick confirmation, OPEN_QUESTIONS §B2 — still pending.)*
2. ~~**Variable-power move coverage**~~ — **RESOLVED (2026-06-15):** handled **during solver build (T3.2)**, sourced from official move data (§11). Until a move's power rule is pinned, its hits default to **`unresolved`** rather than guessing the power. Common cases supported explicitly as encountered.
3. ~~**Empirical prior**~~ — **RESOLVED (2026-06-15):** ship the **structural prior** now; build the prior interface as a **pluggable seam** (§8) that can later accept a learned/empirical prior, but **do not build the learning path yet** (no logs to learn from).
4. ~~**Snapshot status field** (§13)~~ — **RESOLVED:** derived from the timeline (`status_applied`/`status_cured`), not a per-hit field. See §13 and Event Schema v2 §4.8.
