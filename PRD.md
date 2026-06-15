# PRD — Champions Match Analysis Tool

**Status:** Draft for review
**Owner:** Yido
**Format target:** Pokémon Champions, Regulation M-A
**Document role:** Product requirements. Defines *what* is being built and *why*. The *non-negotiable rules* (formulas, invariants) live in the separate Constitution; this PRD references them but does not restate their detail.

---

## 1. Summary

A single-user web app that turns a recording of a Champions VGC match into (a) a structured, replayable log of what happened, (b) a reverse-engineered estimate of each opposing Pokémon's Stat Point allocation, and (c) an interactive replay of the match. The tool exists to help a competitive player scout opponents: by logging real matches, the user learns what spreads opponents are likely running, with an honest distinction between what the damage math *proves* and what is *inferred*.

The system is three components sharing one event log:

1. **Transcription** — record game actions, exact HP values, and observed random outcomes from video.
2. **Stat reverse-engineering (solver)** — infer Stat Point allocations from logged damage and turn order.
3. **Replay** — step through the match forward and backward, rendered via the Pokémon Showdown engine.

---

## 2. Goals

- Let the user transcribe a match into a structured event log accurately and without ambiguity about what each logged number means.
- Produce, per opposing Pokémon, a best-guess Stat Point spread plus a ranked set of alternatives, with every stat tagged as proven-by-data, bounded, or guessed-by-prior.
- **Organize games by player and tournament**, and aggregate all of a player's games in a tournament into one reverse-engineering run for that team (Data Model & Aggregation, T1.3).
- **Import teams in pokepaste format** to populate open-sheet rosters for both the scouted player and their opponents (Pokepaste Import, T1.4).
- Replay any transcribed match with forward/backward stepping, showing every HP change.
- Tell the user honestly where the inference is solid and where it is missing data — including what footage to find to fill a gap.

## 3. Non-goals (out of scope)

- **Re-simulating** matches from team + seed. The replay renders a transcribed protocol log; it does not regenerate outcomes. (Matching real observed rolls to a single RNG seed is intractable and explicitly not attempted.)
- **Closed-sheet inference.** The tool assumes open team sheets. Items, abilities, moves, and stat alignment are known inputs, not unknowns.
- **IV inference.** All Pokémon have perfect IVs by format rule; IVs are not a variable.
- **Tera mechanics.** Not present in Regulation M-A.
- **Video ingestion / computer vision.** The user transcribes by watching footage and entering data. The tool does not read the video automatically.
- **Multi-user / sharing / accounts.** Single-user tool.
- **Live / real-time use during a match.** Transcription is post-hoc from recordings.

## 4. Users and context

Single user (the builder), a competitive Champions player scouting opponents. Comfortable directing development through specs; not writing implementation directly. The tool's output is consumed by a human making teambuilding and matchup decisions, so **honesty about uncertainty is a product feature**, not a footnote.

---

## 5. Domain assumptions (settled)

These are summarized here for scope; the Constitution holds their exact, binding form.

- **Format:** Champions, Regulation M-A. Level 50, pinned. Smaller legal Pokémon and item lists than standard VGC. No Tera.
- **Open sheets:** items, abilities, moves, and stat alignment (formerly Nature; identical ±10% / neutral mechanic) are known per Pokémon.
- **Stat Points (SP):** replace EVs. Budget is **exactly 66 total**, allocated across the six stats. The conversion to final stats is fixed and known (1 SP ≈ +1 to a neutral stat at level 50; alignment multiplier applied last, floored). HP uses `Base + 75 + SP_hp`.
- **Damage data:** the user reads **exact integer HP values** (before and after) off screen. Damage is `HP_before − HP_after`, an exact point constraint. No rounding is applied during transcription.
- **Standard damage formula** applies unchanged; Showdown's calculator must match cartridge output (floor-based math throughout).

---

## 6. Component requirements

### 6.1 Transcription (Part 1)

Produces the **shared event log** — the spine the other two components read.

