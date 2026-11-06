# NFL corrections switch / redeploy facts (2026-11-06)

**Audience:** engine owner + Jimmy. Draft prep only. No infra activation.
**Engine contract verified read-only:** SelfLearning [PR #13](https://github.com/liddar12/SelfLearning/pull/13)
head `37629ecc63c2dc6b92e5cd1b1c5fd5d58398bcb2` (`docs/nfl-corrections-v1.md`).
Engine CI reported green on that PR head (observed via `gh` check rollup this run);
**not** independently re-run here. Beta pending. No merge/activation.

---

## Two different “mode” switches (do not conflate)

| Switch | Where it lives | Who reads it | Instant? |
|---|---|---|---|
| **Engine** `SELFLEARN_CORRECTIONS_MODE` | Vercel env on SelfLearning | Engine process `os.environ` **per request** | **No.** Env change needs a **Vercel redeploy** before workers see it (engine contract §Flag). |
| **NFL** `corrections_mode` | Committed `config/parlay_selflearn_corrections.json` (default **`off`**) + optional Actions/env `NFL_PARLAY_CORRECTIONS_MODE` | `scripts/parlay_selflearn_corrections.py` at **build_predictions** time | **No** for already-served files. Takes effect on the **next** pipeline build that rewrites `data/parlays.json` and publishes to Netlify. |

Engine OFF alone does **not** rewrite Netlify’s `data/parlays.json`. If NFL previously baked adjusted `model_prob` into that file while `on`, clients keep seeing adjusted numbers until NFL rebuilds/restores and Netlify deploys the restored file.

---

## How served parlays actually reach users (NFL hosting)

1. GitHub Actions `daily-pipeline` / `gameday` runs `python -m scripts.build_predictions`.
2. Corrections helper runs **server-side in that job** (browser never holds tokens).
3. Result is written to **`data/parlays.json`** and published via `scripts/publish_data.sh` → commit on **`main`**.
4. **Netlify** auto-deploys the site from `main` (publish dir `.`).
5. Clients fetch `/data/*` with `Cache-Control: public, max-age=0, stale-while-revalidate=120` (`_headers`). SW does not cache.

There is **no** runtime Netlify Edge/Function call to the corrections API today, and **no** remote config store for an instant NFL kill switch.

---

## NFL OFF operability (what works today)

Committed default: `corrections_mode=off`.

When OFF, `maybe_correct_and_write`:

- **Does not** read `SELFLEARN_NFL_CORRECTIONS_TOKEN` or call the network.
- Returns the builder’s unadjusted parlays document.
- **Deletes** `data/parlay_corrections_pairs.json` if present (no stale ON/shadow sidecar).

So a **fresh build under OFF** restores baseline in the artifact that will be published, **without engine reachability**.

### What OFF is *not*

- Not an instant CDN/runtime flip of already-deployed adjusted JSON.
- Not achieved by flipping only the engine Vercel env.
- Not achieved by flipping only an Actions variable without a rebuild+publish that produces a new `data/parlays.json` on `main`.

### Propagation after a correct OFF rebuild + publish

| Step | Bound (approx, not a guarantee) |
|---|---|
| Actions rebuild + `publish_data.sh` push | pipeline duration (often several minutes) |
| Netlify deploy from `main` | typically 1–3 minutes after push |
| Browser `/data/*` revalidate | `max-age=0` + SWR 120s → open tabs pick up within ~2 minutes after deploy completes |

**End-to-end OFF propagation for served data: rebuild+publish+Netlify, on the order of minutes — not seconds, not “env-only.”**

---

## Emergency restore if `parlays.json` was already adjusted

Preferred: re-run `build_predictions` with NFL `corrections_mode=off` (or `NFL_PARLAY_CORRECTIONS_MODE=off`) and publish — builder output is baseline before corrections.

Offline helper (no engine): `restore_parlays_from_pairs(parlays_doc, pairs)` rewrites `model_prob` from the pairs sidecar’s `baseline_prob`. Requires the pairs file from the adjusting run. Then commit/push the restored `data/parlays.json` for Netlify.

If pairs are missing: restore `data/parlays.json` from the last known good git revision and push.

---

## Blocker: no instant runtime NFL kill without new infra

Current architecture **cannot** supply a runtime control that flips served probabilities without a data republish (and Netlify deploy). Smallest **default-deny** option that stays inside today’s stack (no new infra activation now):

1. Keep committed `corrections_mode=off` (default deny) until Jimmy explicitly enables.
2. Treat engine `SELFLEARN_CORRECTIONS_MODE` and NFL `corrections_mode` as **independent**; both must be `on` for served adjustments.
3. Document rollback as: set NFL OFF → trigger pipeline / restore file → push `main` → wait Netlify + ≤120s SWR; optionally set engine OFF + **Vercel redeploy** (separate, non-instant).
4. Future (not now): Edge Config / KV / Netlify Blobs read at request time, or serve baseline from an unadjusted artifact path — would be new production infra.

---

## Method / artifact notes (from actual contract)

- Fit: `delta = mean(hit - baseline_prob) * n / (n + prior_strength)` with `prior_strength=50`; per-market; **min 200 total / 50 per market**; **no global inheritance**.
- Artifact stored as journal `source_snapshot`; pin `SELFLEARN_CORRECTIONS_ARTIFACT_ID` (engine-side).
- **No genuine fitted artifact verified** on NFL → consumer treats no-data as baseline.
- Caps hard ceiling **0.03** probability units (3pp); clamp `[0.01,0.99]` only when `applied=true`.
- Engine **shadow** returns `applied=false` baseline echoes (would-be only in engine logs) — NFL must not expect adjusted probs in shadow responses.
- **PR#13 `public_artifact` omits `segments` + `fit_inputs_hash`.** NFL strict apply gate **rejects** that shape for `applied=true` (does not relax). Digests ≠ signatures. See `docs/pilot/corrections-beta-evidence-20261106.md`.
