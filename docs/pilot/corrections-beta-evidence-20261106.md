# Corrections Beta evidence pack (draft / default-OFF) — 2026-11-06

**Recommendation: do NOT activate.** No genuine fitted artifact verified.
Capture OFF. Corrections OFF. No live ingest, secrets, merge, deploy, or upstream PR.

---

## Heads pinned this run

| Repo | Ref | SHA |
|---|---|---|
| Engine wire (read-only) | [SelfLearning PR #13](https://github.com/liddar12/SelfLearning/pull/13) head | **`37629ecc63c2dc6b92e5cd1b1c5fd5d58398bcb2`** |
| NFL fork draft branch | `cursor/selflearning-shadow-wiring-a401` tip | **`ffab9f3d`** (feature `2e94c6e04ba898a9136323a37d7e85bfdbd6c850`) |

Engine CI: owner reports green; this agent observed SUCCESS on PR #13 check rollup via `gh` — **not** independently re-run. Beta pending.

---

## Strict consumer contract vs current engine incompatibility

| Layer | Meaning |
|---|---|
| **Intended strict NFL apply gate** | Before `served_adjusted=true`, artifact MUST carry eligibility/provenance: `fit_inputs_hash`, `segments` (per-market `n_eligible`, `eligible_for_application`, `delta`), `sufficient_total`, `min_graded_total`≥200, `min_graded_per_market`≥50, `eligibility_rules`, `leg_cap_pp`. Applied legs require their **market segment** evidence — **no global inheritance**. |
| **Current engine PR#13 HTTP `public_artifact`** | Returns **only** `artifact_id, model_version, method, trained_through, fitted_at, expires_at, n_graded, source` — **OMITS** `segments` and `fit_inputs_hash`. |
| **NFL behavior** | Incomplete public shape **cannot apply**. Consumer falls back to baseline. We do **not** relax validation to pass today’s engine response. |

Implementation (line anchors on this branch tip):

- `scripts/parlay_selflearn_corrections.py:74` — `ARTIFACT_APPLY_EVIDENCE_KEYS`
- `scripts/parlay_selflearn_corrections.py:263` — `pr13_public_artifact_shape`
- `scripts/parlay_selflearn_corrections.py:293` — `_validate_artifact_for_apply` (rejects missing evidence)
- `scripts/parlay_selflearn_corrections.py:492` — apply path invokes strict gate
- `scripts/parlay_selflearn_corrections.py:681` / `:689` — OFF: no network, clear pairs
- `scripts/build_predictions.py:1597` — always calls `maybe_correct_and_write`

Regression: `tests/feature/parlay_selflearn_corrections.test.mjs:239` —
*REGRESSION: PR#13 public_artifact (no segments/fit_inputs_hash) cannot apply*.

### Other engine gaps (reported; not authenticity claims)

- **`artifact_id` / digests are content-addressing, not signatures** — not authenticity proof.
- Fit inputs are a **caller-trusted graded list**; no revision-resolution proof in the public response.
- Fit timestamp ordering is only partially constrained by the public fields; NFL still enforces `trained_through ≤ fitted_at ≤ expires_at` and freshness locally, but that does not prove journal integrity.
- Method formula (offline fit): `mean(hit-baseline)*n/(n+50)`; floors 200/50; NFL mirrors floors in the apply gate.

**No genuine fitted artifact exists in this checkout / was not verified against engine journal.** FAKE fixtures in tests are labeled fakes only.

---

## Implementation / test file links (NFL)

| Concern | Path |
|---|---|
| Consumer (strict apply + OFF bypass) | `scripts/parlay_selflearn_corrections.py` |
| Default-OFF config + pinned engine head | `config/parlay_selflearn_corrections.json` |
| Builder always calls helper (OFF clears pairs) | `scripts/build_predictions.py` (parlay corrections block) |
| Conformance + PR13 incomplete-artifact regression | `tests/feature/parlay_selflearn_corrections.test.mjs` |
| Capture fingerprint / gaps | `tests/feature/export_learning_fingerprint.test.mjs`, `docs/pilot/capture-contract-inventory-20261106.md` |
| Switch / redeploy facts | `docs/pilot/nfl-corrections-switch-redeploy-20261106.md` |
| Producer / Eleanor inventory | `docs/pilot/selflearning-parlay-corrections-20261106.md` |

---

## Commands / results (this agent)

```bash
# Focused conformance (must be 100% green)
node --test tests/feature/parlay_selflearn_corrections.test.mjs \
  tests/feature/export_learning_fingerprint.test.mjs \
  tests/feature/pilot_inactive_confirmation.test.mjs \
  tests/feature/pilot_serving_invariance.test.mjs

# Full fast gate
bash tests/run_gate.sh
```

**Results this session (after strict-apply change):**

| Command | Result |
|---|---|
| `node --test tests/feature/parlay_selflearn_corrections.test.mjs` | **15/15 pass** (includes PR#13 incomplete-artifact regression) |
| focused suite (corrections + fingerprint + pilot isolation) | **37/37 pass** |
| `bash tests/run_gate.sh` | **PASS (green)**; Playwright E2E skipped (not installed; fast gate dependency-free) |

---

## Rollback / propagation — tested intent vs reality

| Claim | Status |
|---|---|
| Engine `SELFLEARN_CORRECTIONS_MODE` env flip is instant | **False** — needs Vercel **redeploy** (engine contract). |
| NFL `corrections_mode=off` bypasses network without engine | **Tested** — OFF never calls transport; deletes pairs sidecar. |
| OFF restores baseline on next `build_predictions` | **Tested** in-unit (builder output unchanged under OFF). |
| OFF instantly fixes already-deployed Netlify `data/parlays.json` | **False** — needs rebuild+`publish_data.sh` push to `main` + Netlify deploy; `/data/*` `max-age=0, stale-while-revalidate=120` ⇒ ~minutes, not seconds. |
| Engine OFF alone rewrites NFL served JSON | **False**. |
| Instant runtime kill without new infra | **Unavailable** on current Netlify+Actions architecture (blocker documented; no infra activation). |

Emergency offline rewrite helper: `restore_parlays_from_pairs` (tested) — requires pairs sidecar from the adjusting run; still needs git publish for clients.

---

## Beta checklist (all must stay true to stay draft-safe)

- [x] NFL `corrections_mode=off` committed
- [x] Capture pilot `enabled=false`
- [x] Strict apply rejects PR#13 incomplete public_artifact
- [x] No live token / network exercise this run
- [ ] Genuine fitted artifact verified (engine journal) — **ABSENT**
- [ ] Jimmy caps / mode approval — **ABSENT**
- [ ] Secrets issued — **ABSENT**
- [ ] Activation — **NOT RECOMMENDED**
