// SelfLearning parlay corrections consumer — default OFF, fail-closed.
// Fixtures are LABELED FAKES only; they are not learned production corrections.
// Wire shape pinned to SelfLearning PR #13 head 5941214178254df38a1c67b5935e591bfb052e33.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE_HEAD = '5941214178254df38a1c67b5935e591bfb052e33';

function runPy(code) {
  const result = spawnSync('python3', ['-B', '-'], {
    cwd: ROOT,
    input: code,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: ROOT, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

const PRELUDE = `
import copy, json, math
from scripts import parlay_selflearn_corrections as C

NOW = "2026-11-06T10:15:24Z"
BASELINE = {
  "season": 2026, "week": 9, "updated_utc": NOW,
  "parlays": [{
    "parlay_id": "game-401873048-g1",
    "scope": "game",
    "game_id": "401873048",
    "legs": [
      {"market": "wr_rec_yds", "selection": "M. Wilson 20+ rec yds",
       "game_id": "401873048", "model_prob": 0.667, "implied_prob": 0.697},
      {"market": "moneyline", "selection": "ARI ML",
       "game_id": "401873048", "model_prob": 0.4, "implied_prob": 0.42},
    ],
    "model_ev": -0.05, "confidence_tier": "low", "correlation_note": "same-game",
  }],
}

def leg_ids(doc):
    return [C.stable_leg_id(doc["season"], doc["week"], leg)
            for p in doc["parlays"] for leg in p["legs"]]

def request_from(doc, **kw):
    return C.build_request(doc, baseline_model_version="sha256:" + "a"*64,
                           generated_at=NOW, **kw)

def legacy_incomplete_public_artifact(expire="2026-11-07T00:00:00Z", n_graded=250):
    """Pre-5941214 HTTP public_artifact key set — OMITS apply evidence."""
    return {"artifact_id": "sha256:" + "b"*64, "model_version": C.ENGINE_MODEL_VERSION,
            "method": C.ENGINE_METHOD,
            "trained_through": "2026-11-01T00:00:00Z",
            "fitted_at": "2026-11-05T12:00:00Z",
            "expires_at": expire, "n_graded": n_graded, "source": "graded_journal_receipts"}

# Alias retained for older test names.
pr13_public_artifact = legacy_incomplete_public_artifact

def strict_apply_artifact(req, expire="2026-11-07T00:00:00Z", n_per_seg=None):
    """FAKE full provenance for pin 5941214… (not a real fit)."""
    n_legs = max(1, len(req["legs"]))
    # Floors: overall >=200 and per-segment >=50; n_graded == sum(n_eligible).
    if n_per_seg is None:
        n_per_seg = max(50, (199 + n_legs) // n_legs)
    segs = {}
    for leg in req["legs"]:
        key = C.segment_key(leg["market"], leg["selection"])
        segs[key] = {"n_eligible": n_per_seg, "raw_bias": -0.01, "delta": -0.008,
                     "eligible_for_application": True}
    n_graded = n_per_seg * len(segs)
    return {
        "artifact_id": "sha256:" + "b"*64,
        "model_version": C.ENGINE_MODEL_VERSION,
        "method": C.ENGINE_METHOD,
        "trained_through": "2026-11-01T00:00:00Z",
        "fitted_at": "2026-11-05T12:00:00Z",
        "expires_at": expire,
        "n_graded": n_graded,
        "source": "graded_journal_receipts",
        "eligibility_rules": list(C.ELIGIBILITY_RULES),
        "fit_inputs_hash": "sha256:" + "c"*64,
        "prior_strength": 50.0,
        "min_graded_total": 200,
        "min_graded_per_market": 50,
        "leg_cap_pp": 0.03,
        "parlay_cap_pp": 0.03,
        "parlay_cap_rel": 0.15,
        "clamp": [0.01, 0.99],
        "segments": segs,
        "sufficient_total": True,
    }

def all_leg_adjust(req, deltas=None):
    """Apply every request leg (required for parlay consistency)."""
    out = {}
    for i, leg in enumerate(req["legs"]):
        d = (deltas or {}).get(leg["leg_id"], 0.02 if i == 0 else 0.01)
        out[leg["leg_id"]] = round(leg["baseline_prob"] + d, 6)
    return out

def echo_transport(mode="on", adjust_legs=None, adjust_parlays=None, mutate=None,
                   expire="2026-11-07T00:00:00Z", artifact_shape="strict"):
    """FAKE engine: shadow/off always echo baseline applied=false."""
    def transport(url, body, headers, timeout):
        req = json.loads(body.decode("utf-8"))
        fake = valid_response(req, mode=mode, expire=expire,
                              adjust_legs=adjust_legs, adjust_parlays=adjust_parlays,
                              artifact_shape=artifact_shape)
        if mutate is not None:
            mutate(fake, req)
        return 200, json.dumps(fake).encode()
    return transport

def valid_response(req, *, mode="on", expire="2026-11-07T00:00:00Z",
                   adjust_legs=None, adjust_parlays=None, artifact=True,
                   artifact_shape="strict"):
    legs=[]
    for leg in req["legs"]:
        if mode in ("off", "shadow") or adjust_legs is None or leg["leg_id"] not in (adjust_legs or {}):
            legs.append({**leg, "adjusted_prob": leg["baseline_prob"], "delta": 0.0,
                         "applied": False, "reason": "FAKE_fixture_echo", "cap_pp": 0.03})
        else:
            adj = adjust_legs[leg["leg_id"]]
            delta = adj - leg["baseline_prob"]
            legs.append({**leg, "adjusted_prob": adj, "delta": delta,
                         "applied": True, "reason": "learned_segment_bias", "cap_pp": 0.03})
    parlays=[]
    for p in req["parlays"]:
        if mode in ("off", "shadow") or adjust_parlays is None or p["parlay_id"] not in (adjust_parlays or {}):
            parlays.append({**p, "adjusted_prob": p["baseline_prob"], "delta": 0.0,
                            "applied": False, "reason": "FAKE_fixture_echo", "cap_pp": 0.03})
        else:
            adj = adjust_parlays[p["parlay_id"]]
            delta = adj - p["baseline_prob"]
            parlays.append({**p, "adjusted_prob": adj, "delta": delta,
                            "applied": True, "reason": "learned_parlay_product", "cap_pp": 0.03})
    art = None
    if artifact and mode != "off":
        if artifact_shape == "pr13_public":
            art = legacy_incomplete_public_artifact(expire=expire)
        else:
            art = strict_apply_artifact(req, expire=expire)
    return {"schema_version": 1, "request_id": req["request_id"],
            "corrections_mode": mode, "artifact": art, "legs": legs, "parlays": parlays}
`;

test('committed NFL corrections_mode is off; caps/method pinned to engine PR#13 head', () => {
  const corr = JSON.parse(readFileSync(join(ROOT, 'config/parlay_selflearn_corrections.json'), 'utf8'));
  const pilot = JSON.parse(readFileSync(join(ROOT, 'config/selflearning_pilot.json'), 'utf8'));
  assert.equal(corr.corrections_mode, 'off');
  assert.equal(corr.engine_contract_head, ENGINE_HEAD);
  assert.equal(corr.engine_method, 'market_bias_shrinkage_v1');
  assert.equal(corr.proposed_leg_cap_pp_max, 0.03);
  assert.equal(corr.proposed_parlay_cap_pp_max, 0.03);
  assert.equal(corr.proposed_min_graded_legs_overall, 200);
  assert.equal(corr.proposed_min_graded_legs_per_market, 50);
  assert.equal(corr.env_override_policy, 'off_only_never_elevates');
  assert.equal(pilot.enabled, false);
  assert.equal(corr.consumer_timeout_s, 4);
});

test('OFF: apply returns byte-identical parlays and never calls transport', () => {
  const r = runPy(`${PRELUDE}
calls=[]
def boom(*a, **k):
    calls.append(1); raise AssertionError("transport must not run when OFF")
cfg = C.read_config()
assert cfg["corrections_mode"] == "off"
before = copy.deepcopy(BASELINE)
out = C.correct_parlays_document(BASELINE, config=cfg, transport=boom,
    now=NOW, baseline_model_version="sha256:"+"a"*64)
print(json.dumps({"identical": out["parlays"] == before["parlays"],
  "calls": len(calls), "served_mode": out["provenance"]["corrections_mode"],
  "fallback_reason": out["provenance"]["fallback_reason"],
  "pairs": out["pairs"], "mutated_input": BASELINE != before,
  "head": out["provenance"]["engine_contract_head"]}))
`);
  assert.equal(r.identical, true);
  assert.equal(r.calls, 0);
  assert.equal(r.served_mode, 'off');
  assert.equal(r.fallback_reason, 'corrections_mode_off');
  assert.equal(r.pairs, null);
  assert.equal(r.mutated_input, false);
  assert.equal(r.head, ENGINE_HEAD);
});

test('OFF deletes pairs sidecar and does not depend on engine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corr-off-'));
  try {
    const pairs = join(dir, 'pairs.json');
    writeFileSync(pairs, JSON.stringify({ version: 1, legs: [] }));
    const r = runPy(`${PRELUDE}
import os
pairs = ${JSON.stringify(pairs)}
doc, prov = C.maybe_correct_and_write(BASELINE, pairs_path=pairs,
    environment={"NFL_PARLAY_CORRECTIONS_MODE": "off"})
print(json.dumps({"exists": os.path.exists(pairs), "reason": prov["fallback_reason"],
  "mode": prov["corrections_mode"], "identical": doc == BASELINE}))
`);
    assert.equal(r.exists, false);
    assert.equal(r.reason, 'corrections_mode_off');
    assert.equal(r.identical, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ENV override cannot elevate committed OFF to on/shadow', () => {
  const r = runPy(`${PRELUDE}
cfg_on = C.read_config(environment={"NFL_PARLAY_CORRECTIONS_MODE": "on"})
cfg_shadow = C.read_config(environment={"NFL_PARLAY_CORRECTIONS_MODE": "shadow"})
cfg_off = C.read_config(environment={"NFL_PARLAY_CORRECTIONS_MODE": "off"})
doc, prov = C.maybe_correct_and_write(BASELINE,
    environment={"NFL_PARLAY_CORRECTIONS_MODE": "on", "SELFLEARN_NFL_CORRECTIONS_TOKEN": "t"*32})
print(json.dumps({
  "on_attempt": cfg_on["corrections_mode"],
  "shadow_attempt": cfg_shadow["corrections_mode"],
  "off_force": cfg_off["corrections_mode"],
  "maybe_mode": prov["corrections_mode"],
  "maybe_reason": prov["fallback_reason"],
}))
`);
  assert.equal(r.on_attempt, 'off');
  assert.equal(r.shadow_attempt, 'off');
  assert.equal(r.off_force, 'off');
  assert.equal(r.maybe_mode, 'off');
  assert.equal(r.maybe_reason, 'corrections_mode_off');
});

test('shadow (engine-faithful): applied=false echoes; NFL serves baseline', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "shadow", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
lid = req["legs"][0]["leg_id"]
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="shadow", adjust_legs={lid: 0.69}),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
served = out["parlays"][0]["legs"][0]["model_prob"]
print(json.dumps({"served_baseline": served == 0.667,
  "served_adjusted_flag": out["provenance"]["served_adjusted"],
  "pair_applied": out["pairs"]["legs"][0]["applied"],
  "pair_echo": out["pairs"]["legs"][0]["adjusted_prob"] == 0.667,
  "engine_mode": out["provenance"]["engine_corrections_mode"],
  "method": out["pairs"]["artifact"]["method"],
  "seg_key": next(iter(out["pairs"]["artifact"]["segments"]))}))
`);
  assert.equal(r.served_baseline, true);
  assert.equal(r.served_adjusted_flag, false);
  assert.equal(r.pair_applied, false);
  assert.equal(r.pair_echo, true);
  assert.equal(r.engine_mode, 'shadow');
  assert.equal(r.method, 'market_bias_shrinkage_v1');
  assert.match(r.seg_key, /\|/);
});

test('on + strict FAKE provenance: applies capped adjustment with provenance linkage', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
pid = req["parlays"][0]["parlay_id"]
legs = all_leg_adjust(req)
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs=legs, adjust_parlays={pid: 0.28}),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
print(json.dumps({"served_adj": out["parlays"][0]["legs"][0]["model_prob"],
  "pair_request_id": out["pairs"]["request_id"] == req["request_id"],
  "artifact": out["pairs"]["artifact"]["method"],
  "has_segments": "segments" in out["pairs"]["artifact"],
  "seg_keys": sorted(out["pairs"]["artifact"]["segments"]),
  "rules": out["pairs"]["artifact"]["eligibility_rules"],
  "served_adjusted": out["provenance"]["served_adjusted"],
  "head": out["pairs"]["engine_contract_head"]}))
`);
  assert.equal(r.served_adj, 0.687);
  assert.equal(r.pair_request_id, true);
  assert.equal(r.artifact, 'market_bias_shrinkage_v1');
  assert.equal(r.has_segments, true);
  assert.ok(r.seg_keys.every((k) => k.includes('|')));
  assert.deepEqual(r.rules, [
    'served_at_before_kickoff',
    'exclude_push_void',
    'exclude_after_trained_through',
    'baseline_prob_as_served_in_(0,1)',
    'binary_outcome_only',
    'segment_market_and_selection',
  ]);
  assert.equal(r.served_adjusted, true);
  assert.equal(r.head, ENGINE_HEAD);
});

