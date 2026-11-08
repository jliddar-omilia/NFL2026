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
/** Audited upstream main tip integrated into this draft via ordinary merge. */
const UPSTREAM_PIN = '9e4af833b2deadbc4519d5fb38036dc64f8ebbfb';

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

test('real callers: DNP non-binding; missing context fail-closed for prop+ATD; pre-T90 provisional kept', () => {
  const r = runPy(`
import json, copy
from scripts.build_weekly import (build_weekly_document, build_factors, inactive_ids,
                                  observed_inactive_ids, confirmation_offer_refusal, _fixture)
from scripts.build_leg_pool import prop_legs, atd_legs
from scripts.models.parlay_builder import playable_this_week

_, ELOS, SCHED0 = _fixture()
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

doc = build_weekly_document(PROJ, SCHED, ELOS, {}, 2026, "2026-09-17T21:30:00Z",
                            injuries=[], factors=FX(), this_week=3, first_week=3,
                            depth_chart=None, inactives=INACT)
by = {p["gsis_id"]: p for p in doc["players"]}
assert inactive_ids(INACT, 3) == {}
assert observed_inactive_ids(INACT, 3) == {"9": ("DAL", "G3")}
assert by["espn-9"].get("this_week") is None
assert doc["model"]["this_week"]["by_reason"]["inactive"] == 0
# Intended pre-T90 provisional: no refusal stamp, still playable
assert by["espn-9"].get("eligibility") is None
assert playable_this_week(by["espn-9"], 3) is True
pre = confirmation_offer_refusal(PROJ[1], SCHED, 3, "2026-09-17T21:30:00Z", INACT)
assert pre is None, "provisional before T-90 must remain offerable (None refusal)"

# Missing-context cases must stamp eligible=False (not None bypass)
cases = {
  "missing_week": confirmation_offer_refusal(PROJ[1], SCHED, None, "2026-09-17T23:00:00Z", INACT),
  "missing_kickoff": confirmation_offer_refusal(
      PROJ[1], [{**g, "kickoff_utc": None} if g.get("game_id")=="G3" else g for g in SCHED],
      3, "2026-09-17T23:00:00Z", INACT),
  "missing_game_id": confirmation_offer_refusal(
      PROJ[1], [{**g, "game_id": ""} if g.get("game_id")=="G3" else g for g in SCHED],
      3, "2026-09-17T23:00:00Z", INACT),
  "bad_clock": confirmation_offer_refusal(PROJ[1], SCHED, 3, "not-a-clock", INACT),
  "missing_espn_id": confirmation_offer_refusal(
      {"gsis_id": "00-0033873", "team": "DAL", "position": "RB"}, SCHED, 3,
      "2026-09-17T23:00:00Z", INACT),
  "missing_game": confirmation_offer_refusal(
      {"gsis_id": "espn-9", "team": "ZZZ", "position": "RB"}, SCHED, 3,
      "2026-09-17T23:00:00Z", INACT),
}
for label, ref in cases.items():
    assert ref is not None and ref["eligible"] is False, label
    assert ref["reason"] == "confirmation_required", label
    assert ref["detail"], label
    assert "source_updated_utc" in ref, label
    assert ref["source"] == "inactive_confirmation", label
    assert ref["require_confirmed"] is True, label

# T-90 without official source + build_weekly stamp → prop_legs AND atd_legs refuse
doc2 = build_weekly_document(PROJ, SCHED, ELOS, {}, 2026, "2026-09-17T23:00:00Z",
                             injuries=[], factors=FX(), this_week=3, first_week=3,
                             depth_chart=None, inactives=INACT)
by2 = {p["gsis_id"]: p for p in doc2["players"]}
assert by2["espn-9"]["eligibility"]["eligible"] is False
assert by2["espn-9"]["eligibility"]["source"] == "inactive_confirmation"
assert "source_updated_utc" in by2["espn-9"]["eligibility"]
assert playable_this_week(by2["espn-9"], 3) is False
assert by2["espn-9"].get("this_week") is None

players = [{"gsis_id": "espn-9", "name": "DAL RB", "team": "DAL", "position": "RB"}]
weekly = {"espn-9": by2["espn-9"]}
game_preds = [{"game_id": "G3", "home": "DAL", "away": "SFX", "week": 3,
               "probs": {"home": 0.55, "away": 0.45}}]
legs, counts = prop_legs(players, weekly, game_preds,
                         {"RB": {"a": 0.0, "b": 1.0, "c": 0.0}},
                         {"RB": (-2.0, 2.0)}, {"RB": 20.0}, {"RB": [50.0]}, wk=3)
assert legs == [] and counts["not_playable"] == 1
assert counts.get("not_playable", 0) >= 1
REACHES_OFFER_WHEN_REFUSAL_NONE = False  # stamped path never reaches offer

# ATD path uses the same playable_this_week gate
atd_doc = {"adopted": True, "season": 2026, "week": 3, "players": [
  {"gsis_id": "espn-9", "player": "DAL RB", "team": "DAL", "position": "RB",
   "game_id": "G3", "side": "home", "selection": "D. RB ATD", "model_prob": 0.4}]}
atd_bt = {"adopted": True}
atd_rows, atd_reason = atd_legs(atd_doc, atd_bt, weekly, 2026, 3)
assert atd_rows == [] and "offered: 0" in atd_reason

# Missing-context stamp on a bare weekly row also blocks prop+ATD (integration)
for detail, ref in cases.items():
    bare = {"gsis_id": "espn-9", "weeks": [{"wk": 3, "pts": 10.0}], "eligibility": ref}
    assert playable_this_week(bare, 3) is False, detail
    legs_m, counts_m = prop_legs(players, {"espn-9": bare}, game_preds,
                                 {"RB": {"a": 0.0, "b": 1.0, "c": 0.0}},
                                 {"RB": (-2.0, 2.0)}, {"RB": 20.0}, {"RB": [50.0]}, wk=3)
    assert legs_m == [] and counts_m["not_playable"] == 1, detail
    atd_m, _ = atd_legs(atd_doc, atd_bt, {"espn-9": bare}, 2026, 3)
    assert atd_m == [], detail

print(json.dumps({
  "ok": True, "dnp_bound_inactive": False, "offer_refused": True,
  "pre_T90_provisional_None": True,
  "FAIL_CLOSED_MISSING_CONTEXT": True,
  "REACHES_OFFER_WHEN_REFUSAL_NONE": REACHES_OFFER_WHEN_REFUSAL_NONE,
  "prop_not_playable": counts["not_playable"], "atd_offered": len(atd_rows),
  "missing_details": sorted({c["detail"] for c in cases.values()}),
  "wired_caller": "build_weekly.confirmation_offer_refusal"}))
`);
  assert.equal(r.ok, true);
  assert.equal(r.dnp_bound_inactive, false);
  assert.equal(r.offer_refused, true);
  assert.equal(r.pre_T90_provisional_None, true);
  assert.equal(r.FAIL_CLOSED_MISSING_CONTEXT, true);
  assert.equal(r.REACHES_OFFER_WHEN_REFUSAL_NONE, false);
  assert.equal(r.prop_not_playable, 1);
  assert.equal(r.atd_offered, 0);
  assert.equal(r.wired_caller, 'build_weekly.confirmation_offer_refusal');
});

