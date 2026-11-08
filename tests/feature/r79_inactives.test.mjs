/* tests/feature/r79_inactives.test.mjs — R79 GAME-DAY INACTIVES, the gate's
 * first source.
 *
 * R77 gated on injury status and the QB depth chart. Neither sees a healthy
 * scratch, an RB/WR/TE listed inactive without a report status, or a QB1 who
 * is a surprise inactive. ESPN's per-competition roster carries the posted
 * list as `didNotPlay`, keyed by the ESPN athlete id the projection pool
 * spells `espn-<id>` — an exact join, no name matching. This file locks:
 *
 *   espn.parse_game_roster            -> didNotPlay is the marker, ids exact
 *   build_predictions.games_in_inactive_window -> kickoff-3h until FINAL
 *   build_predictions._inactives_doc  -> one entry per game, failures recorded
 *   build_weekly.this_week_gate       -> reason `inactive` first; QB1 inactive
 *                                        promotes QB2; a bye / FINAL team is
 *                                        never gated; a list naming a team the
 *                                        pool disagrees with gates nobody
 *   validate_data                     -> rule 9 (no silent inactive), the
 *                                        inactive-reason orphan rule, the
 *                                        summary counts, the contract
 *   players.js gateTag                -> WK n · INACTIVE
 *
 * Node built-ins only; the Python cores run through `python3 -`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gateTag } from '../../app/views/players.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runPy(code) {
  const out = execFileSync('python3', ['-'], {
    cwd: REPO_ROOT, input: code, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: REPO_ROOT },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/* The R77 synthetic world plus a posted inactive list for the SFX @ DAL game
 * in week 3: DAL RB (healthy, no report row) and SFX QB One (the healthy
 * starter) are scratched. */
