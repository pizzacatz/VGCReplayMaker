# Constitution — Champions Match Analysis Tool

**Document role:** Binding, non-negotiable rules. Every spec, every implementation, and every Claude Code session must obey these. If a later document or a code change conflicts with this file, this file wins. The PRD defines *what and why*; this file defines the *rules that may not be violated*.

**Target:** Official Pokémon Champions (Nintendo Switch / Switch 2), Regulation M-A, **Doubles (VGC) format only**. **Not** the pokeemerald-expansion project — that is unrelated.

---

## A. Authority and ground truth

- **A1.** The official Champions game is the ground truth for all mechanics. Where any library (e.g. Showdown) diverges from the official game, the official game's behavior wins and the divergence must be corrected or flagged.
- **A2.** Format details that are *not* encoded in this file — the legal Pokémon list, legal item list, banned-move/clause specifics, and the exact text of Regulation M-A — are sourced from the **official ruleset**. They are not to be invented, hardcoded from memory, or assumed. Implementations must load them from an authoritative source and must mark them as external inputs, not constants baked from guesswork.
- **A3.** Any constant in this file derived from observation (not official documentation) is marked **[observed]**. Observed constants are treated as binding but flagged as verifiable.
- **A4. Configured calculator.** The Pokémon Showdown damage calculator, configured for Champions (latest-generation modifier constants plus the official game's flagged exceptions), is the shared damage engine for both the solver (Part 2) and replay (Part 3). It is the **authority for exact constant values and rounding order**; the official game (A1) remains authority for *mechanics*, and the calc must match it. Modules capture *state*; the calc applies *constants*.

## B. Stat Point system

- **B1. Budget.** Each Pokémon allocates **exactly 66 Stat Points** total across the six stats (HP, Atk, Def, SpA, SpD, Spe). Not "up to 66" — exactly 66. A spread whose six SP values do not sum to 66 is invalid.
- **B2. Per-stat range.** Each stat takes **0–32 SP**, giving 33 reachable allocations per stat.
- **B3. SP → stat conversion (non-HP stats).** One Stat Point equals **8 EV-equivalent** fed into the standard level-50 stat formula with perfect IVs (IV = 31). SP 0 → 0 EV-equivalent; SP 32 → 256 EV-equivalent. Net effect: **+1 to the neutral stat per Stat Point**, a contiguous run of 33 values.
  - Verification anchors **[observed]:** neutral SpD of base-90 Incineroar is **110 at SP 0** and **142 at SP 32**. Any implementation of the conversion must reproduce both.
- **B4. Stat alignment.** Alignment is mechanically identical to a Nature: ×1.1 to one stat, ×0.9 to another, ×1.0 otherwise. The multiplier is applied **last**, to the final stat, and is **floored**. Alignment is a known input (open sheets), never inferred.
- **B5. HP.** Max HP = **Base + 75 + SP_hp** at level 50 (equivalent to the standard HP formula expressed in SP units; +1 HP per SP). HP alignment does not apply. Therefore `SP_hp = MaxHP − Base − 75`, and HP Stat Points are **read, never solved**.
- **B6. IVs.** All Pokémon have perfect IVs by format rule. IVs are never a variable.

## C. Damage and randomness

- **C1. Damage formula.** The standard damage formula applies, unchanged, with **floor-based (round-down) math at every step**. No round-half-up anywhere.
- **C2. Damage roll table [observed].** Damage is multiplied by one of **exactly 15 values, 86%–100% inclusive** (integer percentages). The distribution is **uniform** — every value equally likely. This count and range are version-specific to the current official game and must match it.
- **C3. Observed damage is exact.** The user reads exact integer HP values (before and after). `damage = HP_before − HP_after`, an exact integer. **No rounding is applied during transcription** — the cartridge already floored; the user records what is shown.
- **C4. A single hit constrains a band, not a point.** Because the specific roll is unobserved, one clean hit is consistent with a range of true stats spanning the roll table. The solver must treat each hit as a band of width set by C2, never as a single exact stat.

## D. Event log (shared spine)

- **D1.** There is one event log per match. Part 1 writes it; Part 2 reads its `clean` subset; Part 3 reads all of it.
- **D2. Source-certainty status.** Every damage event carries exactly one status: `clean` (single known attacker + move → solver-usable), `composite` (drop combines multiple sources → not solver-usable), or `unresolved` (parked for user reclassification). 
- **D3.** The solver consumes **only `clean` events**. A `composite` or `unresolved` event must never enter the solver as a constraint. This rule is the primary guard against silent corruption and may not be relaxed for convenience.
- **D4.** Every event — regardless of status — is retained in full for replay. Nothing logged is discarded.
- **D5. State is reconstructed, not snapshotted.** *(Updated per Event Schema v2.)* The battle state for each hit — boosts, weather, terrain, screens, status, board composition, items — is **reconstructed by replaying the complete event timeline** to that hit, not hand-recorded on each damage event. The log must capture every state-changing event completely; damage events record only **observed** values (HP before/after, crit, observed effectiveness). A burned attacker, an active ally's Friend Guard, and similar modifiers are derived, not transcribed.
- **D6. Turn order.** The log records who moved first each turn, so Speed is recoverable from order.

## E. Solver

- **E1. Clean-only.** See D3. Binding.
- **E2. Global, not per-hit.** Inference is one constraint system across all logged games versus the same team. An attacker's offense and a defender's defense recur across hits and pin each other; the solver must exploit this rather than solving each hit in isolation.
- **E3. Budget closure.** The exactly-66 rule (B1), minus the read HP Stat Points (B5), is an equality constraint on the remaining five stats and must be applied.
- **E4. Honest tagging — inviolable.** Each reported stat is tagged **locked** (proven by data), **bounded** (narrowed to a small range), or **guessed** (no relevant observation; prior-filled). The solver must **never** report a guessed or bounded stat as locked. Fabricating certainty is the single worst failure this tool can commit.
- **E5. Weak prior.** A meta prior may inform thin-data guesses, but it must be weak enough that accumulating clean observations override it. A genuinely unusual spread must be able to surface given sufficient data; the prior may not permanently mask it.
- **E6. Missing-evidence disclosure.** When a stat is unconstrained, the solver states *why* and *what observation would resolve it*.

## F. Replay

- **F1.** Replay renders the event log as a battle-protocol log via the chosen engine, with forward and backward stepping by turn and by action.
- **F2.** Every HP change is shown — `clean`, `composite`, and `unresolved` alike.
- **F3.** Any derived display values use floor-based math (C1) and must match the integers in the log.
- **F4. Engine inputs.** When a calculator is fed stat data, Stat Points are converted to EV-equivalents per B3 (8 × SP) before being passed in. The engine is used as a math/render layer; it is not authoritative over mechanics (A1).

## G. Cross-cutting prohibitions

- **G1.** No silent guessing. Where a value is assumed rather than known, it is flagged in output, not buried.
- **G2.** No re-simulation. The tool never regenerates match outcomes from team + seed; it renders transcribed outcomes only.
- **G3.** No invented format data. See A2.
- **G4.** No fabricated library APIs. Any external library method must be verified against current documentation before use; unverified calls are flagged for the user to check.