test('REGRESSION: legacy incomplete public_artifact cannot apply', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
legs = all_leg_adjust(req)
pid = req["parlays"][0]["parlay_id"]
public = legacy_incomplete_public_artifact()
assert C.pr13_public_artifact_shape(public) is True
assert C.legacy_incomplete_artifact_shape(public) is True
assert "segments" not in public and "fit_inputs_hash" not in public
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs=legs, adjust_parlays={pid: 0.28},
                             artifact_shape="pr13_public"),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
direct = None
try:
    C.validate_response(
        valid_response(req, mode="on", adjust_legs=legs, adjust_parlays={pid: 0.28},
                       artifact_shape="pr13_public"),
        req, cfg, now=NOW)
except C.CorrectionsError as e:
    direct = e.args[0]
print(json.dumps({"reason": out["provenance"]["fallback_reason"],
  "served": out["parlays"][0]["legs"][0]["model_prob"],
  "served_adjusted": out["provenance"]["served_adjusted"],
  "pairs": out["pairs"], "direct": direct,
  "public_keys": sorted(public.keys())}))
`);
  assert.match(r.reason, /artifact_missing_apply_evidence|insufficient_segment|artifact_/i);
  assert.equal(r.served, 0.667);
  assert.equal(r.served_adjusted, false);
  assert.equal(r.pairs, null);
  assert.match(r.direct, /artifact_missing_apply_evidence|insufficient_segment|artifact_/i);
  assert.deepEqual(r.public_keys, [
    'artifact_id', 'expires_at', 'fitted_at', 'method', 'model_version',
    'n_graded', 'source', 'trained_through',
  ]);
});

test('MB1 REGRESSION: missing required leg hard-fails (not soft any_applied)', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
legs = all_leg_adjust(req)
pid = req["parlays"][0]["parlay_id"]
def drop_leg(fake, req):
    # Otherwise-valid applied response, but omit one required leg id.
    fake["legs"] = [fake["legs"][0]]
direct = None
try:
    C.validate_response(
        valid_response(req, mode="on", adjust_legs=legs, adjust_parlays={pid: 0.28}),
        req, cfg, now=NOW)
    # mutate after build
except C.CorrectionsError:
    pass
fake = valid_response(req, mode="on", adjust_legs=legs, adjust_parlays={pid: 0.28})
drop_leg(fake, req)
try:
    C.validate_response(fake, req, cfg, now=NOW)
except C.CorrectionsError as e:
    direct = e.args[0]
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs=legs, adjust_parlays={pid: 0.28},
                             mutate=drop_leg),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
print(json.dumps({"direct": direct,
  "reason": out["provenance"]["fallback_reason"],
  "served": out["parlays"][0]["legs"][0]["model_prob"],
  "served_adjusted": out["provenance"]["served_adjusted"],
  "pairs": out["pairs"]}))
`);
  assert.equal(r.direct, 'missing_leg_ids');
  assert.match(r.reason, /missing_leg/);
  assert.equal(r.served, 0.667);
  assert.equal(r.served_adjusted, false);
  assert.equal(r.pairs, null);
});

