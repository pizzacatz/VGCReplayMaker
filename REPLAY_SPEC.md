# Replay Consumption Spec (T2.3) — Champions Match Analysis Tool

**Document role:** How Part 3 turns the event log into an interactive replay using the Pokémon Showdown engine. Covers the log → battle-protocol mapping, the stepping model, and the rendering integration risk. Governed by Constitution §F, §A1, §G2.

**Status:** Draft for review. Protocol message formats below are **representative**; exact strings must be verified against current Showdown / `@pkmn/protocol` documentation before use (Constitution §G4). The mapping logic is the spec; the precise syntax is the engine's.

---

## 1. Which Showdown path — and which we do NOT use

Showdown has two relevant pieces:
- a **simulator** that *generates* battles from teams + choices + an RNG seed, and
- a **replay viewer** that *renders* a battle-protocol log (the `|move|…`, `|-damage|…` text stream).

**We use the replay viewer path only.** We translate the transcribed event log into a battle-protocol log and feed it to the viewer. We never re-simulate (Constitution §G2). This is deliberate and was settled at the start: the simulator generates outcomes, it can't be told "this attack rolled 88% and crit," whereas the viewer just renders the outcomes we already recorded. Every outcome — damage, crit, proc — is in our log, so the protocol is fully determined.

---

## 2. The core translation: event log → battle protocol

Each event maps to one or more protocol messages, emitted in `seq` order. Representative mapping (verify exact syntax):

| Event | Protocol message(s) (representative) |
|---|---|
| `turn_start` | `\|turn\|N` |
| `move_used` | `\|move\|<src>\|<Move>\|<target>` (one per target for spread) |
| `damage` | `\|-damage\|<defender>\|<hp_after>/<max_hp>`; preceded by `\|-crit\|<defender>` if `crit`; `\|-supereffective\|`/`\|-resisted\|` per `observed_effectiveness` |
| `passive_hp_change` | `\|-damage\|<target>\|<hp_after>/<max_hp>\|[from] <source>` |
| `heal` | `\|-heal\|<target>\|<hp_after>/<max_hp>\|[from] <source>` |
| `switch` | `\|switch\|<in>\|<details>\|<hp>/<max_hp>` |
| `faint` | `\|faint\|<target>` |
| `status_applied` | `\|-status\|<target>\|<status>`; lift → `\|-curestatus\|<target>\|<status>` |
| `stat_stage_change` | `\|-boost\|<target>\|<stat>\|<n>` or `\|-unboost\|…` |
| `field_change` (weather) | `\|-weather\|<Weather>` |
| `field_change` (terrain / Trick Room / Gravity) | `\|-fieldstart\|<Move>` / `\|-fieldend\|<Move>` |
| `field_change` (Reflect / Light Screen / **Aurora Veil** / Tailwind) | `\|-sidestart\|<side>\|<Condition>` / `\|-sideend\|…` |
| `item_or_ability_event` | `\|-item\|` / `\|-enditem\|` / `\|-activate\|` / `\|-ability\|` as appropriate |
| `random_outcome` | usually implied by the linked event (e.g. a flinch shows as the move not executing); no standalone message needed in most cases |

