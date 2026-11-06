# Rapid disable + baseline cache restoration — design (2026-11-06)

**Audience:** SelfLearning Dev / Eleanor + Jimmy. **Design only.** Draft stays
`corrections_mode=off`. **No** new infra purchase, env, deploy, or runtime
implementation until an explicit architecture decision.

Related: `docs/pilot/nfl-corrections-switch-redeploy-20261106.md` (measured facts).

---

## Problem statement

Today’s served surface is **static Netlify publish** of `data/parlays.json` (and
siblings) from `main`. Corrections, if ever `on`, would be baked at
`build_predictions` time into that file. There is **no runtime OFF** that reaches
already-published or already-loaded clients without a data republish.

Engine `SELFLEARN_CORRECTIONS_MODE` is independent, Vercel-env, **redeploy-bound**,
and **cannot** rewrite NFL static JSON.

Distinguish two goals:

1. **Disable new corrections** — stop baking/serving newly adjusted probs.
2. **Restore baseline for already published/loaded adjusted parlays** — clients
   that already hold adjusted JSON must get unadjusted numbers (or stop showing
   adjusted).

Browser network checks **cannot revoke** offline tabs, in-memory caches, or
SWR-held bodies. Do not claim otherwise.

---

## Current stack constraints (facts)

| Layer | Behavior | Cite |
|---|---|---|
| Publish | Actions → `publish_data.sh` → commit `main` → Netlify | `.github/workflows/daily.yml` |
| CDN | `/data/*` → `max-age=0, stale-while-revalidate=120` | `_headers` L21–22 |
| SW | **No fetch handler**; purge-only — does not cache app/data | `sw.js` L1–44 |
| Client | In-memory promise cache TTL **60s** (`DATA_TTL_MS`); fetch uses `cache: 'no-cache'` | `app/data.js` L52–79 |
| Corrections OFF today | Config default deny; helper skips network; deletes pairs sidecar | `config/parlay_selflearn_corrections.json`, `scripts/parlay_selflearn_corrections.py` |

**Propagation lower bound after a correct file lands on Netlify:** on the order of
**deploy time (often ~1–3 min) + up to ~120s SWR + up to ~60s in-memory TTL** for
cooperative online clients. **Not a guarantee** for open tabs that never re-fetch,
failed networks, or copies saved offline.

---

## Recommendation (smallest viable delta — still needs Jimmy decision)

**Option R1 — Dual artifact + tiny serving flag (same Netlify/Actions stack; no new vendor product).**

Keep everything on git→Netlify. Add (when implementation is approved later):

| Piece | Role |
|---|---|
| `data/parlays.baseline.json` | Always written by `build_predictions` as the **pre-corrections** document (byte-stable under OFF). |
| `data/parlays.json` | Served “active” document (baseline while OFF; may be adjusted only if future `on` approved). |
| `data/corrections_serving.json` | Tiny controller: `{ "version": 1, "mode": "off"\|"shadow"\|"on", "updated_utc": "…", "baseline_path": "/data/parlays.baseline.json", "active_path": "/data/parlays.json" }`. **Default deny: `mode=off`.** |

**Controller location / update channel**

- **Location:** committed file under `data/` (same origin as parlays).
- **Update channel:** GitHub Actions `workflow_dispatch` (and/or config change on the pipeline) that commits **only** the flag (and optionally copies baseline→active) then Netlify auto-deploys. No Vercel dependency for NFL OFF.
- **Fail-closed:** missing/malformed/unreadable flag ⇒ treat as **`off`** and prefer baseline path; never invent `on`.

**Request/render checks (future client; not built now)**

1. Load `corrections_serving.json` first (or in parallel with short timeout).
2. If `mode !== "on"` ⇒ render from **baseline** artifact (or active if it is known-equal to baseline).
3. If flag fetch fails ⇒ **baseline / off** (fail-closed).
4. Never treat a successful flag fetch as proof that other tabs/devices complied.

**Disable new corrections vs restore already published**

| Goal | R1 action | Bound |
|---|---|---|
| Disable **new** baking | Set NFL `corrections_mode=off` + flag `mode=off`; next build writes baseline into both files | Next pipeline |
| Restore **published** adjusted `parlays.json` | Fast path: commit `parlays.json := parlays.baseline.json` (or last known baseline) + flag `off` via dispatch | Netlify deploy + SWR/TTL as above |
| Restore **in-memory / already-painted** UI | Requires client re-fetch after deploy; **cannot** force offline/stale clients | Soft bound only |
| Engine-side disable | Separate Vercel env + redeploy | Independent; insufficient alone |

**Why this is “smallest” under current stack:** uses only git + Netlify already in place; no Edge Config purchase; no new origin; SW stays non-caching. Still **not instant** and **not universal**.

---

## Alternatives (not recommended as first step / or blocked)

| ID | Idea | Pros | Cons / blocker |
|---|---|---|---|
| R0 | Status quo: OFF config + full rebuild+publish | Zero new files | Slowest restore; easy to forget pairs/sidecar discipline |
| R2 | Netlify Edge / Blobs / Edge Config flag | Faster flag flip without republishing parlays bytes | **New infra**; still cannot fix offline clients; needs auth/ops |
| R3 | Browser polls engine health / corrections mode | Couples NFL UI to engine | Wrong dependency; fails closed poorly if engine down; still no offline revoke |
| R4 | Service worker intercept rewrite | Could swap responses | **Conflicts** with deliberate non-caching SW; high risk of stale-shell regressions (`sw.js` history) |
| R5 | Long-cache bust via renamed hashes | Stronger cache bust | Build-step / filename policy change; larger than needed |

---

## Guarantees you **cannot** make

- Instant global revoke of adjusted numbers.
- Control of clients with open tabs that do not re-fetch.
- Control of users who saved JSON / screenshots / third-party mirrors.
- That engine OFF alone restores Netlify content.
- That `max-age=0` + SWR120 means “all clients update within 120s” (SWR allows serving stale while revalidating; in-memory TTL can delay; deploy lag dominates).

Offline simulation tests in this draft **model** TTL/SWR/flag fail-closed behavior in-process only — **not** deployed verification.

---

## Decision / permissions needed before any implementation

1. **Jimmy:** approve architecture option (recommend **R1**) or choose R0/R2+.
2. **Jimmy:** confirm default-deny remains until explicit `on`.
3. **Eleanor / ops:** who may run the emergency `workflow_dispatch` (flag + baseline restore) on **upstream** `liddar12/NFL2026` (not fork cosplay).
4. **Explicit non-activation:** no secrets, no Netlify/Vercel changes, no Edge products in this draft phase.
5. Fresh **Beta review** on any new head that implements R1.

---

## Mapping to today’s OFF (already true)

Until R1 exists: emergency path remains rebuild under `corrections_mode=off`, optional `restore_parlays_from_pairs` offline helper, git restore of `data/parlays.json`, publish to `main`. Propagation = pipeline + Netlify + SWR/TTL — **minutes, not seconds**.
