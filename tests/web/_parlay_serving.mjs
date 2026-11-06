/* Shared Playwright helper for R1 fail-closed parlay serving.
 *
 * getParlays() loads corrections_serving.json + parlays.baseline.json (and
 * active only when mode=on). Stubbing only /data/parlays.json leaves the
 * committed OFF flag bound to the real baseline, so the fixture never paints.
 * Always route the OFF triad together with matching content ids / run_id.
 */
import {
  contentId, expectedRunId, BASELINE_PATH, ACTIVE_PATH, FLAG_PATH,
} from '../../app/parlay-serving.js';

/** Build a default-OFF corrections_serving.json bound to `parlaysDoc`. */
export async function offServingFlag(parlaysDoc) {
  const cid = await contentId(parlaysDoc);
  const stamp = parlaysDoc.updated_utc;
  const flag = {
    version: 1,
    mode: 'off',
    updated_utc: stamp,
    generation_id: stamp,
    baseline_path: BASELINE_PATH,
    active_path: ACTIVE_PATH,
    baseline_content_id: cid,
    active_content_id: cid,
    expires_at: null,
    engine_contract_head: '5941214178254df38a1c67b5935e591bfb052e33',
    note: 'fail_closed_default_off_not_an_activation',
  };
  flag.run_id = await expectedRunId(flag);
  return flag;
}

/**
 * Route flag + baseline + active so getParlays serves `parlaysDoc` under OFF.
 * Uses Playwright `json:` fulfill when `asJson` is true (default); otherwise
 * calls `fulfill(route, bodyString)` for suites that share a custom helper.
 */
export async function routeOffParlayServing(page, parlaysDoc, {
  asJson = true,
  fulfill = null,
} = {}) {
  const flag = await offServingFlag(parlaysDoc);
  const body = (doc) => (typeof doc === 'string' ? doc : JSON.stringify(doc));
  if (asJson && !fulfill) {
    await page.route(`**${FLAG_PATH}*`, (r) => r.fulfill({ json: flag }));
    await page.route(`**${BASELINE_PATH}*`, (r) => r.fulfill({ json: parlaysDoc }));
    await page.route(`**${ACTIVE_PATH}*`, (r) => r.fulfill({ json: parlaysDoc }));
    return flag;
  }
  const send = fulfill || ((route, raw) => route.fulfill({
    status: 200, contentType: 'application/json', body: raw,
  }));
  await page.route(`**${FLAG_PATH}*`, (r) => send(r, body(flag)));
  await page.route(`**${BASELINE_PATH}*`, (r) => send(r, body(parlaysDoc)));
  await page.route(`**${ACTIVE_PATH}*`, (r) => send(r, body(parlaysDoc)));
  return flag;
}
