# Event Schema v2 (T1.1) — Champions Match Analysis Tool

**Document role:** The contract for the shared match log. **Supersedes v1.** Part 1 writes it; Part 2 reads its `clean` subset; Part 3 reads all of it. Governed by Constitution §D.

**Status:** Draft for review.

## What changed from v1 (read first)
- **▲ Modifiers are now reconstructed from the timeline, not hand-snapshotted per hit.** This is the central change. The reason: there are dozens of damage modifiers (screens, terrain, boosts, ally abilities, status, items…), and asking the transcriber to remember all of them per hit is unreliable. Instead, the log captures every *state-changing* event faithfully, and the damage engine reconstructs the exact modifier context for any hit by replaying the timeline to that point.
- **▲ The damage event shrinks to observed-only fields** (the number, crit, status), plus optional overrides for things the user sees that can't be derived.
- **▲ Aurora Veil added; screens generalized.**
- **▲ Ally/board composition is first-class** (switches + leads already give it), enabling ally effects (Friend Guard, Helping Hand).
- **▲ Attacker status and defender HP-conditional effects are now covered** (via timeline reconstruction).
- **▲ A modifier reference (§7) lists what the engine must account for, at latest-generation (Gen 9) constants.**

---

## 1. Core model

**1.1 A match is one ordered event list plus setup.** Global `seq` gives total order.

**1.2 Every HP change is an event** (attacks, passive chip, healing) — unchanged from v1, still non-negotiable, so the running HP timeline is always correct.

**1.3 Stable `mon_id` references**, board position is dynamic — unchanged.

**▲ 1.4 Battle state is derived, not transcribed.** The modifier context of any hit — boosts, field, screens, who's active, statuses, consumed items — is **reconstructed by replaying the event timeline up to that hit's `seq`**. The transcriber's job is to log every state-changing event completely; the engine's job is to assemble the per-hit modifier picture from them. This trades "remember every modifier per hit" (fragile) for "log every state change once" (robust).

> **The tradeoff, stated plainly:** reconstruction is only as good as the timeline's completeness. A missed boost, field change, switch, status, or item pop corrupts every later hit that depended on it. The mitigation is §6.3 (reconstructed-state confirmation) — the tool shows what it believes was active at each hit so the user can catch omissions against the video.

---

## 2. Match-level structure

### 2.1 Metadata — unchanged from v1 (`match_id`, `format`, `players`, `video_ref`, `notes`).

### 2.2 Team sheets — unchanged (per mon: `mon_id`, `species`, `item`, `ability`, `moves`, `alignment`, `observed_max_hp`, `sp_spread`). Base stats, types, item/ability/move data load from the **official source** (§A2).

### 2.3 Battle setup — `brought`, `leads` (by position). Board composition over time is reconstructed from `leads` + `switch` events.
> **Resolved (2026-06-15):** Champions uses **standard VGC bring rules — 4 of 6 brought, full team preview.** `brought` holds the 4 selected from the ≤6 roster; the other 2 are visible at preview but never enter battle.

---

## 3. Common event fields — unchanged (`event_id`, `seq`, `turn`, `type`).

---

## 4. Event types

The event types that **change battle state** are what make reconstruction work. They must be logged completely.

### 4.1 `turn_start` — unchanged.

### 4.2 `move_used` — unchanged in shape (`user`, `move`, `targets`, `is_spread`).
> **▲ Now load-bearing for ally effects.** Status moves with no damage (Helping Hand, Dragon Dance, Reflect, Tailwind, Trick Room) are still logged here. Helping Hand is detected as a `move_used` targeting an ally; the reconstruction reads it to apply the ally boost to that turn's hits.

