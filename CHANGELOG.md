# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Common Changelog](https://common-changelog.org/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Distinguish ESPN `didNotPlay` roster observations from official inactive confirmation; empty team lists stay coverage-unknown (never all-active); `build_weekly.inactive_ids` / `this_week_gate` no longer bind unconfirmed DNP as `playable:false`; confirmed-required MY-prop refusals stamp via `confirmation_offer_refusal` → `recommendation_eligibility` (real offer path through `playable_this_week` / `prop_legs` / `atd_legs`) without rewriting forecasts, locks, or week points
- `confirmation_offer_refusal` fail-closes on missing week/game/kickoff/clock/espn-id (explicit `eligible:false`); returns `None` only for intended provisional/confirmed_active offers
- Confirmation refusal stamps carry required `source_updated_utc` and validate under `player_weekly.schema.json` (`reason=confirmation_required`, `source=inactive_confirmation`, optional `state` / `require_confirmed`); post-T90 generated weekly docs with stamps pass schema without weakening injury eligibility or promoting ESPN DNP to official
- Ordinary home-field Elo and weather/venue binding share conservative neutral treatment: explicit True, malformed, and conflicting snake/camel flags all zero HFA and refuse ordinary venue weather; absent/False keep ordinary HFA
- Stop joining Polymarket season-series/futures titles onto schedule games as single-game moneylines; require matchup title + event/date binding; retain `display_only`
- Draft lock-byte proof requires a real `commit` ancestor for `GITHUB_BASE_SHA` / merge-base (rejects nonexistent 40-hex, blob, tree); integrated upstream pin `9e4af833…` is an ordinary merge ancestor of this draft
