# SelfLearning shadow wiring — NFL2026 safe branch (2026-11-06)

**Status:** draft-only wiring. Capture **disabled**. Serving unchanged.
**Owner lane:** NFL2026 only. SelfLearning engine repo is out of scope.
**Evidence times:** fork/upstream compare and remote tip inspection on **2026-11-06 ~09:15 America/Chicago**.

## Goal

Make eventual shadow capture, outcome grading, and evaluation *possible* without any
effect on served forecast bytes, pick selection/pricing, or betting paths.

## Verified remote state (this run)

| Fact | Value | Confidence |
|---|---|---|
| Fork `jliddar-omilia/NFL2026` main | `9d6c71d3f83370550436e9f16a046b989763ba18` (2026-11-06 10:19 UTC, daily pipeline refresh) | HIGH |
| Upstream `liddar12/NFL2026` main | **identical** `9d6c71d3…` (0 ahead / 0 behind) | HIGH |
| Nov 5 handoff upstream tip | `d8eebc0e…` — superseded only by later daily/gameday data refreshes on **both** remotes | HIGH |
| Fork branches `feat/selflearning-shadow-wiring-20261104` / `pilot/selflearning-shadow-enable-20261104` | **absent** on the fork | HIGH |
| Upstream wiring tip | `46bfff7c…` (workflow under `docs/pilot/proposed/` only) | HIGH |
| Upstream enable tip | `306a8968…` (`enabled=true`) — **not** included here | HIGH |
| Previously “unpublished” local `2b574537` / `a005def7` | Recoverable via GitHub API on upstream; tree of `2b574537` == `f2748887` (workflow installed, `enabled=false`). Not present as branch tips on the fork until this PR. | HIGH |
| Main pilot config | `enabled=false`, `serving_mode=shadow`, engine pin `aacb19c73122f257449e977df40f2a2733991b2f` | HIGH |

**Divergence report:** fork main matches upstream main at `9d6c71d3`. No fork-main sync was performed (none needed).

## What this branch changes

Reconstructed from verified remote tree `2b574537` / `f2748887` onto current main:

1. `.github/workflows/selflearning-shadow-capture.yml` — default-off shadow capture after successful `daily-pipeline` on `main` (or manual dispatch). No-op unless resolved `enabled=1`. Read-only `contents: read`. Never commits/pushes/deploys.
2. `scripts/pilot_capture.py` — `disabled_config()` → `pinned_shadow_config()` so the offline capture tool requires **shadow + exact pin** and does **not** require `enabled=false`. (`enabled` gates the workflow only.) This is the Nov 3 “pilot flip would break capture” fix.
3. Contract tests for the workflow + production isolation allow-list update.
4. New offline served-forecast invariance tests (`tests/feature/pilot_serving_invariance.test.mjs`).

**Unchanged on purpose**

- `config/selflearning_pilot.json` stays `enabled=false`.
- No learned-correction application into served predictions.
- No env/secret/Netlify/Vercel mutations.
- No live capture run.
- Enable-flip branch (`enabled=true`) is a **separate** future PR after Jimmy yes.

## Differences vs recovered `2b574537`

| Item | `2b574537` | This branch |
|---|---|---|
| Base | older main (~Nov 4–5 wiring base) | current main `9d6c71d3` |
| Wiring file bytes | workflow + `pilot_capture` + inactive allow-list + shadow workflow test | **same four paths** restored from that tip |
| Extra | — | serving-invariance tests + this report |
| Data JSON | older pipeline outputs in that tip’s ancestry | **not** taken; current main data retained |

No fabricated comparison to missing objects: the four wiring paths were checked with `git diff 2b574537 -- <paths>` after restore (empty before local extras).

## Fail-closed serving invariants (offline)

- Capture refuses workspaces under the checkout / `data/`.
- Export `--send` refuses delivery dirs that overlap sports data.
- Capture results always set `learning_enabled=false`, `serving_mode=shadow`, `production_authorized=false`, `network_used=false` for the offline path.
- App + production builders do not import pilot modules.
- Committed config keeps `enabled=false`; workflow capture/delivery steps are gated on `enabled==1`.

**Honesty limits:** these tests do **not** prove hosted SelfLearning persistence, journal durability, or future accuracy. They prove the NFL checkout’s served forecast files are not mutated by the offline capture/export guards.

**Baseline SHA-256 of served forecast files** (workspace at gate green, 2026-11-06; offline invariance tests assert these bytes are unchanged by capture dry-run / external-workspace execute):

