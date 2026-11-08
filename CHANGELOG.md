# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Common Changelog](https://common-changelog.org/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Distinguish ESPN `didNotPlay` roster observations from official inactive confirmation; empty team lists stay coverage-unknown (never all-active); `build_weekly.inactive_ids` / `this_week_gate` no longer bind unconfirmed DNP as `playable:false`; confirmed-required MY-prop refusals stamp via `confirmation_offer_refusal` → `recommendation_eligibility` (real offer path through `playable_this_week` / `prop_legs`) without rewriting forecasts, locks, or week points
- Ordinary home-field Elo and weather/venue binding share conservative neutral treatment: explicit True, malformed, and conflicting snake/camel flags all zero HFA and refuse ordinary venue weather; absent/False keep ordinary HFA
- Stop joining Polymarket season-series/futures titles onto schedule games as single-game moneylines; require matchup title + event/date binding; retain `display_only`
- Draft lock-byte proof uses verifiable `GITHUB_BASE_SHA` / merge-base (fail if unavailable); integrated upstream pin `35a6c8b…` is an ordinary merge ancestor of this draft
