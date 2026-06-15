# Pokepaste Import (T1.4) — Champions Match Analysis Tool

**Document role:** Parse pasted teams in the standard Showdown/pokepaste text format into Champions team sheets (the roster of a TeamInstance). Governed by Constitution §A2 (validate against official data), §B (SP system).

**Status:** Draft for review. New feature spec. One genuine unknown flagged (§4) — it determines the parser and I won't guess it.

---

## 1. What it does

You paste a team in pokepaste format; the tool produces the open-sheet roster for a TeamInstance (species, item, ability, moves, alignment) and, when present, a spread. This is how rosters get populated for both the player you're scouting and their opponents (Data Model §5 recommends sheeting both sides).

---

## 2. The standard format (input)

A pokepaste is one or more blocks like:

```
Incineroar @ Assault Vest
Ability: Intimidate
Level: 50
Tera Type: Grass
EVs: 252 HP / 4 Atk / 252 SpD
Adamant Nature
IVs: 0 Spe
- Fake Out
- Knock Off
- Flare Blitz
- Parting Shot
```

The parser reads each block into one team-sheet entry.

---

## 3. Field mapping to a Champions sheet

| Pokepaste line | Champions sheet field | Handling |
|---|---|---|
| `Species @ Item` | `species`, `item` | direct; validate against official dex/item list (§A2) |
| `Ability: X` | `ability` | direct; validate legal for species |
| `Level: 50` | — | expect 50 (pinned); flag if not |
| `Tera Type: X` | — | **ignored** — no Tera in Reg M-A; flag if present so you notice a mis-pasted format |
| `<Nature> Nature` | `alignment` | **map nature → alignment** (§5) |
| `SP: …` (raw Stat Points) | `sp_spread` | read directly; validate 0–32 each, sum 66 (§4) |
| `IVs: …` | — | **ignored** — perfect IVs by rule; optionally validate all 31 |
| `- Move` (×4) | `moves` | direct; validate legal for species |

---

## 4. The spread line — RESOLVED: raw Stat Points

Champions pokepastes carry **raw Stat Point values directly** — no EVs, no conversion. The parser reads the spread line as SP per stat and validates:
- each stat's SP is an integer **0–32**,
- the six values **sum to exactly 66** (Constitution §B1),
- HP's SP is consistent if a max-HP is also known elsewhere.

That's the whole rule. There is no EV↔SP translation in the import or export path.

> Internal note (not an import concern): the solver still converts SP → EV-equivalent (8 × SP) when feeding the Showdown calc, because the calc's API takes EVs (Constitution §F4). That conversion lives in the solver/calc boundary, **not** in pokepaste handling. The paste layer is pure SP.

> Minor confirm: I'm assuming the spread line is labeled as SP (e.g. `SP: 20 HP / 12 Def / 12 SpD / 22 Spe`) rather than reusing the `EVs:` label with SP numbers. Either is parseable; just confirm the label so the parser reads the right line. (§9 Q1.)

---

## 5. Nature → alignment mapping

Alignment is mechanically a Nature (Constitution §B4), so the map is direct: each nature names the boosted (×1.1) and reduced (×0.9) stat. E.g. Adamant → `up: Atk, down: SpA`; Timid → `up: Spe, down: Atk`; a neutral nature (Hardy/Docile/…) → `neutral`. The parser uses the standard nature table; validate the name is a real nature.

> Note: the boost/reduce **stats** transfer exactly; only the *name* changes (Nature → alignment). The ×1.1/×0.9 magnitudes are the calc's (Constitution §A4).

---

## 6. Two import modes (both supported)

- **Sheet-only (scouting input):** no spread in the paste (or you intentionally omit it). `sp_spread` stays blank → **the solver reverse-engineers it.** This is the normal open-sheet scouting case — you know items/moves/abilities/alignment, not the hidden SP.
- **Known-spread (ground truth / your own team):** spread present → `sp_spread` filled and marked **known**. Used for your own team, a confirmed build, or as **synthetic/validation ground truth** to test the solver against. A known spread is not re-solved; if observed hits contradict it, that's a flag (data or paste error).

The parser detects which mode per mon by whether a valid spread line is present.

---

## 7. Nice-to-have complement (not requested, flagging only)
Pokepaste **export** of a solved spread (best-guess → pokepaste text) would let you round-trip scouted teams back into the standard format for sharing or for feeding other tools. Out of scope unless you want it; mentioning because it's cheap once the import mapping exists and the SP↔EV form (§4) is decided.

---

## 8. Validation hooks (added to Validation List)
- A known paste parses to the correct sheet (species/item/ability/moves/alignment).
- Nature → alignment maps correctly for boosted, reduced, and neutral natures.
- `Tera Type` and `IVs` lines are ignored; a `Tera Type` line raises a soft flag.
- **Sheet-only** paste → `sp_spread` blank → mon is solver-eligible.
- **Known-spread** paste → `sp_spread` filled, marked known, not re-solved; a contradicting observation flags.
- Illegal species/item/ability/move (not in official data) is rejected, not silently accepted (§A2).
- The raw-SP spread line parses to a valid spread — each stat 0–32, sum exactly 66; non-66 sum or out-of-range rejected.

---

## 9. Open questions
1. **Spread-line label** — confirm the line is labeled `SP:` (vs. an `EVs:` label reused for SP numbers). Resolved that values are **raw SP**; just need the label so the parser reads the right line. Minor.
2. **Do you want pokepaste export** (§7) in scope?
3. **Multi-mon paste delimiting** — confirm blocks are separated by blank lines (standard) and that a paste may contain fewer than 6 mons (partial rosters allowed).