const SETUP = `
import json, sys, copy, datetime as dt
sys.path.insert(0, ".")
from scripts import availability as av
from scripts.build_weekly import (build_weekly_document, build_factors, inactive_ids,
                                  observed_inactive_ids, load_inactives, _fixture)
from scripts.scrape.espn import parse_game_roster
from scripts.build_predictions import games_in_inactive_window, _inactives_doc
SCHED_BY_TEAM, ELOS, SCHED = _fixture()
# Confirmation offer gate needs kickoff/game_id; week-3 matches INACT kickoff so
# builds at 2026-09-17T21:30Z stay provisional (before T-90).
for _g in SCHED:
    if _g.get("week") == 3 and _g.get("home") == "DAL" and _g.get("away") == "SFX":
        _g["game_id"] = "G3"
        _g["kickoff_utc"] = "2026-09-18T00:15Z"
    else:
        _g.setdefault("game_id", "FX%s" % _g.get("week"))
        _g.setdefault("kickoff_utc", "2026-09-%02dT17:00Z" % (10 + int(_g.get("week") or 1)))
FX = lambda: build_factors(2026, None, None, None)
PROJ = [
  {"gsis_id": "espn-1", "name": "QB One",   "team": "SFX", "position": "QB", "proj_points": 300.0},
  {"gsis_id": "espn-2", "name": "QB Two",   "team": "SFX", "position": "QB", "proj_points": 120.0},
  {"gsis_id": "espn-3", "name": "QB Three", "team": "SFX", "position": "QB", "proj_points": 40.0},
  {"gsis_id": "espn-4", "name": "Hurt RB",  "team": "SFX", "position": "RB", "proj_points": 200.0},
  {"gsis_id": "espn-5", "name": "Q WR",     "team": "SFX", "position": "WR", "proj_points": 150.0},
  {"gsis_id": "espn-8", "name": "DAL QB",   "team": "DAL", "position": "QB", "proj_points": 250.0},
  {"gsis_id": "espn-9", "name": "DAL RB",   "team": "DAL", "position": "RB", "proj_points": 180.0},
]
DEPTH = {"season": 2026, "updated_utc": "2026-09-16T12:34:22Z", "source": "fixture",
  "positions": ["QB"], "counts": {"teams": 2, "rows": 4}, "teams": {
  "SFX": {"snapshot": "s", "QB": [
     {"rank": 1, "name": "QB One",   "gsis_id": None, "espn_id": "1"},
     {"rank": 2, "name": "QB Two",   "gsis_id": None, "espn_id": "2"},
     {"rank": 3, "name": "QB Three", "gsis_id": None, "espn_id": "3"}]},
  "DAL": {"snapshot": "s", "QB": [{"rank": 1, "name": "DAL QB", "gsis_id": None, "espn_id": "8"}]}}}
INJ = [
  {"team": "SFX", "player": "Hurt RB", "status": "Out"},
  {"team": "SFX", "player": "Q WR",    "status": "Questionable"},
]
# Observation-only ESPN DNP fixture (matches production stamps). Does NOT bind.
INACT = {"season": 2026, "week": 3, "updated_utc": "2026-09-17T21:30:00Z",
  "source": "fixture", "window_hours": 3.0, "confirmation": "unconfirmed",
  "evidence_profile": "espn_core_roster_didnotplay_v1",
  "counts": {"games": 1, "failed": 0, "players": 3},
  "games": [{"game_id": "G3", "home": "DAL", "away": "SFX", "kickoff_utc": "2026-09-18T00:15Z",
             "status": "STATUS_SCHEDULED", "fetched_utc": "2026-09-17T21:30:00Z",
             "evidence_kind": "observation", "confirmation": "unconfirmed",
             "team_coverage": {
               "DAL": {"coverage": "unknown", "complete": False, "dnp_rows": 1,
                       "source_profile": "espn_core_roster_didnotplay_v1"},
               "SFX": {"coverage": "unknown", "complete": False, "dnp_rows": 2,
                       "source_profile": "espn_core_roster_didnotplay_v1"}},
             "inactive": {"DAL": [{"espn_id": "9", "name": "D. RB"}],
                          "SFX": [{"espn_id": "1", "name": "Q. One"},
                                  {"espn_id": "4", "name": "H. RB"}]}}],
  "failed": []}
# Synthetic confirmed+complete list — the only shape that binds reason=inactive.
CONFIRMED = copy.deepcopy(INACT)
CONFIRMED["confirmation"] = "confirmed"
CONFIRMED["games"][0]["confirmation"] = "confirmed"
CONFIRMED["games"][0]["evidence_kind"] = "official"
for _t, _n in (("DAL", 1), ("SFX", 2)):
    CONFIRMED["games"][0]["team_coverage"][_t] = {
        "coverage": "complete", "complete": True, "dnp_rows": _n,
        "source_profile": "fixture_official_v1"}
def build(inj=INJ, wk=3, depth=DEPTH, skip=(), proj=PROJ, inact=INACT,
          updated="2026-09-17T21:30:00Z"):
    return build_weekly_document(proj, SCHED, ELOS, {}, 2026, updated,
                                 injuries=inj, factors=FX(), this_week=wk,
                                 first_week=wk if wk else 1, depth_chart=depth,
                                 gate_skip_teams=skip, inactives=inact)
def by_id(doc):
    return {p["gsis_id"]: p for p in doc["players"]}
def wkrow(p, wk):
    return next(w for w in p["weeks"] if w["wk"] == wk)
def emit(obj):
    print(json.dumps(obj))
`;

/* 1 — the fetcher's parser ---------------------------------------------------- */

test('R79: parse_game_roster keeps didNotPlay entries only, by ESPN athlete id, sorted, never guessed', () => {
  const out = runPy(`${SETUP}
entries = [
  {"playerId": 100, "displayName": "Z. Last", "didNotPlay": True, "active": False},
  {"playerId": 7, "displayName": "A. First", "didNotPlay": True, "active": False},
  {"playerId": 8, "displayName": "Plays", "didNotPlay": False, "active": False},
  {"displayName": "No Id", "didNotPlay": True},
  {"playerId": "", "displayName": "Empty Id", "didNotPlay": True},
]
emit({"rows": parse_game_roster(entries), "empty": parse_game_roster([]), "none": parse_game_roster(None)})`);
  assert.deepEqual(out.rows, [{ espn_id: '7', name: 'A. First' }, { espn_id: '100', name: 'Z. Last' }]);
  assert.deepEqual(out.empty, [], 'a list not yet posted is empty, not an error');
  assert.deepEqual(out.none, []);
});