### 4.3 `damage` — ▲ **leaner; observed-only**
| Field | Meaning | Required | Example |
|---|---|---|---|
| `attacker` | `mon_id` dealing damage | yes | `B1` |
| `move` | Move responsible | yes | `Knock Off` |
| `defender` | `mon_id` taking damage | yes | `A1` |
| `hp_before` / `hp_after` | Exact integers | yes | `175 → 131` |
| `crit` | Critical hit? (cannot be derived — it's random) | yes | `false` |
| `status` | `clean` \| `composite` \| `unresolved` (§5) | yes | `clean` |
| `observed_effectiveness` | What the screen showed (cross-check vs derived types) | yes | `1x` |
| `applied_effects` | **▲** Optional: hit-specific consumables the user *saw* fire whose timing is ambiguous (e.g. a resist berry popping to reduce this hit) | no | `["Occa Berry consumed"]` |
| `note` | Caveats / why composite | conditional | — |

Everything else (boosts, screens, terrain, weather, attacker burn, ally abilities, STAB, item, ability) is **reconstructed**, not entered here. `is_spread` is read from the linked `move_used`.

### 4.4 `passive_hp_change` — unchanged (`target`, `source`, `hp_before/after`). Sources include weather, status damage, recoil, Life Orb, hazards-equivalents.

### 4.5 `heal` — unchanged (`target`, `source`, `hp_before/after`).

### 4.6 `switch` — unchanged (`side`, `position`, `out`, `in`). **▲ Critical for ally effects** — reconstruction needs to know who is active alongside the attacker/defender at every hit.

### 4.7 `faint` — unchanged.

### 4.8 `status_applied` — unchanged (`target`, `status`, `source`).
> **▲ Now damage-relevant.** A burned attacker deals half physical damage; reconstruction reads the status timeline so attacker burn is applied automatically.
> **Resolved (2026-06-15):** a status lift is its **own** `status_cured` / `status_ended` event (not an `action: applied|cured` field on `status_applied`). This keeps each event atomic and symmetric with `field_change` (`set`/`end`) and `item_or_ability_event`, and maps cleanly to the replay protocol's distinct `|-curestatus|` message.

### 4.9 `stat_stage_change` — unchanged (`target`, `stat`, `stages`, `source`). Covers Dragon Dance, Intimidate, Swords Dance, Snarl, etc. Reconstruction applies the stage multiplier to the relevant candidate stat at hit-time.

### 4.10 `field_change` — ▲ **expanded**
| Field | Meaning | Required | Example |
|---|---|---|---|
| `field` | Effect name — now explicitly includes **Aurora Veil**, Reflect, Light Screen, weather (Sun/Rain/Sand/Snow), terrain (Electric/Grassy/Psychic/Misty), Tailwind, Trick Room, Gravity, etc. | yes | `Aurora Veil` |
| `action` | `set` / `end` | yes | `set` |
| `side` | Side-scoped effects (screens, Tailwind) | conditional | `A` |
| `turns_known` | Duration if known | no | `5` |

### 4.11 `item_or_ability_event` — unchanged in shape (`mon`, `kind`, `name`, `effect`). Covers item consumption (berries, Sash), on-entry abilities (Intimidate, weather setters), and any conditional activation. Reconstruction reads these to know an item is gone or an effect fired.

### 4.12 `random_outcome` — unchanged (`mon`, `event_kind`, `outcome`, `linked_event`). The luck record.

---

## 5. Source-certainty status — unchanged from v1

`clean` / `composite` / `unresolved`, same definitions and the same "when in doubt, `unresolved`" discipline. One clarification under the reframe: a hit is only `clean` if its **reconstructed modifier context is itself trustworthy** — i.e. the relevant state events were captured. If you're unsure the boosts/screens were fully logged, the hit is `unresolved`, not `clean`.

---

## 6. ▲ Reconstructed state (replaces v1 §5 "snapshot")

### 6.1 What the engine reconstructs for each hit
By replaying the timeline to the hit's `seq`:
- **Attacker offensive state:** active offensive stage(s); attacker status (burn → ½ physical); attacker item/ability (Choice item, Life Orb, Adaptability…); Helping Hand if an ally used it this turn.
- **Defender defensive state:** active defensive stage(s) (ignored if `crit`); defender item/ability (Assault Vest, Eviolite, Multiscale…); defender current-HP-conditional effects (Multiscale active iff `hp_before == max_hp`, derivable from the timeline).
- **Side state (defender's side):** Reflect / Light Screen / Aurora Veil (with singles-vs-doubles fraction); Friend Guard from an **active ally's** ability.
- **Field state:** weather, terrain (grounded check), Gravity, etc.
- **Move/type:** STAB (from attacker types), type effectiveness (from defender types), spread flag (from `move_used`).

### 6.2 What stays observed (cannot be derived)
- The HP numbers, `crit`, `observed_effectiveness`, and any `applied_effects` the user witnessed. These are the only things transcription must supply per hit.

### 6.3 ▲ Reconstructed-state confirmation (recommended feature, strong)
When logging a hit, the tool **displays the reconstructed context** ("terrain Grassy · attacker +1 Atk · Light Screen up · Friend Guard active · attacker not burned") for the user to confirm against the video. This turns "did I capture every modifier?" from invisible memory burden into a visible checklist — the practical answer to the problem your Light Screen / Aurora Veil / Dragon Dance question exposed.

---

## 7. ▲ Modifier reference (what the engine must apply — latest-generation / Gen 9 basis)

**Authority note:** the **damage engine owns the exact constant values** (the 4096-fixed-point fractions and the round-half-down order of operations). The schema captures the *state*; the engine applies the *numbers*. Magnitudes below are the Gen-9 values, given so the spec is concrete — **exact fractions and the rounding order must be verified against the engine, not trusted from this list** (Constitution §C1, §G4). And the **generation basis for Champions must be confirmed** — these are "latest mainline" values as you instructed; if Champions diverges, the engine's data must reflect it.

| Modifier | Gen-9 magnitude | Notes |
|---|---|---|
| Critical hit | ×1.5 | ignores defender's beneficial defensive boosts |
| STAB | ×1.5 (×2 Adaptability) | from attacker types |
| Type effectiveness | ×0.25 / ×0.5 / ×1 / ×2 / ×4 | observed value cross-checks derived |
| Burn (attacker) | physical ×0.5 | from status timeline |
| Stage multipliers | +1 ×1.5 … +6 ×4; −1 ×⅔ … −6 ×0.25 | Dragon Dance, Intimidate, etc. |
| Spread move (doubles) | ×0.75 | from `is_spread` |
| Reflect / Light Screen / Aurora Veil | singles ×0.5; **doubles ≈ ⅔** | Aurora Veil covers both categories; ignored on crit; exact doubles fraction = engine's |
| Weather | boost ×1.5 / reduce ×0.5 (e.g. Rain–Water / Fire) | field timeline |
| Terrain | **boost ×1.3** (grounded, matching type) | **▲ Gen 8+ value — was ×1.5 in Gen 7**; Misty halves Dragon to grounded |
| Helping Hand | ×1.5 | ally `move_used` this turn |
| Friend Guard | ×0.75 | active ally's ability |
| Life Orb | ×1.3 | attacker item |
| Multiscale / Shadow Shield | ×0.5 at full HP | defender HP-conditional |
| Filter / Solid Rock / Prism Armor | ×0.75 on super-effective | defender ability |
| Tinted Lens | ×2 on not-very-effective | attacker ability |
| Expert Belt | ×1.2 on super-effective | attacker item |
| Choice Band / Specs | ×1.5 Atk / SpA | attacker item |
| Assault Vest | ×1.5 SpD | defender item |
| Eviolite | ×1.5 Def & SpD (NFE) | defender item |

This list is **representative, not exhaustive** — which is exactly why §6.1 reconstructs from the engine's full modifier set rather than this table. The table tells you the schema captures the *state* each needs; the engine holds the complete, exact ruleset.

---

## 8. Worked example — boosted spread hit through screens, in doubles

Turn 4. B1 Incineroar (+1 Atk from a prior Swords Dance) uses a spread move; A1 has Light Screen up and an active ally A2 with Friend Guard. A1: 175 → 158, no crit.

```
(earlier) e0050 stat_stage_change  target B1, stat Atk, stages +1, source "Swords Dance"
(earlier) e0048 field_change       field "Light Screen", action set, side A
(earlier) leads/switch establish A2 (Friend Guard ability) active alongside A1

e0061 move_used  user B1, move "<spread move>", targets [A1, A2], is_spread true
e0062 damage     attacker B1, move "<spread move>", defender A1,
                 hp_before 175, hp_after 158, crit false,
                 observed_effectiveness "1x", status clean
```

The damage event records only the number, crit, and effectiveness. The engine reconstructs: attacker +1 Atk (×1.5), spread (×0.75), Light Screen (doubles ≈⅔), Friend Guard (×0.75) — none of it hand-entered. At log time the tool shows that stack (§6.3) for the user to confirm.

---

## 9. Validation hooks
Validation List §3 plus additions: **▲** reconstructed state for a hit matches a hand-verified expected context on a fixture match; **▲** a deliberately omitted boost/field event causes the affected hit's reconstruction to be wrong *and* is catchable via the §6.3 confirmation; Aurora Veil and doubles-screen fractions apply; ally effects (Friend Guard/Helping Hand) appear only when the ally is active.

---

## 10. Cross-document effects
- **Constraint model (T2.2 §3.1):** "modifiers from the snapshot" now reads "modifiers from the **reconstructed state**." No change to the math — T2.2 already obtains modifiers via the engine; this just confirms the source.
- **Constitution §C1:** the engine owns exact constants and rounding order; reaffirmed here.

---

## 11. Open questions
1. ~~**Bring/preview rules** (§2.3)~~ — **RESOLVED (2026-06-15):** standard VGC, bring 4 of 6, full preview.
2. **Generation basis for Champions** (§7) — confirm latest-gen constants apply, or supply Champions' values to the engine's data. *(Build-time verification, OPEN_QUESTIONS §C — the spike.)*
3. ~~**Doubles vs singles**~~ — **RESOLVED:** Doubles (VGC). The doubles fractions (screens ≈⅔, spread ×0.75) apply.
4. ~~**`status_cured`/`status_ended` representation** (§4.8)~~ — **RESOLVED:** its own event (not an `action` field). See §4.8.
