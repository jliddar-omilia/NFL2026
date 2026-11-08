"""Home-field Elo policy for ordinary vs neutral-site games.

Designated home/away labels stay on the schedule. Ordinary home-field Elo is
applied only when the game is NOT an explicit neutral site. Weather/venue
binding stays in weather_source_contract — this module never invents a roof
or coordinates.
"""


def neutral_site_flag(game):
    """Return True / False / None (absent) / 'malformed'.

    Accepts ESPN `neutralSite` or our snake_case `neutral_site`. None means the
    provider omitted the field — ordinary HFA is retained (no inference that
    the game is neutral). Any non-bool present value is malformed.
    """
    if type(game) is not dict:
        return "malformed"
    if "neutral_site" in game:
        value = game.get("neutral_site")
    elif "neutralSite" in game:
        value = game.get("neutralSite")
    else:
        return None
    if value is True:
        return True
    if value is False:
        return False
    return "malformed"


def is_neutral_site(game):
    """True only for an explicit boolean True neutral flag."""
    return neutral_site_flag(game) is True


def home_field_elo(game, hfa_live, venue_delta=0.0, cold_delta=0.0):
    """Home-only Elo components for one game.

    neutral / malformed -> 0 (no ordinary home edge).
    absent / False      -> hfa_live + venue_delta + cold_delta.
    Non-home signals (rest, EPA, QB, etc.) are applied by the caller separately.
    """
    flag = neutral_site_flag(game)
    if flag is True or flag == "malformed":
        return 0.0
    return float(hfa_live) + float(venue_delta or 0.0) + float(cold_delta or 0.0)