test('REGRESSION: partial leg apply / parlay EV inconsistency hard-fails', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
lid0 = req["legs"][0]["leg_id"]
pid = req["parlays"][0]["parlay_id"]
# Only one leg applied; parlay left unapplied — would rewrite one model_prob while EV stale.
partial = None
try:
    C.validate_response(
        valid_response(req, mode="on", adjust_legs={lid0: 0.69}),
        req, cfg, now=NOW)
except C.CorrectionsError as e:
    partial = e.args[0]
# All legs applied but parlay not — inconsistent card.
legs = all_leg_adjust(req)
inconsist = None
try:
    C.validate_response(
        valid_response(req, mode="on", adjust_legs=legs),
        req, cfg, now=NOW)
except C.CorrectionsError as e:
    inconsist = e.args[0]
# Parlay applied without all legs.
parlay_only = None
try:
    C.validate_response(
        valid_response(req, mode="on", adjust_legs={lid0: 0.69}, adjust_parlays={pid: 0.28}),
        req, cfg, now=NOW)
except C.CorrectionsError as e:
    parlay_only = e.args[0]
print(json.dumps({"partial": partial, "inconsist": inconsist, "parlay_only": parlay_only}))
`);
  assert.equal(r.partial, 'partial_leg_apply_in_parlay');
  assert.equal(r.inconsist, 'parlay_leg_apply_inconsistency');
  assert.match(r.parlay_only, /partial_leg_apply_in_parlay|parlay_applied_without_all_legs/);
});

test('I1: market-only segment keys cannot bind; selection must match', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
legs = all_leg_adjust(req)
pid = req["parlays"][0]["parlay_id"]
def market_only(fake, req):
    remapped = {}
    for leg in req["legs"]:
        remapped[leg["market"]] = {
          "n_eligible": 100, "raw_bias": -0.01, "delta": -0.008,
          "eligible_for_application": True}
    fake["artifact"]["segments"] = remapped
    fake["artifact"]["n_graded"] = 100 * len(remapped)
def wrong_sel(fake, req):
    segs = {}
    for leg in req["legs"]:
        segs[leg["market"] + "|WRONG SEL"] = {
          "n_eligible": 100, "raw_bias": -0.01, "delta": -0.008,
          "eligible_for_application": True}
    fake["artifact"]["segments"] = segs
    fake["artifact"]["n_graded"] = 100 * len(segs)
out_m = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs=legs, adjust_parlays={pid: 0.28},
                             mutate=market_only),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
out_s = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs=legs, adjust_parlays={pid: 0.28},
                             mutate=wrong_sel),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
print(json.dumps({"market": out_m["provenance"]["fallback_reason"],
  "wrong_sel": out_s["provenance"]["fallback_reason"],
  "served_m": out_m["parlays"][0]["legs"][0]["model_prob"],
  "served_s": out_s["parlays"][0]["legs"][0]["model_prob"]}))
`);
  assert.match(r.market, /insufficient_segment|segment/i);
  assert.match(r.wrong_sel, /insufficient_segment|segment/i);
  assert.equal(r.served_m, 0.667);
  assert.equal(r.served_s, 0.667);
});

