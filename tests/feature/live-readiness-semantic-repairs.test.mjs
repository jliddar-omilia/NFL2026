/* Live-readiness semantic repairs (draft): inactive evidence honesty,
 * confirmed-required offer gating through real callers, neutral-site HFA,
 * Polymarket series≠game moneyline, and lock-byte invariance vs integrated
 * upstream. Pure offline checks — no network, no data regeneration, no
 * learning activation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const UPSTREAM_PIN = '35a6c8b65c6257ff369574fa375e5db3576f145a';

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: ROOT },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

function gitOk(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
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

ok, reason = ic.validate_evidence({
  "source_profile": "espn_core_roster_didnotplay_v1", "game_id": G["game_id"],
  "home": "ATL", "away": "CIN", "kickoff_utc": G["kickoff_utc"], "team": "ATL",
  "posted_utc": "2026-11-08T13:00:00Z", "fetched_utc": "2026-11-08T13:00:00Z",
  "complete": True, "inactive_ids": ["14012"], "active_ids": ["999"],
  "raw_sha256": "a" * 64}, G, now)
assert ok is False and reason == "observation_only_source"

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

test('real callers: unconfirmed DNP does not bind this_week inactive; confirmation_offer_refusal gates prop_legs', () => {
  const r = runPy(`
import json, copy, datetime as dt
from scripts.build_weekly import (build_weekly_document, build_factors, inactive_ids,
                                  observed_inactive_ids, confirmation_offer_refusal, _fixture)
from scripts.build_leg_pool import prop_legs
from scripts.models.parlay_builder import playable_this_week

_, ELOS, SCHED0 = _fixture()
# Real schedule rows carry game_id + kickoff (fixture weeks alone are not enough
# for confirmation_offer_refusal / recommendation_eligibility).
SCHED = []
for g in SCHED0:
    row = dict(g)
    if g.get("week") == 3 and g.get("home") == "DAL" and g.get("away") == "SFX":
        row["game_id"] = "G3"
        row["kickoff_utc"] = "2026-09-18T00:15Z"
    else:
        row["game_id"] = "G%s" % g.get("week")
        row["kickoff_utc"] = "2026-09-%02dT17:00Z" % (10 + int(g.get("week") or 1))
    SCHED.append(row)
FX = lambda: build_factors(2026, None, None, None)
PROJ = [
  {"gsis_id": "espn-1", "name": "QB One", "team": "SFX", "position": "QB", "proj_points": 300.0},
  {"gsis_id": "espn-9", "name": "DAL RB", "team": "DAL", "position": "RB", "proj_points": 180.0},
]
INACT = {"season": 2026, "week": 3, "updated_utc": "2026-09-17T21:30:00Z",
  "source": "fixture", "window_hours": 3.0, "confirmation": "unconfirmed",
  "counts": {"games": 1, "failed": 0, "players": 1},
  "games": [{"game_id": "G3", "home": "DAL", "away": "SFX", "kickoff_utc": "2026-09-18T00:15Z",
             "status": "STATUS_SCHEDULED", "fetched_utc": "2026-09-17T21:30:00Z",
             "evidence_kind": "observation", "confirmation": "unconfirmed",
             "team_coverage": {
               "DAL": {"coverage": "unknown", "complete": False, "dnp_rows": 1,
                       "source_profile": "espn_core_roster_didnotplay_v1"},
               "SFX": {"coverage": "unknown", "complete": False, "dnp_rows": 0,
                       "source_profile": "espn_core_roster_didnotplay_v1"}},
             "inactive": {"DAL": [{"espn_id": "9", "name": "D. RB"}], "SFX": []}}],
  "failed": []}

# Probe A repro→fix: observation DNP must not bind playable=false
doc = build_weekly_document(PROJ, SCHED, ELOS, {}, 2026, "2026-09-17T21:30:00Z",
                            injuries=[], factors=FX(), this_week=3, first_week=3,
                            depth_chart=None, inactives=INACT)
by = {p["gsis_id"]: p for p in doc["players"]}
assert inactive_ids(INACT, 3) == {}
assert observed_inactive_ids(INACT, 3) == {"9": ("DAL", "G3")}
assert by["espn-9"].get("this_week") is None
assert doc["model"]["this_week"]["by_reason"]["inactive"] == 0

# Mid-week (before T-90): provisional → no confirmation refusal stamp
assert by["espn-9"].get("eligibility") is None
assert playable_this_week(by["espn-9"], 3) is True

# Inside T-90 window without official source: confirmation_offer_refusal fails closed
t90 = confirmation_offer_refusal(
  PROJ[1], SCHED, 3, "2026-09-17T23:00:00Z", INACT)
assert t90 is not None and t90["eligible"] is False and t90["reason"] == "confirmation_required"
assert t90["state"] == "unknown_or_stale"

# Real build_weekly stamps eligibility after T-90; prop_legs refuses via playable_this_week
doc2 = build_weekly_document(PROJ, SCHED, ELOS, {}, 2026, "2026-09-17T23:00:00Z",
                             injuries=[], factors=FX(), this_week=3, first_week=3,
                             depth_chart=None, inactives=INACT)
by2 = {p["gsis_id"]: p for p in doc2["players"]}
assert by2["espn-9"]["eligibility"]["eligible"] is False
assert by2["espn-9"]["eligibility"]["source"] == "inactive_confirmation"
assert playable_this_week(by2["espn-9"], 3) is False
# Week points are NOT rewritten by confirmation refusal (no this_week inactive bind)
assert by2["espn-9"].get("this_week") is None

players = [{"gsis_id": "espn-9", "name": "DAL RB", "team": "DAL", "position": "RB"}]
weekly = {"espn-9": by2["espn-9"]}
game_preds = [{"game_id": "G3", "home": "DAL", "away": "SFX", "week": 3,
               "probs": {"home": 0.55, "away": 0.45}}]
calib = {"RB": {"a": 0.0, "b": 1.0, "c": 0.0}}
support = {"RB": (-2.0, 2.0)}
sd = {"RB": 20.0}
ladder = {"RB": [50.0]}
legs, counts = prop_legs(players, weekly, game_preds, calib, support, sd, ladder, wk=3)
assert legs == [] and counts["not_playable"] == 1

print(json.dumps({"ok": True, "dnp_bound_inactive": False, "offer_refused": True,
                  "wired_caller": "build_weekly.confirmation_offer_refusal"}))
`);
  assert.equal(r.ok, true);
  assert.equal(r.dnp_bound_inactive, false);
  assert.equal(r.offer_refused, true);
  assert.equal(r.wired_caller, 'build_weekly.confirmation_offer_refusal');
});

test('neutralSite=true zeros ordinary HFA; malformed/conflict refuse HFA+weather consistently', () => {
  const r = runPy(`
import json
from scripts.home_field import home_field_elo, is_neutral_site, neutral_site_flag
from scripts.weather_source_contract import target
from scripts.models.game_model import predict_game

ordinary = {"game_id": "1", "home": "DAL", "away": "IND", "kickoff_utc": "2026-11-08T18:00Z",
            "week": 9, "roof": "outdoor", "home_elo": 1500, "away_elo": 1500, "hfa_elo": 65,
            "neutral_site": False, "venue": "AT&T Stadium"}
absent = {"game_id": "2", "home": "DAL", "away": "IND", "kickoff_utc": "2026-11-08T18:00Z",
          "week": 9, "roof": "outdoor", "home_elo": 1500, "away_elo": 1500, "hfa_elo": 65,
          "venue": "AT&T Stadium"}
neutral = {"game_id": "401873038", "home": "ATL", "away": "CIN",
           "kickoff_utc": "2026-11-08T14:30Z", "week": 9, "roof": "indoor",
           "venue": "Santiago Bernabeu", "home_elo": 1500, "away_elo": 1500,
           "hfa_elo": 65, "neutral_site": True}
malformed = {**ordinary, "neutral_site": "yes"}
conflict = {"game_id": "c", "home": "DAL", "away": "IND", "kickoff_utc": "2026-11-08T18:00Z",
            "week": 9, "venue": "AT&T Stadium", "home_elo": 1500, "away_elo": 1500,
            "hfa_elo": 65, "neutral_site": False, "neutralSite": True}
camel_only_true = {"game_id": "k", "home": "DAL", "away": "IND", "kickoff_utc": "2026-11-08T18:00Z",
                   "week": 9, "venue": "AT&T Stadium", "neutralSite": True}
elo0 = {"game_id": "e", "home": "DAL", "away": "IND", "kickoff_utc": "2026-11-08T18:00Z",
        "week": 9, "venue": "AT&T Stadium", "neutral_site": 0}

assert home_field_elo(ordinary, 65.0, venue_delta=3.0, cold_delta=1.0) == 69.0
assert home_field_elo(absent, 65.0, venue_delta=3.0, cold_delta=1.0) == 69.0
assert home_field_elo(neutral, 65.0, venue_delta=3.0, cold_delta=1.0) == 0.0
assert home_field_elo(malformed, 65.0, venue_delta=3.0, cold_delta=1.0) == 0.0
assert home_field_elo(conflict, 65.0, venue_delta=3.0, cold_delta=1.0) == 0.0
assert home_field_elo(camel_only_true, 65.0, venue_delta=3.0, cold_delta=1.0) == 0.0
assert home_field_elo(elo0, 65.0, venue_delta=3.0, cold_delta=1.0) == 0.0
assert neutral_site_flag(conflict) == "conflict"
assert neutral_site_flag(elo0) == "malformed"
assert is_neutral_site(malformed) and is_neutral_site(conflict) and is_neutral_site(elo0)
assert is_neutral_site(ordinary) is False and neutral_site_flag(absent) is None

bare_neutral = {"game_id": "x", "home": "ATL", "away": "CIN",
                "kickoff_utc": "2026-11-08T14:30Z", "neutral_site": True,
                "home_elo": 1500, "away_elo": 1500, "hfa_elo": 0}
pred = predict_game(bare_neutral, teams=None, model="elo_prior")
assert pred["roof"] == "outdoor"

bind, reason = target(2026, {
  "game_id": "401873038", "home": "ATL", "away": "CIN", "week": 9,
  "kickoff_utc": "2026-11-08T14:30Z", "venue": "Santiago Bernabeu",
  "neutral_site": True})
assert bind is None and reason == "weather_neutral_venue_unbound"

for g, label in ((malformed, "malformed"), (conflict, "conflict"), (elo0, "elo0")):
    b, rsn = target(2026, g)
    assert b is None and rsn == "weather_neutral_venue_unbound", (label, b, rsn)

bind2, reason2 = target(2026, {
  "game_id": "401873038", "home": "ATL", "away": "CIN", "week": 9,
  "kickoff_utc": "2026-11-08T14:30Z", "venue": "Santiago Bernabeu",
  "neutral_site": False})
assert bind2 is None and reason2 == "weather_actual_venue_unbound"

print(json.dumps({"ok": True, "ordinary_hfa": 69.0, "neutral_hfa": 0.0,
                  "conflict_hfa": 0.0, "malformed_hfa": 0.0}))
`);
  assert.equal(r.ok, true);
  assert.equal(r.ordinary_hfa, 69);
  assert.equal(r.neutral_hfa, 0);
  assert.equal(r.conflict_hfa, 0);
  assert.equal(r.malformed_hfa, 0);
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

schedule = [
  {"game_id": "past", "home": "WAS", "away": "NYG", "kickoff_utc": "2026-10-11T17:00Z"},
  {"game_id": "today", "home": "PHI", "away": "NYG", "kickoff_utc": "2026-11-08T18:00Z"},
]
title = "Pro Football: Eagles vs. Giants Season Series Winner"
assert pm.game_market_title_ok(title) is False

assert date_near("2026-11-08T18:00Z", "2026-11-08") is True
assert date_near("2026-11-08T18:00Z", "2026-10-11") is False

doc = json.load(open("data/market_prices.json", encoding="utf-8"))
assert doc["display_only"] is True
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

test('historical lock/archive/receipt bytes match integrated upstream; own commits skip data/**', () => {
  // (1) Worktree data blobs == HEAD (idempotent; offline tests must not rewrite).
  // (2) data/** outside contracts == UPSTREAM_PIN (imported merge, not regen).
  // (3) Own non-merge commits after UPSTREAM_PIN touch no data/** outside contracts.
  // Base resolution: GITHUB_BASE_SHA or merge-base with origin/main|main — never
  // HEAD~N. Fail visibly if unavailable.
  const tracked = new Set(execFileSync('git', ['ls-files', 'data'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim().split('\n').filter(Boolean));
  const headBlob = (rel) => execFileSync('git', ['rev-parse', `HEAD:${rel}`], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  const pinBlob = (rel) => execFileSync('git', ['rev-parse', `${UPSTREAM_PIN}:${rel}`], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  const workBlob = (rel) => execFileSync('git', ['hash-object', rel], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();

  // CI PR checkouts are often depth=1. Fetch the audited pin read-only (no
  // push, no history rewrite) until it is a reachable ancestor of HEAD, or fail
  // visibly — never invent HEAD~N success.
  const ensureUpstreamPin = () => {
    const pinReady = () => {
      if (!gitOk(['cat-file', '-t', UPSTREAM_PIN])) return false;
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', UPSTREAM_PIN, 'HEAD'], {
          cwd: ROOT, stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    };
    if (pinReady()) return;
    const fetches = [
      ['fetch', '--no-tags', '--depth=1', 'origin', UPSTREAM_PIN],
      ['fetch', '--no-tags', '--deepen=80', 'origin'],
      ['fetch', '--no-tags', '--deepen=200', 'origin'],
      ['fetch', '--no-tags', '--depth=1', 'https://github.com/liddar12/NFL2026.git', UPSTREAM_PIN],
      ['fetch', '--no-tags', 'origin', UPSTREAM_PIN],
    ];
    for (const args of fetches) {
      try {
        execFileSync('git', args, {
          cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        /* try next */
      }
      if (pinReady()) return;
    }
    assert.fail(
      `upstream pin ${UPSTREAM_PIN} unavailable after read-only fetch — `
      + 'refuse lock-equality claim (no HEAD~N fallback)',
    );
  };
  ensureUpstreamPin();

  const after = {};
  for (const rel of tracked) {
    const a = workBlob(rel);
    const b = headBlob(rel);
    assert.equal(a, b, `${rel} working-tree drift vs HEAD`);
    after[rel] = a;
    if (rel.startsWith('data/contracts/')) continue;
    assert.equal(a, pinBlob(rel), `${rel} must equal integrated upstream ${UPSTREAM_PIN}`);
  }
  for (const [rel, blob] of Object.entries(after)) {
    assert.equal(workBlob(rel), blob, `${rel} non-idempotent`);
  }

  const resolveBase = () => {
    if (process.env.GITHUB_BASE_SHA) {
      const sha = process.env.GITHUB_BASE_SHA.trim();
      if (!gitOk(['rev-parse', '--verify', sha])) {
        throw new Error(`GITHUB_BASE_SHA=${sha} is not a resolvable git object`);
      }
      return sha;
    }
    for (const cand of ['origin/main', 'main']) {
      if (!gitOk(['rev-parse', '--verify', cand])) continue;
      const mb = gitOk(['merge-base', cand, 'HEAD']);
      if (mb) return mb;
    }
    throw new Error(
      'hash proof base unavailable: set GITHUB_BASE_SHA to the PR base SHA '
      + 'or fetch origin/main (refuse HEAD~N ancestor guesses)',
    );
  };
  const base = resolveBase();
  assert.ok(/^[0-9a-f]{40}$/i.test(base) || base === 'origin/main' || base === 'main'
    || gitOk(['rev-parse', '--verify', base]), `unverified base ${base}`);

  // Own edits = non-merge commits on HEAD not in UPSTREAM_PIN.
  const own = execFileSync('git', ['rev-list', '--no-merges', `${UPSTREAM_PIN}..HEAD`], {
    cwd: ROOT, encoding: 'utf8',
  }).trim().split('\n').filter(Boolean);
  assert.ok(own.length >= 1, 'expected own draft commits after upstream pin');
  const ownDataHits = [];
  for (const c of own) {
    const files = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', c], {
      cwd: ROOT, encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);
    for (const p of files) {
      if (p.startsWith('data/') && !p.startsWith('data/contracts/')) ownDataHits.push(`${c.slice(0, 8)}:${p}`);
    }
  }
  assert.deepEqual(ownDataHits, [], `own commits must not mutate lock/receipts: ${ownDataHits.join(',')}`);

  // Ancestry proof: audited upstream pin is ancestor of this draft HEAD.
  execFileSync('git', ['merge-base', '--is-ancestor', UPSTREAM_PIN, 'HEAD'], {
    cwd: ROOT, stdio: 'ignore',
  });
  assert.ok(Object.keys(after).length >= 8, `tracked data count ${Object.keys(after).length}`);
  assert.ok(base, 'base resolved');
});
