// Offline proof that shadow capture / evaluation wiring cannot change served
// forecast bytes. Does NOT prove hosted SelfLearning persistence or future
// accuracy. Capture stays disabled in committed config; learned adoption stays
// off the serving path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PIN = 'aacb19c73122f257449e977df40f2a2733991b2f';

// Forecast / pick / pricing surfaces that Netlify serves from data/.
const SERVED = [
  'game_predictions.json',
  'player_projections.json',
  'leg_pool.json',
  'parlays.json',
  'parlay_leg_scores.json',
  'my_card_scores.json',
  'atd_cards.json',
  'atd_game_cards.json',
  'market_prices.json',
  'learning_loops.json',
];

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function servedFingerprints() {
  const out = {};
  for (const name of SERVED) {
    const path = join(ROOT, 'data', name);
    assert.ok(statSync(path).isFile(), name);
    out[name] = sha256(path);
  }
  return out;
}

function runPy(code) {
  const result = spawnSync('python3', ['-B', '-'], {
    cwd: ROOT,
    input: code,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: ROOT, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('committed pilot keeps capture OFF, shadow-only serving, and the pinned engine', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'config/selflearning_pilot.json'), 'utf8'));
  assert.equal(config.enabled, false);
  assert.equal(config.serving_mode, 'shadow');
  assert.equal(config.engine_commit, PIN);
  const resolved = JSON.parse(execFileSync('python3', ['-B', 'scripts/pilot_config.py'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  }).trim());
  assert.equal(resolved.enabled, '0');
  assert.equal(resolved.serving_mode, 'shadow');
  assert.equal(resolved.engine_commit, PIN);
  assert.equal(resolved.production_authorized, false);
  assert.equal(resolved.model_approval_recorded, false);
});

test('served forecast fingerprints are unchanged by dry-run and external-workspace capture', () => {
  const before = servedFingerprints();
  const workspace = mkdtempSync(join(tmpdir(), 'nfl-shadow-'));
  try {
    const r = runPy(`
import json, pathlib, tempfile
from scripts import pilot_capture as pc
from tests.fixtures import week6_outcomes as F
with tempfile.TemporaryDirectory() as d:
    _, pool, schedule = F.generation(pathlib.Path(d))
preview = pc.capture_generation(pool, schedule, None, clock=lambda: F.RECORDED)
recorded = pc.capture_generation(pool, schedule, None, workspace=${JSON.stringify(workspace)},
    execute=True, clock=lambda: F.RECORDED)
print(json.dumps({"preview_writes": preview["writes"], "recorded_writes": recorded["writes"],
    "learning_enabled": recorded["learning_enabled"], "serving_mode": recorded["serving_mode"],
    "production_authorized": recorded["production_authorized"], "network_used": recorded["network_used"],
    "workspace_under_checkout": pathlib.Path(${JSON.stringify(workspace)}).resolve().is_relative_to(pc.ROOT)}))
`);
    assert.equal(r.preview_writes, false);
    assert.equal(r.recorded_writes, true);
    assert.equal(r.learning_enabled, false);
    assert.equal(r.serving_mode, 'shadow');
    assert.equal(r.production_authorized, false);
    assert.equal(r.network_used, false);
    assert.equal(r.workspace_under_checkout, false);
    assert.deepEqual(servedFingerprints(), before);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('capture and export refuse writing into the checkout data tree (fail closed)', () => {
  const before = servedFingerprints();
  const r = runPy(`
import json, os, pathlib, tempfile
from scripts import pilot_capture as pc, export_learning as export
out = {}
try:
    pc.workspace_root(pc.ROOT / "data")
    out["workspace"] = "accepted"
except pc.PilotCaptureError as e:
    out["workspace"] = e.args[0]
try:
    export.send({"snapshot_dir": str(pc.ROOT / "data"), "source_objects": [], "generations": []},
                "https://self-learning-beige.vercel.app", str(pc.ROOT / "data"), "t" * 32)
    out["export"] = "accepted"
except export.ExportError as e:
    out["export"] = e.args[0]
print(json.dumps(out))
`);
  assert.equal(r.workspace, 'pilot_workspace_overlaps_checkout');
  assert.equal(r.export, 'delivery_directory_overlaps_sports_data');
  assert.deepEqual(servedFingerprints(), before);
});

test('no production builder, app surface, or betting path imports the self-learning pilot', () => {
  const banned = /pilot_capture|pilot_config|selflearning_pilot|inactive_confirmation|export_learning|learning_journal|capture_outcome_evidence|run_parlay_feedback/;
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, name);
      const full = join(ROOT, rel);
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === '.git') continue;
        walk(rel);
        continue;
      }
      if (!/\.(js|mjs|py|html)$/.test(name)) continue;
      if (rel.startsWith(join('scripts', 'pilot_')) || [
        'inactive_confirmation.py', 'learning_journal.py', 'export_learning.py',
        'capture_outcome_evidence.py', 'run_parlay_feedback.py', 'learning_history_guard.py',
        'pilot_config.py', 'pilot_capture.py',
      ].map((n) => join('scripts', n)).includes(rel)) continue;
      if (banned.test(readFileSync(full, 'utf8'))) hits.push(rel);
    }
  };
  for (const d of ['app', 'scripts']) walk(d);
  assert.ok(!banned.test(readFileSync(join(ROOT, 'index.html'), 'utf8')));
  assert.deepEqual(hits, []);
});

test('workflow stays a no-op while enabled=0 and never writes the repo', () => {
  const source = readFileSync(join(ROOT, '.github/workflows/selflearning-shadow-capture.yml'), 'utf8');
  assert.match(source, /if: steps\.pilot\.outputs\.enabled == '1'/);
  assert.match(source, /Report disabled pilot/);
  assert.doesNotMatch(source, /contents: write|git push|git commit|netlify|vercel deploy/i);
  // Committed config is the merge-time truth; kill-switch vars are optional later.
  const config = JSON.parse(readFileSync(join(ROOT, 'config/selflearning_pilot.json'), 'utf8'));
  assert.equal(config.enabled, false);
});
