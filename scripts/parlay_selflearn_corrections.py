#!/usr/bin/env python3
"""NFL consumer boundary for SelfLearning parlay corrections (default OFF).

Validated read-only against engine draft:
  PR https://github.com/liddar12/SelfLearning/pull/13
  head 5941214178254df38a1c67b5935e591bfb052e33
  (segments keyed market|selection; full public_artifact provenance keys)

Server-side only: POST /api/v1/nfl/corrections with Bearer
SELFLEARN_NFL_CORRECTIONS_TOKEN. NEVER reads that token when
corrections_mode=off, NEVER places secrets in logs, NEVER invents a fitted
artifact. No genuine fitted artifact is verified in this repo — no-data stays
baseline. Digests are content-address, not authenticity.

NFL kill switch (distinct from engine Vercel SELFLEARN_CORRECTIONS_MODE):
  config/parlay_selflearn_corrections.json → corrections_mode: off|shadow|on
  env NFL_PARLAY_CORRECTIONS_MODE may force OFF only (never elevate).

Modes (NFL consumer):
  off    — no network; active serving = baseline; retain pairs audit lineage.
  shadow — may POST; engine contract echoes baselines (applied=false); NFL
           never serves adjusted model_prob.
  on     — serve applied adjustments only after full validation + separate
           activation approval (not this draft).

R1 same-stack publish (draft): parlays.baseline.json + parlays.json (active) +
corrections_serving.json bound by run_id / content ids. Default flag mode=off.
Fail-closed client never serves adjusted active when flag/baseline invalid.
SWR120 is NOT a global restoration upper bound; offline/open tabs are unbounded.

Engine mode is a Vercel env var and requires redeploy — NOT an instant kill.
NFL OFF must not depend on engine reachability.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config" / "parlay_selflearn_corrections.json"
CORRECTIONS_PATH = "/api/v1/nfl/corrections"
TOKEN_ENV = "SELFLEARN_NFL_CORRECTIONS_TOKEN"
MODE_ENV = "NFL_PARLAY_CORRECTIONS_MODE"
BASELINE_NAME = "parlays.baseline.json"
ACTIVE_NAME = "parlays.json"
SERVING_FLAG_NAME = "corrections_serving.json"
PAIRS_AUDIT_NAME = "parlay_corrections_pairs.audit.json"
BASELINE_URL = "/data/parlays.baseline.json"
ACTIVE_URL = "/data/parlays.json"
SERVING_FLAG_URL = "/data/corrections_serving.json"

# Pinned from SelfLearning PR #13 head (read-only verify; not a live deploy pin).
ENGINE_CONTRACT_PR = "https://github.com/liddar12/SelfLearning/pull/13"
ENGINE_CONTRACT_HEAD = "5941214178254df38a1c67b5935e591bfb052e33"
ENGINE_METHOD = "market_bias_shrinkage_v1"
ENGINE_MODEL_VERSION = "corrections_v1"

# Engine HARD_* are probability units (0.03 == 3 percentage points).
HARD_LEG_CAP_PP = 0.03
HARD_PARLAY_CAP_PP = 0.03
HARD_PARLAY_CAP_REL = 0.15
HARD_CLAMP = (0.01, 0.99)
MIN_GRADED_TOTAL = 200
MIN_GRADED_PER_MARKET = 50

REQUEST_KEYS = frozenset({
    "schema_version", "request_id", "season", "week", "baseline_model_version",
    "generated_at", "legs", "parlays",
})
LEG_KEYS = frozenset({"leg_id", "game_id", "market", "selection", "baseline_prob"})
PARLAY_KEYS = frozenset({"parlay_id", "leg_ids", "baseline_prob"})
# Exact canon from engine pin 5941214… — reject empty/fake rule lists.
ELIGIBILITY_RULES = (
    "served_at_before_kickoff",
    "exclude_push_void",
    "exclude_after_trained_through",
    "baseline_prob_as_served_in_(0,1)",
    "binary_outcome_only",
    "segment_market_and_selection",
)
# Legacy incomplete HTTP public shape (pre-5941214) — retain reject regression.
LEGACY_INCOMPLETE_PUBLIC_KEYS = (
    "artifact_id", "model_version", "method", "trained_through", "fitted_at",
    "expires_at", "n_graded", "source",
)
# Current engine public_artifact (pin 5941214…) — still NOT authenticity proof.
ARTIFACT_PUBLIC_KEYS = (
    "artifact_id", "model_version", "method", "trained_through", "fitted_at",
    "expires_at", "n_graded", "source", "eligibility_rules", "fit_inputs_hash",
    "prior_strength", "min_graded_total", "min_graded_per_market", "leg_cap_pp",
    "parlay_cap_pp", "parlay_cap_rel", "clamp", "segments", "sufficient_total",
)
# Apply requires the full public provenance set (floors not weakened).
ARTIFACT_APPLY_EVIDENCE_KEYS = ARTIFACT_PUBLIC_KEYS

MODES = frozenset({"off", "shadow", "on"})
HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


class CorrectionsError(ValueError):
    """Safe machine reason; never includes tokens or response bodies."""


def _need(cond, reason):
    if not cond:
        raise CorrectionsError(reason)


def _parse_utc(value):
    if not isinstance(value, str) or not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError:
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc)


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _open_unit(value):
    return _finite(value) and 0.0 < float(value) < 1.0


def read_config(path=None, environment=None):
    path = Path(path or CONFIG_PATH)
    environment = os.environ if environment is None else environment
    raw = json.loads(path.read_text(encoding="utf-8"))
    _need(isinstance(raw, dict) and raw.get("version") == 1, "config_refused")
    mode = raw.get("corrections_mode")
    override = environment.get(MODE_ENV)
    # Emergency override is OFF-only. Env must never elevate to on/shadow.
    # Activation requires committed config corrections_mode=on (+ separate approval).
    if override == "off":
        mode = "off"
    _need(mode in MODES, "config_mode_refused")
    timeout = raw.get("consumer_timeout_s", 4)
    _need(_finite(timeout) and 0 < float(timeout) <= 8, "config_timeout_refused")
    leg_cap = float(raw.get("proposed_leg_cap_pp_max", HARD_LEG_CAP_PP))
    parlay_cap = float(raw.get("proposed_parlay_cap_pp_max", HARD_PARLAY_CAP_PP))
    _need(0 < leg_cap <= HARD_LEG_CAP_PP, "config_leg_cap_refused")
    _need(0 < parlay_cap <= HARD_PARLAY_CAP_PP, "config_parlay_cap_refused")
    return {
        "version": 1,
        "corrections_mode": mode,
        "consumer_timeout_s": float(timeout),
        "endpoint_path": raw.get("endpoint_path") or CORRECTIONS_PATH,
        "base_url": raw.get("base_url"),
        "schema_version": int(raw.get("schema_version") or 1),
        "proposed_leg_cap_pp_max": leg_cap,
        "proposed_parlay_cap_pp_max": parlay_cap,
        "proposed_parlay_cap_relative": float(raw.get("proposed_parlay_cap_relative", HARD_PARLAY_CAP_REL)),
        "proposed_applied_prob_min": float(raw.get("proposed_applied_prob_min", HARD_CLAMP[0])),
        "proposed_applied_prob_max": float(raw.get("proposed_applied_prob_max", HARD_CLAMP[1])),
        "proposed_min_graded_legs_overall": int(raw.get("proposed_min_graded_legs_overall", MIN_GRADED_TOTAL)),
        "proposed_min_graded_legs_per_market": int(raw.get("proposed_min_graded_legs_per_market", MIN_GRADED_PER_MARKET)),
        "engine_method": raw.get("engine_method") or ENGINE_METHOD,
        "engine_contract_head": raw.get("engine_contract_head") or ENGINE_CONTRACT_HEAD,
        "engine_contract_pr": raw.get("engine_contract_pr") or ENGINE_CONTRACT_PR,
        "caps_status": raw.get("caps_status", "pending_jimmy_decision"),
        "contract_status": raw.get("contract_status", "provisional"),
    }


def stable_leg_id(season, week, leg):
    """Deterministic NFL leg id. Not a learned artifact."""
    game_id = leg.get("game_id") or ""
    market = leg.get("market") or ""
    selection = leg.get("selection") or ""
    return "%s:%s:%s:%s:%s" % (int(season), int(week), game_id, market, selection)


def _request_id(payload):
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                       ensure_ascii=True, allow_nan=False).encode("utf-8")).hexdigest()
    return "sha256:" + digest


def build_request(parlays_doc, *, baseline_model_version, generated_at, request_id=None):
    _need(isinstance(parlays_doc, dict), "baseline_doc_malformed")
    season, week = parlays_doc.get("season"), parlays_doc.get("week")
    _need(isinstance(season, int) and isinstance(week, int), "baseline_period_malformed")
    _need(1 <= int(week) <= 22, "baseline_week_out_of_range")
    _need(isinstance(baseline_model_version, str) and baseline_model_version, "baseline_model_version_required")
    _need(_parse_utc(generated_at) is not None, "generated_at_invalid")
    legs, parlays, seen = [], [], set()
    for card in parlays_doc.get("parlays") or []:
        _need(isinstance(card, dict) and isinstance(card.get("parlay_id"), str), "parlay_malformed")
        leg_ids = []
        model = 1.0
        for leg in card.get("legs") or []:
            _need(isinstance(leg, dict), "leg_malformed")
            game_id = leg.get("game_id")
            market = leg.get("market")
            selection = leg.get("selection")
            _need(isinstance(game_id, str) and game_id, "game_id_required")
            _need(isinstance(market, str) and market, "market_required")
            _need(isinstance(selection, str) and selection, "selection_required")
            lid = stable_leg_id(season, week, leg)
            prob = leg.get("model_prob")
            _need(_open_unit(prob), "baseline_prob_not_open_unit")
            if lid not in seen:
                seen.add(lid)
                legs.append({
                    "leg_id": lid,
                    "game_id": game_id,
                    "market": market,
                    "selection": selection,
                    "baseline_prob": float(prob),
                })
            leg_ids.append(lid)
            model *= float(prob)
        parlays.append({
            "parlay_id": card["parlay_id"],
            "leg_ids": leg_ids,
            "baseline_prob": float(model),
        })
    _need(legs, "legs_required")
    body = {
        "schema_version": 1,
        "season": season,
        "week": week,
        "baseline_model_version": baseline_model_version,
        "generated_at": generated_at,
        "legs": legs,
        "parlays": parlays,
    }
    body["request_id"] = request_id or _request_id({k: body[k] for k in body if k != "request_id"})
    _need(set(body) == REQUEST_KEYS, "request_shape_mismatch")
    for row in body["legs"]:
        _need(set(row) == LEG_KEYS, "leg_shape_mismatch")
    for row in body["parlays"]:
        _need(set(row) == PARLAY_KEYS, "parlay_shape_mismatch")
    return body


def _base_url(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/") or any(c.isspace() for c in value)):
            raise ValueError()
        host = parsed.hostname.lower()
        return "https://" + host + ((":" + str(parsed.port)) if parsed.port not in (None, 443) else "")
    except (ValueError, TypeError, AttributeError):
        raise CorrectionsError("invalid_https_base_url") from None


def _token_ok(token):
    return (isinstance(token, str) and len(token) >= 32 and len(token) <= 8192
            and all(0x21 <= ord(c) <= 0x7e for c in token))


def default_transport(url, body, headers, timeout):
    request = urllib.request.Request(url, data=body, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(3 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        return status, b""


def _same_prob(a, b, eps=1e-12):
    return _finite(a) and _finite(b) and abs(float(a) - float(b)) <= eps


def segment_key(market, selection):
    """Engine pin 5941214… segment identity: market|selection (case-sensitive text)."""
    _need(isinstance(market, str) and market, "segment_market_invalid")
    _need(isinstance(selection, str) and selection, "segment_selection_invalid")
    return "%s|%s" % (market, selection)


def pr13_public_artifact_shape(artifact):
    """True for LEGACY incomplete public shape (pre-5941214) — apply-insufficient."""
    return isinstance(artifact, dict) and set(artifact.keys()) == set(LEGACY_INCOMPLETE_PUBLIC_KEYS)


def legacy_incomplete_artifact_shape(artifact):
    return pr13_public_artifact_shape(artifact)


def _validate_artifact_public(artifact, *, now, generated_at):
    """Minimal public fields (shadow echo / display). Not sufficient to apply."""
    _need(isinstance(artifact, dict), "artifact_missing")
    for key in ARTIFACT_PUBLIC_KEYS:
        _need(key in artifact, "artifact_incomplete")
    _need(isinstance(artifact["artifact_id"], str) and HASH_RE.match(artifact["artifact_id"]),
          "artifact_id_invalid")
    # Content-address digest is NOT a signature / authenticity proof.
    _need(artifact.get("method") == ENGINE_METHOD, "artifact_method_mismatch")
    _need(isinstance(artifact["n_graded"], int) and artifact["n_graded"] >= 0, "artifact_n_graded_invalid")
    trained = _parse_utc(artifact["trained_through"])
    fitted = _parse_utc(artifact["fitted_at"])
    expires = _parse_utc(artifact["expires_at"])
    generated = _parse_utc(generated_at)
    now_dt = _parse_utc(now)
    _need(None not in (trained, fitted, expires, generated, now_dt), "artifact_timestamps_invalid")
    # Intended ordering; incomplete engine guarantees are still enforced locally.
    _need(trained <= fitted, "artifact_trained_after_fitted")
    _need(fitted <= expires, "artifact_fitted_after_expires")
    _need(fitted <= now_dt, "artifact_fitted_in_future")
    _need(trained <= generated, "artifact_trained_after_request")
    _need(now_dt < expires, "artifact_expired")
    return artifact


def _validate_artifact_for_apply(artifact, *, now, generated_at, request_legs, applied_leg_rows, config):
    """Strict apply gate against engine pin 5941214…. Do not relax floors.

    Digests/fit_inputs_hash are content-address only — NOT authenticity or journal
    integrity. Legacy incomplete public shapes must still fail here.
    """
    if legacy_incomplete_artifact_shape(artifact):
        raise CorrectionsError("artifact_missing_apply_evidence")
    _validate_artifact_public(artifact, now=now, generated_at=generated_at)
    missing = [key for key in ARTIFACT_APPLY_EVIDENCE_KEYS if key not in artifact]
    _need(not missing, "artifact_missing_apply_evidence")
    _need(isinstance(artifact.get("fit_inputs_hash"), str)
          and HASH_RE.match(artifact["fit_inputs_hash"]), "artifact_fit_inputs_hash_invalid")
    _need(isinstance(artifact["sufficient_total"], bool), "artifact_sufficient_total_invalid")
    _need(isinstance(artifact["min_graded_total"], int)
          and artifact["min_graded_total"] >= MIN_GRADED_TOTAL, "artifact_min_total_invalid")
    _need(isinstance(artifact["min_graded_per_market"], int)
          and artifact["min_graded_per_market"] >= MIN_GRADED_PER_MARKET,
          "artifact_min_market_invalid")
    rules = artifact.get("eligibility_rules")
    _need(isinstance(rules, list) and tuple(rules) == ELIGIBILITY_RULES,
          "artifact_eligibility_rules_mismatch")
    _need(artifact["sufficient_total"] is True, "insufficient_graded_data")
    _need(artifact["n_graded"] >= max(config["proposed_min_graded_legs_overall"],
                                      artifact["min_graded_total"]),
          "insufficient_overall_graded")
    _need(_finite(artifact.get("leg_cap_pp"))
          and 0 < float(artifact["leg_cap_pp"]) <= HARD_LEG_CAP_PP + 1e-15,
          "artifact_leg_cap_invalid")
    _need(_finite(artifact.get("parlay_cap_pp"))
          and 0 < float(artifact["parlay_cap_pp"]) <= HARD_PARLAY_CAP_PP + 1e-15,
          "artifact_parlay_cap_invalid")
    _need(_finite(artifact.get("parlay_cap_rel"))
          and 0 < float(artifact["parlay_cap_rel"]) <= HARD_PARLAY_CAP_REL + 1e-15,
          "artifact_parlay_cap_rel_invalid")
    _need(_finite(artifact.get("prior_strength")) and float(artifact["prior_strength"]) > 0,
          "artifact_prior_strength_invalid")
    clamp = artifact.get("clamp")
    _need(isinstance(clamp, list) and clamp == list(HARD_CLAMP), "artifact_clamp_mismatch")
    _need(artifact.get("model_version") == ENGINE_MODEL_VERSION, "artifact_model_version_mismatch")
    segments = artifact["segments"]
    _need(isinstance(segments, dict) and segments, "artifact_segments_missing")
    # Optional integrity: n_graded should equal sum of segment n_eligible when present.
    try:
        seg_sum = sum(int(row.get("n_eligible") or 0) for row in segments.values()
                      if isinstance(row, dict))
        _need(seg_sum == artifact["n_graded"], "artifact_n_graded_segment_sum_mismatch")
    except (TypeError, ValueError):
        raise CorrectionsError("artifact_segments_missing") from None
    req_by_id = {row["leg_id"]: row for row in request_legs}
    for row in applied_leg_rows:
        if not row["applied"]:
            continue
        req = req_by_id[row["leg_id"]]
        key = segment_key(req["market"], req["selection"])
        seg = segments.get(key)
        # Wrong-selection / market-only key must not inherit another segment.
        _need(isinstance(seg, dict), "insufficient_segment_evidence")
        _need("|" in key and key.split("|", 1)[1] == req["selection"], "segment_selection_mismatch")
        floor = max(config["proposed_min_graded_legs_per_market"], artifact["min_graded_per_market"])
        _need(isinstance(seg.get("n_eligible"), int) and seg["n_eligible"] >= floor,
              "insufficient_segment_data")
        _need(seg.get("eligible_for_application") is True, "segment_not_eligible")
        _need(bool(seg.get("eligible_for_application"))
              == (seg["n_eligible"] >= artifact["min_graded_per_market"]),
              "segment_eligibility_flag_inconsistent")
        _need(_finite(seg.get("delta")), "segment_delta_invalid")
    return artifact


def _cap_ok(baseline, adjusted, *, cap_pp_max, relative_max=None):
    """cap_pp_max is probability units (0.03 == 3pp), matching engine HARD_*."""
    delta = abs(float(adjusted) - float(baseline))
    if delta - cap_pp_max > 1e-9:
        return False
    if relative_max is not None and float(baseline) > 0:
        if delta - relative_max * float(baseline) > 1e-9:
            return False
    return True


def _clamp_applied(adjusted, lo, hi):
    value = float(adjusted)
    if value < lo:
        return lo, True
    if value > hi:
        return hi, True
    return value, False


def validate_response(response, request, config, *, now):
    _need(isinstance(response, dict), "response_not_object")
    _need(response.get("schema_version") == 1, "schema_version_mismatch")
    _need(response.get("request_id") == request["request_id"], "request_id_mismatch")
    mode = response.get("corrections_mode")
    _need(mode in MODES, "engine_mode_invalid")

    req_legs = {row["leg_id"]: row for row in request["legs"]}
    req_parlays = {row["parlay_id"]: row for row in request["parlays"]}
    _need(len(req_legs) == len(request["legs"]), "request_duplicate_legs")
    _need(len(req_parlays) == len(request["parlays"]), "request_duplicate_parlays")

    legs = response.get("legs")
    parlays = response.get("parlays")
    _need(isinstance(legs, list) and isinstance(parlays, list), "response_collections_invalid")

    seen_legs, seen_parlays = set(), set()
    leg_rows, parlay_rows = [], []
    for row in legs:
        _need(isinstance(row, dict), "leg_row_malformed")
        lid = row.get("leg_id")
        _need(isinstance(lid, str), "leg_id_malformed")
        if lid in seen_legs:
            raise CorrectionsError("duplicate_leg_id")
        seen_legs.add(lid)
        if lid not in req_legs:
            raise CorrectionsError("unknown_leg_id")
        baseline = req_legs[lid]["baseline_prob"]
        _need(_same_prob(row.get("baseline_prob"), baseline), "baseline_echo_mismatch")
        adjusted = row.get("adjusted_prob")
        applied = row.get("applied")
        delta = row.get("delta")
        _need(isinstance(applied, bool), "applied_not_bool")
        _need(_finite(adjusted) and _finite(delta), "nonfinite_adjustment")
        # Engine contract: shadow/off always echo baseline with applied=false.
        if mode in ("off", "shadow"):
            _need(applied is False, "shadow_or_off_must_not_apply")
            _need(_same_prob(adjusted, baseline), "applied_false_must_echo_baseline")
            _need(abs(float(delta)) <= 1e-12, "applied_false_delta_nonzero")
        elif not applied:
            _need(_same_prob(adjusted, baseline), "applied_false_must_echo_baseline")
            _need(abs(float(delta)) <= 1e-12, "applied_false_delta_nonzero")
        else:
            _need(mode == "on", "applied_true_requires_engine_on")
            lo = config["proposed_applied_prob_min"]
            hi = config["proposed_applied_prob_max"]
            clamped, did_clamp = _clamp_applied(adjusted, lo, hi)
            direction = math.copysign(1.0, float(adjusted) - baseline) if float(adjusted) != baseline else 0.0
            if did_clamp:
                new_dir = math.copysign(1.0, clamped - baseline) if clamped != baseline else 0.0
                if direction != 0.0 and new_dir != direction:
                    raise CorrectionsError("clamp_broke_direction")
                if not _cap_ok(baseline, clamped, cap_pp_max=config["proposed_leg_cap_pp_max"]):
                    raise CorrectionsError("clamp_broke_cap")
                adjusted = clamped
            else:
                _need(lo <= float(adjusted) <= hi, "applied_prob_out_of_range")
            _need(_cap_ok(baseline, adjusted, cap_pp_max=config["proposed_leg_cap_pp_max"]),
                  "leg_cap_exceeded")
            _need(abs(float(delta) - (float(adjusted) - baseline)) <= 1e-9, "delta_untruthful")
        if "cap_pp" in row:
            _need(_finite(row["cap_pp"]) and 0 < float(row["cap_pp"]) <= HARD_LEG_CAP_PP + 1e-15,
                  "cap_pp_invalid")
        leg_rows.append({**row, "adjusted_prob": float(adjusted), "baseline_prob": float(baseline),
                         "applied": bool(applied), "delta": float(delta)})

    missing_legs = set(req_legs) - seen_legs
    # MB1: partial required leg sets are hard-fail, not soft-missing.
    _need(not missing_legs, "missing_leg_ids")
    adjusted_by_leg = {row["leg_id"]: row for row in leg_rows}

    for row in parlays:
        _need(isinstance(row, dict), "parlay_row_malformed")
        pid = row.get("parlay_id")
        _need(isinstance(pid, str), "parlay_id_malformed")
        if pid in seen_parlays:
            raise CorrectionsError("duplicate_parlay_id")
        seen_parlays.add(pid)
        if pid not in req_parlays:
            raise CorrectionsError("unknown_parlay_id")
        baseline = req_parlays[pid]["baseline_prob"]
        _need(_same_prob(row.get("baseline_prob"), baseline), "parlay_baseline_echo_mismatch")
        adjusted = row.get("adjusted_prob")
        applied = row.get("applied")
        delta = row.get("delta")
        _need(isinstance(applied, bool), "parlay_applied_not_bool")
        _need(_finite(adjusted) and _finite(delta), "parlay_nonfinite_adjustment")
        dep_ids = req_parlays[pid]["leg_ids"]
        deps_ok = all(lid in adjusted_by_leg for lid in dep_ids)
        if not deps_ok or any(lid in missing_legs for lid in dep_ids):
            applied = False
            adjusted = baseline
            delta = 0.0
        if mode in ("off", "shadow"):
            _need(applied is False, "parlay_shadow_or_off_must_not_apply")
            _need(_same_prob(adjusted, baseline), "parlay_applied_false_must_echo_baseline")
        elif not applied:
            _need(_same_prob(adjusted, baseline), "parlay_applied_false_must_echo_baseline")
        else:
            _need(mode == "on", "parlay_applied_true_requires_engine_on")
            lo = config["proposed_applied_prob_min"]
            hi = config["proposed_applied_prob_max"]
            clamped, did_clamp = _clamp_applied(adjusted, lo, hi)
            direction = math.copysign(1.0, float(adjusted) - baseline) if float(adjusted) != baseline else 0.0
            if did_clamp:
                new_dir = math.copysign(1.0, clamped - baseline) if clamped != baseline else 0.0
                if direction != 0.0 and new_dir != direction:
                    raise CorrectionsError("parlay_clamp_broke_direction")
                rel = config["proposed_parlay_cap_relative"]
                if not _cap_ok(baseline, clamped, cap_pp_max=config["proposed_parlay_cap_pp_max"],
                               relative_max=rel):
                    raise CorrectionsError("parlay_clamp_broke_cap")
                adjusted = clamped
            else:
                _need(lo <= float(adjusted) <= hi, "parlay_applied_prob_out_of_range")
            rel = config["proposed_parlay_cap_relative"]
            _need(_cap_ok(baseline, adjusted, cap_pp_max=config["proposed_parlay_cap_pp_max"],
                          relative_max=rel), "parlay_cap_exceeded")
            _need(abs(float(delta) - (float(adjusted) - baseline)) <= 1e-9, "parlay_delta_untruthful")
        if "cap_pp" in row:
            _need(_finite(row["cap_pp"]) and 0 < float(row["cap_pp"]) <= HARD_PARLAY_CAP_PP + 1e-15,
                  "parlay_cap_pp_invalid")
        parlay_rows.append({**row, "applied": bool(applied), "adjusted_prob": float(adjusted),
                            "baseline_prob": float(baseline), "delta": float(delta)})

    missing_parlays = set(req_parlays) - seen_parlays
    _need(not missing_parlays, "missing_parlay_ids")

    # Parlay/leg consistency: no partial applied legs inside a card, and no
    # applied legs while the parent parlay stays unapplied (or the reverse).
    by_parlay = {row["parlay_id"]: row for row in parlay_rows}
    for pid, req_p in req_parlays.items():
        prow = by_parlay[pid]
        deps = [adjusted_by_leg[lid] for lid in req_p["leg_ids"]]
        flags = [d["applied"] for d in deps]
        if any(flags) and not all(flags):
            raise CorrectionsError("partial_leg_apply_in_parlay")
        if any(flags) and not prow["applied"]:
            raise CorrectionsError("parlay_leg_apply_inconsistency")
        if prow["applied"] and not all(flags):
            raise CorrectionsError("parlay_applied_without_all_legs")

    any_applied = any(row["applied"] for row in leg_rows + parlay_rows)
    artifact = None
    raw_artifact = response.get("artifact")
    if any_applied:
        _need(mode == "on", "applied_without_engine_on")
        _need(raw_artifact is not None, "artifact_missing")
        # Strict: PR#13 public_artifact alone is intentionally rejected here.
        artifact = _validate_artifact_for_apply(
            raw_artifact, now=now, generated_at=request["generated_at"],
            request_legs=request["legs"], applied_leg_rows=leg_rows, config=config)
    elif raw_artifact is not None:
        artifact = _validate_artifact_public(
            raw_artifact, now=now, generated_at=request["generated_at"])
    return {
        "corrections_mode": mode,
        "artifact": artifact,
        "legs": leg_rows,
        "parlays": parlay_rows,
        "missing_legs": sorted(missing_legs),
    }


def _provenance(mode, reason, *, network_used=False, engine_mode=None, served_adjusted=False,
                request_id=None):
    return {
        "corrections_mode": mode,
        "engine_corrections_mode": engine_mode,
        "fallback_reason": reason,
        "network_used": bool(network_used),
        "served_adjusted": bool(served_adjusted),
        "request_id": request_id,
        "token_env": TOKEN_ENV,
        "contract_path": CORRECTIONS_PATH,
        "engine_contract_head": ENGINE_CONTRACT_HEAD,
    }


def restore_parlays_from_pairs(parlays_doc, pairs):
    """Emergency offline restore: rewrite model_prob from pairs baseline_prob.

    Does not call the engine. Use when a previously adjusted served parlays.json
    must be restored without a full builder rebuild. Returns (doc, n_restored).
    """
    _need(isinstance(parlays_doc, dict) and isinstance(pairs, dict), "restore_input_invalid")
    by_leg = {row["leg_id"]: row for row in (pairs.get("legs") or [])
              if isinstance(row, dict) and "leg_id" in row and "baseline_prob" in row}
    restored = deepcopy(parlays_doc)
    count = 0
    season, week = restored.get("season"), restored.get("week")
    for card in restored.get("parlays") or []:
        for leg in card.get("legs") or []:
            lid = stable_leg_id(season, week, leg)
            row = by_leg.get(lid)
            if row is None:
                continue
            if not _same_prob(leg.get("model_prob"), row["baseline_prob"]):
                leg["model_prob"] = float(row["baseline_prob"])
                count += 1
    return restored, count


def correct_parlays_document(parlays_doc, *, config=None, transport=None, now=None,
                             baseline_model_version=None, token=None, prior_pairs=None,
                             logger=None):
    """Return {parlays, pairs, provenance}. Never mutates parlays_doc."""
    del prior_pairs  # intentionally ignored: OFF/fallback must not reuse stale pairs
    config = config or read_config()
    mode = config["corrections_mode"]
    baseline = deepcopy(parlays_doc)
    if mode == "off":
        return {
            "parlays": baseline.get("parlays"),
            "pairs": None,
            "provenance": _provenance("off", "corrections_mode_off"),
        }

    generated_at = now or baseline.get("updated_utc")
    version = baseline_model_version or baseline.get("baseline_model_version") or "unknown"
    try:
        request = build_request(baseline, baseline_model_version=version, generated_at=generated_at)
    except CorrectionsError as error:
        return {
            "parlays": baseline.get("parlays"),
            "pairs": None,
            "provenance": _provenance(mode, str(error)),
        }

    if not _token_ok(token):
        return {
            "parlays": baseline.get("parlays"),
            "pairs": None,
            "provenance": _provenance(mode, "missing_or_invalid_corrections_token",
                                      request_id=request["request_id"]),
        }
    if not config.get("base_url"):
        return {
            "parlays": baseline.get("parlays"),
            "pairs": None,
            "provenance": _provenance(mode, "base_url_unconfigured",
                                      request_id=request["request_id"]),
        }

    try:
        destination = _base_url(config["base_url"]) + config["endpoint_path"]
        body = json.dumps(request, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=True, allow_nan=False).encode("utf-8")
        headers = {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        if logger is not None:
            logger.info("parlay corrections POST %s request_id=%s timeout_s=%s",
                        config["endpoint_path"], request["request_id"],
                        config["consumer_timeout_s"])
        send = transport or default_transport
        status, raw = send(destination, body, headers, config["consumer_timeout_s"])
        if not isinstance(status, int) or not (200 <= status < 300):
            raise CorrectionsError("http_status_%s" % status)
        try:
            response = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CorrectionsError("invalid_json_response") from error
        validated = validate_response(response, request, config, now=generated_at)
    except CorrectionsError as error:
        return {
            "parlays": baseline.get("parlays"),
            "pairs": None,
            "provenance": _provenance(mode, str(error), network_used=True,
                                      request_id=request["request_id"]),
        }
    except (TimeoutError, urllib.error.URLError, OSError):
        return {
            "parlays": baseline.get("parlays"),
            "pairs": None,
            "provenance": _provenance(mode, "transport_timeout_or_error", network_used=True,
                                      request_id=request["request_id"]),
        }
    except Exception:
        return {
            "parlays": baseline.get("parlays"),
            "pairs": None,
            "provenance": _provenance(mode, "transport_failed", network_used=True,
                                      request_id=request["request_id"]),
        }

    engine_mode = validated["corrections_mode"]
    pairs = {
        "version": 1,
        "kind": "nfl.parlay_corrections_pairs.v1",
        "request_id": request["request_id"],
        "baseline_model_version": version,
        "generated_at": generated_at,
        "artifact": validated["artifact"],
        "legs": validated["legs"],
        "parlays": validated["parlays"],
        "engine_contract_head": ENGINE_CONTRACT_HEAD,
        "label": "paired_for_grading_not_a_production_accuracy_claim",
    }

    # Engine shadow always echoes baselines (applied=false). NFL serves adjusted
    # only when BOTH sides are on.
    serve_adjusted = mode == "on" and engine_mode == "on"
    served = deepcopy(baseline)
    if serve_adjusted:
        by_leg = {row["leg_id"]: row for row in validated["legs"]}
        by_parlay = {row["parlay_id"]: row for row in validated["parlays"]}
        for card in served.get("parlays") or []:
            for leg in card.get("legs") or []:
                lid = stable_leg_id(served["season"], served["week"], leg)
                row = by_leg.get(lid)
                if row and row["applied"]:
                    leg["model_prob"] = row["adjusted_prob"]
            prow = by_parlay.get(card.get("parlay_id"))
            if prow and prow["applied"]:
                try:
                    model = prow["adjusted_prob"]
                    implied = 1.0
                    for leg in card.get("legs") or []:
                        implied *= float(leg["implied_prob"])
                    card["model_ev"] = round(model / implied - 1.0, 4) if implied else card.get("model_ev")
                except (KeyError, TypeError, ValueError, ZeroDivisionError):
                    pass

    return {
        "parlays": served.get("parlays"),
        "pairs": pairs,
        "provenance": _provenance(
            mode,
            "ok" if serve_adjusted or mode == "shadow" else "engine_mode_not_on",
            network_used=True, engine_mode=engine_mode,
            served_adjusted=serve_adjusted,
            request_id=request["request_id"]),
    }


def content_id(value):
    """Content-address for a JSON document. Not a signature."""
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"),
                     ensure_ascii=True, allow_nan=False).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _archive_pairs_for_audit(pairs_path):
    """Retain grading lineage when leaving active serving; clear live sidecar.

    Copies bytes to the audit path then unlinks the live pairs file so OFF/restore
    never leaves an active pairs sidecar that could be mistaken for live apply
    state. Audit retention is intentional — do not destroy lineage silently.
    """
    path = Path(pairs_path)
    if not path.exists():
        return False
    audit = path.with_name(PAIRS_AUDIT_NAME)
    audit.write_bytes(path.read_bytes())
    path.unlink()
    return True


def build_serving_flag(*, mode, baseline_doc, active_doc, updated_utc,
                       generation_id=None, expires_at=None):
    """Bind baseline/active/flag for one publish run. Default-deny mode=off."""
    _need(mode in MODES, "serving_mode_invalid")
    baseline_id = content_id(baseline_doc)
    active_id = content_id(active_doc)
    if mode == "off":
        _need(baseline_id == active_id, "off_requires_active_equals_baseline")
    generation = generation_id or baseline_doc.get("updated_utc") or updated_utc
    _need(isinstance(generation, str) and generation, "generation_id_required")
    body = {
        "version": 1,
        "mode": mode,
        "updated_utc": updated_utc,
        "generation_id": generation,
        "baseline_path": BASELINE_URL,
        "active_path": ACTIVE_URL,
        "baseline_content_id": baseline_id,
        "active_content_id": active_id,
        "expires_at": expires_at,
        "engine_contract_head": ENGINE_CONTRACT_HEAD,
        "note": "fail_closed_default_off_not_an_activation",
    }
    body["run_id"] = content_id({
        "generation_id": generation,
        "mode": mode,
        "baseline_content_id": baseline_id,
        "active_content_id": active_id,
    })
    return body


def validate_serving_bundle(flag, baseline_doc, active_doc, *, now=None):
    """Server/client shared rules. Returns (ok, reason, serve_doc_or_none).

    Never returns the active document when it may be adjusted under a bad flag.
    Baseline unavailable ⇒ safe unavailable (None), not active fallback.
    """
    if not isinstance(flag, dict) or flag.get("version") != 1:
        return False, "flag_missing_or_malformed", None
    mode = flag.get("mode")
    if mode not in MODES:
        return False, "flag_mode_invalid", None
    if not isinstance(baseline_doc, dict):
        return False, "baseline_unavailable", None
    baseline_id = content_id(baseline_doc)
    if flag.get("baseline_content_id") != baseline_id:
        return False, "baseline_content_mismatch", None
    expires = flag.get("expires_at")
    if expires is not None:
        exp = _parse_utc(expires)
        now_dt = _parse_utc(now) if now else datetime.now(timezone.utc)
        if exp is None or now_dt is None or not (now_dt < exp):
            return False, "flag_expired", None
    expected_run = content_id({
        "generation_id": flag.get("generation_id"),
        "mode": mode,
        "baseline_content_id": flag.get("baseline_content_id"),
        "active_content_id": flag.get("active_content_id"),
    })
    if flag.get("run_id") != expected_run:
        return False, "run_id_mismatch", None
    gen = flag.get("generation_id")
    if not isinstance(gen, str) or not gen:
        return False, "generation_mismatch", None
    if gen not in (baseline_doc.get("updated_utc"), baseline_doc.get("generation_id")):
        return False, "generation_mismatch", None
    if mode == "off":
        return True, "flag_off", baseline_doc
    if mode == "shadow":
        return True, "flag_shadow_serve_baseline", baseline_doc
    # mode == on — only then may active differ; still require identity binding.
    if not isinstance(active_doc, dict):
        return False, "active_unavailable_while_on", None
    active_id = content_id(active_doc)
    if flag.get("active_content_id") != active_id:
        return False, "active_content_mismatch", None
    if active_doc.get("updated_utc") != baseline_doc.get("updated_utc"):
        return False, "mixed_generation_active_baseline", None
    if gen not in (active_doc.get("updated_utc"), active_doc.get("generation_id")):
        return False, "generation_mismatch", None
    return True, "flag_on", active_doc


def publish_parlay_artifacts(baseline_doc, active_doc, *, data_dir, mode, updated_utc,
                             write_json, pairs_path=None):
    """Write baseline, active, and serving flag with run_id binding.

    write_json(path, obj) must match repo on-disk encoding. Returns flag dict.
    """
    data_dir = Path(data_dir)
    flag = build_serving_flag(mode=mode, baseline_doc=baseline_doc, active_doc=active_doc,
                              updated_utc=updated_utc)
    ok, reason, _served = validate_serving_bundle(flag, baseline_doc, active_doc,
                                                  now=updated_utc)
    _need(ok, reason)
    write_json(str(data_dir / BASELINE_NAME), baseline_doc)
    write_json(str(data_dir / ACTIVE_NAME), active_doc)
    write_json(str(data_dir / SERVING_FLAG_NAME), flag)
    if pairs_path is not None and mode == "off":
        _archive_pairs_for_audit(pairs_path)
    return flag


def emergency_restore_active_from_baseline(*, data_dir, write_json, now=None):
    """Least-privilege restore: active := baseline, flag mode=off. No engine/forecast.

    Does not delete pairs audit. Caller (Actions) must not invoke build_predictions.
    """
    data_dir = Path(data_dir)
    baseline_path = data_dir / BASELINE_NAME
    _need(baseline_path.is_file(), "baseline_unavailable")
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    _need(isinstance(baseline, dict), "baseline_unavailable")
    stamp = now or baseline.get("updated_utc") or datetime.now(timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    active = deepcopy(baseline)
    flag = build_serving_flag(mode="off", baseline_doc=baseline, active_doc=active,
                              updated_utc=stamp, generation_id=baseline.get("updated_utc"))
    write_json(str(data_dir / ACTIVE_NAME), active)
    write_json(str(data_dir / SERVING_FLAG_NAME), flag)
    pairs = data_dir / "parlay_corrections_pairs.json"
    if pairs.exists():
        _archive_pairs_for_audit(pairs)
    return flag


def maybe_correct_and_write(parlays_doc, *, pairs_path=None, environment=None):
    """Build-time helper. OFF: no network; retain pairs audit lineage."""
    env = os.environ if environment is None else environment
    config = read_config(environment=env)
    path = Path(pairs_path) if pairs_path is not None else None
    if config["corrections_mode"] == "off":
        if path is not None:
            _archive_pairs_for_audit(path)
        return parlays_doc, _provenance("off", "corrections_mode_off")
    token = env.get(TOKEN_ENV)
    result = correct_parlays_document(
        parlays_doc, config=config, token=token,
        now=parlays_doc.get("updated_utc"),
        baseline_model_version=parlays_doc.get("baseline_model_version"),
    )
    doc = deepcopy(parlays_doc)
    doc["parlays"] = result["parlays"]
    if path is not None:
        if result["pairs"] is None:
            # Keep prior pairs for audit; do not destroy grading lineage on fallback.
            _archive_pairs_for_audit(path)
        else:
            if path.exists():
                _archive_pairs_for_audit(path)
            path.write_text(json.dumps(result["pairs"], indent=2, sort_keys=True) + "\n",
                            encoding="utf-8")
    return doc, result["provenance"]
