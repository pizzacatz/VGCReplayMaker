# Open Questions — Champions Match Analysis Tool

Everything still unresolved across the spec set, in one place. Three groups: **A** needs a decision only you can make; **B** is a quick confirmation (a default is assumed, low risk); **C** is build-time verification Claude Code must do against current docs/data — not a question for you.

---

## A — RESOLVED (decisions made 2026-06-15)

All §A items below are now decided. Recorded here as the binding resolutions; the original discussion text is retained beneath for context.

| Item | Resolution |
|---|---|
| 1. Aggregation key | `(player, tournament)`. Cross-tournament merge is **manual-only**. |
| 2. Opponent sheeting | **Accept partial**, flag the game; coupling degrades to `bounded`/`guessed`. |
| 3. Bring / preview | **Bring 4 of 6, full team preview** (standard VGC). Confirmed. |
| 4. Variable-power moves | Handled **during solver build**; unsupported moves default `unresolved`. |
| 5. Confidence presentation | Percentages **rounded coarsely (~nearest 5%)** + soft-confidence caveat + evidence block. |
| 6. Empirical prior | **Structural prior now**; build the pluggable-prior seam; defer the learning path. |
| 7. Replay renderer | **Showdown/`@pkmn` viewer first**, custom renderer as fallback (spike confirms). |
| 8. Ranked-candidate count | **5** + `remaining_mass` line. |
| 9. Benchmark readouts | **Deferred** to post-integration. |
| 10. Damage-number overlays | **On by default** (always the logged value, never recomputed). |
| (PRD §10) Intermediate solver states | **Cumulative view default**; per-game drill-down deferred. |
| (Schema §11) Status lift | Dedicated **`status_cured`/`status_ended` event** (not an `action` field). |

**Stack decision (was unstated):** TypeScript end-to-end — Node engine + browser UI, single-user **local** app (Vite-style, not hosted). One in-process Champions-configured calc is the shared damage authority for solver and replay (Constitution A4, U6.5). Rationale: the calc/replay libraries (`@smogon/calc`, `@pkmn/*`) are TS and must not be severed from the solver, which calls the calc thousands of times in Phase A; Phase A/B are discrete integer work with no Python numerics advantage; shared types guard the silent-corruption failure modes the Constitution targets.

**Next action:** the §C verification spike (below) before production code, then T3.1 conversion → T3.2 solver prototype.

---

## A. Decisions needed from you — superseded by the resolution table above (original text retained for context)

1. **▲ Aggregation key default** *(Data Model T1.3 §4)* — is the unit `(player, tournament)` (defaulted, safe), or may `(player, team-version)` span tournaments by default? Governs how games get merged into one solve, and crossing a real spread change corrupts inference.

2. **▲ Opponent sheeting** *(Data Model §5, §8)* — require both teams sheeted before a game's hits are solver-eligible, or accept partial with weakened/flagged hits? Defaulted to accept-partial-with-flag. Affects inference strength.

3. **Bring / team-preview rules.** *(Schema v2 §2.3)* How many brought of how many, and is full preview shown? Constrains the roster/`brought` model.

4. **Variable-power move handling.** *(Constraint §11)* Which legal moves have non-fixed power, and the rule for each. Until pinned, such hits default to `unresolved`.

3. **Confidence presentation: percentages vs. coarse buckets.** *(Output Contract §14)* Percentages are precise but imply more calibration than a weak prior may earn; high/medium/low may be more honest. I defaulted to **percentages + a soft-confidence caveat** — but this is a real call worth your judgment.

4. **Empirical prior path.** *(Constraint §15)* Keep the structural prior indefinitely, or build a path to learn an empirical spread prior from your own accumulated logs over time? Affects whether the prior interface needs a learning hook now.

5. **Replay renderer.** *(Replay §11)* Commit to the Showdown/`@pkmn` viewer first (with the custom-renderer fallback if dex coverage fails), or build custom from the start? Default: **Showdown first** (protocol-as-interface makes switching cheap).

6. **Ranked-candidate count.** *(Output Contract §14)* How many full spreads in the ranked list. Default **5**.

7. **Benchmark readouts.** *(Output Contract §14)* Should output include derived benchmarks ("survives X's Y", "outspeeds base-100s at +0"), or stay raw spreads? Useful but expands scope.

8. **Damage-number overlays in replay.** *(Replay §11)* Show the exact logged damage on each hit by default? Minor UI, useful for analysis.

9. **Intermediate solver states.** *(PRD §10)* Should per-game (vs. cumulative) solver states be user-visible?

10. **Status lift representation.** *(Schema v2 §11)* Status removal as its own `status_cured`/`status_ended` event, or an `action: applied|cured` field. Reconstruction needs the lift point either way; pick the shape.

---

## B. Quick confirmations (default assumed, low risk)

1. **Alignment is exactly ×1.1 / ×0.9 with truncation** (standard Nature). *(Conversion §10)* Assumed from "alignment = Nature"; the calc encodes it. Confirm no Champions twist.

2. **Speed-control mechanics are standard** — Trick Room reverses, Tailwind doubles, paralysis quarters (modern), Choice Scarf ×1.5. *(Constraint §15)* The speed factor assumes standard; you said you'd flag exceptions.

3. **Nicknames vs species names** shown in-game. *(Replay §11)* Affects protocol identity strings. Minor.

---

## C. Build-time verifications (Claude Code, against current docs/data)

1. **Showdown battle-protocol syntax** — exact message formats in Replay §2 against current `@pkmn/protocol` / Showdown `PROTOCOL.md`. *(Replay §9)*

2. **Viewer dex coverage for Champions** — does the Showdown/`@pkmn` viewer have species, sprites, move animations, and item/ability data for **all** Champions legal entries? If not, supply data or use the custom-renderer fallback. *(Replay §6 — the main Part-3 risk.)*

3. **Calc matches the official game** — confirm the Champions-configured `@smogon/calc` reproduces cartridge damage exactly, including your flagged constant exceptions, the 15-roll table, and floor/rounding order. *(Constitution A4, C1, C2.)*

4. **Library APIs current** — `@smogon/calc`, `@pkmn/*` (sim/client/protocol/dex) method signatures verified before use; no calls assumed from memory. *(Constitution G4; PRD §9.)*

5. **Inference algorithm validated** — exact-enumeration vs. Gibbs-sampling agreement on small cases, and recovery on synthetic ground truth, before trusting confidence numbers. *(Constraint §10; Validation §4.1.)*

---

## Resolved (for the record)
Generation basis (latest-gen + flagged exceptions, in the calc); Doubles-only format; SP↔stat conversion (anchors confirmed); attacker-status handling (timeline reconstruction); the snapshot→reconstruction reframe; **pokepaste spread line = raw Stat Points** (no EV conversion at the paste boundary); all earlier cross-doc correction flags. See `CONSOLIDATION_RECORD.md`.
