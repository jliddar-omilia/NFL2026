"""Home-field Elo policy for ordinary vs neutral-site games.

Designated home/away labels stay on the schedule. Ordinary home-field Elo is
applied only when the game is NOT an explicit neutral site. Weather/venue
binding stays in weather_source_contract — this module never invents a roof
or coordinates.
"""


def _as_bool_flag(value):
    """True / False for bools; 'malformed' for any other present value."""
    if value is True:
        return True
    if value is False:
        return False
    return "malformed"


def neutral_site_flag(game):
    """Return True / False / None (absent) / 'malformed' / 'conflict'.

    Accepts ESPN `neutralSite` or our snake_case `neutral_site`. None means the
    provider omitted the field — ordinary HFA is retained (no inference that
    the game is neutral). Any non-bool present value is malformed. When both
    keys are present and disagree, the result is conflict (never prefer one
    casing): HFA and weather/venue both take the conservative path.
    """
    if type(game) is not dict:
        return "malformed"
    has_snake = "neutral_site" in game
    has_camel = "neutralSite" in game
    if not has_snake and not has_camel:
        return None
    if has_snake and has_camel:
        a, b = _as_bool_flag(game.get("neutral_site")), _as_bool_flag(game.get("neutralSite"))
        if a == "malformed" or b == "malformed":
            return "malformed"
        if a != b:
            return "conflict"
        return a
    return _as_bool_flag(game.get("neutral_site") if has_snake else game.get("neutralSite"))


def is_neutral_site(game):
    """True when ordinary home treatment must be refused.

    Explicit True, malformed, and conflicting snake/camel flags all refuse
    ordinary home roof/weather inheritance. Absent and explicit False do not.
    """
    return neutral_site_flag(game) in (True, "malformed", "conflict")


def home_field_elo(game, hfa_live, venue_delta=0.0, cold_delta=0.0):
    """Home-only Elo components for one game.

    neutral / malformed / conflict -> 0 (no ordinary home edge).
    absent / False                 -> hfa_live + venue_delta + cold_delta.
    Non-home signals (rest, EPA, QB, etc.) are applied by the caller separately.
    """
    if is_neutral_site(game):
        return 0.0
    return float(hfa_live) + float(venue_delta or 0.0) + float(cold_delta or 0.0)