Because every state-change event becomes a protocol message in order, the replay shows boosts, screens (incl. Aurora Veil), terrain, status, and field exactly as they occurred — no separate reconstruction needed here. (The reconstruction engine from the schema v2 is for the *solver's* damage interpretation; replay just streams events → protocol.)

---

## 3. Pokémon identity and position (Doubles)

Format is **Doubles only**, so each side has two active slots. Showdown's protocol identifies actives as `p1a / p1b / p2a / p2b` (a = left, b = right) plus a name. The mapping:

> `mon_id` + current board position (from `leads` and `switch` events) → `p{side}{slot}: <species/nickname>`

A `switch` updates which `mon_id` occupies a `p_a`/`p_b` slot. Spread moves emit one `|-damage|` per target slot, each with its own logged HP — so a spread hit renders correctly as two damage messages.

---

## 4. HP representation

Our data is **exact integer HP** (we read it), and we know each mon's max HP (observed or read). So we feed the protocol `current/max` with real integers, and the viewer shows true HP rather than a coarse bar. Validation U5.3 checks displayed HP equals the logged integers.

> Verify how the viewer renders `current/max` HP for the opponent's side (some contexts coerce to /100 or /48). If it coarsens, we may need to render HP numerically ourselves as an overlay. Flag, don't assume.

---

## 5. The stepping model — forward, backward, by turn, by action

**Key property that makes this easy:** the protocol is **fully deterministic** — every outcome is logged, no hidden RNG. So the battle state at any `seq` index is a pure function of the protocol up to that index.

- **Forward step:** advance to the next message/turn, applying it to the rendered state.
- **Backward step / jump to any point:** **rebuild** the state by replaying the protocol from the start (or from the nearest cached keyframe) up to the target index. State isn't mutated in reverse — it's recomputed forward to an earlier target. This is cheap because there's no simulation, just message application, and it's exact because the stream is deterministic.
- **By turn:** jump between `|turn|N` markers (the `turn` field).
- **By action:** step individual messages (the `seq` granularity).

> Performance note: cache periodic **keyframes** (full state every K turns) so a backward jump replays only from the last keyframe, not always from turn 0. Optional until matches are long enough to matter.

This deterministic-rebuild model is the clean consequence of the no-re-simulation design, and it directly satisfies "forward and backward stepping by turn and by action" (Constitution §F1, Validation U5.2).

---

## 6. Rendering — the engine, and the real integration risk

**Default:** emit the protocol and render with the Showdown / `@pkmn/client` viewer.

**The integration risk to verify (this is the main one for Part 3):** the viewer needs **dex data** — species, sprites, move animations, item/ability text — for everything in the match. Showdown's data is built for mainline games. So:
- If Champions' legal species/moves/items are all standard mainline entries, the viewer likely has them and renders normally.
- If Champions includes **anything not in the mainline dex** (a new species, a renamed/new move or item), the viewer won't have sprites/animation/text for it and rendering breaks for that entry.

You've said the **damage calculator is already configured for Champions including the exceptions** — good, and in the `@pkmn`/Smogon ecosystem the calc and viewer often share underlying dex data, so that may already cover the viewer too. But **calc data ≠ sprite/animation data necessarily**, so this still needs an explicit check.

**Mitigation built into the design:** the **battle protocol is the interface**, and the renderer sits behind it. If the Showdown viewer can't cover Champions' data, a lightweight custom renderer driven by the *same* protocol + event log is a drop-in fallback — no change to Parts 1, 2, or the translation. Keeping the protocol as the contract is what makes the renderer swappable.

---

## 7. What replay shows that's specific to this tool

- **Every HP change renders — `clean`, `composite`, and `unresolved` alike** (Constitution §F2, Validation U5.4). Replay is faithful playback; the solver's certainty tags don't filter it.
- **Optional:** overlay the **exact logged damage number** on each hit (we have it), and optionally the calc's expected range for context. If the calc is invoked for any such overlay, stats are fed as SP→EV-equivalent (8×SP) per Constitution §F4 / Validation U5.5. The *displayed damage is always the logged value*, never a recomputed one.

---

## 8. What replay does NOT do

- **No re-simulation / no outcome generation** (Constitution §G2, Validation U5.6).
- **No stat recomputation** — replay renders logged HP; it doesn't infer or recompute stats (that's the solver).
- **No "correcting" the log** — if the log says 175 → 131, replay shows exactly that, even if a calc would expect a different number. A mismatch is a *data* signal for the solver's contradiction check (T1.2 §9), not something replay silently fixes.

---

## 9. Dependencies and integration risks (summary)

1. **Exact protocol syntax** — verify every message format in §2 against current `@pkmn/protocol` / Showdown `PROTOCOL.md`. Representative here, not authoritative.
2. **Viewer dex coverage for Champions** (§6) — the main risk; verify, with the custom-renderer fallback ready.
3. **HP rendering granularity** (§4) — verify the viewer shows exact integers; numerical overlay as fallback.
4. **Shared engine config** — confirm the viewer uses the same Champions-configured data the calc does, where possible, so constants/exceptions stay consistent across Parts 2 and 3.

---

## 10. Validation hooks
Validation List §5: valid protocol covering every event type (U5.1); forward/backward by turn and action (U5.2); displayed HP equals logged integers (U5.3); composite/unresolved HP changes render (U5.4); SP→EV-equivalent for any calc overlay (U5.5); no re-simulation (U5.6). Add: **deterministic-rebuild** — replaying to the same index twice yields identical state (the property §5 relies on); and a **spread-hit** fixture renders two correct per-target damage messages.

---

## 11. Open questions
1. ~~**Viewer choice**~~ — **RESOLVED (2026-06-15):** **Showdown/`@pkmn` viewer first**, custom renderer as the fallback if dex/sprite coverage for Champions fails. The protocol-as-interface design (§6) makes the swap cheap. The verification spike (OPEN_QUESTIONS §C2) confirms which path applies.
2. ~~**Damage-number overlays** (§7)~~ — **RESOLVED:** **on by default** — the exact *logged* damage is shown on each hit (never a recomputed value, §7/§8). Cheap and directly useful for analysis.
3. **Nicknames:** does Champions show nicknames, or species names only? Affects the protocol identity strings (§3). *(Minor, still open — confirm during replay build.)*
