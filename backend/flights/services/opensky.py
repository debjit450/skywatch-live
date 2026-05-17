"""
OpenSky Network API client.

Handles authentication (OAuth2 client credentials or basic auth),
rate limiting, and response parsing.
"""

import logging
import math
import re
import time
import requests
from django.conf import settings

logger = logging.getLogger(__name__)

TOKEN_URL = (
    "https://auth.opensky-network.org/auth/realms/opensky-network"
    "/protocol/openid-connect/token"
)
STATES_URL = "https://opensky-network.org/api/states/all"

_cached_token = {"token": None, "expires_at": 0}
_last_fetch_time = 0
MIN_FETCH_INTERVAL = 10  # seconds
ICAO24_RE = re.compile(r"^[0-9a-f]{6}$")


def _valid_icao24(value):
    return isinstance(value, str) and bool(ICAO24_RE.fullmatch(value.strip().lower()))


def _valid_coordinate(latitude, longitude):
    return (
        isinstance(latitude, (int, float))
        and isinstance(longitude, (int, float))
        and math.isfinite(latitude)
        and math.isfinite(longitude)
        and -90 <= latitude <= 90
        and -180 <= longitude <= 180
    )


def _get_access_token():
    """Obtain an OAuth2 access token using client credentials."""
    client_id = settings.OPENSKY_CLIENT_ID
    client_secret = settings.OPENSKY_CLIENT_SECRET
    if not client_id or not client_secret:
        return None

    if _cached_token["token"] and _cached_token["expires_at"] - 30 > time.time():
        return _cached_token["token"]

    try:
        resp = requests.post(
            TOKEN_URL,
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        _cached_token["token"] = data["access_token"]
        _cached_token["expires_at"] = time.time() + data.get("expires_in", 300)
        logger.info("OpenSky OAuth token refreshed")
        return _cached_token["token"]
    except Exception as exc:
        logger.warning("Failed to get OpenSky OAuth token: %s", exc)
        return None


def _get_basic_auth():
    """Fall back to basic auth if OAuth credentials aren't set."""
    username = settings.OPENSKY_USERNAME
    password = settings.OPENSKY_PASSWORD
    if username and password:
        return (username, password)
    return None


def fetch_all_states(bounds=None):
    """
    Fetch all flight state vectors from OpenSky.

    Returns:
        dict with keys: time (int), states (list of parsed dicts), authenticated (bool)
    Raises:
        Exception on network/API errors.
    """
    global _last_fetch_time

    now = time.time()
    if now - _last_fetch_time < MIN_FETCH_INTERVAL:
        logger.debug("Skipping fetch — too soon since last call")
        return None

    headers = {"Accept": "application/json"}
    auth = None

    token = _get_access_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    else:
        auth = _get_basic_auth()

    params = {"extended": 1}
    if bounds:
        params.update({
            "lamin": bounds["lamin"],
            "lamax": bounds["lamax"],
            "lomin": bounds["lomin"],
            "lomax": bounds["lomax"],
        })

    try:
        resp = requests.get(
            STATES_URL,
            headers=headers,
            auth=auth,
            params=params,
            timeout=30,
        )
        _last_fetch_time = time.time()

        if resp.status_code == 429:
            logger.warning("OpenSky rate limit hit (429)")
            return None

        resp.raise_for_status()
        data = resp.json()

        states = data.get("states") or []
        parsed = []
        for s in states:
            if len(s) < 17:
                continue
            icao24 = str(s[0] or "").strip().lower()
            if not _valid_icao24(icao24):
                continue
            # Only include flights with position data
            if s[5] is None or s[6] is None:
                continue
            if not _valid_coordinate(s[6], s[5]):
                continue
            parsed.append({
                "icao24": icao24,
                "callsign": (s[1] or "").strip() or None,
                "origin_country": s[2],
                "time_position": s[3],
                "last_contact": s[4],
                "longitude": s[5],
                "latitude": s[6],
                "baro_altitude": s[7],
                "on_ground": s[8],
                "velocity": s[9],
                "true_track": s[10],
                "vertical_rate": s[11],
                "sensors": s[12],
                "geo_altitude": s[13],
                "squawk": s[14],
                "spi": s[15],
                "position_source": s[16],
                "category": s[17] if len(s) > 17 and s[17] is not None else 0,
                "data_source": "opensky",
            })

        logger.info(
            "Fetched %d flight states from OpenSky (authenticated=%s)",
            len(parsed),
            bool(token or auth),
        )

        return {
            "time": data.get("time", int(time.time())),
            "states": parsed,
            "authenticated": bool(token or auth),
        }

    except requests.exceptions.Timeout:
        logger.error("OpenSky API timeout")
        raise
    except requests.exceptions.HTTPError as exc:
        logger.error("OpenSky API HTTP error: %s", exc)
        raise
    except Exception as exc:
        logger.error("OpenSky API error: %s", exc)
        raise