test('I2: noncanonical eligibility_rules rejected (exact engine canon required)', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
legs = all_leg_adjust(req)
pid = req["parlays"][0]["parlay_id"]
def bad_rules(fake, req):
    fake["artifact"]["eligibility_rules"] = ["served_at_before_kickoff", "binary_outcome_only"]
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs=legs, adjust_parlays={pid: 0.28},
                             mutate=bad_rules),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
print(json.dumps({"reason": out["provenance"]["fallback_reason"],
  "served": out["parlays"][0]["legs"][0]["model_prob"]}))
`);
  assert.match(r.reason, /eligibility_rules/i);
  assert.equal(r.served, 0.667);
});

test('fallback on timeout, HTTP error, schema failure, bad request_id, stale artifact', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
ver = "sha256:"+"a"*64
req = request_from(BASELINE)
legs = all_leg_adjust(req)
cases = {}
cases["timeout"] = C.correct_parlays_document(BASELINE, config=cfg,
    transport=lambda *a, **k: (_ for _ in ()).throw(TimeoutError("slow")),
    now=NOW, baseline_model_version=ver, token="t"*32)["provenance"]["fallback_reason"]
cases["http"] = C.correct_parlays_document(BASELINE, config=cfg,
    transport=lambda *a, **k: (500, b""),
    now=NOW, baseline_model_version=ver, token="t"*32)["provenance"]["fallback_reason"]
cases["schema"] = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mutate=lambda fake, req: fake.__setitem__("schema_version", 2)),
    now=NOW, baseline_model_version=ver, token="t"*32)["provenance"]["fallback_reason"]
cases["request_id"] = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mutate=lambda fake, req: fake.__setitem__("request_id", "nope")),
    now=NOW, baseline_model_version=ver, token="t"*32)["provenance"]["fallback_reason"]
cases["stale"] = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs=legs,
                             adjust_parlays={req["parlays"][0]["parlay_id"]: 0.28},
                             expire="2026-11-06T09:00:00Z"),
    now=NOW, baseline_model_version=ver, token="t"*32)["provenance"]["fallback_reason"]
cases["token"] = C.correct_parlays_document(BASELINE, config=cfg,
    transport=lambda *a, **k: (200, b"{}"),
    now=NOW, baseline_model_version=ver, token=None)["provenance"]["fallback_reason"]
print(json.dumps(cases))
`);
  for (const [k, reason] of Object.entries(r)) {
    assert.ok(typeof reason === 'string' && reason.length > 0, k);
    assert.notEqual(reason, 'ok', k);
  }
  assert.match(r.timeout, /timeout|transport/);
  assert.match(r.http, /http|transport|status/);
  assert.match(r.schema, /schema/);
  assert.match(r.request_id, /request_id/);
  assert.match(r.stale, /expir|stale|fresh|artifact/);
  assert.match(r.token, /token/);
});

