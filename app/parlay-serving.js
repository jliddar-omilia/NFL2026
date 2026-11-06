/* R1 draft: fail-closed parlay serving (baseline / active / flag).
 *
 * NOT an activation. Default deny. Never serves adjusted active when the flag
 * is missing/malformed/expired/unreachable, when baseline mismatches, or when
 * baseline is unavailable (safe unavailable beats unapproved adjustments).
 * run_id binding rejects mixed-generation artifacts across non-atomic deploys.
 *
 * Deploy/CDN/client lag is NOT instant and NOT globally bounded. This module
 * cannot revoke offline, stale-while-revalidate, or open-tab in-memory copies.
 */

export const BASELINE_PATH = '/data/parlays.baseline.json';
export const ACTIVE_PATH = '/data/parlays.json';
export const FLAG_PATH = '/data/corrections_serving.json';

const MODES = new Set(['off', 'shadow', 'on']);

/** Canonical JSON matching Python json.dumps(sort_keys=True, separators=(',',':'), ensure_ascii=True). */
export function canonicalStringify(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('nonfinite_json');
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(',')}]`;
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
  }
  throw new Error('unsupported_json_type');
}

async function sha256Hex(bytes) {
  if (globalThis.crypto?.subtle) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Node --test / gate (no SubtleDigest on some builds): node:crypto only.
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

export async function contentId(value) {
  const raw = canonicalStringify(value);
  const bytes = new TextEncoder().encode(raw);
  return `sha256:${await sha256Hex(bytes)}`;
}

export async function expectedRunId(flag) {
  return contentId({
    generation_id: flag.generation_id,
    mode: flag.mode,
    baseline_content_id: flag.baseline_content_id,
    active_content_id: flag.active_content_id,
  });
}

/**
 * Pure async resolver. Returns { ok, reason, doc } — doc null = safe unavailable.
 * Never returns active when baseline is missing or flag is untrustworthy.
 */
export async function resolveParlayServing(flag, baselineDoc, activeDoc, { nowIso = null } = {}) {
  if (!flag || typeof flag !== 'object' || flag.version !== 1) {
    return { ok: false, reason: 'flag_missing_or_malformed', doc: null };
  }
  if (!MODES.has(flag.mode)) {
    return { ok: false, reason: 'flag_mode_invalid', doc: null };
  }
  if (!baselineDoc || typeof baselineDoc !== 'object') {
    return { ok: false, reason: 'baseline_unavailable', doc: null };
  }
  let baselineId;
  try {
    baselineId = await contentId(baselineDoc);
  } catch {
    return { ok: false, reason: 'baseline_unavailable', doc: null };
  }
  if (flag.baseline_content_id !== baselineId) {
    return { ok: false, reason: 'baseline_content_mismatch', doc: null };
  }
  if (flag.expires_at != null) {
    const exp = Date.parse(flag.expires_at);
    const now = nowIso ? Date.parse(nowIso) : Date.now();
    if (!Number.isFinite(exp) || !Number.isFinite(now) || !(now < exp)) {
      return { ok: false, reason: 'flag_expired', doc: null };
    }
  }
  if (flag.run_id !== await expectedRunId(flag)) {
    return { ok: false, reason: 'run_id_mismatch', doc: null };
  }
  const gen = flag.generation_id;
  if (typeof gen !== 'string' || !gen) {
    return { ok: false, reason: 'generation_mismatch', doc: null };
  }
  if (gen !== baselineDoc.updated_utc && gen !== baselineDoc.generation_id) {
    return { ok: false, reason: 'generation_mismatch', doc: null };
  }
  if (flag.mode === 'off' || flag.mode === 'shadow') {
    return {
      ok: true,
      reason: flag.mode === 'off' ? 'flag_off' : 'flag_shadow_serve_baseline',
      doc: baselineDoc,
    };
  }
  if (!activeDoc || typeof activeDoc !== 'object') {
    return { ok: false, reason: 'active_unavailable_while_on', doc: null };
  }
  let activeId;
  try {
    activeId = await contentId(activeDoc);
  } catch {
    return { ok: false, reason: 'active_unavailable_while_on', doc: null };
  }
  if (flag.active_content_id !== activeId) {
    return { ok: false, reason: 'active_content_mismatch', doc: null };
  }
  if (activeDoc.updated_utc !== baselineDoc.updated_utc) {
    return { ok: false, reason: 'mixed_generation_active_baseline', doc: null };
  }
  if (gen !== activeDoc.updated_utc && gen !== activeDoc.generation_id) {
    return { ok: false, reason: 'generation_mismatch', doc: null };
  }
  return { ok: true, reason: 'flag_on', doc: activeDoc };
}

/** loader(path) -> Promise<json>; reject on transport failure. */
export async function loadServedParlays(loader, { nowIso = null } = {}) {
  let flag;
  try {
    flag = await loader(FLAG_PATH);
  } catch {
    return { ok: false, reason: 'flag_unreachable', doc: null };
  }
  let baseline;
  try {
    baseline = await loader(BASELINE_PATH);
  } catch {
    return { ok: false, reason: 'baseline_unavailable', doc: null };
  }
  let active = null;
  if (flag && flag.mode === 'on') {
    try {
      active = await loader(ACTIVE_PATH);
    } catch {
      active = null;
    }
  }
  return resolveParlayServing(flag, baseline, active, { nowIso });
}
