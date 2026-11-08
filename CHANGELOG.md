# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Common Changelog](https://common-changelog.org/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Distinguish ESPN `didNotPlay` roster observations from official inactive confirmation; empty team lists stay coverage-unknown (never all-active); recommendation eligibility requiring confirmation fails closed without rewriting forecasts or locks
- Skip ordinary home-field Elo when ESPN `neutralSite` is explicitly true; keep designated home/away labels; leave weather unbound without a reviewed venue profile
- Stop joining Polymarket season-series/futures titles onto schedule games as single-game moneylines; require matchup title + event/date binding; retain `display_only`
