# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Common Changelog](https://common-changelog.org/).
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Default-off SelfLearning shadow-capture workflow (`.github/workflows/selflearning-shadow-capture.yml`) gated on pilot `enabled`, with offline served-forecast invariance tests and wiring report under `docs/pilot/`.
- Default-off NFL parlay corrections boundary (`config/parlay_selflearn_corrections.json`, `scripts/parlay_selflearn_corrections.py`) validated read-only against SelfLearning PR #13, with conformance tests, capture-contract inventory, and switch/redeploy facts (engine Vercel env ≠ instant; NFL OFF bypasses network and clears pairs without engine). Caps pending Jimmy; no live calls.
- Draft design docs only: provenance-chain eligibility (600 ledger resolves explicitly ineligible; no backfill) and rapid-disable/baseline-restore architecture options under Netlify/Actions, plus offline simulation tests (not deployed verification).
- R1 draft serving triad (still default-OFF): `data/parlays.baseline.json` + `data/parlays.json` + `data/corrections_serving.json`, `app/parlay-serving.js` fail-closed resolver, `getParlays` wired through it, builder `publish_parlay_artifacts` / `emergency_restore_active_from_baseline`. Not an activation.

### Changed

- Corrections consumer retargeted to engine pin `5941214178254df38a1c67b5935e591bfb052e33` (`market|selection` segments + exact `ELIGIBILITY_RULES`). MB1: missing required legs hard-fail; partial parlay/leg apply consistency hard-fail. Env `NFL_PARLAY_CORRECTIONS_MODE` is OFF-only (never elevates). Legacy incomplete public_artifact reject retained. Floors/date/provenance gates not weakened.
- `scripts/pilot_capture.py` shadow/pin guard no longer requires `enabled=false` (workflow owns the enable gate); committed pilot config remains disabled.
- `scripts/publish_data.sh` logs the resolved retry budget so the R88 reject-path test locks `PUBLISH_BACKOFF_S=0` without a brittle wall-clock check.