test('cap enforcement: rejects oversize delta even if engine advertises higher cap_pp', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
lid = req["legs"][0]["leg_id"]
# baseline 0.667; +0.05 exceeds HARD 0.03 — fail before consistency if single-leg applied
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs={lid: 0.717},
        mutate=lambda fake, req: fake["legs"][0].__setitem__("cap_pp", 0.03)),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
print(json.dumps({"reason": out["provenance"]["fallback_reason"],
  "served": out["parlays"][0]["legs"][0]["model_prob"],
  "served_adjusted": out["provenance"]["served_adjusted"]}))
`);
  assert.match(r.reason, /cap|partial_leg/i);
  assert.equal(r.served, 0.667);
  assert.equal(r.served_adjusted, false);
});

test('applied=false must echo baseline; baseline outside .01-.99 is preserved on fallback', () => {
  const r = runPy(`${PRELUDE}
doc = copy.deepcopy(BASELINE)
doc["parlays"][0]["legs"][0]["model_prob"] = 0.005  # outside applied window
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
out_lie = C.correct_parlays_document(doc, config=cfg,
    transport=echo_transport(mode="on", mutate=lambda fake, req: (
        fake["legs"][0].__setitem__("adjusted_prob", 0.5),
        fake["legs"][0].__setitem__("applied", False),
        fake["legs"][0].__setitem__("delta", 0.0))),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
out_ok = C.correct_parlays_document(doc, config=cfg,
    transport=echo_transport(mode="on"),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
print(json.dumps({"lie_reason": out_lie["provenance"]["fallback_reason"],
  "ok_served": out_ok["parlays"][0]["legs"][0]["model_prob"],
  "ok_pairs_mode": out_ok["provenance"]["corrections_mode"]}))
`);
  assert.match(r.lie_reason, /applied|baseline|echo/i);
  assert.equal(r.ok_served, 0.005);
});

test('invalid/nonfinite/mismatched baseline echo / unknown id / duplicate id reject', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
ver="sha256:"+"a"*64
def run(mutate):
    return C.correct_parlays_document(BASELINE, config=cfg,
        transport=echo_transport(mode="on", mutate=mutate),
        now=NOW, baseline_model_version=ver, token="t"*32)["provenance"]["fallback_reason"]
out = {
  "nonfinite": run(lambda fake, req: fake["legs"].__setitem__(0, {**fake["legs"][0], "adjusted_prob": float("nan"), "applied": True, "delta": float("nan")})),
  "baseline_echo": run(lambda fake, req: fake["legs"][0].__setitem__("baseline_prob", 0.12)),
  "unknown": run(lambda fake, req: fake["legs"].append({**fake["legs"][0], "leg_id": "unknown-leg"})),
  "dup": run(lambda fake, req: fake["legs"].append(dict(fake["legs"][0]))),
  "shadow_lie": C.correct_parlays_document(BASELINE, config={**cfg, "corrections_mode": "shadow"},
      transport=echo_transport(mode="shadow", mutate=lambda fake, req: (
          fake["legs"][0].__setitem__("applied", True),
          fake["legs"][0].__setitem__("adjusted_prob", 0.7),
          fake["legs"][0].__setitem__("delta", 0.033))),
      now=NOW, baseline_model_version=ver, token="t"*32)["provenance"]["fallback_reason"],
}
print(json.dumps(out))
`);
  assert.match(r.nonfinite, /finite|nan|invalid|json/i);
  assert.match(r.baseline_echo, /baseline|echo/i);
  assert.match(r.unknown, /unknown|id/i);
  assert.match(r.dup, /dup/i);
  assert.match(r.shadow_lie, /shadow|apply|applied/i);
});

