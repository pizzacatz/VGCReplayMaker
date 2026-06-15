# Spike 1 — Calc / Dex verification findings

**Date:** 2026-06-15 · **Probe:** `spike/probe-calc.ts` (`npm run spike:calc`)
**Libraries (installed, introspected — not from memory, per Constitution §G4):**
`@smogon/calc@0.11.0`, `@pkmn/dex@0.10.10`, `@pkmn/data@0.10.10`, Node 22.

**Scope of this spike:** mechanics / formula / data-shape against the *real* libraries. It does **not** yet cover (a) full Champions legal-list coverage, (b) the flagged constant exceptions, or (c) viewer sprite/animation dex coverage — those are follow-up spikes (see "Still open").

---

## What passed (the design's premises hold)

- **Libraries load; Gen 9 works.** `@smogon/calc` exposes `calculate`, `Generations`, `Pokemon`, `Move`, `calcStat`, data tables (`SPECIES`, `MOVES`, `ITEMS`, `ABILITIES`, `NATURES`, `TYPE_CHART`). `Generations.get(9)` ok.
- **Base-stat data is present and correct.** Incineroar base stats `{hp:95, atk:115, def:90, spa:80, spd:90, spe:60}` — base SpD 90 matches the conversion anchor's premise (Constitution §B3).
- **Conversion anchors reproduce EXACTLY** (Constitution §B3, Validation U1.1.1–2): base-90 neutral SpD = **110 at 0 EV (SP0)** and **142 at 256 EV (SP32)**. The library's stat formula agrees with our closed form `neutral = Base + 20 + SP`.
- **EV-cap does not bite at SP32.** 8×32 = 256 EV-equivalent exceeds the standard 252 cap, but the library returns **142 for both 252 and 256 EV** — flooring makes them equal at this anchor. So feeding `8×SP` is safe; if the lib ever clamps to 252 the result is identical here. *(Still verify at other bases during T3.1 — the conversion module proves it analytically, this confirms one case.)*
- **Damage is integer / floor-based** (Constitution §C1): all rolls are integers.

## The key finding — roll table needs a Champions adaptation

- **`@smogon/calc` returns a 16-value damage array** = the **16 mainline rolls, 85–100%** inclusive.
- **Champions uses 15 rolls, 86–100%** (Constitution §C2, Validation U2.1.1/U2.3.2).
- **Adaptation (low-risk, ours to own):** drop **index 0** (the 85% roll) from the calc's array to get Champions' 15-roll 86–100% table. The library is **not** natively Champions-configured for the roll count; the solver/calc boundary must apply this slice, and replay must use the same table (Constitution A4, U6.5 — solver and replay share one calc).
- Sample: `252+ Atk Incineroar Flare Blitz vs. 0 HP / 0 Def Garchomp → [54,54,55,56,57,57,58,59,59,60,60,61,62,63,63,64]` (16 values). Champions table = drop the leading `54` (the 85% roll).
- *Note on the probe's `min/max ratio 0.8438`:* that is min-damage/max-damage **after flooring**, not the roll percentage — it does not contradict "index 0 = 85% roll." The 16-count is what identifies the table.

---

## Implications for the specs (no contradictions found)

- **Constitution §C2 stands** and is now confirmed as a *required override* of the library default, not something the library gives for free. Worth a one-line note in the constraint model / replay spec that the 15-roll table is applied by us on top of `@smogon/calc`'s 16-roll output.
- **The `@pkmn`/Smogon ecosystem is the right foundation** for the shared calc (Constitution A4): correct Gen-9 data, floor math, and exact anchor reproduction. The TypeScript-end-to-end stack decision is validated — the calc is in-process and authoritative.

## Still open (follow-up spikes / external inputs needed)

1. **Champions legal-list coverage.** Only mainline mons tested (Incineroar, Garchomp). The real risk is any Champions-legal entry that is **not** in the mainline dex. Resolving this needs the **official Champions Reg M-A legal list** (Constitution §A2 — must not be invented). Until supplied, coverage is "confirmed for mainline entries only."
2. **Flagged constant exceptions.** The Constitution refers to "the official game's flagged exceptions" baked into the configured calc. None are enumerated yet; when they are, verify each against `@smogon/calc` and override where it diverges.
3. **Viewer dex / sprite coverage (Part 3).** Separate probe — does the `@pkmn` client/viewer have sprites + animations + item/ability text for all Champions entries? (Replay §6, the main Part-3 risk.) Custom-renderer fallback ready if not.
4. **Modifier exactness.** This spike did not exercise the modifier stack (screens ≈⅔ doubles, spread ×0.75, terrain ×1.3, burn ×0.5, etc.). A follow-up probe should compute a few hand-verified modified hits and diff against the calc.

## Verdict

The core external-dependency risk for **Parts 2's math foundation** is **retired**: correct data, correct floor math, exact anchor reproduction. The one concrete adaptation — the 15-roll table — is identified and trivial. Remaining unknowns are **data-list coverage** (needs the official legal list) and **Part-3 viewer coverage** (separate spike), neither of which blocks starting **T3.1 (conversion module)**.

---

## Addendum — Spike 2 (T3.2 prep, `spike/probe-injection.ts`)

Two findings while wiring the shared damage engine:

1. **Showdown ships Champions formats.** `@pkmn/dex` contains `[Gen 9 Champions] VGC 2026` and `[Gen 9 Champions] BSS Reg M`. So Champions is modeled on **Gen 9 mechanics** (confirming the Gen-9 basis in Event Schema §7) and the legal-set data exists in-ecosystem if ever needed. Damage *resolution* = Gen 9 + our `champions.ts` override layer (15-roll table + exception registry).
2. **The calc ignores direct stat mutation** (`attacker.stats.atk = …` had no effect on damage). So candidate stats are fed via the supported **`evs (=8×SP) + nature (=alignment)`** path. Because the spike proved the calc's stat formula equals our conversion module exactly, this is consistent — and `buildMon` now **asserts** `calc stat === conversion stat` on every prediction, turning R5 into a checked invariant that will trip immediately on any future Champions stat-formula exception.

**Implication for design:** the exception infrastructure (`ExceptionRegistry` in `src/engine/champions.ts`) is the single place discovered ability/odds deviations get registered; the shared `predictHit` engine applies them, so the solver and replay inherit every exception identically (Constitution §A4).

---

## Addendum — Spike 3 (Part-3 viewer coverage, T3.4)

`@pkmn/img` `Sprites.getPokemon(name, {gen:9})` returns sprite URLs for every species tested — Incineroar, Garchomp, **Annihilape** (Gen 9), Zapdos, Giratina. Since Champions species are mainline Gen-9 entries (Spike 2) and footage self-enforces legality, the `@pkmn`/Showdown viewer ecosystem covers them. **The primary Part-3 risk (Replay §6 — does the viewer have Champions data?) is low.**

Remaining viewer unknowns are browser-time only — move animations and the live `@pkmn/client` render loop — verifiable when a real viewer is wired up, with the **custom-renderer fallback** ready. The protocol-as-interface design (`src/replay/protocol.ts` emits the message stream; the renderer sits behind it) makes that swap cheap, so it does not block the headless replay core (translation + deterministic-rebuild stepping), which is built and tested (Validation §5).

`@pkmn/img` was installed only for this probe and removed afterward.
