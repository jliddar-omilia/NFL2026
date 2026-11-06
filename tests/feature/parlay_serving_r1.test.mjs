// R1 fail-closed parlay serving (baseline / active / flag). Not an activation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contentId, expectedRunId, resolveParlayServing, loadServedParlays,
  BASELINE_PATH, ACTIVE_PATH, FLAG_PATH,
} from '../../app/parlay-serving.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = '2026-11-06T10:15:24Z';

const baseline = {
  season: 2026, week: 9, updated_utc: NOW,
  parlays: [{ parlay_id: 'g1', legs: [{ model_prob: 0.4 }] }],
};
const adjusted = {
  ...baseline,
  parlays: [{ parlay_id: 'g1', legs: [{ model_prob: 0.69 }] }],
};

async function flagFor(mode, baselineDoc, activeDoc) {
  const baseline_content_id = await contentId(baselineDoc);
  const active_content_id = await contentId(activeDoc);
  const body = {
    version: 1,
    mode,
    updated_utc: NOW,
    generation_id: baselineDoc.updated_utc,
    baseline_path: BASELINE_PATH,
    active_path: ACTIVE_PATH,
    baseline_content_id,
    active_content_id,
    expires_at: null,
    engine_contract_head: '5941214178254df38a1c67b5935e591bfb052e33',
    note: 'fail_closed_default_off_not_an_activation',
  };
  body.run_id = await expectedRunId(body);
  return body;
}

test('committed data ships OFF serving triad (baseline == active)', async () => {
  const flagPath = join(ROOT, 'data/corrections_serving.json');
  const baselinePath = join(ROOT, 'data/parlays.baseline.json');
  const activePath = join(ROOT, 'data/parlays.json');
  assert.equal(existsSync(flagPath), true);
  assert.equal(existsSync(baselinePath), true);
  assert.equal(existsSync(activePath), true);
  const flag = JSON.parse(readFileSync(flagPath, 'utf8'));
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const active = JSON.parse(readFileSync(activePath, 'utf8'));
  assert.equal(flag.mode, 'off');
  assert.equal(flag.version, 1);
  assert.equal(await contentId(base), flag.baseline_content_id);
  assert.equal(await contentId(active), flag.active_content_id);
  assert.equal(flag.baseline_content_id, flag.active_content_id);
  assert.equal(flag.run_id, await expectedRunId(flag));
});

test('resolve: off/shadow serve baseline; on serves active only when bound', async () => {
  const off = await flagFor('off', baseline, baseline);
  const shadow = await flagFor('shadow', baseline, baseline);
  const on = await flagFor('on', baseline, adjusted);

  const rOff = await resolveParlayServing(off, baseline, adjusted);
  assert.equal(rOff.ok, true);
  assert.equal(rOff.reason, 'flag_off');
  assert.equal(rOff.doc, baseline);

  const rShadow = await resolveParlayServing(shadow, baseline, adjusted);
  assert.equal(rShadow.ok, true);
  assert.equal(rShadow.reason, 'flag_shadow_serve_baseline');
  assert.equal(rShadow.doc, baseline);

  const rOn = await resolveParlayServing(on, baseline, adjusted);
  assert.equal(rOn.ok, true);
  assert.equal(rOn.reason, 'flag_on');
  assert.equal(rOn.doc, adjusted);
});

test('resolve fail-closed: missing flag/baseline, run_id mismatch, mixed generation', async () => {
  assert.equal((await resolveParlayServing(null, baseline, adjusted)).reason, 'flag_missing_or_malformed');
  assert.equal((await resolveParlayServing({ version: 1, mode: 'on' }, null, adjusted)).reason, 'baseline_unavailable');

  const on = await flagFor('on', baseline, adjusted);
  const badRun = { ...on, run_id: 'sha256:' + '0'.repeat(64) };
  assert.equal((await resolveParlayServing(badRun, baseline, adjusted)).reason, 'run_id_mismatch');

  const mixedActive = { ...adjusted, updated_utc: '2026-11-06T11:00:00Z' };
  const mixedFlag = await flagFor('on', baseline, mixedActive);
  // Force generation_id to baseline stamp while active differs.
  mixedFlag.generation_id = baseline.updated_utc;
  mixedFlag.run_id = await expectedRunId(mixedFlag);
  assert.equal(
    (await resolveParlayServing(mixedFlag, baseline, mixedActive)).reason,
    'mixed_generation_active_baseline',
  );
});

test('loadServedParlays: OFF never fetches active; ON fail-closed if active missing', async () => {
  const off = await flagFor('off', baseline, baseline);
  const paths = {};
  const loader = async (path) => {
    paths[path] = (paths[path] || 0) + 1;
    if (path === FLAG_PATH) return off;
    if (path === BASELINE_PATH) return baseline;
    throw new Error('should not load active when off');
  };
  const r = await loadServedParlays(loader);
  assert.equal(r.ok, true);
  assert.equal(r.doc, baseline);
  assert.equal(paths[ACTIVE_PATH], undefined);

  const on = await flagFor('on', baseline, adjusted);
  const loaderOn = async (path) => {
    if (path === FLAG_PATH) return on;
    if (path === BASELINE_PATH) return baseline;
    throw new Error('active missing');
  };
  const rOn = await loadServedParlays(loaderOn);
  assert.equal(rOn.ok, false);
  assert.equal(rOn.reason, 'active_unavailable_while_on');
  assert.equal(rOn.doc, null);
});

test('propagation caveat lock: SWR120 is not a global revoke upper bound', () => {
  const src = readFileSync(join(ROOT, 'app/parlay-serving.js'), 'utf8');
  assert.match(src, /NOT globally bounded|offline|open-tab|stale-while-revalidate/i);
  const dataSrc = readFileSync(join(ROOT, 'app/data.js'), 'utf8');
  assert.match(dataSrc, /loadServedParlays/);
  assert.match(dataSrc, /NOT a global revoke bound|open-tab/i);
});