test('build_request exact keys match engine REQUEST_KEYS/LEG_KEYS/PARLAY_KEYS', () => {
  const r = runPy(`${PRELUDE}
req = request_from(BASELINE)
print(json.dumps({
  "req_keys": sorted(req.keys()),
  "leg_keys": sorted(req["legs"][0].keys()),
  "parlay_keys": sorted(req["parlays"][0].keys()),
  "expected_req": sorted(C.REQUEST_KEYS),
  "expected_leg": sorted(C.LEG_KEYS),
  "expected_parlay": sorted(C.PARLAY_KEYS),
  "n_legs": len(req["legs"]), "path": C.CORRECTIONS_PATH,
  "head": C.ENGINE_CONTRACT_HEAD, "method": C.ENGINE_METHOD,
  "rules": list(C.ELIGIBILITY_RULES),
}))
`);
  assert.deepEqual(r.req_keys, r.expected_req);
  assert.deepEqual(r.leg_keys, r.expected_leg);
  assert.deepEqual(r.parlay_keys, r.expected_parlay);
  assert.equal(r.path, '/api/v1/nfl/corrections');
  assert.equal(r.head, ENGINE_HEAD);
  assert.equal(r.method, 'market_bias_shrinkage_v1');
  assert.ok(r.rules.includes('segment_market_and_selection'));
});

