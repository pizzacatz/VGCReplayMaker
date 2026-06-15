# Consolidation Record — Champions Match Analysis Tool

**Purpose:** the canonical document index after consolidation, what supersedes what, and the changelog of every cross-document correction reconciled. Read this first to know which files are live.

---

## Canonical document set (live)

| # | Document | Role | Status |
|---|---|---|---|
| 1 | `PRD.md` | Scope, components, done-criteria | current |
| 2 | `CONSTITUTION.md` | Binding invariants | **edited** (see CL-3, CL-4, CL-5) |
| 3 | `TASK_LIST.md` | Ordered work breakdown | current |
| 4 | `VALIDATION_LIST_v2.md` | Acceptance criteria + unit tests | **supersedes v1** |
| 5 | `EVENT_SCHEMA_v2.md` | Shared event log (T1.1) | **supersedes v1** |
| 6 | `SOLVER_OUTPUT_CONTRACT.md` | Solver answer shape (T1.2) | current |
| 7 | `CONVERSION_MODULE.md` | SP↔stat math (T2.1) | **edited** (CL-1) |
| 8 | `CONSTRAINT_MODEL.md` | Solver reasoning (T2.2) | **edited** (CL-2, CL-3) |
| 9 | `REPLAY_SPEC.md` | Replay (T2.3) | current |
| 10 | `DATA_MODEL_AND_AGGREGATION.md` | Player/tournament tracking & aggregation (T1.3) | **new feature** |
| 11 | `POKEPASTE_IMPORT.md` | Pokepaste team import (T1.4) | **new feature** |

**Retired (do not use):** `EVENT_SCHEMA.md` (v1), `VALIDATION_LIST.md` (v1).

---

## Changelog of reconciled items

**CL-1 — Alignment ambiguity corrected.** Earlier docs implied a *boosted* stat collapses two SP together. Correct behavior: **reduced (×0.9) collides** (two SP → one final stat → `bounded`); **boosted (×1.1) gaps** (some finals unreachable; inverse unique). *Applied in:* Conversion §4.2–4.3; Validation U1.2.3 (reworded) + new U1.2.4.

**CL-2 — Attacker status resolved.** The constraint model flagged that the v1 per-hit snapshot omitted attacker burn (a hidden ÷2 on physical damage). *Resolved by* Event Schema v2's timeline reconstruction — attacker status is derived from `status_applied`/`status_cured`, not transcribed. *Applied in:* Schema v2 §4.8/§6.1; Constraint §13 (marked resolved); Constitution D5.

**CL-3 — Snapshot → reconstruction.** The whole "hand-snapshot every modifier per hit" model (fragile; missed Aurora Veil and ally effects) replaced by "log every state change once, reconstruct per-hit context from the timeline." *Applied in:* Event Schema v1→v2; Constitution D5 (rewritten); Constraint §3.1 (now reads "reconstructed state"). Added Aurora Veil, ally effects (Friend Guard/Helping Hand), defender HP-conditionals, and the reconstructed-state confirmation feature (Schema v2 §6.3).

**CL-4 — Doubles-only locked.** Format confirmed Doubles (VGC). *Applied in:* Constitution target line; Schema v2 (doubles screen/spread fractions); Replay §3 (p_a/p_b position model).

**CL-5 — Constant authority = configured calc.** Latest-generation modifier constants apply, with the official game's flagged exceptions, all held in the Champions-configured Showdown calculator — shared by solver and replay. The calc owns exact values/rounding; modules capture state. *Applied in:* Constitution A4; Schema v2 §7; Constraint §12; Replay §6.

**CL-6 — Tests folded into Validation v2.** New tests added from the specs: U1.2.4 (boost gaps), U1.2.5 (integer-math R1), U3.9–U3.12 (reconstruction, omitted-event catch, Aurora Veil/doubles fractions, ally-active gating), U4.3.7 (fixed-damage no factor), U4.3.8 (contradiction → empty set + flag), U5.7 (deterministic rebuild), U5.8 (spread-hit two messages), U6.5 (solver/replay share one calc).

**CL-7 — Player/tournament tracking & pokepaste import added (new features).** Two new specs: `DATA_MODEL_AND_AGGREGATION.md` (T1.3) and `POKEPASTE_IMPORT.md` (T1.4). *Touches:* PRD goals (two new bullets); Constraint §9 (aggregation now keys off the **TeamInstance** and is framed as one global system across tracked teams); Validation v2 §7 (new tests U7.1.x, U7.2.x). Key new design point: inference is one coupled system across all tracked teams sharing games, so sheeting **both** sides per game strengthens both. One blocking decision flagged: the pokepaste spread-line form (Open Questions A0).

**CL-8 — All §A decisions resolved + stack chosen (2026-06-15).** Every decision-level open question is now decided; the binding resolution table lives in `OPEN_QUESTIONS.md` ("A — RESOLVED"). *Applied across docs:* Output Contract §14 (5 candidates; coarse-rounded % confidence + caveat; benchmarks deferred); Event Schema §2.3 (bring 4-of-6, full preview), §4.8/§11 (status lift = own `status_cured`/`status_ended` event); Data Model §8 (aggregation key `(player, tournament)`, manual-only cross-tournament merge; accept-partial-sheeting + flag); Replay §11 (Showdown viewer first w/ custom fallback; damage overlays on by default); Constraint §15 (variable-power moves handled at solver build, default `unresolved`; structural prior now with pluggable seam); PRD §10 (cumulative solver view default). **Stack decided (was unstated):** TypeScript end-to-end, single-user local app, one in-process Champions-configured calc shared by solver and replay (recorded in README + OPEN_QUESTIONS §A). Remaining items are non-blocking confirmations (§B), build-time verifications (§C — the spike), and two deferred Data Model questions (player aliases, cross-tournament time-tracking).

---

## Outstanding cross-doc flags
All previously-flagged cross-document corrections are now **resolved**. Remaining items are *open questions* (decisions/confirmations needed from you) and *build-time verifications* (Claude Code must verify against current docs/data) — compiled in `OPEN_QUESTIONS.md`.