/* 2 — the window ----------------------------------------------------------------- */

test('R79: the inactives window opens at kickoff-3h, stays open while the game plays, and closes at FINAL', () => {
  const out = runPy(`${SETUP}
games = [
  {"game_id": "A", "home": "DAL", "away": "SFX", "kickoff_utc": "2026-09-18T00:15Z", "status": "STATUS_SCHEDULED"},
  {"game_id": "B", "home": "GBX", "away": "DAL", "kickoff_utc": "2026-09-20T17:00:00Z", "status": "STATUS_SCHEDULED"},
  {"game_id": "C", "home": "SFX", "away": "GBX", "kickoff_utc": "2026-09-17T17:00Z", "status": "STATUS_FINAL"},
  {"game_id": "D", "home": "SFX", "away": "GBX", "kickoff_utc": "not a date", "status": "STATUS_SCHEDULED"},
]
def at(s): return dt.datetime.strptime(s, "%Y-%m-%dT%H:%MZ").replace(tzinfo=dt.timezone.utc)
emit({"early": [g["game_id"] for g in games_in_inactive_window(games, at("2026-09-17T20:30Z"))],
      "open":  [g["game_id"] for g in games_in_inactive_window(games, at("2026-09-17T21:15Z"))],
      "live":  [g["game_id"] for g in games_in_inactive_window(games, at("2026-09-18T01:30Z"))],
      "sun":   [g["game_id"] for g in games_in_inactive_window(games, at("2026-09-20T14:30Z"))]})`);
  assert.deepEqual(out.early, [], '3h15m before kickoff: not yet');
  assert.deepEqual(out.open, ['A'], 'exactly 3h before: open');
  assert.deepEqual(out.live, ['A'], 'in progress: the list stays true');
  assert.deepEqual(out.sun, ['A', 'B'], 'a later game opens on its own clock; a game never marked FINAL stays open (only FINAL closes it); FINAL and unparseable never');
});

test('R79: _inactives_doc writes one entry per game in the window, records a failed fetch, and is None outside the window', () => {
  const out = runPy(`${SETUP}
games = [{"game_id": "A", "home": "DAL", "away": "SFX", "kickoff_utc": "2026-09-18T00:15Z", "status": "STATUS_SCHEDULED"},
         {"game_id": "B", "home": "GBX", "away": "DAL", "kickoff_utc": "2026-09-18T00:20Z", "status": "STATUS_SCHEDULED"}]
now = dt.datetime(2026, 9, 17, 22, 0, tzinfo=dt.timezone.utc)
def fetch(gid):
    if gid == "B":
        raise RuntimeError("boom")
    return {"home": "DAL", "away": "SFX", "inactive": {"DAL": [{"espn_id": "9", "name": "D. RB"}], "SFX": []}}
doc = _inactives_doc("2026-09-17T22:00:00Z", games, 3, now_utc=now, fetch=fetch)
swapped = _inactives_doc("t", games[:1], 3, now_utc=now, fetch=lambda g: {"home": "SFX", "away": "GBX", "inactive": {"SFX": [], "GBX": []}})
none = _inactives_doc("t", games, 3, now_utc=dt.datetime(2026, 9, 17, 12, 0, tzinfo=dt.timezone.utc), fetch=fetch)
emit({"counts": doc["counts"], "games": [g["game_id"] for g in doc["games"]],
      "failed": doc["failed"], "keys": list(doc), "week": doc["week"],
      "swapped_failed": swapped["failed"], "none": none})`);
  assert.deepEqual(out.counts, { games: 1, failed: 1, players: 1 });
  assert.deepEqual(out.games, ['A']);
  assert.deepEqual(out.failed, [{ game_id: 'B', error: 'boom' }]);
  for (const k of ['season', 'week', 'updated_utc', 'source', 'window_hours', 'counts', 'games', 'failed']) {
    assert.ok(out.keys.includes(k), k);
  }
  assert.ok(out.keys.includes('evidence_profile'));
  assert.ok(out.keys.includes('confirmation'));
  assert.equal(out.week, 3);
  assert.match(out.swapped_failed[0].error, /ESPN teams SFX\/GBX != schedule DAL\/SFX/, 'a team mismatch is a failure, never a silent mis-attribution');
  assert.equal(out.none, null, 'no game in the window: nothing to state');
});

