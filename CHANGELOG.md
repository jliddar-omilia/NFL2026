# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Common Changelog](https://common-changelog.org/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Distinguish ESPN `didNotPlay` roster observations from official inactive confirmation; empty team lists stay coverage-unknown (never all-active); `build_weekly.inactive_ids` / `this_week_gate` no longer bind unconfirmed DNP as `playable:false`; confirmed-required MY-prop refusals stamp via `confirmation_offer_refusal` → `recommendation_eligibility` (real offer path through `playable_this_week` / `prop_legs` / `atd_legs`) without rewriting forecasts, locks, or week points
- `confirmation_offer_refusal` fail-closes on missing week/game/kickoff/clock/espn-id (explicit `eligible:false`); returns `None` only for intended provisional/confirmed_active offers
- Confirmation refusal stamps carry required `source_updated_utc` and validate under `player_weekly.schema.json` (`reason=confirmation_required`, `source=inactive_confirmation`, optional `state` / `require_confirmed`); post-T90 generated weekly docs with stamps pass schema without weakening injury eligibility or promoting ESPN DNP to official
- Refuse observation-only `this_week.reason=inactive` as an official-list claim (requires confirmed complete list + `confirmation=confirmed`); reject forged `eligibility.state` confirmed_inactive/active without binding evidence; UI `gateTag` emits INACTIVE/posted-list copy only when `confirmation=confirmed`; eligibility-backed fail-closed week zeroes may explain `avail:false` without inventing points; live-readiness lock/hash proof fetches documented exact commit objects without bypassing type/ancestor checks
- Draft-only nine-gate weekly transition on pin `4bd7` (prior evidence tip `ce53725d`, not current-base clearance): remove unsupported observation `reason=inactive` for nine players; convert three ESPN-feed OUT labels to honest `reason=status` (per-row evidence/confidence remain null); six others drop `this_week` and stamp eligibility `unknown_or_stale`; retain `avail:false`/`pts:0`
- Current-base draft on verified upstream `b849f81…`: honesty source/contracts plus seventeen observation-inactive label transitions on current weekly only (7 NOT_PLAYABLE → `reason=status`; 10 → eligibility `unknown_or_stale` including Q rows); model inactive 17→0, status 28→35, gated 59→49; retain zeroes/exclusions; no fabricated confirmed status; no protected cards/history/scores/probability rewrite
- Reconcile eligibility-backed fail-closed week zeroes across validator, schema, `availability.test.mjs`, and `weekly_contract.test.mjs` (confirmation_required + concrete week may explain one `avail:false` without inventing `availability{}` or official inactive); forged `confirmed_*` without binding evidence still reds — not test suppression
- Ordinary home-field Elo and weather/venue binding share conservative neutral treatment: explicit True, malformed, and conflicting snake/camel flags all zero HFA and refuse ordinary venue weather; absent/False keep ordinary HFA
- Stop joining Polymarket season-series/futures titles onto schedule games as single-game moneylines; require matchup title + event/date binding; retain `display_only`
- Draft lock-byte proof requires a real `commit` ancestor for `GITHUB_BASE_SHA` / merge-base (rejects nonexistent 40-hex, blob, tree); integrated upstream pin `9e4af833…` is an ordinary merge ancestor of this draft