- Records typed events: damage-dealing moves, switches, status procs, weather/terrain/screen changes, turn boundaries, and observed random outcomes (e.g. whether a chance effect fired).
- Each damage event carries: attacker, move, defender, defender HP before/after, and a **battle-state snapshot** at that instant (active boosts, weather, terrain, screens) — because these change mid-game and are *not* on the team sheet.
- Records **turn order / who-moved-first**, so Speed is recoverable.
- Tags each damage event with a **source-certainty status**: `clean` (one known attacker + move → usable as a hard constraint), `composite` (drop combines multiple sources → not solver-usable), or `unresolved` (parked for the user to reclassify after re-watching). Every event, regardless of status, is retained for replay.

**Done when:** the user can log a full match such that (a) every HP change is captured, (b) clean hits are unambiguously attributable, and (c) the log fully reconstructs the match for replay.

### 6.2 Stat reverse-engineering / solver (Part 2)

Infers Stat Point allocations from the event log.

- Consumes **only `clean` damage events**, plus known open-sheet data and turn-order facts.
- Treats the problem as **one global constraint system** across all logged games versus the same team — not per-hit — so an attacker's offense and a defender's defense (which recur across many hits) pin each other down. Diversity of observed matchups, not raw hit count, is what strengthens inference.
- Reads HP Stat Points directly from max-HP (`SP_hp = MaxHP − Base − 75`); HP is not solved. The remaining five stats share the budget `66 − SP_hp`.
- Applies a **weak meta prior**: thin data yields a sensible common-spread guess; accumulating evidence overrides it so genuinely unusual spreads still surface.
- **Output per Pokémon:** a best-guess spread (headline), a ranked set of still-consistent alternatives with rough confidence, and a per-stat tag — **locked** (proven by damage), **bounded** (narrowed to a small range), or **guessed** (no relevant hit; prior-filled). Plus a note on **missing evidence** (e.g. "no physical hit observed → Def unconstrained; log one to resolve").

**Done when:** given a synthetic match with known spreads, the solver recovers them within tolerance, tags unobserved stats as guessed rather than inventing them, and never reports a guessed stat as locked.

### 6.3 Replay (Part 3)

Interactive playback of a transcribed match.

- Converts the event log into a **Showdown battle-protocol log** and renders it via Showdown's replay viewer.
- Supports **forward and backward** stepping by turn and by individual action.
- Shows **every** HP change — `clean`, `composite`, and `unresolved` alike.
- Uses Showdown's damage calculator for any derived display values, with floor-based math matching the cartridge.

**Done when:** any transcribed match plays back faithfully, steps both directions, and HP values shown match the logged integers.

---

## 7. Data flow

```
Video (user-watched)
        │  transcribe
        ▼
   Event log  ──────────────┬──────────────┐
 (shared, all events)       │ clean events  │ all events
                            ▼               ▼
                    Solver (Part 2)   Replay (Part 3)
                            │
                            ▼
              Ranked spreads + per-stat tags
                  + missing-evidence notes
```

One log, written by Part 1, read two different ways: the solver eats the `clean` subset; the replay consumes everything.

---

## 8. Success criteria (whole tool)

- A real recorded match can be transcribed, solved, and replayed end to end.
- Solver output visibly separates proven stats from guessed ones, and the user reports it tells them something actionable for scouting.
- Estimates measurably tighten as more matches against the same team are logged.
- No silent failure modes: composite/ambiguous hits never corrupt the solver; conversion math matches the cartridge.

## 9. Key risks

- **Inference is the novel, risky part.** Calc/sim/replay are off-the-shelf (`@smogon/calc`, `@pkmn/*` family — to be verified against current docs before build). The damage→SP solver has no known polished precedent; it should be prototyped first to de-risk before UI is built around it. *(Library APIs to be confirmed via current docs at build time.)*
- **Composite-hit handling** is the most likely source of silent error. The `clean/composite/unresolved` tagging is the mitigation; it must be enforced, not optional.
- **Alignment flooring** reintroduces small (±1 SP) ambiguity on boosted/reduced stats, which is why ranked candidates (not a bare best guess) are required.

## 10. Open questions

- Solver tolerance and confidence thresholds — to be defined when the solver behavior is specced. *(Confidence presentation resolved: coarse percentages + caveat — Output Contract §14.)*
- Exact UI/interaction model for transcription speed — deferred; the schema is locked first.
- ~~Whether intermediate solver states (per-game vs. cumulative) need to be user-visible.~~ **RESOLVED (2026-06-15):** the **cumulative** (aggregated) view is the default; a per-game drill-down is deferred (debugging/curiosity view, not v1's main path).
