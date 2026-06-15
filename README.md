# Champions Match Analysis Tool (VGC Replay Maker)

A single-user tool for scouting **Pokémon Champions, Regulation M-A (Doubles/VGC)**. It turns a recording of a match into:

1. **A structured, replayable event log** — transcribed by hand from video.
2. **A reverse-engineered estimate of each opposing Pokémon's Stat Point spread** — with every stat tagged for how much the data actually proves (`read` / `locked` / `bounded` / `guessed`).
3. **An interactive replay** — stepped forward/backward, rendered via the Pokémon Showdown engine, with no re-simulation.

One event log, read two ways: the **solver** consumes only `clean` damage events; the **replay** renders everything.

## Status

Implemented end-to-end. The full pipeline — pokepaste import, transcription, the reverse-engineering solver (with honest tagging), aggregation across games, and replay — is built and tested (`npm test`, 156 tests). A web UI ties it together, organized as **Tournament → Match (a best-of set) → Game**: teams are registered once per tournament and reused every game (team-lock), each game owns its event log, and the **match winner is derived from the games' results** (first to ⌈bestOf/2⌉). The Solve tab aggregates every game of a player into one spread estimate.

## Running the app

```sh
npm install
npm run dev      # local app at http://localhost:5173
npm test         # the headless test suite
npm run build    # production bundle
```

The UI has four tabs: **Teams** (paste both teams; omit a spread to have it solved), **Transcribe** (log the match event by event, with reconstructed-state confirmation), **Solve** (reverse-engineer spreads with per-stat `read`/`locked`/`bounded`/`guessed` tags + missing-evidence notes), and **Replay** (the official Showdown replay engine, or a simple board).

## Deploy (Netlify, free, private repo)

The app is a static client-side SPA, hosted on Netlify and deployed automatically from GitHub. **Every push to `main` runs `.github/workflows/deploy.yml`** (typecheck → test → build → `netlify deploy --prod`). No manual `netlify deploy` is needed.

One-time setup — add the Netlify token as a repo secret:

1. Create a token at [app.netlify.com](https://app.netlify.com) → **User settings → Applications → Personal access tokens → New access token**.
2. `gh secret set NETLIFY_AUTH_TOKEN` (paste the token), or add it under **Settings → Secrets and variables → Actions**.

The site id (`07f1e826-…`) is non-secret and lives in the workflow. To deploy by hand instead, run `npx netlify-cli deploy --build --prod` from the repo root.

## Stack

- **TypeScript end-to-end** — Node engine + browser UI.
- **Single-user local app** (Vite-style; not hosted, no accounts).
- **One in-process Champions-configured damage calculator** (`@smogon/calc` / `@pkmn/*`) is the shared damage authority for both the solver and the replay (Constitution §A4) — the solver and replay must never disagree on a shared hit.

## Build order

1. **Verification spike** — resolve the external-data unknowns (OPEN_QUESTIONS §C).
2. **T3.1 — Conversion module** (SP ⇄ stat). Smallest, fully specified, everything depends on it.
3. **T3.2 — Solver prototype** against synthetic ground truth. The novel, highest-risk core; proven before any UI.
4. **T3.3 / T3.4 / T3.5** — transcription UI, replay, integration.

## Document map

The specs are authoritative; this README is a pointer.

| Document | Role |
|---|---|
| [`CONSTITUTION.md`](CONSTITUTION.md) | Binding, non-negotiable rules. If anything conflicts with this, this wins. |
| [`PRD.md`](PRD.md) | Product scope, components, done-criteria. |
| [`CONSOLIDATION_RECORD.md`](CONSOLIDATION_RECORD.md) | Canonical document index + changelog of reconciled corrections. **Read first.** |
| [`TASK_LIST.md`](TASK_LIST.md) | Ordered work breakdown. |
| [`OPEN_QUESTIONS.md`](OPEN_QUESTIONS.md) | Resolved decisions + remaining build-time verifications. |
| [`EVENT_SCHEMA_v2.md`](EVENT_SCHEMA_v2.md) | The shared event log (T1.1). |
| [`SOLVER_OUTPUT_CONTRACT.md`](SOLVER_OUTPUT_CONTRACT.md) | The solver's answer shape (T1.2). |
| [`CONVERSION_MODULE.md`](CONVERSION_MODULE.md) | SP ⇄ stat math (T2.1). |
| [`CONSTRAINT_MODEL.md`](CONSTRAINT_MODEL.md) | Solver reasoning, two-phase model (T2.2). |
| [`REPLAY_SPEC.md`](REPLAY_SPEC.md) | Event log → battle protocol → render (T2.3). |
| [`DATA_MODEL_AND_AGGREGATION.md`](DATA_MODEL_AND_AGGREGATION.md) | Player/tournament tracking & aggregation (T1.3). |
| [`POKEPASTE_IMPORT.md`](POKEPASTE_IMPORT.md) | Pokepaste team import (T1.4). |
| [`VALIDATION_LIST_v2.md`](VALIDATION_LIST_v2.md) | Acceptance criteria + unit-test enumeration. |
