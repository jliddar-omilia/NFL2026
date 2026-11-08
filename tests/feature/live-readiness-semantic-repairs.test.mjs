/* Live-readiness semantic repairs (draft): inactive evidence honesty,
 * neutral-site HFA, Polymarket series≠game moneyline, and lock-byte
 * invariance. Pure offline checks against pinned helpers — no network,
 * no data regeneration, no learning activation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: ROOT },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (st.isFile() && st.size < 60_000_000) out.push(p);
  }
  return out;
}

test('inactive: DNP observation never confirms; active=false unused; empty≠all-active; fail-closed offers', () => {
  const r = runPy(`
import json, datetime as dt
from scripts import inactive_confirmation as ic
from scripts.scrape.espn import parse_game_roster

# active=false alone emits nothing
assert parse_game_roster([
  {"playerId": 1, "active": False},
  {"playerId": 2, "didNotPlay": False, "active": False},
  {"playerId": 3, "didNotPlay": True, "active": False, "displayName": "X"},
]) == [{"espn_id": "3", "name": "X"}]

G = {"game_id": "401873038", "home": "ATL", "away": "CIN", "kickoff_utc": "2026-11-08T14:30Z"}
now = dt.datetime(2026, 11, 8, 13, 0, tzinfo=dt.timezone.utc)
doc = {"games": [{"game_id": "401873038", "home": "ATL", "away": "CIN",
  "kickoff_utc": "2026-11-08T14:30Z", "fetched_utc": "2026-11-08T12:59:02Z",
  "inactive": {"ATL": [{"espn_id": "14012", "name": "Dalton"}], "CIN": []},
  "evidence_kind": "observation", "confirmation": "unconfirmed",
  "team_coverage": {
    "ATL": {"coverage": "unknown", "complete": False, "dnp_rows": 1,
            "source_profile": "espn_core_roster_didnotplay_v1"},
    "CIN": {"coverage": "unknown", "complete": False, "dnp_rows": 0,
            "source_profile": "espn_core_roster_didnotplay_v1"}}}]}
obs = ic.espn_observations(doc)
assert all(e["confirmation"] == "unconfirmed" and e["complete"] is False
           and e["coverage"] == "unknown" for e in obs["401873038"])
cin = next(e for e in obs["401873038"] if e["team"] == "CIN")
assert cin["dnp_rows"] == 0 and cin["inactive_ids"] == []

# Observation-only profile never validates as confirmation
ok, reason = ic.validate_evidence({
  "source_profile": "espn_core_roster_didnotplay_v1", "game_id": G["game_id"],
  "home": "ATL", "away": "CIN", "kickoff_utc": G["kickoff_utc"], "team": "ATL",
  "posted_utc": "2026-11-08T13:00:00Z", "fetched_utc": "2026-11-08T13:00:00Z",
  "complete": True, "inactive_ids": ["14012"], "active_ids": ["999"],
  "raw_sha256": "a" * 64}, G, now)
assert ok is False and reason == "observation_only_source"

# Fail-closed recommendation eligibility after T-90 without official source
el = ic.recommendation_eligibility("14012", "ATL", G, now, obs["401873038"],
                                   require_confirmed=True)
assert el["eligible"] is False and el["state"] == "unknown_or_stale"

cov = ic.team_coverage_from_observation(doc["games"][0], "CIN")
assert cov["complete"] is False and cov["coverage"] == "unknown" and cov["dnp_rows"] == 0

print(json.dumps({"ok": True, "cin_empty_all_active": False, "dnp_confirmed": False}))
`);
  assert.equal(r.ok, true);
  assert.equal(r.cin_empty_all_active, false);
  assert.equal(r.dnp_confirmed, false);
});

test('neutralSite=true zeros ordinary HFA; ordinary/absent unchanged; weather refuses unbound', () => {
  const r = runPy(`
import json
from scripts.home_field import home_field_elo, is_neutral_site, neutral_site_flag
from scripts.weather_source_contract import target
from scripts.models.game_model import predict_game

ordinary = {"game_id": "1", "home": "DAL", "away": "IND", "kickoff_utc": "2026-11-08T18:00Z",
            "roof": "outdoor", "home_elo": 1500, "away_elo": 1500, "hfa_elo": 65,
            "neutral_site": False}
absent = {"game_id": "2", "home": "DAL", "away": "IND", "kickoff_utc": "2026-11-08T18:00Z",
          "roof": "outdoor", "home_elo": 1500, "away_elo": 1500, "hfa_elo": 65}
neutral = {"game_id": "401873038", "home": "ATL", "away": "CIN",
           "kickoff_utc": "2026-11-08T14:30Z", "roof": "indoor",
           "venue": "Santiago Bernabeu", "home_elo": 1500, "away_elo": 1500,
           "hfa_elo": 65, "neutral_site": True}
malformed = {**ordinary, "neutral_site": "yes"}

assert home_field_elo(ordinary, 65.0, venue_delta=3.0, cold_delta=1.0) == 69.0
assert home_field_elo(absent, 65.0, venue_delta=3.0, cold_delta=1.0) == 69.0
assert home_field_elo(neutral, 65.0, venue_delta=3.0, cold_delta=1.0) == 0.0
assert home_field_elo(malformed, 65.0, venue_delta=3.0, cold_delta=1.0) == 0.0
assert is_neutral_site(neutral) is True and neutral_site_flag(absent) is None

# Predict: neutral does not invent home-stadium roof when roof missing
bare_neutral = {"game_id": "x", "home": "ATL", "away": "CIN",
                "kickoff_utc": "2026-11-08T14:30Z", "neutral_site": True,
                "home_elo": 1500, "away_elo": 1500, "hfa_elo": 0}
pred = predict_game(bare_neutral, teams=None, model="elo_prior")
assert pred["roof"] == "outdoor"

# Weather: explicit neutral refuses without reviewed venue evidence
bind, reason = target(2026, {
  "game_id": "401873038", "home": "ATL", "away": "CIN", "week": 9,
  "kickoff_utc": "2026-11-08T14:30Z", "venue": "Santiago Bernabeu",
  "neutral_site": True})
assert bind is None and reason == "weather_neutral_venue_unbound"

# Venue mismatch (Madrid vs Mercedes-Benz) also refuses without inventing weather
bind2, reason2 = target(2026, {
  "game_id": "401873038", "home": "ATL", "away": "CIN", "week": 9,
  "kickoff_utc": "2026-11-08T14:30Z", "venue": "Santiago Bernabeu",
  "neutral_site": False})
assert bind2 is None and reason2 == "weather_actual_venue_unbound"

print(json.dumps({"ok": True, "ordinary_hfa": 69.0, "neutral_hfa": 0.0}))
`);
  assert.equal(r.ok, true);
  assert.equal(r.ordinary_hfa, 69);
  assert.equal(r.neutral_hfa, 0);
});

test('Polymarket season-series/futures never join as single-game moneyline; display_only retained', () => {
  const r = runPy(`
import json
from scripts.scrape import polymarket_nfl as pm
from scripts.build_markets import date_near

assert pm.game_market_title_ok("Pro Football: Eagles vs. Giants Season Series Winner") is False
assert pm.game_market_title_ok("Chiefs vs. Bills") is True
assert pm.game_market_title_ok("Will the Bills win the 2027 championship") is False
assert pm.game_market_title_ok("Bills vs Jets Super Bowl futures") is False

# Join simulation: series title + team overlap must not attach without date bind
schedule = [
  {"game_id": "past", "home": "WAS", "away": "NYG", "kickoff_utc": "2026-10-11T17:00Z"},
  {"game_id": "today", "home": "PHI", "away": "NYG", "kickoff_utc": "2026-11-08T18:00Z"},
]
title = "Pro Football: Eagles vs. Giants Season Series Winner"
assert pm.game_market_title_ok(title) is False

# Exact-game path requires end_date near kickoff; missing date withholds
assert date_near("2026-11-08T18:00Z", "2026-11-08") is True
assert date_near("2026-11-08T18:00Z", "2026-10-11") is False

doc = json.load(open("data/market_prices.json", encoding="utf-8"))
assert doc["display_only"] is True
# Served artifact may still contain pre-fix series rows; the producer filter
# is what this draft changes. Prove the filter would drop every Season Series slug.
series = 0
for row in (doc.get("games") or {}).values():
  slug = ((row.get("polymarket") or {}).get("slug") or "")
  if "season series" in slug.lower():
    series += 1
    assert pm.game_market_title_ok(slug) is False
print(json.dumps({"ok": True, "served_series_rows_blocked_by_filter": series,
                  "display_only": True}))
`);
  assert.equal(r.ok, true);
  assert.equal(r.display_only, true);
  assert.ok(r.served_series_rows_blocked_by_filter >= 0);
});

test('historical lock/archive/receipt bytes unchanged by this draft (idempotent hash proof)', () => {
  // Prove this draft did not modify served/lock artifacts: working tree bytes
  // for data/** must match the committed HEAD blob (git). Re-hash twice for
  // idempotence. Schemas/scripts/tests may change; data receipts must not.
  const pinned = [
    'data/game_predictions.json',
    'data/inactives.json', // optional: absent outside the inactives window
    'data/market_prices.json',
    'data/parlays.json',
    'data/parlays/index.json',
    'data/parlays/2026_wk09.json',
    'data/schedule_full.json',
    'data/weather_forecast.json',
    'data/learning_loops.json',
    'data/review.json',
    'data/pipeline_status.json',
    'data/my_card_scores.json',
  ];
  const tracked = new Set(execFileSync('git', ['ls-files', 'data'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim().split('\n').filter(Boolean));
  // Compare git blob ids (not file bytes in Node) so large receipts stay in-process.
  const headBlob = (rel) => execFileSync('git', ['rev-parse', `HEAD:${rel}`], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  const workBlob = (rel) => execFileSync('git', ['hash-object', rel], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  const after = {};
  const check = (rel) => {
    if (!tracked.has(rel)) return;
    const a = workBlob(rel);
    const b = headBlob(rel);
    assert.equal(a, b, `${rel} working-tree drift vs HEAD`);
    after[rel] = a;
  };
  for (const rel of pinned) check(rel);
  for (const dir of ['data/parlays', 'data/my_cards', 'data/atd_cards', 'data/atd_my_cards']) {
    for (const p of walkFiles(join(ROOT, dir))) {
      check(p.slice(ROOT.length + 1).replace(/\\/g, '/'));
    }
  }
  for (const [rel, blob] of Object.entries(after)) {
    assert.equal(workBlob(rel), blob, `${rel} non-idempotent`);
  }
  // Diff scope guard: no data/** path outside contracts/ is in this commit.
  const changed = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);
  const dataHits = changed.filter((p) => p.startsWith('data/') && !p.startsWith('data/contracts/'));
  assert.deepEqual(dataHits, [], `unexpected data mutations: ${dataHits.join(',')}`);
  assert.ok(Object.keys(after).length >= 8);
});