| File | sha256 |
|---|---|
| `game_predictions.json` | `9b5c5afdf7b4d7f3192661db15809ebf1e1f8e0789b049e96bb92e6515684a9c` |
| `player_projections.json` | `af718db3a484af6084f9151b787d287e19dcb7e23e09cd1b56afb96886eb4809` |
| `leg_pool.json` | `91afb04ee3d0144d5fc594a1e6f178b16ce09f2979b89a504f832ce126bfb569` |
| `parlays.json` | `41f0e16c3a3918957517394a5f92e7d39dae0fad43d5ddbcb70473c2f0a98d82` |
| `parlay_leg_scores.json` | `69af4107ebeceb6350a2ae23f945a9ef8fe94941f00430c5553e138b4a517995` |
| `my_card_scores.json` | `f22428344f315fce5839e0132af77aa41620eff5ff5fc62e72b585a5901302a7` |
| `atd_cards.json` | `a3ac43020905c1a4ae3c4953c394f5d10041cb7fa5dfe934f2336d56fd260c00` |
| `atd_game_cards.json` | `bf7f08410c502f5b1221e4c6d51bc9b2ad792fca1e4cc474564b296cbab42ae0` |
| `market_prices.json` | `a12e33de7a20d2974f8db7a9b5a56961828e16c7066407446ffb5f2c5e4e0ba4` |
| `learning_loops.json` | `faf8d4feb8989b20161aba1536569fc1fd91bbff6cd6ac4fb436932d24edc9f4` |

## Proposed ingest contract (NFL ↔ SelfLearning) — ASSUMPTIONS, not agreed

Reconcile with the SelfLearning engine owner before any production enable. Unknowns are marked.

| Topic | Proposed NFL assumption | Status |
|---|---|---|
| Auth | Server-to-server `Authorization: Bearer <SELFLEARN_NFL_INGEST_TOKEN>` | Historical plan; **not yet agreed** |
| Token constraints | ≥32 printable ASCII chars, ≤8192, distinct from any operator bearer; never logged | NFL exporter currently enforces non-empty printable ≤8192; **min-32 not coded** — propose engine + NFL both enforce ≥32 |
| Routes | `POST {base}/api/v1/nfl/objects` then `POST {base}/api/v1/nfl/generations` | Coded in `scripts/export_learning.py`; **engine ACK schema not re-verified this run** |
| Base URL (pilot) | `https://self-learning-beige.vercel.app` | Stated in workflow; confirm with engine owner |
| Payload | Immutable journal snapshots + generation envelopes (`export_learning.plan` / `send`) | Schema/version negotiation **UNKNOWN** — fail closed on hash/ACK mismatch |
| IDs | Content-addressed `sha256:…` object ids; generation + receipt ids from journal | Stable IDs assumed; mapping rules **UNKNOWN** beyond current exporter validators |
| Outcomes / grading | Separate engine-side grading from captured receipts; NFL does not write grades into served JSON | Linkage protocol **UNKNOWN** |
| Idempotency | Repeat POST allowed; server returns durable duplicate ACK | Assumed by exporter; confirm |
| Retries / timeouts | 3 attempts, exponential backoff capped at 2s; HTTP timeout 20s; no redirects | NFL-side coded; engine SLA **UNKNOWN** |
| Freshness / evaluation | Evaluation freshness windows **UNKNOWN** — do not adopt into serving without prospective baseline comparison + Jimmy yes |
| Errors | NFL maps failures to static machine codes; never echoes bodies/tokens | Keep |

Until the engine owner signs this contract, keep `enabled=false` and do not set `SELFLEARN_NFL_INGEST_TOKEN` on NFL Actions.

## Smallest separate production activation (NOT executed)

1. SelfLearning owner confirms ingest contract + journal env green (their Phase B).
2. Jimmy yes to set Actions secret `SELFLEARN_NFL_INGEST_TOKEN` (value never displayed; ≥32 chars; distinct from operator token).
3. Merge **this** wiring PR only (still `enabled=false`) → workflow exists but no-ops.
4. Separate draft enable PR: `enabled=true` only (still `serving_mode=shadow`). Jimmy yes required to merge.
5. Optional kill-switch repo variables (both required together): `SELFLEARN_NFL_PILOT_ENABLED=0` + `SELFLEARN_NFL_ENGINE_COMMIT=aacb19c73122f257449e977df40f2a2733991b2f`.
6. Observe one shadow run artifact; verify Netlify served forecast hashes unchanged vs pre-enable baseline.
7. Learned corrections / adoption remain OFF until prospective baseline-comparison evidence exists and Jimmy approves separately.

## Rollback (NFL side)

- **Before enable merge:** close/revert this draft; nothing served changed while `enabled=false`.
- **After wiring merge, still disabled:** revert the merge commit on main (one-line revert).
- **After enable merge:** revert enable commit **or** set kill-switch vars `SELFLEARN_NFL_PILOT_ENABLED=0` + matching engine pin. Journal rows on SelfLearning are append-only (engine lane).

## Gate note (this VM)

Full `node --test tests/feature/*.mjs` on the cloud agent disk previously false-failed
`r88_publish_race` test (f) when wall-clock exceeded 20s under FS load even with
`PUBLISH_BACKOFF_S=0`. The reject-path assertion now locks the emitted
`retry budget: … backoff_s=0` line instead of wall-clock. Unrelated to capture wiring;
required so the regression gate can stay honest on shared runners.

## Engine-side dependencies (not owned here)

- Ingest routes + durable ACK behavior at pinned commit `aacb19c7…` (or a newly agreed pin).
- Matching Vercel ingest token.
- Outcome grading / evaluation freshness implementation.
- Any learned-correction serve path must remain unreachable from NFL serving until separate approval.
