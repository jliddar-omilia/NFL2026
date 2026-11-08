// Offline M1 ingest fixture conformance + exporter 5-op fake-transport flow.
// Fixtures: tests/fixtures/nfl-ingest-m1 (SelfLearning 707b737 draft; NOT prod).
// No live network. Does not claim live journal write success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIX = join(ROOT, 'tests/fixtures/nfl-ingest-m1');
const ENGINE_DRAFT = '707b73783119d57e69a549aa8cc6f95fb6795539';
const PROD_PIN = 'aacb19c73122f257449e977df40f2a2733991b2f';

function load(name) {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

function runPy(code) {
  const r = spawnSync('python3', ['-B', '-c', code], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: ROOT, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

test('M1 fixtures: index IDs, publication_status, and independently recomputed hashes', () => {
  const index = load('index.json');
  const contract = load('contract.json');
  const gen = load('generation_envelope.json');
  const seq = load('objects_upload_sequence.json');
  assert.equal(index.kind, 'nfl.ingest_fixture_index.m1.v1');
  assert.equal(contract.publication_status.required_on_generation_capture, 'generated_unverified');
  assert.equal(contract.auth.token_min_chars, 32);
  assert.deepEqual(contract.auth.placeholder_ban, ['', '[SENSITIVE]']);
  assert.equal(contract.limits.supabase_http_timeout_seconds_per_request, 12);
  assert.equal(contract.limits.vercel_function_max_duration_seconds, 60);
  assert.equal(contract.limits.m1_serial_http_operations.length, 5);
  assert.equal(seq.order.length, 4);
  assert.equal(seq.then, 'finalize_request.json');
  assert.equal(gen.payload.generations[0].publication_status, 'generated_unverified');
  assert.equal(gen.payload.receipts[0].publication_status, 'generated_unverified');
  assert.equal(gen.object_id, index.ids.envelope_id);
  assert.equal(load('finalize_request.json').object_id, index.ids.envelope_id);

  const out = runPy(`
import json
from pathlib import Path
from scripts import export_learning as e
FIX = Path(${JSON.stringify(FIX)})
index = json.loads((FIX / "index.json").read_text())
ids = index["ids"]
checks = {}
for name, key in [
  ("source_snapshot_leg_pool.json", "leg_pool_object_id"),
  ("source_snapshot_schedule.json", "schedule_object_id"),
  ("source_snapshot_parlay_calibration.json", "parlay_calibration_object_id"),
]:
    obj = json.loads((FIX / name).read_text())
    checks[key] = {
      "claimed": obj["object_id"],
      "index": ids[key],
      "recomputed": e.fingerprint(obj["payload"]),
      "match": obj["object_id"] == ids[key] == e.fingerprint(obj["payload"]),
    }
gen = json.loads((FIX / "generation_envelope.json").read_text())
payload = gen["payload"]
body = {k: v for k, v in payload.items() if k != "envelope_id"}
manifest = payload["generations"][0]
keys = e.MANIFEST_KEYS
checks["envelope"] = {
  "claimed": gen["object_id"],
  "index": ids["envelope_id"],
  "recomputed": e.fingerprint(body),
  "match": gen["object_id"] == payload["envelope_id"] == ids["envelope_id"] == e.fingerprint(body),
}
checks["generation"] = {
  "claimed": manifest["generation_id"],
  "index": ids["generation_id"],
  "recomputed": e.fingerprint({k: manifest[k] for k in keys}),
  "match": manifest["generation_id"] == ids["generation_id"] == e.fingerprint({k: manifest[k] for k in keys}),
}
checks["receipt"] = payload["receipts"][0]["receipt_id"] == ids["source_receipt_id"]
print(json.dumps(checks))
`);
  for (const key of Object.keys(out)) {
    if (key === 'receipt') assert.equal(out[key], true);
    else assert.equal(out[key].match, true, JSON.stringify(out[key]));
  }
});

test('M1 contract timeout guidance: 12s per DB request; client bound N_ops×timeout×(1+retries)', () => {
  const contract = load('contract.json');
  const limits = contract.limits;
  assert.equal(limits.supabase_http_timeout_seconds_per_request, 12);
  assert.equal(limits.vercel_function_max_duration_seconds, 60);
  assert.ok(!('engine_store_timeout_seconds' in limits));
  assert.ok(!('client_timeout_should_be_at_most_seconds' in limits));
  const g = limits.producer_timeout_retry_guidance;
  assert.match(g.per_request_client_timeout_seconds, /20s/);
  assert.match(g.retries, /identical immutable/i);
  assert.match(g.total_wall_clock, /N_ops|5 HTTP/);
  const out = runPy(`
from scripts import export_learning as e
print(__import__("json").dumps({
  "default_timeout": e.DEFAULT_HTTP_TIMEOUT_SECONDS,
  "n_ops": 5,
  "attempts_default_doc": 3,
  "bound_with_default_retries": 5 * e.DEFAULT_HTTP_TIMEOUT_SECONDS * (1 + (3 - 1)),
}))
`);
  assert.equal(out.default_timeout, 20);
  // Bound = N_ops × timeout × (1 + retry_budget); retry_budget = attempts-1 = 2 → 300s
  assert.equal(out.bound_with_default_retries, 300);
});

test('exporter plan accepts fixture snapshot layout; rejects verified_publication on capture', () => {
  const out = runPy(`
import json, tempfile, copy
from pathlib import Path
from scripts import export_learning as e
FIX = Path(${JSON.stringify(FIX)})
def materialize(root, *, publication=None):
    sources = root / "learning_sources"
    journal = root / "learning_journal" / "2026_wk06"
    sources.mkdir(parents=True); journal.mkdir(parents=True)
    for name in ("source_snapshot_leg_pool.json", "source_snapshot_schedule.json",
                 "source_snapshot_parlay_calibration.json"):
        obj = json.loads((FIX / name).read_text())
        (sources / (obj["object_id"].split(":")[1] + ".json")).write_text(
            json.dumps(obj["payload"], sort_keys=True, separators=(",", ":"), ensure_ascii=True))
    gen = json.loads((FIX / "generation_envelope.json").read_text())
    doc = copy.deepcopy(gen["payload"])
    if publication is not None:
        doc["generations"][0]["publication_status"] = publication
        doc["receipts"][0]["publication_status"] = publication
        doc["receipts"][0]["learning_receipt"]["publication_status"] = publication
        # Re-bind envelope id after mutation so hash checks stay coherent until
        # publication_status gate fires (it runs after envelope hash).
        body = {k: v for k, v in doc.items() if k != "envelope_id"}
        doc["envelope_id"] = e.fingerprint(body)
    gid = doc["generations"][0]["generation_id"].split(":")[1]
    (journal / (gid + ".json")).write_text(
        json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=True))
    return root

ok_root = Path(tempfile.mkdtemp()) / "ok"
materialize(ok_root)
plan = e.plan(ok_root)
bad_root = Path(tempfile.mkdtemp()) / "bad"
materialize(bad_root, publication="verified_publication")
try:
    e.plan(bad_root); bad = "accepted"
except e.ExportError as err:
    bad = err.args[0]
print(json.dumps({
  "sources": len(plan["source_objects"]),
  "generations": len(plan["generations"]),
  "envelope_id": plan["generations"][0]["request"]["object_id"],
  "receipt": plan["generations"][0]["expected_receipt_ids"][0],
  "bad": bad,
}))
`);
  const index = load('index.json');
  assert.equal(out.sources, 3);
  assert.equal(out.generations, 1);
  assert.equal(out.envelope_id, index.ids.envelope_id);
  assert.equal(out.receipt, index.ids.source_receipt_id);
  assert.equal(out.bad, 'capture_requires_generated_unverified');
});

test('exporter send: 5 serial HTTP ops; recorded then duplicate ACK; token gates', () => {
  const out = runPy(`
import json, tempfile, copy
from pathlib import Path
from scripts import export_learning as e
FIX = Path(${JSON.stringify(FIX)})
index = json.loads((FIX / "index.json").read_text())
TOKEN = "test-nfl-ingest-credential-" + ("a" * 32)
SHORT = "too-short-token-not-32"

def materialize(root):
    sources = root / "learning_sources"
    journal = root / "learning_journal" / "2026_wk06"
    sources.mkdir(parents=True); journal.mkdir(parents=True)
    for name in ("source_snapshot_leg_pool.json", "source_snapshot_schedule.json",
                 "source_snapshot_parlay_calibration.json"):
        obj = json.loads((FIX / name).read_text())
        (sources / (obj["object_id"].split(":")[1] + ".json")).write_text(
            json.dumps(obj["payload"], sort_keys=True, separators=(",", ":"), ensure_ascii=True))
    gen = json.loads((FIX / "generation_envelope.json").read_text())
    doc = gen["payload"]
    gid = doc["generations"][0]["generation_id"].split(":")[1]
    (journal / (gid + ".json")).write_text(
        json.dumps(doc, sort_keys=True, separators=(",", ":"), ensure_ascii=True))

snap = Path(tempfile.mkdtemp()) / "snap"
materialize(snap)
plan = e.plan(snap)
routes = []
seen_objects = set()

def transport(route, body):
    routes.append(route)
    req = json.loads(body.decode())
    if route == e.OBJECT_ROUTE:
        oid = req["object_id"]
        status = "duplicate" if oid in seen_objects else "recorded"
        seen_objects.add(oid)
        ack = {"version": 1, "object_id": oid, "durable": True, "status": status}
        return 200, json.dumps(ack, separators=(",", ":")).encode()
    if route == e.GENERATION_ROUTE:
        rid = index["ids"]["source_receipt_id"]
        # First finalize → recorded; identical-ID replay → duplicate
        status = "duplicate" if routes.count(e.GENERATION_ROUTE) > 1 else "recorded"
        ack = {"version": 1, "object_id": req["object_id"], "durable": True,
               "receipts": [{"source_receipt_id": rid, "receipt_id": "sha256:" + "b"*64, "status": status}],
               "rejections": []}
        return 200, json.dumps(ack, separators=(",", ":")).encode()
    raise AssertionError("unexpected route " + route)

out1 = Path(tempfile.mkdtemp()) / "out1"
summary = e.send(plan, "https://self-learning-beige.vercel.app", out1, TOKEN, transport=transport, attempts=1)
# Replay via cached ACKs (no new HTTP); then fresh outdir for duplicate object ACKs
out2 = Path(tempfile.mkdtemp()) / "out2"
seen_objects.clear()  # first pass records again
# Pre-seed by running once so second send hits duplicate statuses
summary2 = e.send(plan, "https://self-learning-beige.vercel.app", out2, TOKEN, transport=transport, attempts=1)
# Force object duplicates: third send to new outdir after objects already in seen_objects
out3 = Path(tempfile.mkdtemp()) / "out3"
summary3 = e.send(plan, "https://self-learning-beige.vercel.app", out3, TOKEN, transport=transport, attempts=1)

token_cases = {}
for label, tok in (("short", SHORT), ("sensitive", "[SENSITIVE]"), ("empty", "")):
    try:
        e.send(plan, "https://self-learning-beige.vercel.app", Path(tempfile.mkdtemp())/"x", tok, transport=transport)
        token_cases[label] = "accepted"
    except e.ExportError as err:
        token_cases[label] = err.args[0]

print(json.dumps({
  "routes": routes,
  "n_ops_first": 5,
  "summary_ok": summary["ok"],
  "objects": summary["objects_acked"],
  "generations": summary["generations_acked"],
  "receipts": summary["receipts_acked"],
  "summary3_ok": summary3["ok"],
  "object_statuses_third": [json.loads(p.read_text())["ack"]["status"]
    for p in sorted((out3 / e.fingerprint({"base_url": "https://self-learning-beige.vercel.app"}).split(":")[1] / "acks").glob("*.json"))
    if json.loads(p.read_text())["operation"]["phase"] == "object"],
  "finalize_statuses": [json.loads(p.read_text())["ack"]["receipts"][0]["status"]
    for p in sorted((out3 / e.fingerprint({"base_url": "https://self-learning-beige.vercel.app"}).split(":")[1] / "acks").glob("*.json"))
    if json.loads(p.read_text())["operation"]["phase"] == "generation"],
  "token_cases": token_cases,
  "engine_draft_note": ${JSON.stringify(ENGINE_DRAFT)},
  "prod_pin": ${JSON.stringify(PROD_PIN)},
}))
`);
  // First send: 3 sources + generation envelope + finalize = 5
  assert.deepEqual(out.routes.slice(0, 5), [
    '/api/v1/nfl/objects',
    '/api/v1/nfl/objects',
    '/api/v1/nfl/objects',
    '/api/v1/nfl/objects',
    '/api/v1/nfl/generations',
  ]);
  assert.equal(out.summary_ok, true);
  assert.equal(out.objects, 4);
  assert.equal(out.generations, 1);
  assert.equal(out.receipts, 1);
  assert.equal(out.summary3_ok, true);
  assert.ok(out.object_statuses_third.every((s) => s === 'duplicate'), JSON.stringify(out.object_statuses_third));
  assert.deepEqual(out.finalize_statuses, ['duplicate']);
  assert.deepEqual(out.token_cases, {
    short: 'missing_or_invalid_ingest_token',
    sensitive: 'missing_or_invalid_ingest_token',
    empty: 'missing_or_invalid_ingest_token',
  });
  assert.equal(out.prod_pin, PROD_PIN);
});

test('fixtures README pins engine draft vs prod; no permanent live POST from tests', () => {
  const readme = readFileSync(join(FIX, 'README.txt'), 'utf8');
  assert.match(readme, new RegExp(ENGINE_DRAFT));
  assert.match(readme, new RegExp(PROD_PIN));
  assert.match(readme, /Do not POST/i);
  // Pilot remains disabled on this capture draft.
  const config = JSON.parse(readFileSync(join(ROOT, 'config/selflearning_pilot.json'), 'utf8'));
  assert.equal(config.enabled, false);
  assert.equal(config.serving_mode, 'shadow');
  assert.equal(config.engine_commit, PROD_PIN);
});
