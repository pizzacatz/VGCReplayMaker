# Solver Output Contract (T1.2) — Champions Match Analysis Tool

**Document role:** The shape of the solver's answer — what Part 2 hands back per opposing Pokémon. This is the format *you* judge the tool by, so it's designed around the scouting questions you'll actually ask, not around the math. Governed by Constitution §B, §E.

**Status:** Draft for review. Output structure, not implementation.

---

## 1. What you get, in one sentence

For each opposing Pokémon, an **honest posterior over its Stat Point spread**: a best-guess build up top, two views of the uncertainty beneath it (per-stat and whole-spread), every value tagged for how much the data actually proves, and a note on what footage would tighten the weak spots.

---

## 2. The two questions this format answers

Scouting really asks two different things, so the output gives two views of the same underlying result:

- **"How much did they invest in stat X?"** (Do they outspeed me? How bulky on the physical side?) → the **per-stat marginal** view. Usually the more actionable one.
- **"What's their actual full build?"** → the **ranked full-spread** view, where the six stats are shown together and respect the exactly-66 budget.

Both are read-outs of one posterior distribution. They cannot contradict each other because they're derived from the same candidate set (§6).

---

## 3. Per-Pokémon result — top-level fields

| Field | Meaning | Example |
|---|---|---|
| `mon_id` / `species` | Which Pokémon | `B1 / Incineroar` |
| `alignment` | Known from sheet (echoed for context) | `up: Spe, down: SpA` |
| `headline_spread` | Best-guess SP allocation (the top full candidate) | see §4 |
| `headline_confidence` | Posterior mass on the headline spread | `34%` |
| `per_stat` | Marginal distribution + tag per stat | see §5 |
| `candidates` | Ranked full spreads with posterior mass | see §6 |
| `evidence` | What informed this result | see §7 |
| `missing` | What observations would tighten it | see §8 |
| `flags` | Any data problems (contradictions, etc.) | see §9 |

---

## 4. Headline spread

The single most probable complete spread. Shown as **SP allocation, resulting final stats, and the budget check**:

```
HP 20 · Atk 0 · Def 12 · SpA 0 · SpD 12 · Spe 22   (sums to 66 ✓)
final: 175 / 110 / 100 / 90 / 100 / 134
```

> The headline is just the top of the `candidates` list (§6). `headline_confidence` is its posterior mass — and **if that mass is low, the headline is weak and the format says so loudly.** A 34% headline means "most likely, but far from settled"; the per-stat view below is where the real signal lives in that case.

---

## 5. Per-stat marginal view (the primary readout)

For each of the six stats: the most likely SP value, its tag, and the distribution behind it.

| Field | Meaning | Example |
|---|---|---|
| `stat` | Which stat | `Spe` |
| `best` | Most likely SP (and final stat) | `22 SP → 134` |
| `tag` | `read` \| `locked` \| `bounded` \| `guessed` (§10) | `bounded` |
| `distribution` | SP values with marginal probability | `{22: 58%, 20: 22%, 24: 12%, other: 8%}` |
| `range` | For `bounded`: the consistent SP span | `20–24` |

Example block for one mon:
```
HP   20 SP → 175   [read]      (from observed max HP)
Atk   0 SP →  90   [locked]    {0: 96%}      never invested — every clean hit it dealt is consistent only with 0
Def  12 SP → 100   [locked]    {12: 91%}
SpA   0 SP →  90   [guessed]   {0: 41%, 4: 18%, ...}   no special attack observed from this mon
SpD  12 SP → 100   [bounded]   {12: 54%, 16: 27%, 8: 11%}  range 8–16
Spe  22 SP → 134   [bounded]   {22: 58%, 20: 22%, 24: 12%}  range 20–24, from turn order vs known speeds
```

This view is where you read "they're at least +20 Speed" or "minimal SpD investment" at a glance — and crucially, the `[guessed]` tag tells you SpA here is **the prior talking, not the data**, so don't trust it.

---

## 6. Ranked full-spread candidates

The top-N complete spreads by posterior mass. **This is the primary object; everything else (headline, per-stat tags) is derived from it** — which is what guarantees the views stay coherent and every candidate sums to exactly 66 (Constitution §E3).

| Field | Meaning | Example |
|---|---|---|
| `rank` | Position | `1` |
| `spread` | Full SP allocation | `20/0/12/0/12/22` |
| `confidence` | Posterior mass | `34%` |
| `final_stats` | Resulting stats | `175/110/100/90/100/134` |

Plus a **`remaining_mass`** line: the probability not covered by the listed candidates (e.g. "top 5 shown = 81%; remaining 19% spread across other valid builds"). This stops the list from implying false completeness.

---

## 7. Evidence summary (provenance)

So you know how much to trust the whole thing:

| Field | Meaning | Example |
|---|---|---|
| `games_observed` | How many logged games featured this mon | `3` |
| `clean_hits_in` | Clean hits *taken* (constrain its defenses/HP) | `5` |
| `clean_hits_out` | Clean hits *dealt* (constrain its offenses) | `2` |
| `speed_evidence` | Turn-order facts pinning Speed | `"outsped A1 (known 120), slower than B-Tailwind"` |

A mon with `games_observed: 1, clean_hits: 0` will be almost entirely `guessed` — and that's correct, not a bug. The format makes thin evidence visible rather than hiding it behind a confident-looking spread.

---

## 8. Missing-evidence notes (the actionable part)

