# Capture contract inventory (offline verify) — 2026-11-06

**Scope:** draft prep only. Engine owner FYI reportedly at commit `aacb19c` (not in this
repo; **engine source not independently re-read here**). All checks below are **offline**
against `scripts/export_learning.py` and related NFL draft wiring. **No** live ingest,
secrets, merge, deploy, or upstream PR.

Evidence: independently recomputed fingerprint vectors; static inspection of exporter
routes/headers/limits; grep for outcome producers. Claimed engine hashes treated as
unverified claims until recomputed — they matched.

---

## Fingerprint (recomputed; all three MATCH claimed vectors)

Canonical form:
`sha256:` + `sha256(json.dumps(value, sort_keys=True, separators=(',',':'), ensure_ascii=True, allow_nan=False).encode('utf-8'))`

| Input | Encoded bytes | Digest (hex after `sha256:`) |
|---|---|---|
| `null` | `null` | `74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b` |
| `{b:1,a:2}` | `{"a":2,"b":1}` | `d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772` |
| `{x:'é'}` | `{"x":"\u00e9"}` | `bca462b835df0d11fbe295ae8e0bfb14f010da4801c954734d1801e1a07400a9` |

Python numeric repr / key sort / `\uXXXX` escapes matter. Locked by
`tests/feature/export_learning_fingerprint.test.mjs`.

---

## Objects / generations — NFL exporter vs FYI

| Contract item | NFL `export_learning` | Status |
|---|---|---|
| Auth: Bearer `SELFLEARN_NFL_INGEST_TOKEN` | Yes (`--send` only) | aligned |
| Token ≥32 chars | **No** — only non-empty printable ASCII ≤8192 | **GAP** |
| Disallow placeholder tokens | **Not coded** | **GAP** |
| Token uniqueness across roles | Engine-config only; NFL must never read other tokens to check | **N/A / cannot verify** |
| No `Origin` header on POST | `Authorization` + `Content-Type` + `Accept` only | aligned |
| Max body 3 MiB | `MAX_BODY_BYTES = 3*1024*1024` | aligned |
| Max JSON depth 24 | `MAX_JSON_DEPTH = 24` | aligned |
| Reject duplicate JSON keys | `object_pairs_hook` → `duplicate_json_key` (ExportError not collapsed) | aligned (client parse) |
| Reject NUL / NaN / Inf | nonfinite refused; NUL via invalid UTF-8/JSON path | aligned (client parse) |
| Engine store timeout 12s / request | Client default **`timeout=20`** | **GAP** (consumer should be ≤12) |
| Engine `maxDuration` 60 | Vercel/engine side; not NFL client | **engine-owned** |
| `POST /api/v1/nfl/objects` exact keys `{version,kind,object_id,payload}` | `_request` builds exactly those four | aligned |
| `version` int `1` | yes | aligned |
| `kind` `source_snapshot` \| `generation` | yes | aligned |
| `object_id` `sha256:` + 64 lower hex | `HASH` regex | aligned |
| source_snapshot ID = fingerprint(payload) | plan checks | aligned |
| generation: `envelope_id == object_id` and ID = fingerprint(payload minus envelope_id) | plan checks | aligned |
| Upload alone does not finalize membership | generations POST is separate membership step | aligned (intent) |
| Object ACK `{version,object_id,durable:true,status:recorded\|duplicate}` | `_validate_ack` | aligned |
| `POST /api/v1/nfl/generations` exact `{version:1,object_id}` | deliver body | aligned |
| week 1..18 | enforced in plan | aligned |
| source joins exact; `publication_status generated_unverified` | **not validated in exporter** | **GAP / engine-side?** |
| Generation ACK receipts/rejections shape | validated | aligned |
| Retries replay original result (cached ACK), not adapter rerun | outbox/acks immutable cache | aligned (NFL side) |
| Manifest `generation_id` hashes `MANIFEST_KEYS` only | yes, local tuple | **provisional** |
| Exact `MANIFEST_KEYS` + envelope/source schemas from engine | NFL uses local: `version,season,week,pool_generated_utc,source_snapshots,offered_cards,selection_policy_version,joint_model_version` | **NOT SUPPLIED by engine FYI — do not declare full schema conformance** |
| HTTP 401/413/415/422/409/503 mapping | client maps non-2xx to `http_NNN` (no body echo); semantic fail-closed is engine | **partial** — status codes not specially named beyond generic |
| Base URL | workflow hardcodes beige host | **unconfirmed with owner** |

---

## Outcome routes — distinct token; NFL must not invent

| Contract item | NFL today | Status |
|---|---|---|
| `SELFLEARN_NFL_OUTCOME_INGEST_TOKEN` | **not issued**; no reader in repo producers | absent |
| `POST /api/v1/nfl/capture-chunks` exact keys | **no producer** | **GAP — do not invent** |
| Staging returns `learning_accepted:false`, `durable_ack:false` ≠ training accept | N/A until producer exists | document-only warning |
| `POST /api/v1/nfl/capture-deliveries` exact keys + identity tuple hash | **no producer**; destination/producer/envelope/raw_pointers schemas **missing** | **GAP — do not invent** |
| `GET /api/v1/nfl/capture-deliveries/{delivery_id}` | none | **GAP** |

---

## Precise remaining gaps (inventory)

1. **Engine commit `aacb19c` not present in this checkout** — FYI text only; cannot diff engine handlers.
2. **Exact MANIFEST_KEYS / envelope / source_snapshot payload schemas** still not supplied by engine — NFL local list is provisional; **do not claim full conformance**.
3. **`publication_status: generated_unverified`** and “source joins exact” not asserted in NFL exporter.
4. **Ingest token ≥32 + placeholder ban** not enforced in `export_learning.send`.
5. **HTTP client timeout 20s vs engine store 12s**.
6. **Base URL unconfirmed**.
7. **Outcome chunk/delivery identity tuple, destination_id, producer_id, envelope schemas** missing — **no NFL outcome producer** may invent them.
8. **Role-token uniqueness** is engine-config; NFL must never open other secrets to verify.
9. **No live engine journal / graded fit** yet (owner) — Saturday honest `applied=false`.
10. Capture pilot remains **`enabled=false`**; corrections **`corrections_mode=off`**.

---

## Explicit non-actions this run

No live POSTs, no secret creation, no merge to `main`, no Netlify/Vercel deploy, no upstream PR, no ready-for-review, no accuracy claims.
