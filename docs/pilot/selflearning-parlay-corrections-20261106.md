# SelfLearning parlay corrections + producer inventory (2026-11-06)

**Status:** draft prep only on fork PR. Capture OFF. Corrections OFF.
**No** live network, secrets, merge, deploy, upstream PR, or producer activation.
**Evidence time:** 2026-11-06 afternoon America/Chicago (cloud agent).

**Engine wire contract (read-only):** [SelfLearning PR #13](https://github.com/liddar12/SelfLearning/pull/13)
head **`37629ecc63c2dc6b92e5cd1b1c5fd5d58398bcb2`** — `docs/nfl-corrections-v1.md`.
Owner reports CI green; this run observed check rollup SUCCESS via `gh` but did **not**
re-run engine CI. Beta pending. No merge/activation.
Switch/redeploy facts: **`docs/pilot/nfl-corrections-switch-redeploy-20261106.md`**.

## Prominent honesty gate for Saturday / Nov 7

Engine owner reports **no graded history has been captured via the engine yet**.
**No genuine fitted artifact verified** → NFL consumer **no-data = baseline**.
NFL local archives exist (see below), but they are **not** a verified engine journal
and lack some fit-required fields (`baseline_model_version` on the flat leg ledger).

Method (engine): per-market `mean(hit-baseline)*n/(n+50)`; min **200** total / **50**
per market; **no global inheritance**. Artifact pin (engine): journal
`source_snapshot` via `SELFLEARN_CORRECTIONS_ARTIFACT_ID`.

Therefore any honest live activation can only serve **`applied=false`
everywhere** until a verified fit artifact exists **and** Jimmy approves NFL
`corrections_mode=on` + secrets/base URL.

This is **not** evidence that adjustments improve accuracy.

### CRITICAL: rollback is not env-only / not instant

- Engine `SELFLEARN_CORRECTIONS_MODE` is Vercel env → **needs redeploy**.
- NFL OFF is independent and must bypass network + restore baseline without engine.
- Served site is Netlify `data/parlays.json` from git publish — OFF needs
  **rebuild+publish+Netlify** (minutes; `/data/*` SWR ≤120s). See switch doc.

---

## NFL-side kill switch (distinct from capture)

| | Capture pilot | Parlay corrections |
|---|---|---|
| Config file | `config/selflearning_pilot.json` | **`config/parlay_selflearn_corrections.json`** |
| Mode field | `enabled` + `serving_mode` | **`corrections_mode`**: `off` \| `shadow` \| `on` |
| Default | `enabled=false`, `serving_mode=shadow` | **`corrections_mode=off`** |
| Env override | `SELFLEARN_NFL_PILOT_ENABLED` + `SELFLEARN_NFL_ENGINE_COMMIT` (both) | **`NFL_PARLAY_CORRECTIONS_MODE`** (optional) |
| Code | `scripts/pilot_capture.py`, shadow workflow | **`scripts/parlay_selflearn_corrections.py`**, gated in `build_predictions.py` |

OFF bypasses remote entirely and restores unadjusted parlays exactly (no stale pairs).

Caps (engine HARD_* / NFL local): leg **0.03** prob units (3pp); parlay
**min(0.03, 15% relative)**; clamp **[0.01, 0.99]** only when `applied=true`;
consumer timeout **4s** (max 8s). `caps_status: pending_jimmy_decision`.

---

## Eleanor inventory — EXACT NFL secrets / surfaces (names only)

### A. Capture / journal ingest (shadow capture workflow)

| Name | Where | Purpose | Status |
|---|---|---|---|
| **`SELFLEARN_NFL_INGEST_TOKEN`** | GitHub Actions **secret** on the NFL repo that runs `.github/workflows/selflearning-shadow-capture.yml` (today: intended prod repo `liddar12/NFL2026`; fork has the workflow file in this draft but must not be treated as live producer) | Bearer for `POST /api/v1/nfl/objects` and `POST /api/v1/nfl/generations` | **Does not exist yet** on NFL Actions (this run did not create it) |
| `SELFLEARN_NFL_PILOT_ENABLED` | GitHub Actions **variable** (optional kill switch; requires engine commit var too) | Override pilot enabled | Not required while config `enabled=false` |
| `SELFLEARN_NFL_ENGINE_COMMIT` | GitHub Actions **variable** (pair with above) | Pin / kill switch | Not set |
| Workflow | `.github/workflows/selflearning-shadow-capture.yml` | After successful `daily-pipeline` on **`main`**, or `workflow_dispatch` | Present in draft; **no-ops** while pilot `enabled≠1` |
| Base URL (workflow env) | `SELFLEARN_BASE_URL=https://self-learning-beige.vercel.app` | Ingest origin | **Unconfirmed** with engine owner |

### B. Outcome / evidence ingest (engine-authorized separately; NFL producer not built)

| Name | Where (if NFL ever posts) | Purpose | Status |
|---|---|---|---|
| **`SELFLEARN_NFL_OUTCOME_INGEST_TOKEN`** | Would be NFL Actions secret (distinct from corrections + object ingest) | `POST /api/v1/nfl/capture-chunks`, `POST /api/v1/nfl/capture-deliveries` | **No NFL producer implementation**; schemas incomplete — do not invent |

### C. Parlay corrections (live adjust path; server-side only)

| Name | Where | Purpose | Status |
|---|---|---|---|
| **`SELFLEARN_NFL_CORRECTIONS_TOKEN`** | GitHub Actions secret on the repo that runs `build_predictions` / daily-pipeline **if/when** corrections_mode≠off; also must match engine Vercel env | Bearer for `POST /api/v1/nfl/corrections` | **Does not exist**; ≥32 chars; unique vs ingest/outcome/operator tokens (engine-config rule — NFL must not read other tokens to verify) |
| `NFL_PARLAY_CORRECTIONS_MODE` | Optional Actions variable / runner env | Emergency override of `corrections_mode` | Unused while config is `off` |
| Hosting for served site | **Netlify** publish dir `.` auto-deploys on **push/merge to `main`** (`nfl2026.j5lagenticstrategy.com` / netlify app) | Serves `data/parlays.json` etc. | **Merging to main auto-deploys the PWA** |
| Live-score API | Separate Vercel `live-api` project — **not** this corrections path | `/api/nfl` scores | Out of scope here |

**Browser / Netlify must never hold corrections or ingest tokens.**

---

## Pilot / corrections switch behavior

1. **Capture `enabled=false` (current):** shadow-capture workflow reports disabled; no capture; no delivery. Exporter may still be invoked manually (see below) but is not scheduled.
2. **Corrections `corrections_mode=off` (current):** `build_predictions` skips the corrections module call path’s remote; parlays bytes = unadjusted builder output; no `data/parlay_corrections_pairs.json`.
3. **Corrections `shadow`:** may POST corrections, write pairs sidecar for grading; **served** `model_prob` stays baseline.
4. **Corrections `on`:** only after Jimmy yes + valid artifact; serves applied adjustments under local caps.

---

## How served baselines + grades would reach the engine

| Path | What it carries | Adequate for learning fit? |
|---|---|---|
| Shadow capture → objects/generations | Journal envelopes + learning_receipts from pool capture (`scripts/pilot_capture.py` + `export_learning.py`) | **Intended** producer for served receipts; **not live** while pilot OFF; no engine journal rows yet per owner |
| Outcome routes (chunks/deliveries) | Raw evidence + delivery binding | **Engine lane**; NFL has **no** poster; concrete destination/producer/envelope schemas **missing** |
| Local archives only (git `data/`) | See inventory below | Useful for **offline** engine fit prep; **not** the same as engine-accepted journal |

**Missing NFL path today:** automated post of per-leg/parlay **served baseline_prob + served_at + baseline_model_version + later grade** into engine outcome APIs. Capture workflow covers generation membership when enabled; outcome token/routes are separate and unfinished on NFL.

### Fork Actions caution

A workflow_run on a **fork** `main` rebuilds via `build_predictions` and would publish **fork-recomputed** `data/`, not a byte-faithful copy of upstream Netlify served files. Do **not** treat fork Actions output as live upstream served baselines. Upstream prod remains `liddar12/NFL2026` → Netlify.

---

## Historical forecast + outcome artifacts (measured offline)

Measured on workspace tip matching fork/upstream data refresh `9d6c71d3` lineage (files present in this checkout).

### Best leg-level archive (locked pre-kickoff + graded)

| Path | Role |
|---|---|
| `data/estimates/parlays_2026.json` | Append-only ledger: first-sight `model_prob`, `implied_prob`, `locked`/`locked_utc`, `kickoff_utc`, game/market/selection |
| `data/parlay_leg_scores.json` | Grades locked legs → `hit` true/false + `actual` scores |

**Measured counts**

- Ledger legs: **858** (locked **703**, unlocked 155)
- Resolved win/loss in scores: **600**
- Unresolved: **89** (`no_stat_line` 82, `push` 6, `tie` 1) — exclude push/void from fit
- Pre-kickoff lock among locked legs joining resolved: **600** (locked_utc &lt; kickoff_utc)
- By market among those 600: moneyline 129, spread 137, wr_rec_yds 116, rb_rush_yds 109, qb_pass_yds 109
- **Gap:** ledger rows do **not** carry `baseline_model_version` (required for fit rows). Join keys to scores: `(week, game_id, market, selection)`.
- Odds/lines: `implied_prob` present on all 858 ledger legs; prop `line` present on props; market prices are display/benchmark only per owner policy.

### Card-level graded MY parlays

| Path | Role |
|---|---|
| `data/my_cards/2026_wk0{2-9}.json` | Offered cards with `first_seen_utc`, `locked`, legs including `learning_receipt` (`served_prob`, `base_model_version`, `forecast_created_utc`, `receipt_id`) |
| `data/my_card_scores.json` | **23381** graded cards (`result` hit/miss/…), weeks_resolved **8** |

These are closer to “served receipt + grade” but are **TEAM-seed reconstructed offerings**, not every browser-built card.

### Game lock receipts

`data/snapshots/2026_wk*_games_open.json` — pre-kickoff game probs with `brier`/`log_loss` once `resolved` (121 games referenced by scores finals_source). Not prop-parlay legs.

### Distillation

- **Archive capture (git JSON):** yes, substantial locked+graded prop/ML/spread history locally.
- **True engine-accepted served+graded learning rows:** **no** (owner: none captured via engine yet).
- Saturday honest corrections: **applied=false** until engine fit + Jimmy yes.

---

## Producer ingest while pilot OFF (verified, no live POST)

| Mechanism | Behavior while OFF |
|---|---|
| Workflow `selflearning-shadow-capture.yml` | Resolves config; **reports disabled**; skips capture + delivery steps |
| `python3 scripts/export_learning.py` (no `--send`) | Dry-run only: `network_used=false`, `writes=false` (verified this run against default snapshots → 0 objects) |
| `export_learning.py --send` | Requires `SELFLEARN_NFL_INGEST_TOKEN` + `--base-url` + `--out-dir`; refuses overlap with `data/`; **not invoked** this run |
| Confirm-producer / live capture | **Not approved** |

### Capture contract conformance notes (offline)

Full gap inventory: **`docs/pilot/capture-contract-inventory-20261106.md`**
(engine FYI reportedly `aacb19c` — engine source not in this checkout; offline NFL checks only).

Fingerprint vectors independently recomputed; **all three claimed hashes MATCH**:

- `null` → `74234e98…90b`
- `{b:1,a:2}` → `d3626ac3…772`
- `{x:'é'}` → `bca462b8…0a9` (UTF-8 escapes as `\u00e9`)

**Top remaining gaps:** ingest token ≥32 + placeholder ban; client timeout 20s vs engine 12s;
exact MANIFEST/envelope/source schemas not supplied; outcome chunk/delivery schemas missing
(no NFL producer — do not invent); base URL unconfirmed; `publication_status` not client-checked.

---

## Remaining blockers (realistic)

1. Engine green-CI final confirmation of corrections + capture contracts  
2. Engine graded journal / fit artifact (n_graded, per-segment ≥50)  
3. Jimmy yes: caps, `corrections_mode`, secrets issuance  
4. Create **`SELFLEARN_NFL_CORRECTIONS_TOKEN`** (and separately ingest/outcome tokens if producers enabled) on the correct GitHub repo + matching Vercel env — **not done**  
5. Confirm corrections/ingest base URL  
6. Outcome producer schemas still incomplete — no NFL implementation  
7. Fork must not be mistaken for upstream served producer  
8. Merge to `main` **auto-deploys Netlify** — treat as production gate  

## Rollback (later activation)

- Set `corrections_mode=off` (config) or `NFL_PARLAY_CORRECTIONS_MODE=off` → exact baseline serve; delete `data/parlay_corrections_pairs.json` if present  
- Capture: keep `enabled=false` or kill-switch vars `SELFLEARN_NFL_PILOT_ENABLED=0` + pin  
- Revert merge commit if needed; Netlify follows `main`
