# Data Model & Aggregation (T1.3) — Champions Match Analysis Tool

**Document role:** How games are organized by player and tournament, and how the solver aggregates them. Adds the entity hierarchy that the event log (T1.1) and solver (T2.2) hang off. Governed by Constitution §E2 (global inference) and §E9 (aggregation).

**Status:** Draft for review. New feature spec.

---

## 1. Why this exists

You want to scout by **player and tournament** — e.g. several recorded games of Wolfe Glick's team at one tournament, all feeding one reverse-engineering run for that team. This spec defines the entities that make that work, and the rule that keeps aggregation honest (don't merge games where the spread actually changed).

It also formalizes something the solver always implied: inference is **one coupled system across all tracked teams that share games**, not isolated per-team solves (§5). Tracking both sides of a game strengthens both.

---

## 2. Entity hierarchy

```
Player ── owns ──> TeamInstance ── appears in ──> Game <── appears in ── TeamInstance <── owns ── Player
                        │                                                      │
                   (roster of ≤6                                         (the opponent's
                    open-sheet mons                                       team in that game)
                    + solved spreads)
```

| Entity | Fields | Notes |
|---|---|---|
| **Player** | `player_id`, `display_name` (e.g. "Wolfe Glick"), `aliases?` | A real competitor label. |
| **Tournament** | `tournament_id`, `name`, `date`, `format` | e.g. "2026 Worlds", Champions Reg M-A. |
| **TeamInstance** | `instance_id`, `player_id`, `roster` (≤6 team sheets, §2.2 of Schema v2), `constancy_scope` (§4), `solved_output` (per-mon, from the solver) | **The aggregation unit.** A fixed roster + fixed (to-be-solved) spreads over a defined scope. |
| **Game** | `game_id`, `tournament_id`, `side_A` `{player_id, instance_id}`, `side_B` `{player_id, instance_id}`, `event_log`, `video_ref` | One recorded match. References **two** TeamInstances. |

A Game's event log uses `mon_id`s that resolve to specific mons within each side's TeamInstance roster.

---

## 3. The aggregation rule

> **The solver aggregates all `clean` hits from every Game in which a TeamInstance appears, across that instance's mons, into one inference for that instance.**

- More games → more of the 6 roster mons get observed (each game brings a subset), and more diverse matchups → tighter spreads. This is the payoff you described.
- A single Game feeds **both** participating TeamInstances — Wolfe's mons inform Wolfe's instance; his opponent's mons inform theirs.
- Adding a game to one instance tightens **only that instance** (and, through coupling, its co-occurring opponents — §5).

---

## 4. Spread-constancy scope — the honesty guard (read carefully)

A TeamInstance assumes its spreads are **identical across all its games**. That assumption is only valid if the player didn't change the spread between those games. Aggregating across a spread change corrupts the inference exactly like a composite hit does — it's the **team-level analog of clean/composite**.

- **Default scope:** one `(player, tournament)`. Within a single tournament a competitor runs one locked spread, so this is almost always safe.
- **You control the scope:**
  - **Merge** instances across tournaments if you confirm the team+spreads are unchanged → wider aggregation, more data.
  - **Split** an instance if a player changed spreads mid-scope (rare) → prevents contamination.
  - **Roster change** (a swapped mon) defaults to a **new** TeamInstance; you decide whether to link.
- The solver must **never** silently aggregate across instance boundaries. Crossing a boundary is your explicit choice, surfaced like reclassifying a composite hit.

> **Open decision (you):** is the default aggregation key `(player, tournament)`, or `(player, team-version)` allowed to span tournaments by default? I've defaulted to per-tournament as the safe unit. (§8 Q1.)

---

## 5. Global coupling across tracked teams

A hit where mon A (instance X) damages mon D (instance Y) is **one factor coupling X's offense and Y's defense** (Constraint Model §3, §6). Therefore:

- The solver runs as **one global constraint system** over all TeamInstances that share games, and **slices output per instance**. It does not solve each team in a sealed box.
- **Consequence — sheet both sides.** To use a hit fully, the solver needs the *other* side's mon identity, typing, item, ability (for the damage factor's modifiers) — i.e. that side's **open sheet**. Open team sheets make both sides' sheets available at a tournament, so the recommended practice is to **import both teams** (feature 2) for every game.
- **If an opponent is un-sheeted/untracked:** their mons' stats become extra unconstrained unknowns, and hits involving them are **weakened** (the tracked mon's stat stays fused to an unknown opponent stat). Such hits may degrade to `bounded`/`guessed` contributions or, if even the modifiers are unknown, become effectively `unresolved`. The tool should flag a game as "partially sheeted" so you know its hits are weaker.

This is why features 1 and 2 reinforce each other: tracking organizes the data; importing both sheets unlocks the coupling that makes the data strong.

---

## 6. How this changes existing docs (cross-refs)

- **Constraint Model §9 (aggregation):** "same team" is now concretely the **TeamInstance** key; the global-system framing (§5) is made explicit.
- **Event Schema v2 §2.2:** a roster's team sheets are populated per TeamInstance, typically via pokepaste import (T1.4).
- **Solver Output Contract:** output is reported **per TeamInstance** (per player+team), with a per-mon "games observed" provenance already in §7 of that contract — now keyed to the instance's games.

---

## 7. Validation hooks (added to Validation List)
- Games group correctly by TeamInstance; a game feeds **both** sides' instances.
- Adding a game tightens only the intended instance(s).
- A spread-change **split** prevents cross-instance contamination (aggregating across it would corrupt; the boundary blocks it).
- A **merge** across tournaments widens aggregation only when explicitly set.
- A partially-sheeted game is flagged, and its weakened hits are tagged accordingly.
- Global coupling: a shared hit links two instances' stats (solving improves both).

---

## 8. Open questions
1. ~~**Default aggregation key**~~ — **RESOLVED (2026-06-15):** `(player, tournament)`. Cross-tournament merge is **manual-only** (never automatic), since crossing a real spread change corrupts inference like a composite hit (§4).
2. ~~**Opponent sheeting requirement**~~ — **RESOLVED (2026-06-15):** **accept partial**, flag the game as partially-sheeted; its weakened hits degrade gracefully to `bounded`/`guessed` rather than being refused (§5).
3. **Player identity:** any need for alias handling (a player tagged under variant names across sources), or is one canonical name per player enough? *(Still open — not blocking; the `aliases?` field exists in the Player entity for when it is.)*
4. **Cross-tournament reporting:** do you want a player's spreads tracked over *time* (how their builds evolve across tournaments), or always the latest instance? *(Still open — relates to whether old TeamInstances are retained/shown; decide when reporting UI is built.)*
