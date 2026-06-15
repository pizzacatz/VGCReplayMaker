# Task List — Champions Match Analysis Tool

**Document role:** Ordered work breakdown. Sequenced per the agreed principle — **lock contracts before behavior, validate the riskiest assumptions earliest.** This is a living document: contract tasks are detailed; behavior and implementation tasks are sketched and expand as the contracts above them lock.

Each task lists: **deliverable**, **depends on**, and **done when**. Validation checks for each task live in the separate Validation List.

---

## Phase 0 — Foundations (complete / in review)

- **T0.1 — PRD.** *Deliverable:* product requirements. *Status:* drafted, approved.
- **T0.2 — Constitution.** *Deliverable:* binding invariants. *Status:* drafted, in review.

## Phase 1 — Contracts (lock before any behavior)

### T1.1 — Event schema (Part 1 output / shared log) — **highest leverage**
- *Deliverable:* a field-by-field definition of every event type (damage, switch, status proc, weather/terrain/screen change, turn boundary, observed random outcome), the required/optional fields per type, legal values, the `clean/composite/unresolved` status field, the state-snapshot structure, and the turn-order representation.
- *Depends on:* Constitution §D.
- *Done when:* a full sample match can be expressed in the schema with every HP change captured, every clean hit unambiguously attributable, and the log sufficient to drive replay.

### T1.2 — Solver output contract (Part 2 answer shape)
- *Deliverable:* the exact structure of the solver's result — per-Pokémon best-guess spread, ranked alternatives with confidence, per-stat `locked/bounded/guessed` tag, and the missing-evidence note format.
- *Depends on:* Constitution §E, §B.
- *Done when:* the user confirms the output format tells them what they need to scout, and the tag semantics are unambiguous.

## Phase 2 — Behavior specs (behind the locked contracts)

### T2.1 — SP ⇄ stat conversion module spec
- *Deliverable:* the isolated, fully-specified conversion: SP→neutral stat, alignment application (floored, last), HP read, and the inverse (observed stat → candidate SP set, including alignment-floor ambiguity).
- *Depends on:* T1.1, T1.2, Constitution §B.
- *Done when:* spec reproduces the Incineroar anchors and defines inverse behavior on aligned stats.

### T2.2 — Constraint model spec (solver reasoning)
- *Deliverable:* how a clean hit becomes a band constraint (per §C2/C4), how bands combine into one global system across games (§E2), how the budget equality (§E3) and HP read (§B5) tighten it, how the weak prior is applied and overridden (§E5), and how tags are assigned (§E4).
- *Depends on:* T1.1, T1.2, T2.1.
- *Done when:* the model, on paper, can be traced from a small set of clean hits to a tagged output by hand.

### T2.3 — Replay consumption spec (Part 3)
- *Deliverable:* event-log → battle-protocol-log mapping, forward/backward stepping model, and how engine inputs are fed (SP→EV-equivalent per §F4).
- *Depends on:* T1.1.
- *Done when:* the mapping covers every event type the schema defines, including non-clean HP changes.
- *Open integration risk to resolve here:* whether the chosen engine (Showdown family) can render Champions content natively, or whether the protocol log / dex must be adapted because Champions species/sets/SP system are not in the engine's data. **Verify engine + library APIs against current docs before committing** (Constitution §G4).

## Phase 3 — Implementation (de-risk inference first)

### T3.1 — Conversion module (implement T2.1)
- *Rationale for ordering:* smallest, most-tested, everything depends on it. Build and unit-test before anything consumes it.

### T3.2 — Solver core (implement T2.2) — **prototype before UI**
- *Rationale:* the novel, risky part with no known precedent. Build against synthetic matches with known spreads first; prove recovery and honest tagging before any surrounding UI exists.

### T3.3 — Transcription UI (implement T1.1)
- *Deliverable:* the data-entry surface that produces valid event logs.

### T3.4 — Replay (implement T2.3)

### T3.5 — Integration
- *Deliverable:* end-to-end path — transcribe → solve → replay — over a real recorded match.

---

## Sequencing rules (binding for this project)

1. No Phase 2 task starts before its Phase 1 contract is locked.
2. The solver (T3.2) is prototyped against synthetic data **before** UI is built around it.
3. Library/engine APIs are verified against current docs at the point of use, never assumed.
