// SelfLearning parlay corrections consumer — default OFF, fail-closed.
// Fixtures are LABELED FAKES only; they are not learned production corrections.
// Wire shape pinned to SelfLearning PR #13 head 37629ecc63c2dc6b92e5cd1b1c5fd5d58398bcb2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE_HEAD = '37629ecc63c2dc6b92e5cd1b1c5fd5d58398bcb2';

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

def pr13_public_artifact(expire="2026-11-07T00:00:00Z", n_graded=250):
    """Exact HTTP public_artifact key set from engine PR#13 — OMITS apply evidence."""
    return {"artifact_id": "sha256:" + "b"*64, "model_version": C.ENGINE_MODEL_VERSION,
            "method": C.ENGINE_METHOD,
            "trained_through": "2026-11-01T00:00:00Z",
            "fitted_at": "2026-11-05T12:00:00Z",
            "expires_at": expire, "n_graded": n_graded, "source": "graded_journal_receipts"}

def strict_apply_artifact(req, expire="2026-11-07T00:00:00Z", n_graded=250):
    """FAKE full provenance satisfying NFL strict apply gate (not a real fit)."""
    art = pr13_public_artifact(expire=expire, n_graded=n_graded)
    markets = sorted({leg["market"] for leg in req["legs"]})
    art.update({
        "fit_inputs_hash": "sha256:" + "c"*64,
        "sufficient_total": True,
        "min_graded_total": 200,
        "min_graded_per_market": 50,
        "eligibility_rules": ["served_at_before_kickoff", "exclude_push_void",
                              "binary_outcome_only"],
        "leg_cap_pp": 0.03,
        "segments": {m: {"n_eligible": 80, "raw_bias": -0.01, "delta": -0.008,
                         "eligible_for_application": True} for m in markets},
    })
    return art

def valid_response(req, *, mode="on", expire="2026-11-07T00:00:00Z",
                   adjust_legs=None, adjust_parlays=None, artifact=True,
                   artifact_shape="strict"):
    legs=[]
    for leg in req["legs"]:
        # Engine shadow/off: never apply; would-be adjustments stay in engine logs only.
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
            art = pr13_public_artifact(expire=expire)
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

test('shadow (engine-faithful): applied=false echoes; NFL serves baseline', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "shadow", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
lid = req["legs"][0]["leg_id"]
# adjust_legs ignored by FAKE when mode=shadow (engine contract)
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="shadow", adjust_legs={lid: 0.69}),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
served = out["parlays"][0]["legs"][0]["model_prob"]
print(json.dumps({"served_baseline": served == 0.667,
  "served_adjusted_flag": out["provenance"]["served_adjusted"],
  "pair_applied": out["pairs"]["legs"][0]["applied"],
  "pair_echo": out["pairs"]["legs"][0]["adjusted_prob"] == 0.667,
  "engine_mode": out["provenance"]["engine_corrections_mode"],
  "method": out["pairs"]["artifact"]["method"]}))
`);
  assert.equal(r.served_baseline, true);
  assert.equal(r.served_adjusted_flag, false);
  assert.equal(r.pair_applied, false);
  assert.equal(r.pair_echo, true);
  assert.equal(r.engine_mode, 'shadow');
  assert.equal(r.method, 'market_bias_shrinkage_v1');
});

test('on + strict FAKE provenance: applies capped adjustment with provenance linkage', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
pid = req["parlays"][0]["parlay_id"]
lid = req["legs"][0]["leg_id"]
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs={lid: 0.69}, adjust_parlays={pid: 0.28}),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
print(json.dumps({"served_adj": out["parlays"][0]["legs"][0]["model_prob"],
  "pair_request_id": out["pairs"]["request_id"] == req["request_id"],
  "artifact": out["pairs"]["artifact"]["method"],
  "has_segments": "segments" in out["pairs"]["artifact"],
  "served_adjusted": out["provenance"]["served_adjusted"],
  "head": out["pairs"]["engine_contract_head"]}))
`);
  assert.equal(r.served_adj, 0.69);
  assert.equal(r.pair_request_id, true);
  assert.equal(r.artifact, 'market_bias_shrinkage_v1');
  assert.equal(r.has_segments, true);
  assert.equal(r.served_adjusted, true);
  assert.equal(r.head, ENGINE_HEAD);
});