test('restore_parlays_from_pairs rewrites adjusted model_prob offline without engine', () => {
  const r = runPy(`${PRELUDE}
req = request_from(BASELINE)
lid = req["legs"][0]["leg_id"]
adjusted = copy.deepcopy(BASELINE)
adjusted["parlays"][0]["legs"][0]["model_prob"] = 0.69
pairs = {"legs": [{"leg_id": lid, "baseline_prob": 0.667, "adjusted_prob": 0.69, "applied": True}]}
restored, n = C.restore_parlays_from_pairs(adjusted, pairs)
print(json.dumps({"n": n, "prob": restored["parlays"][0]["legs"][0]["model_prob"],
  "input_untouched": adjusted["parlays"][0]["legs"][0]["model_prob"] == 0.69}))
`);
  assert.equal(r.n, 1);
  assert.equal(r.prob, 0.667);
  assert.equal(r.input_untouched, true);
});

test('no-data / insufficient artifact floor refuses applied serving', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
legs = all_leg_adjust(req)
pid = req["parlays"][0]["parlay_id"]
def low_n(fake, req):
    fake["artifact"]["n_graded"] = 40
    fake["artifact"]["sufficient_total"] = False
    for row in fake["artifact"]["segments"].values():
        row["n_eligible"] = 20
        row["eligible_for_application"] = False
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs=legs, adjust_parlays={pid: 0.28}, mutate=low_n),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
print(json.dumps({"reason": out["provenance"]["fallback_reason"],
  "served": out["parlays"][0]["legs"][0]["model_prob"]}))