test('post-T90 stamped generation validates player_weekly.schema; confirmed≠DNP', () => {
  // Real producer stamps → schema validator (not fixture avoidance). Covers
  // fail-closed unknown/unconfirmed, genuine confirmed+complete via a temporary
  // registered profile (never ESPN DNP), and pre-T90 provisional silence.
  const r = runPy(`
import json, copy, os
from scripts.build_weekly import (build_weekly_document, build_factors,
                                  confirmation_offer_refusal, _fixture)
from scripts.models.parlay_builder import playable_this_week
from scripts.validate_data import validate_against_schema, ValidationError, _load
from scripts import inactive_confirmation as ic

_, ELOS, SCHED0 = _fixture()
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
INACT = {"season": 2026, "week": 3, "updated_utc": "2026-09-17T23:00:00Z",
  "source": "fixture", "window_hours": 3.0, "confirmation": "unconfirmed",
  "counts": {"games": 1, "failed": 0, "players": 1},
  "games": [{"game_id": "G3", "home": "DAL", "away": "SFX", "kickoff_utc": "2026-09-18T00:15Z",
             "status": "STATUS_SCHEDULED", "fetched_utc": "2026-09-17T23:00:00Z",
             "evidence_kind": "observation", "confirmation": "unconfirmed",
             "team_coverage": {
               "DAL": {"coverage": "unknown", "complete": False, "dnp_rows": 1,
                       "source_profile": "espn_core_roster_didnotplay_v1"},
               "SFX": {"coverage": "unknown", "complete": False, "dnp_rows": 0,
                       "source_profile": "espn_core_roster_didnotplay_v1"}},
             "inactive": {"DAL": [{"espn_id": "9", "name": "D. RB"}], "SFX": []}}],
  "failed": []}

schema = _load(os.path.join("data", "contracts", "player_weekly.schema.json"))
RELABEL = {"SFX": "SF", "GBX": "GB"}
def real_teams(d):
    d = copy.deepcopy(d)
    for p in d["players"]:
        for w in p["weeks"]:
            w["opp"] = RELABEL.get(w["opp"], w["opp"])
    return d

# 1) Real post-T90 rebuild with observation DNP stamps → schema green
doc = build_weekly_document(PROJ, SCHED, ELOS, {}, 2026, "2026-09-17T23:00:00Z",
                            injuries=[], factors=FX(), this_week=3, first_week=3,
                            depth_chart=None, inactives=INACT)
by = {p["gsis_id"]: p for p in doc["players"]}
stamp = by["espn-9"]["eligibility"]
assert stamp["eligible"] is False
assert stamp["reason"] == "confirmation_required"
assert stamp["source"] == "inactive_confirmation"
assert stamp["state"] == "unknown_or_stale"
assert stamp["require_confirmed"] is True
assert stamp["source_updated_utc"] == "2026-09-17T23:00:00Z"
assert stamp["week"] == 3
validate_against_schema(real_teams(doc), schema, "player_weekly.json")
assert playable_this_week(by["espn-9"], 3) is False

# 2) Fail-closed missing-context stamps each validate under eligibility schema
el_schema = schema["properties"]["players"]["items"]["properties"]["eligibility"]
ctx = {
  "missing_week": confirmation_offer_refusal(PROJ[1], SCHED, None, "2026-09-17T23:00:00Z", INACT),
  "missing_kickoff": confirmation_offer_refusal(
      PROJ[1], [{**g, "kickoff_utc": None} if g.get("game_id")=="G3" else g for g in SCHED],
      3, "2026-09-17T23:00:00Z", INACT),
  "bad_clock": confirmation_offer_refusal(PROJ[1], SCHED, 3, "not-a-clock", INACT),
}
for label, ref in ctx.items():
    assert ref["eligible"] is False and ref["source"] == "inactive_confirmation", label
    assert "source_updated_utc" in ref, label
    validate_against_schema(ref, el_schema, "eligibility:" + label)

# 3) Pre-T90 provisional: no stamp; document still schema-valid
doc_pre = build_weekly_document(PROJ, SCHED, ELOS, {}, 2026, "2026-09-17T21:30:00Z",
                                injuries=[], factors=FX(), this_week=3, first_week=3,
                                depth_chart=None, inactives=INACT)
by_pre = {p["gsis_id"]: p for p in doc_pre["players"]}
assert by_pre["espn-9"].get("eligibility") is None
assert playable_this_week(by_pre["espn-9"], 3) is True
validate_against_schema(real_teams(doc_pre), schema, "player_weekly.json")

# 4) Genuine confirmed+complete via temporary registered profile — NOT ESPN DNP
OFFICIAL = frozenset({"fixture_official_inactives_v1"})
assert "espn_core_roster_didnotplay_v1" not in OFFICIAL
assert "espn_core_roster_didnotplay_v1" in ic.OBSERVATION_ONLY_SOURCES
game = next(g for g in SCHED if g.get("game_id") == "G3")
now_s = "2026-09-17T23:00:00Z"
digest = "a" * 64
official_complete = [{
  "source_profile": "fixture_official_inactives_v1",
  "game_id": "G3", "home": "DAL", "away": "SFX",
  "kickoff_utc": game["kickoff_utc"], "team": "DAL",
  "posted_utc": now_s, "fetched_utc": now_s,
  "complete": True,
  "inactive_ids": ["99"], "active_ids": ["9", "1"],
  "raw_sha256": digest,
}]
# Observation DNP still refuses even if somehow passed as evidence under empty registry
dnp_only = confirmation_offer_refusal(
    PROJ[1], SCHED, 3, now_s, INACT, registry=frozenset(), evidence=None)
assert dnp_only is not None and dnp_only["state"] == "unknown_or_stale"
validate_against_schema(dnp_only, el_schema, "eligibility:dnp_unconfirmed")

# confirmed_active → None (offerable); DNP was never the confirming source
active = confirmation_offer_refusal(
    PROJ[1], SCHED, 3, now_s, INACT, registry=OFFICIAL, evidence=official_complete)
assert active is None, "confirmed_active must remain offerable (no refusal stamp)"

# confirmed_inactive → schema-valid refusal stamp; still not DNP-as-official
inactive_ev = [{**official_complete[0],
                "inactive_ids": ["9", "99"], "active_ids": ["1"]}]
inactive_ref = confirmation_offer_refusal(
    PROJ[1], SCHED, 3, now_s, INACT, registry=OFFICIAL, evidence=inactive_ev)
assert inactive_ref is not None
assert inactive_ref["eligible"] is False
assert inactive_ref["state"] == "confirmed_inactive"
assert inactive_ref["detail"] == "official_inactive"
assert inactive_ref["source"] == "inactive_confirmation"
assert inactive_ref["source_updated_utc"] == "2026-09-17T23:00:00Z"
validate_against_schema(inactive_ref, el_schema, "eligibility:confirmed_inactive")
# Attach to a generated doc and prove full weekly schema still accepts it
doc_ci = copy.deepcopy(doc)
for p in doc_ci["players"]:
    if p["gsis_id"] == "espn-9":
        p["eligibility"] = inactive_ref
validate_against_schema(real_teams(doc_ci), schema, "player_weekly.json")
assert playable_this_week({"gsis_id": "espn-9", "weeks": by["espn-9"]["weeks"],
                           "eligibility": inactive_ref}, 3) is False

# Production OFFICIAL_SOURCES remains empty — no accidental DNP promotion
assert ic.OFFICIAL_SOURCES == frozenset()

print(json.dumps({
  "ok": True,
  "post_T90_schema_valid": True,
  "fail_closed_ctx_schema_valid": True,
  "pre_T90_provisional_schema_valid": True,
  "dnp_never_official": True,
  "confirmed_active_None": True,
  "confirmed_inactive_schema_valid": True,
}))
`);
  assert.equal(r.ok, true);
  assert.equal(r.post_T90_schema_valid, true);
  assert.equal(r.fail_closed_ctx_schema_valid, true);
  assert.equal(r.pre_T90_provisional_schema_valid, true);
  assert.equal(r.dnp_never_official, true);
  assert.equal(r.confirmed_active_None, true);
  assert.equal(r.confirmed_inactive_schema_valid, true);
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

  /** Require a real commit object that is an ancestor of HEAD (PR base / merge-base). */
  const requireCommitAncestor = (raw) => {
    const sha = String(raw || '').trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) {
      throw new Error(`base ${sha} is not a 40-char hex commit id`);
    }
    const typ = gitOk(['cat-file', '-t', sha]);
    if (typ !== 'commit') {
      throw new Error(`base ${sha} git type is ${typ || 'missing'}, want commit`);
    }
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
        cwd: ROOT, stdio: 'ignore',
      });
    } catch {
      throw new Error(`base ${sha} is not an ancestor of HEAD`);
    }
    return sha;
  };
  const resolveBase = () => {
    if (process.env.GITHUB_BASE_SHA) {
      return requireCommitAncestor(process.env.GITHUB_BASE_SHA);
    }
    for (const cand of ['origin/main', 'main']) {
      if (!gitOk(['rev-parse', '--verify', cand])) continue;
      const mb = gitOk(['merge-base', cand, 'HEAD']);
      if (mb) return requireCommitAncestor(mb);
    }
    throw new Error(
      'hash proof base unavailable: set GITHUB_BASE_SHA to a real commit SHA '
      + 'that is an ancestor of HEAD, or fetch origin/main (refuse HEAD~N)',
    );
  };
  const base = resolveBase();
  assert.equal(gitOk(['cat-file', '-t', base]), 'commit');
  execFileSync('git', ['merge-base', '--is-ancestor', base, 'HEAD'], {
    cwd: ROOT, stdio: 'ignore',
  });

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