/* 3 — the gate ------------------------------------------------------------------ */

test('R79: observation DNP does not bind inactive; status/depth still gate; confirmed+complete does bind', () => {
  const out = runPy(`${SETUP}
obs = build()
p = by_id(obs)
conf = build(inact=CONFIRMED)
pc = by_id(conf)
emit({"meta": obs["model"]["this_week"],
      "tw": {k: v.get("this_week") for k, v in p.items()},
      "wk3": {k: wkrow(v, 3)["pts"] for k, v in p.items()},
      "ids": inactive_ids(INACT, 3),
      "observed": observed_inactive_ids(INACT, 3),
      "ids_other_week": inactive_ids(INACT, 4),
      "conf_meta": conf["model"]["this_week"],
      "conf_tw": {k: v.get("this_week") for k, v in pc.items()},
      "conf_ids": inactive_ids(CONFIRMED, 3)})`);
  const m = out.meta;
  // Observation DNP: unknown — not inactive, not all-active. Status + depth only.
  assert.deepEqual(m.by_reason, { inactive: 0, status: 1, depth: 2 });
  assert.equal(m.gated, 3);
  assert.equal(m.promoted, 0);
  assert.equal(m.inactives_fetched, '2026-09-17T21:30:00Z');
  assert.equal(out.tw['espn-9'], null, 'healthy DAL RB DNP observation does not zero');
  assert.ok(out.wk3['espn-9'] > 0);
  assert.equal(out.tw['espn-4'].reason, 'status');
  assert.equal(out.tw['espn-1'], null, 'QB1 DNP observation does not demote him');
  assert.equal(out.tw['espn-2'].reason, 'depth');
  assert.equal(out.tw['espn-3'].reason, 'depth');
  assert.equal(out.tw['espn-5'], null);
  assert.deepEqual(out.ids, {}, 'binding inactive_ids ignores unconfirmed observation');
  assert.deepEqual(out.observed, { 9: ['DAL', 'G3'], 1: ['SFX', 'G3'], 4: ['SFX', 'G3'] });
  assert.deepEqual(out.ids_other_week, {});
  // Confirmed + complete synthetic list still binds (future official source shape).
  assert.deepEqual(out.conf_meta.by_reason, { inactive: 3, status: 0, depth: 1 });
  assert.equal(out.conf_tw['espn-9'].reason, 'inactive');
  assert.equal(out.conf_tw['espn-1'].reason, 'inactive');
  assert.equal(out.conf_tw['espn-2'].reason, 'depth_promoted');
  assert.deepEqual(out.conf_ids, { 9: ['DAL', 'G3'], 1: ['SFX', 'G3'], 4: ['SFX', 'G3'] });
});

