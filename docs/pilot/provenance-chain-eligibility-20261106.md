# Historical provenance chain — eligibility for SelfLearning fit (2026-11-06)

**Audience:** SelfLearning Dev / Eleanor. **Read-only inventory.** Draft stays OFF.
**No backfill. No inferred timestamps/model versions. Do not certify the 600 ledger resolves.**

Engine fit eligibility (PR #13 / `nfl_corrections_fit`): needs among other things
`served_at` before kickoff, binary outcome, exclude push/void, `graded_at <= trained_through`,
and a baseline probability that is the **served** number with model provenance.

This document pins what NFL JSON actually contains vs what is missing.

NFL draft tip at investigation: `0612b161d955ea78a6231f5a8d3e8fbf28d271ef`
(branch `cursor/selflearning-shadow-wiring-a401`). Counts measured on this checkout’s
`data/` (same lineage as upstream data refresh; **fork rebuild ≠ browser proof of
what Netlify served to a user**).

---

## Verdict (pin this)

| Candidate set | Eligible as *actual-served receipt + graded fit rows*? |
|---|---|
| **`data/parlay_leg_scores.json` `resolved` (n=600)** | **INELIGIBLE** — no `graded_at`, no `baseline_model_version` / `base_model_version`, no `learning_receipt`, no `served_at`; score rows omit lock timestamps; document `generated_utc` is **rebuild time**, not grade time. **Do not certify these 600.** |
| **`data/estimates/parlays_2026.json` locked legs (n=703)** | **INELIGIBLE as served-receipt evidence** — first-sight of pipeline `parlays.json` at `updated_utc`, not browser/CDN attestation; no model-version field; no grade fields. Useful as **immutable first-sight archive of offered probs**, not as engine-accepted served receipts. |
| **`data/my_cards/*` legs with `learning_receipt` (n≈27040)** | **NOT publication-proven** — every receipt has `publication_status: "generated_unverified"` by construction (`scripts/learning_receipts.py`). Internal lineage for MY prop offers only; **not** proof of public availability. |
| **`data/my_card_scores.json` graded cards** | **INELIGIBLE for fit without more work** — no `graded_at`; grades rewritten on each resolve run; only a minority of graded legs carry `receipt_id` (~21k / ~101k); cards are TEAM-seed reconstructed offerings, not full browser-built surface. |
| **Engine journal / capture** | **EMPTY for graded fit** (engine owner) — no genuine fitted artifact verified. |

**Absent proof ⇒ explicitly ineligible. Do not invent `graded_at` or `baseline_model_version`.**

---

## Artifact A — Parlay leg ledger (offered / first-sight, not receipt)

| Item | Fact | Cite |
|---|---|---|
| Path | `data/estimates/parlays_2026.json` | on disk |
| Writer | `scripts/build_parlay_ledger.py` | introduced lineage `a48058c8807f4ea2069dc7dabd7c0f0aef215b60` (R53) |
| Identity key | `(season, week, game_id, market, selection)` | ```92:94:scripts/build_parlay_ledger.py``` |
| Line / side | Props: `line` field + selection text (`N+ … yds`); ML/spread: selection regex + `side` home/away | ```155:205:scripts/build_parlay_ledger.py``` |
| First-sight / immutability | First append locks as-made fields; **later appends never rewrite** | ```12:16:scripts/build_parlay_ledger.py```, ```230:232:scripts/build_parlay_ledger.py``` |
| Chronology | `seen_utc` / `locked_utc` = `parlays.json` `updated_utc` when first seen; `locked` only if `as_of < kickoff` | ```219:238:scripts/build_parlay_ledger.py``` |
| Probability | `model_prob` (and optional seed fields) | ledger row shape |
| Model version | **ABSENT** | measured: 0/858 rows |
| Revision history | **None** — overwrite forbidden; no revision log | policy above |
| What it is | Archive of **pipeline-offered** legs as first recorded in git/Netlify publish path | docstring ```1:11:scripts/build_parlay_ledger.py``` |
| What it is **not** | Browser “user saw this” telemetry; content-addressed learning receipt; graded outcome | |

Measured on tip data: **858** legs, **703** locked, **155** unlocked.

---

## Artifact B — Parlay leg scores (grades without graded_at)

| Item | Fact | Cite |
|---|---|---|
| Path | `data/parlay_leg_scores.json` | |
| Writer | `scripts/resolve_parlay_legs.py` | |
| Inputs | Locked ledger legs + nflverse week stats / FINAL scores | module docstring ```1:38:scripts/resolve_parlay_legs.py``` |
| Resolved row fields | `week, game_id, market, selection, …, model_prob, actual, hit` (+ prop extras) | ```302:312:scripts/resolve_parlay_legs.py``` |
| **`graded_at`** | **ABSENT** on resolved rows | measured 0/600 |
| Lock / served times on score row | **Dropped** — not copied from ledger into resolved objects | same append block |
| Document clock | Top-level `generated_utc` = **this resolve run**, not first grade instant | ```447:478:scripts/resolve_parlay_legs.py``` |
| Grade revision | Score file is **rebuilt wholesale** each resolve; not an append-only grade journal | writer `write()` |
| Push/void | Unresolved with reason (not miss) | docstring honesty rules |
| Count | **600** resolved, **89** unresolved | `legs` summary in file |

**Why 600 cannot be certified for engine fit:** even joining back to the ledger for `locked_utc`/`kickoff` still lacks `graded_at` and `baseline_model_version`. Inferring grade time from `generated_utc` or “stats release appeared” would be invention.

---

## Artifact C — MY cards + learning receipts (lineage, unverified publication)

| Item | Fact | Cite |
|---|---|---|
| Paths | `data/my_cards/2026_wk*.json` | |
| Receipt module | `scripts/learning_receipts.py` | commit `32c5bfbe10e10e600a2d2f570391f7f7ede4af12` (#172) |
| Identity | `(season, game_id, player_id, market, line, side, direction, comparison_operator)` via `canonical_key` — **line + side explicit**; display names excluded | ```26:38:scripts/learning_receipts.py``` |
| Served vs base | `served_prob = serve_probability(base_prob, calibrator)`; leg `model_prob` must match | ```49:62:scripts/learning_receipts.py```, ```128:129:scripts/learning_receipts.py``` |
| Model version | `base_model_version` on receipt | ```93:93:scripts/learning_receipts.py``` |
| Created time | `forecast_created_utc` | ```95:95:scripts/learning_receipts.py``` |
| Publication | **Always** `publication_status: "generated_unverified"` until a publisher supplies separate evidence | ```1:5:scripts/learning_receipts.py```, ```99:99:scripts/learning_receipts.py``` |
| Markets covered | Prop only: `qb_pass_yds`, `rb_rush_yds`, `wr_rec_yds` | ```13:13:scripts/learning_receipts.py``` |
| Card immutability | `first_seen_utc` / lock; first `card_id` wins, never rewritten | ```224:245:scripts/build_my_cards.py``` |
| Measured | ~109731 card-legs; **27040** with receipts; **all** `generated_unverified` | this checkout |

**Honest label:** reconstructed/offered MY-pool lineage with cryptographic receipt IDs — **not** “actual-served public” until publication evidence exists outside this flag.

---

## Artifact D — MY card scores

| Item | Fact | Cite |
|---|---|---|
| Path | `data/my_card_scores.json` | |
| Writer | `scripts/resolve_my_cards.py` | |
| Grade row | `result/bucket/legs/money` — may copy `receipt_id` from card leg | ```294:306:scripts/resolve_my_cards.py``` |
| **`graded_at`** | **ABSENT** | measured |
| Receipt on graded legs | Partial (~21229 receipt_id on ~100867 graded card-legs) | measured |
| Revision | Document regenerated each run | |

---

## Chronological eligibility checklist (engine)

| Required | Ledger→scores (600) | MY receipt→scores |
|---|---|---|
| Selection-specific id (line/side) | Partial via `selection`+`line`/`side`; ML line null | Strong for props via `canonical_key` |
| `served_at` before kickoff | Proxy only: `locked_utc` on ledger if joined; **not on score row**; not browser-served | `forecast_created_utc` / card `locked_utc` — still unverified publication |
| Binary outcome / exclude push | Yes (unresolved reasons) | Card buckets include void/push handling |
| `graded_at <= trained_through` | **FAIL — no graded_at** | **FAIL — no graded_at** |
| `baseline_model_version` | **FAIL — absent** | Present on receipt when attached |
| Immutable first-sight | Yes (ledger/cards) | Yes (cards) |
| Grade revision journal | **No** | **No** |

---

## What would make rows eligible later (out of scope here)

Not implementing now. Would require, at minimum: append-only grade events with true `graded_at`, retained `served_at`/`locked_utc`/`kickoff` on the graded row, `baseline_model_version` (or receipt_id join), publication evidence beyond `generated_unverified`, and engine journal acceptance. Until then: **ineligible**.

---

## Explicit non-claims

- Not certifying 600 resolved ledger legs for learning fit.
- Not equating pipeline first-sight with CDN/user-served proof.
- Not treating `generated_unverified` receipts as published.
- Not backfilling missing clocks or model versions.
