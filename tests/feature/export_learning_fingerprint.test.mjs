// Offline capture-contract checks for scripts/export_learning.py.
// Independently recomputed fingerprints; claimed engine hashes are verified here, not trusted.
// No live network. Outcome producers are asserted absent (schemas still missing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  const r = spawnSync('python3', ['-B', '-c', code], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: ROOT, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

test('export_learning.fingerprint matches independently recomputed sha256 vectors', () => {
  const out = runPy(`
import json, hashlib, inspect
from scripts import export_learning as e
def independent(v):
    b = json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode('utf-8')
    return 'sha256:' + hashlib.sha256(b).hexdigest()
claimed = {
  'null': 'sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
  'ab': 'sha256:d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772',
  'eacute': 'sha256:bca462b835df0d11fbe295ae8e0bfb14f010da4801c954734d1801e1a07400a9',
}
values = {'null': None, 'ab': {'b': 1, 'a': 2}, 'eacute': {'x': 'é'}}
got = {k: e.fingerprint(v) for k, v in values.items()}
indep = {k: independent(v) for k, v in values.items()}
src = inspect.getsource(e.send)
transport = inspect.getsource(e.http_transport)
print(json.dumps({
  'got': got, 'indep': indep, 'claimed': claimed,
  'match_claimed': got == claimed, 'match_independent': got == indep,
  'token_min32_enforced': ('len(token) < 32' in src) or ('len(token) >= 32' in src),
  'placeholder_ban': any(s in src.lower() for s in ('placeholder', 'changeme', 'todo_token')),
  'timeout_default_20': 'timeout=20' in transport,
  'has_origin_header': 'Origin' in transport,
  'max_body': e.MAX_BODY_BYTES, 'max_depth': e.MAX_JSON_DEPTH,
  'object_route': e.OBJECT_ROUTE, 'generation_route': e.GENERATION_ROUTE,
  'manifest_keys': list(e.MANIFEST_KEYS),
}))
`);
  assert.equal(out.match_independent, true, JSON.stringify(out));
  assert.equal(out.match_claimed, true, 'claimed vectors matched independent recompute');
  assert.equal(out.max_body, 3 * 1024 * 1024);
  assert.equal(out.max_depth, 24);
  assert.equal(out.object_route, '/api/v1/nfl/objects');
  assert.equal(out.generation_route, '/api/v1/nfl/generations');
  assert.equal(out.has_origin_header, false);
  assert.equal(out.timeout_default_20, true); // documented GAP vs engine 12s
  assert.equal(out.token_min32_enforced, false); // documented GAP
  assert.equal(out.placeholder_ban, false); // documented GAP
  assert.deepEqual(out.manifest_keys, [
    'version', 'season', 'week', 'pool_generated_utc', 'source_snapshots',
    'offered_cards', 'selection_policy_version', 'joint_model_version',
  ]);
});

test('export_learning JSON parser refuses duplicate keys, NaN/Inf, and over-depth', () => {
  const out = runPy(`
import json
from scripts import export_learning as e
cases = {}
for name, raw in [
  ('dup', b'{"a":1,"a":2}'),
  ('nan', b'{"x":NaN}'),
  ('inf', b'{"x":Infinity}'),
  ('depth', ('[' * 26 + '0' + ']' * 26).encode()),
]:
    try:
        e._json(raw); cases[name] = 'accepted'
    except e.ExportError as err:
        cases[name] = err.args[0]
# exact object request keys
req = e._request('source_snapshot', 'sha256:' + 'a'*64, {'k': 1})
cases['object_keys'] = sorted(req.keys())
print(json.dumps(cases))
`);
  assert.equal(out.dup, 'duplicate_json_key');
  assert.ok(['nonfinite_json', 'invalid_json'].includes(out.nan), out.nan);
  assert.ok(['nonfinite_json', 'invalid_json'].includes(out.inf), out.inf);
  assert.equal(out.depth, 'invalid_json');
  assert.deepEqual(out.object_keys, ['kind', 'object_id', 'payload', 'version']);
});

test('no NFL outcome capture-chunk/delivery producer invents missing schemas', () => {
  const banned = /capture-chunks|capture-deliveries|SELFLEARN_NFL_OUTCOME_INGEST_TOKEN|learning_accepted|nfl\.capture_delivery_request/;
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name);
      const full = join(ROOT, rel);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === '.git' || name === 'docs') continue;
        walk(rel);
        continue;
      }
      if (!/\.(py|mjs|js|yml)$/.test(name)) continue;
      // Inventory/docs under docs/pilot may name the gaps; code must not implement invented fields.
      if (banned.test(readFileSync(full, 'utf8'))) hits.push(rel);
    }
  };
  for (const d of ['scripts', 'app', '.github', 'tests', 'config']) walk(d);
  // Allow this test file and the corrections inventory doc path is under docs (skipped).
  assert.deepEqual(hits.filter((h) => !h.endsWith('export_learning_fingerprint.test.mjs')), []);
});