test('R79: no list -> R77 behaviour; observation mismatch/FINAL/bye never invent inactive gates', () => {
  const out = runPy(`${SETUP}
plain = build(inact=None)
fin = build(skip=("SFX",))
wrong = copy.deepcopy(INACT); wrong["games"][0]["inactive"] = {"DAL": [{"espn_id": "1", "name": "QB One"}], "SFX": []}
mis = build(inact=wrong)
bye = build(wk=2)
conf_fin = build(skip=("SFX",), inact=CONFIRMED)
emit({"plain": plain["model"]["this_week"], "plain_rb": by_id(plain)["espn-9"].get("this_week"),
      "fin": {k: (v.get("this_week") or {}).get("reason") for k, v in by_id(fin).items()},
      "mis": {k: (v.get("this_week") or {}).get("reason") for k, v in by_id(mis).items()},
      "bye": {k: (v.get("this_week") or {}).get("reason") for k, v in by_id(bye).items()},
      "conf_fin": {k: (v.get("this_week") or {}).get("reason") for k, v in by_id(conf_fin).items()}})`);
  assert.deepEqual(out.plain.by_reason, { inactive: 0, status: 1, depth: 2 });
  assert.equal(out.plain.inactives_fetched, null);
  assert.equal(out.plain_rb, null, 'the healthy DAL RB carries points without a list');
  // Observation FIN path: no inactive binds on either side
  assert.equal(out.fin['espn-9'], null);
  assert.equal(out.mis['espn-1'], null, 'observation DNP never binds regardless of team key');
  assert.equal(out.mis['espn-2'], 'depth', 'QB One stays the starter, QB Two stays gated');
  assert.equal(out.bye['espn-1'], null, 'SFX is on bye in week 2: nothing gated');
  // Confirmed list + FINAL SFX: DAL RB still binds; SFX players skip
  assert.equal(out.conf_fin['espn-9'], 'inactive');
  assert.equal(out.conf_fin['espn-1'], null);
});

/* 4 — the validator and the contract -------------------------------------------- */

test('R79: observation docs validate without inactive binds; confirmed docs catch orphan/silent/drift', () => {
  const out = runPy(`${SETUP}
import os
from scripts.validate_data import (ValidationError, check_weekly_availability,
                                   validate_against_schema, _load)
schema = _load(os.path.join("data", "contracts", "player_weekly.schema.json"))
in_schema = _load(os.path.join("data", "contracts", "inactives.schema.json"))
inj_doc = {"injuries": [dict(r, availability=av.normalize_status(r["status"])) for r in INJ]}
proj_doc = {"players": PROJ}
RELABEL = {"SFX": "SF", "GBX": "GB"}
def real_teams(d):
    d = copy.deepcopy(d)
    for p in d["players"]:
        for w in p["weeks"]:
            w["opp"] = RELABEL.get(w["opp"], w["opp"])
    return d
# Observation DNP weekly + inactives schema (confirmation=unconfirmed only)
obs = build()
check_weekly_availability(obs, proj_doc, inj_doc, depth_chart=DEPTH, inactives=INACT)
validate_against_schema(real_teams(obs), schema, "player_weekly.json")
validate_against_schema(INACT, in_schema, "inactives.json")
# Confirmed binding path (synthetic; not ESPN schema)
doc = build(inact=CONFIRMED)
check_weekly_availability(doc, proj_doc, inj_doc, depth_chart=DEPTH, inactives=CONFIRMED)
validate_against_schema(real_teams(doc), schema, "player_weekly.json")
res = {"green": True, "obs_ok": True}
def red(d, why, inact=CONFIRMED):
    try:
        check_weekly_availability(d, proj_doc, inj_doc, depth_chart=DEPTH, inactives=inact)
    except ValidationError as exc:
        return str(exc)
    raise AssertionError("not caught: " + why)
res["orphan"] = red(copy.deepcopy(doc), "inactive reason without the list", inact=None)
d = copy.deepcopy(doc); p = by_id(d)["espn-9"]; del p["this_week"]
w = wkrow(p, 3); del w["avail"]; w["pts"] = 30.0
d["model"]["this_week"]["gated"] = 3; d["model"]["this_week"]["by_reason"]["inactive"] = 2
res["silent"] = red(d, "confirmed list names him but wk3 is not gated")
d = copy.deepcopy(doc); by_id(d)["espn-9"]["this_week"]["game_id"] = "G9"
res["game_drift"] = red(d, "this_week.game_id != the list's game")
d = copy.deepcopy(doc); d["model"]["this_week"]["by_reason"]["inactive"] = 1
res["count_drift"] = red(d, "by_reason.inactive != rows")
d = copy.deepcopy(build(inact=None)); del d["model"]["this_week"]["by_reason"]["inactive"]; del d["model"]["this_week"]["inactives_fetched"]
check_weekly_availability(d, proj_doc, inj_doc, depth_chart=DEPTH, inactives=None)
validate_against_schema(real_teams(d), schema, "player_weekly.json")
res["pre_r79_ok"] = True
bad = copy.deepcopy(INACT); del bad["games"][0]["inactive"]["DAL"][0]["espn_id"]
try:
    validate_against_schema(bad, in_schema, "inactives.json"); res["schema_red"] = False
except ValidationError:
    res["schema_red"] = True
# Observation silent-inactive must NOT fire (binding set empty)
silent_obs = copy.deepcopy(obs)
check_weekly_availability(silent_obs, proj_doc, inj_doc, depth_chart=DEPTH, inactives=INACT)
res["obs_no_silent"] = True
emit(res)`);
  assert.equal(out.green, true);
  assert.equal(out.obs_ok, true);
  assert.equal(out.obs_no_silent, true);
  assert.match(out.orphan, /reason inactive but data\/inactives\.json does not name him/);
  assert.match(out.silent, /on the posted inactive list but wk3 is not gated/);
  assert.match(out.game_drift, /this_week\.game_id 'G9'/);
  assert.match(out.count_drift, /model\.this_week says/);
  assert.equal(out.pre_r79_ok, true);
  assert.equal(out.schema_red, true);
});