`);
  assert.match(r.reason, /insufficient|artifact|graded/i);
  assert.equal(r.served, 0.667);
});

test('segment below 50 eligible refuses applied leg (no global inheritance)', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
legs = all_leg_adjust(req)
pid = req["parlays"][0]["parlay_id"]
key = C.segment_key(req["legs"][0]["market"], req["legs"][0]["selection"])
def thin(fake, req):
    fake["artifact"]["segments"][key] = {
      "n_eligible": 12, "raw_bias": 0.1, "delta": 0.02,
      "eligible_for_application": False}
    fake["artifact"]["n_graded"] = sum(s["n_eligible"] for s in fake["artifact"]["segments"].values())
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs=legs, adjust_parlays={pid: 0.28}, mutate=thin),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
print(json.dumps({"reason": out["provenance"]["fallback_reason"],
  "served": out["parlays"][0]["legs"][0]["model_prob"]}))
`);
  assert.match(r.reason, /segment|insufficient/i);
  assert.equal(r.served, 0.667);
});

test('R1 publish: baseline/active/flag bound; emergency restore forces OFF', () => {
  const dir = mkdtempSync(join(tmpdir(), 'corr-r1-'));
  try {
    const r = runPy(`${PRELUDE}
from pathlib import Path
dir_path = Path(${JSON.stringify(dir)})
def write_json(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=True, indent=2) + "\\n", encoding="utf-8")
baseline = copy.deepcopy(BASELINE)
active_on = copy.deepcopy(BASELINE)
active_on["parlays"][0]["legs"][0]["model_prob"] = 0.69
# OFF publish requires active == baseline
flag_off = C.publish_parlay_artifacts(baseline, baseline, data_dir=dir_path, mode="off",
    updated_utc=NOW, write_json=write_json)
ok_off, reason_off, served_off = C.validate_serving_bundle(flag_off, baseline, baseline, now=NOW)
# tamper active while claiming on
flag_bad = C.build_serving_flag(mode="on", baseline_doc=baseline, active_doc=active_on,
                                updated_utc=NOW)
ok_bad, reason_bad, served_bad = C.validate_serving_bundle(flag_bad, baseline, active_on, now=NOW)
# write active on disk then emergency restore
write_json(str(dir_path / C.ACTIVE_NAME), active_on)
write_json(str(dir_path / C.BASELINE_NAME), baseline)
restored = C.emergency_restore_active_from_baseline(data_dir=dir_path, write_json=write_json, now=NOW)
active_after = json.loads((dir_path / C.ACTIVE_NAME).read_text())
flag_after = json.loads((dir_path / C.SERVING_FLAG_NAME).read_text())
print(json.dumps({
  "flag_mode": flag_off["mode"], "ok_off": ok_off, "reason_off": reason_off,
  "served_is_baseline": served_off == baseline,
  "ok_on": ok_bad, "reason_on": reason_bad,
  "restored_mode": restored["mode"],
  "active_eq_baseline": active_after == baseline,
  "flag_after_mode": flag_after["mode"],
  "run_id": bool(flag_off.get("run_id")),
}))
`);
    assert.equal(r.flag_mode, 'off');
    assert.equal(r.ok_off, true);
    assert.equal(r.served_is_baseline, true);
    assert.equal(r.ok_on, true);
    assert.equal(r.reason_on, 'flag_on');
    assert.equal(r.restored_mode, 'off');
    assert.equal(r.active_eq_baseline, true);
    assert.equal(r.flag_after_mode, 'off');
    assert.equal(r.run_id, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('production builders always call helper; committed mode remains off', () => {
  const src = readFileSync(join(ROOT, 'scripts/build_predictions.py'), 'utf8');
  assert.match(src, /parlay_selflearn_corrections/);
  assert.match(src, /maybe_correct_and_write/);
  assert.match(src, /publish_parlay_artifacts/);
  assert.doesNotMatch(src, /if _corr_cfg\["corrections_mode"\] != "off"/);
  const pilot = JSON.parse(readFileSync(join(ROOT, 'config/selflearning_pilot.json'), 'utf8'));
  assert.equal(pilot.enabled, false);
});
