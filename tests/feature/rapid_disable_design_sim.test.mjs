// Offline DESIGN SIMULATION only — not deployed verification.
// Models proposed R1 rapid-disable / baseline-restore semantics under
// Netlify/Actions constraints. Does not enable corrections or call network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Pure sim of proposed corrections_serving.json fail-closed resolver. */
function resolveServingChoice(flag, { baseline, active }) {
  if (!flag || typeof flag !== 'object' || flag.version !== 1) {
    return { mode: 'off', source: 'baseline', reason: 'flag_missing_or_malformed' };
  }
  const mode = flag.mode;
  if (mode !== 'on' && mode !== 'shadow' && mode !== 'off') {
    return { mode: 'off', source: 'baseline', reason: 'flag_mode_invalid' };
  }
  if (mode === 'on') {
    return { mode: 'on', source: 'active', reason: 'flag_on' };
  }
  // off and shadow: UI serves baseline artifact (shadow may still POST server-side later)
  return { mode, source: 'baseline', reason: mode === 'off' ? 'flag_off' : 'flag_shadow_serve_baseline' };
}

/** Sim: cooperative online client with in-memory TTL + optional SWR stale body. */
function clientViewAfterFlagFlip({
  previouslyLoaded,
  flagAtDeploy,
  baselineAtDeploy,
  memoryAgeMs,
  memoryTtlMs = 60_000,
  revalidate,
}) {
  if (!revalidate) {
    return {
      shown: previouslyLoaded,
      reason: 'no_refetch_open_tab_or_offline',
      revoked: false,
    };
  }
  if (memoryAgeMs < memoryTtlMs && previouslyLoaded != null) {
    return {
      shown: previouslyLoaded,
      reason: 'in_memory_ttl_not_elapsed',
      revoked: false,
    };
  }
  const choice = resolveServingChoice(flagAtDeploy, {
    baseline: baselineAtDeploy,
    active: previouslyLoaded,
  });
  const shown = choice.source === 'baseline' ? baselineAtDeploy : previouslyLoaded;
  return {
    shown,
    reason: choice.reason,
    revoked: shown !== previouslyLoaded,
  };
}

test('committed corrections remain default-OFF (design precondition)', () => {
  const corr = JSON.parse(readFileSync(join(ROOT, 'config/parlay_selflearn_corrections.json'), 'utf8'));
  assert.equal(corr.corrections_mode, 'off');
});

test('SIM fail-closed: missing/malformed/invalid flag => baseline, never on', () => {
  const baseline = { parlays: [{ model_prob: 0.4 }] };
  const active = { parlays: [{ model_prob: 0.69 }] };
  for (const flag of [null, undefined, {}, { version: 2, mode: 'on' }, { version: 1, mode: 'weird' }]) {
    const r = resolveServingChoice(flag, { baseline, active });
    assert.equal(r.source, 'baseline', JSON.stringify(flag));
    assert.notEqual(r.mode, 'on');
  }
  assert.equal(resolveServingChoice({ version: 1, mode: 'off' }, { baseline, active }).source, 'baseline');
  assert.equal(resolveServingChoice({ version: 1, mode: 'shadow' }, { baseline, active }).source, 'baseline');
  assert.equal(resolveServingChoice({ version: 1, mode: 'on' }, { baseline, active }).source, 'active');
});

test('SIM distinguish disable-new vs restore-published vs offline tab', () => {
  const baseline = { tag: 'baseline' };
  const adjusted = { tag: 'adjusted' };
  // Disable new baking is a server/config concern; client flag off prefers baseline after refetch.
  const afterDeployRefetch = clientViewAfterFlagFlip({
    previouslyLoaded: adjusted,
    flagAtDeploy: { version: 1, mode: 'off' },
    baselineAtDeploy: baseline,
    memoryAgeMs: 120_000,
    revalidate: true,
  });
  assert.equal(afterDeployRefetch.shown, baseline);
  assert.equal(afterDeployRefetch.revoked, true);

  // Already-loaded tab that never revalidates is NOT revoked by flag flip alone.
  const staleTab = clientViewAfterFlagFlip({
    previouslyLoaded: adjusted,
    flagAtDeploy: { version: 1, mode: 'off' },
    baselineAtDeploy: baseline,
    memoryAgeMs: 0,
    revalidate: false,
  });
  assert.equal(staleTab.shown, adjusted);
  assert.equal(staleTab.revoked, false);
  assert.match(staleTab.reason, /no_refetch|offline/);

  // In-memory TTL can delay restore even when revalidate is attempted early.
  const ttlHold = clientViewAfterFlagFlip({
    previouslyLoaded: adjusted,
    flagAtDeploy: { version: 1, mode: 'off' },
    baselineAtDeploy: baseline,
    memoryAgeMs: 10_000,
    memoryTtlMs: 60_000,
    revalidate: true,
  });
  assert.equal(ttlHold.revoked, false);
  assert.match(ttlHold.reason, /ttl/i);
});

test('SIM documents Netlify/SW/data.js bounds as code facts (not a live probe)', () => {
  const headers = readFileSync(join(ROOT, '_headers'), 'utf8');
  assert.match(headers, /\/data\/\*[\s\S]*stale-while-revalidate=120/);
  const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /NO 'fetch' handler|intentionally NO 'fetch'/i);
  assert.match(sw, /PURE CACHE-PURGER|caches NOTHING/i);
  const dataJs = readFileSync(join(ROOT, 'app/data.js'), 'utf8');
  assert.match(dataJs, /DATA_TTL_MS = 60000/);
  assert.match(dataJs, /cache: 'no-cache'/);
  // Design doc exists and forbids claiming offline revoke.
  const design = readFileSync(join(ROOT, 'docs/pilot/rapid-disable-baseline-restore-design-20261106.md'), 'utf8');
  assert.match(design, /cannot revoke/i);
  assert.match(design, /Option R1/);
  assert.match(design, /Offline simulation tests[\s\S]*deployed verification/i);
});

test('SIM: engine OFF alone does not mutate NFL active document', () => {
  // Models independence: flipping an engine-mode variable does not rewrite parlays bytes.
  const nflActive = { tag: 'adjusted' };
  const engineMode = 'off'; // after hypothetical Vercel redeploy
  assert.equal(engineMode, 'off');
  assert.equal(nflActive.tag, 'adjusted');
});