/* 5 — feed health: zero inactives outside a window is a fact, not an outage ----- */

test('R79: pipeline health accepts the inactives feed at rows 0 / ok WITH its note (the first R79 pipeline run failed here)', () => {
  const out = runPy(`${SETUP}
from scripts.validate_data import ValidationError, check_pipeline_health
def status(feed):
    return {"health": "ok", "generated_utc": "2026-09-17T16:36:57Z",
            "feeds": {"espn_teams": {"rows": 32, "age_hours": 0.0, "last_success_utc": "x", "status": "ok"},
                      "inactives": feed}}
res = {}
check_pipeline_health(status({"rows": 0, "age_hours": 0.0, "last_success_utc": "x", "status": "ok",
                              "note": "no game inside the inactives window this run"}))
res["outside_window_ok"] = True
check_pipeline_health(status({"rows": 13, "age_hours": 0.0, "last_success_utc": "x", "status": "ok",
                              "note": "1 game(s) in the 3h window, 0 fetch failure(s)"}))
res["inside_window_ok"] = True
try:
    check_pipeline_health(status({"rows": 0, "age_hours": 0.0, "last_success_utc": "x", "status": "ok"}))
    res["no_note"] = "accepted"
except ValidationError as exc:
    res["no_note"] = str(exc)
emit(res)`);
  assert.equal(out.outside_window_ok, true);
  assert.equal(out.inside_window_ok, true);
  assert.match(String(out.no_note), /inactives/, 'a zero without its note is still refused');
});

/* 6 — the app ------------------------------------------------------------------- */

test('R79: the PLAYERS headline reads WK n · INACTIVE only for confirmed official lists', () => {
  assert.deepEqual(
    gateTag({ wk: 2, playable: false, reason: 'inactive', game_id: 'G',
      confirmation: 'confirmed', points_lost: 9.1 }),
    ['INACTIVE', 'Not playable this week — on the posted game-day inactive list']);
  assert.equal(
    gateTag({ wk: 2, playable: false, reason: 'inactive', game_id: 'G', points_lost: 9.1 }),
    null,
    'observation-only / unconfirmed reason=inactive must not claim a posted official list');
  assert.equal(gateTag({ wk: 2, playable: true, reason: 'inactive' }), null, 'playable is never tagged inactive');
});