test('REGRESSION: PR#13 public_artifact (no segments/fit_inputs_hash) cannot apply', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
lid = req["legs"][0]["leg_id"]
pid = req["parlays"][0]["parlay_id"]
public = pr13_public_artifact()
assert C.pr13_public_artifact_shape(public) is True
assert "segments" not in public and "fit_inputs_hash" not in public
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs={lid: 0.69}, adjust_parlays={pid: 0.28},
                             artifact_shape="pr13_public"),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
# Direct validator must also refuse apply on the incomplete shape.
direct = None
try:
    C.validate_response(
        valid_response(req, mode="on", adjust_legs={lid: 0.69}, artifact_shape="pr13_public"),
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

test('fallback on timeout, HTTP error, schema failure, bad request_id, stale artifact', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
ver = "sha256:"+"a"*64
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
    transport=echo_transport(mode="on", adjust_legs={request_from(BASELINE)["legs"][0]["leg_id"]: 0.69},
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
  assert.match(r.stale, /expir|stale|fresh/);
  assert.match(r.token, /token/);
});

test('cap enforcement: rejects oversize delta even if engine advertises higher cap_pp', () => {
  const r = runPy(`${PRELUDE}
cfg = {**C.read_config(), "corrections_mode": "on", "base_url": "https://example.invalid"}
req = request_from(BASELINE)
lid = req["legs"][0]["leg_id"]
# baseline 0.667; +0.05 exceeds HARD 0.03
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs={lid: 0.717},
        mutate=lambda fake, req: fake["legs"][0].__setitem__("cap_pp", 0.03)),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
print(json.dumps({"reason": out["provenance"]["fallback_reason"],
  "served": out["parlays"][0]["legs"][0]["model_prob"],
  "served_adjusted": out["provenance"]["served_adjusted"]}))
`);
  assert.match(r.reason, /cap/i);
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
}))
`);
  assert.deepEqual(r.req_keys, r.expected_req);
  assert.deepEqual(r.leg_keys, r.expected_leg);
  assert.deepEqual(r.parlay_keys, r.expected_parlay);
  assert.equal(r.path, '/api/v1/nfl/corrections');
  assert.equal(r.head, ENGINE_HEAD);
  assert.equal(r.method, 'market_bias_shrinkage_v1');
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
lid = req["legs"][0]["leg_id"]
def low_n(fake, req):
    fake["artifact"]["n_graded"] = 40
    fake["artifact"]["sufficient_total"] = False
    fake["legs"][0]["applied"] = True
    fake["legs"][0]["adjusted_prob"] = 0.69
    fake["legs"][0]["delta"] = 0.023
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs={lid: 0.69}, mutate=low_n),
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
lid = req["legs"][0]["leg_id"]
market = req["legs"][0]["market"]
def thin(fake, req):
    fake["artifact"]["segments"][market] = {
      "n_eligible": 12, "raw_bias": 0.1, "delta": 0.02,
      "eligible_for_application": False}
out = C.correct_parlays_document(BASELINE, config=cfg,
    transport=echo_transport(mode="on", adjust_legs={lid: 0.69}, mutate=thin),
    now=NOW, baseline_model_version="sha256:"+"a"*64, token="t"*32)
print(json.dumps({"reason": out["provenance"]["fallback_reason"],
  "served": out["parlays"][0]["legs"][0]["model_prob"]}))
`);
  assert.match(r.reason, /segment|insufficient/i);
  assert.equal(r.served, 0.667);
});

test('production builders always call helper; committed mode remains off', () => {
  const src = readFileSync(join(ROOT, 'scripts/build_predictions.py'), 'utf8');
  assert.match(src, /parlay_selflearn_corrections/);
  assert.match(src, /maybe_correct_and_write/);
  assert.doesNotMatch(src, /if _corr_cfg\["corrections_mode"\] != "off"/);
  const pilot = JSON.parse(readFileSync(join(ROOT, 'config/selflearning_pilot.json'), 'utf8'));
  assert.equal(pilot.enabled, false);
});