For every `guessed` or `bounded` stat, a plain statement of *why* it's loose and *what observation resolves it* (Constitution §E6):

```
SpA  guessed  — this mon was never seen using a special attack.
               Resolve: log one clean special hit it deals.
SpD  bounded  — seen taking special hits, but all from one attacker,
               so SpD is coupled to that attacker's SpA.
               Resolve: log a special hit from a different known attacker.
```

This is the feature that turns the tool from "guesser" into "scouting director" — it tells you which game to go re-watch or which matchup to seek.

---

## 9. Flags (data problems — never silently swallowed)

If the clean constraints can't all be satisfied by any valid 66-budget spread, the solver **does not force-fit**. It flags:

```
flags: [
  "INCONSISTENT: no valid spread satisfies all clean hits on this mon.
   Likely a logging error or an unrecorded modifier (missed crit/screen/spread).
   Suspect events: e0042, e0061. Recommend re-watch."
]
```

A contradiction means a transcription problem, not a stat truth — surfacing it (Constitution validation U4.3.6) is mandatory. Silent best-fit would launder bad data into a confident wrong answer.

---

## 10. Tag definitions (precise — these are the trust contract)

- **`read`** — directly observed, not inferred. Currently only HP (from max HP, §B5). Full certainty.
- **`locked`** — the clean damage data pins this stat to a single SP value; effectively all surviving candidates agree. Trust it.
- **`bounded`** — narrowed to a small range, but more than one SP value remains consistent. The `range`/`distribution` show how loose.
- **`guessed`** — no relevant observation constrains this stat; the value is the **prior** filling a blank. *Do not trust as scouting fact.* This is the spicy-tech blind spot — exactly where a surprise spread hides.

**Inviolable (Constitution §E4):** a `guessed` or `bounded` stat is **never** shown as `locked`. The tags are derived from the marginal's concentration, so they can't drift from the actual candidate set. Fabricating certainty is the worst thing this tool can do.

> Honest caveat on confidence numbers: every percentage is a **posterior** — it blends the clean data with the weak meta prior (§E5). With little data, the numbers lean on the prior, so treat early-game confidence as soft. As clean hits accumulate, the data dominates and the numbers sharpen. The format shows `evidence` precisely so you can tell which regime you're in.

---

## 11. Worked example — full result for one scouted mon

```
B1  Incineroar   (alignment: up Spe, down SpA)

HEADLINE:  HP 20 · Atk 0 · Def 12 · SpA 0 · SpD 12 · Spe 22   (66 ✓)   confidence 34%
           final 175/110/100/90/100/134

PER-STAT:
  HP   20 → 175   read      from observed max HP 175
  Atk   0 →  90   locked    {0: 96%}
  Def  12 → 100   locked    {12: 91%}
  SpA   0 →  90   guessed   prior only — never used a special move
  SpD  12 → 100   bounded   {12:54%,16:27%,8:11%}  range 8–16
  Spe  22 → 134   bounded   {22:58%,20:22%,24:12%}  range 20–24

CANDIDATES:
  1  20/0/12/0/12/22   34%
  2  20/0/12/0/16/18   19%
  3  20/0/16/0/12/18   12%
  4  20/0/12/0/8/26    9%
  5  16/0/12/0/16/22   7%
  remaining mass: 19%

EVIDENCE:  3 games · 5 clean hits taken · 2 clean hits dealt
           speed: outsped A1(120), slower under no Tailwind vs B-known

MISSING:
  SpA  — never used a special attack. Resolve: log one clean special hit it deals.
  SpD  — coupled to one attacker. Resolve: log a special hit from a different attacker.
  Spe  — bracketed but not pinned. Resolve: a speed-tie or order vs a known-speed mon at 22+.

FLAGS:  none
```

---

## 12. Edge cases the format must handle

- **Never-observed mon** (brought, but no clean hits in or out): every non-HP stat `guessed`, output = prior spread, `evidence` shows zero hits. Correct, not a failure.
- **Single-sighting team:** works, but mostly `guessed`/`bounded`; confidence soft. The format degrades gracefully rather than refusing.
- **Contradiction:** `flags` fires (§9); no forced answer.
- **Speed from order only:** typically `bounded` (inequalities, not a point) unless a speed tie or exact bracket pins it.

---

## 13. Validation hooks

Checked by Validation List §4.2 (honest tagging) and §4.1 (recovery): guessed-not-locked (U4.2.1), bounded-not-locked (U4.2.2), no locked without a pinning constraint (U4.2.3), every loose stat carries a missing-evidence note (U4.2.4), and the candidate set is the single source the per-stat view derives from (coherence).

---

## 14. Decisions — RESOLVED (2026-06-15)

1. **Ranked-candidate count:** **5**, always with the `remaining_mass` line (§6) so the list never implies false completeness. Configurable later.
2. **Final stats alongside SP:** **shown everywhere** — final stats matter for damage benchmarks.
3. **Confidence presentation:** **percentages rounded coarsely (≈ nearest 5%)**, plus the soft-confidence caveat (§10) and the `evidence` block (§7) so the reader can tell which regime (prior-led vs data-led) they're in. Coarse rounding avoids implying more calibration than a weak prior earns, while preserving the "low headline = weak" signal that pure high/med/low buckets would lose.
4. **Benchmark readouts** ("survives X's Y move", "outspeeds base-100s at +0"): **deferred to post-integration.** v1 output stays raw spreads; benchmarks are a derived presentation layer added once the solver is trusted (scope control).