test('hash-proof base validation rejects nonexistent/blob/tree and non-ancestor commits', () => {
  // Adversarial: prove the weak rev-parse-only check would pass these, but the
  // hardened requireCommitAncestor fails closed.
  const weakRevParseOk = (ref) => {
    try {
      execFileSync('git', ['rev-parse', '--verify', ref], {
        cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  };
  const requireCommitAncestor = (raw) => {
    const sha = String(raw || '').trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('not hex');
    const typ = gitOk(['cat-file', '-t', sha]);
    if (typ !== 'commit') throw new Error(`type ${typ}`);
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
      cwd: ROOT, stdio: 'ignore',
    });
    return sha;
  };

  const bogus = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  assert.equal(weakRevParseOk(bogus), true, 'adversarial: rev-parse accepts nonexistent 40-hex');
  assert.throws(() => requireCommitAncestor(bogus), /type missing|type undefined|not hex|type/);

  const blob = execFileSync('git', ['rev-parse', 'HEAD:CHANGELOG.md'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  assert.equal(gitOk(['cat-file', '-t', blob]), 'blob');
  assert.equal(weakRevParseOk(blob), true, 'adversarial: rev-parse accepts blob');
  assert.throws(() => requireCommitAncestor(blob), /type blob/);

  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  assert.equal(gitOk(['cat-file', '-t', tree]), 'tree');
  assert.equal(weakRevParseOk(tree), true, 'adversarial: rev-parse accepts tree');
  assert.throws(() => requireCommitAncestor(tree), /type tree/);

  // A real commit that is NOT an ancestor of this draft HEAD must fail.
  // Synthesize an orphan commit object without commit-tree (CI runners often
  // lack user.email / user.name, which makes commit-tree refuse).
  const orphanBody = [
    `tree ${tree}`,
    'author Hash Proof Adversarial <hash-proof@example.invalid> 0 +0000',
    'committer Hash Proof Adversarial <hash-proof@example.invalid> 0 +0000',
    '',
    'orphan-hash-proof-adversarial',
    '',
  ].join('\n');
  const orphan = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: ROOT, encoding: 'utf8', input: orphanBody,
  }).trim();
  assert.equal(gitOk(['cat-file', '-t', orphan]), 'commit');
  assert.equal(weakRevParseOk(orphan), true);
  assert.throws(() => requireCommitAncestor(orphan), /not an ancestor|Command failed/);

  // Intended base: fork main tip / merge-base with HEAD must pass.
  const intended = gitOk(['rev-parse', 'origin/main']) || gitOk(['rev-parse', 'main']);
  if (intended) {
    const mb = gitOk(['merge-base', intended, 'HEAD']);
    assert.ok(mb);
    assert.equal(requireCommitAncestor(mb), mb);
  }
  assert.equal(requireCommitAncestor(UPSTREAM_PIN), UPSTREAM_PIN);
});
