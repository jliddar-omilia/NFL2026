# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Common Changelog](https://common-changelog.org/).
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Default-off SelfLearning shadow-capture workflow (`.github/workflows/selflearning-shadow-capture.yml`) gated on pilot `enabled`, with offline served-forecast invariance tests and wiring report under `docs/pilot/`.

### Changed

- `scripts/pilot_capture.py` shadow/pin guard no longer requires `enabled=false` (workflow owns the enable gate); committed pilot config remains disabled.
- `scripts/publish_data.sh` logs the resolved retry budget so the R88 reject-path test locks `PUBLISH_BACKOFF_S=0` without a brittle wall-clock check.
