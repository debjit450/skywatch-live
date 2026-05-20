"""Supplemental ADS-B source clients.

Both adsb.one and airplanes.live expose ADSBExchange v2-compatible JSON.
The normalizer below maps that payload into the same flight-state dict shape
produced by ``services.opensky.fetch_all_states``.
"""

import logging
import math
import time

import requests

logger = logging.getLogger(__name__)

ADSB_ONE_URL = "https://api.adsb.one/v2/all"
AIRPLANES_LIVE_URL = "https://api.airplanes.live/v2/all"
ADSB_LOL_URL = "https://api.adsb.lol/v2"
REQUEST_TIMEOUT = 30
FT_TO_M = 0.3048
KT_TO_MS = 0.514444
FPM_TO_MS = 0.00508
HEX_DIGITS = set("0123456789abcdef")

CATEGORY_MAP = {
    "A0": 1,
    "A1": 2,
    "A2": 3,
    "A3": 4,
    "A4": 5,
    "A5": 6,
    "A6": 7,
    "A7": 8,
    "B1": 9,
    "B2": 10,
    "B3": 11,
    "B4": 12,
    "B6": 14,
    "B7": 15,
    "C1": 16,
    "C2": 17,
    "C3": 18,
    "C4": 19,
    "C5": 20,
}


def _to_float(value):
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _is_valid_icao24(value):
    return len(value) == 6 and all(char in HEX_DIGITS for char in value)


def _is_valid_coordinate(latitude, longitude):
    return (
        latitude is not None
        and longitude is not None
        and math.isfinite(latitude)
        and math.isfinite(longitude)
        and -90 <= latitude <= 90
        and -180 <= longitude <= 180
    )


def _to_epoch_seconds(value):
    epoch = _to_float(value)
    if epoch is None:
        return time.time()
    if epoch > 10_000_000_000:
        return epoch / 1000
    return epoch


def _altitude_ft_to_m(value):
    if isinstance(value, str) and value.lower() == "ground":
        return 0
    altitude = _to_float(value)
    return altitude * FT_TO_M if altitude is not None else None


def _rate_fpm_to_ms(value):
    rate = _to_float(value)
    return rate * FPM_TO_MS if rate is not None else None


def _speed_kt_to_ms(value):
    speed = _to_float(value)
    return speed * KT_TO_MS if speed is not None else None


def _position_source(aircraft_type):
    source = (aircraft_type or "").lower()
    if "mlat" in source:
        return 2
    if "flarm" in source:
        return 3
    return 0


def _normalize_category(value):
    if value is None:
        return 0
    if isinstance(value, int):
        return value
    category = str(value).strip().upper()
    return CATEGORY_MAP.get(category, 0)


def normalize_adsbx_aircraft(aircraft, source_now=None):
    """Normalize one ADSBExchange v2 aircraft object to the OpenSky state shape."""
    if not isinstance(aircraft, dict):
        return None
    icao24 = str(aircraft.get("hex") or aircraft.get("icao24") or "").strip().lower()
    if not _is_valid_icao24(icao24):
        return None

    latitude = _to_float(aircraft.get("lat"))
    longitude = _to_float(aircraft.get("lon"))
    if not _is_valid_coordinate(latitude, longitude):
        return None

    now_epoch = _to_epoch_seconds(source_now)
    seen = _to_float(aircraft.get("seen"))
    seen_pos = _to_float(aircraft.get("seen_pos"))
    last_contact = now_epoch - seen if seen is not None else now_epoch
    time_position = now_epoch - seen_pos if seen_pos is not None else last_contact
    alt_baro = aircraft.get("alt_baro")
    callsign = str(aircraft.get("flight") or aircraft.get("callsign") or "").strip() or None
    squawk = aircraft.get("squawk")

    return {
        "icao24": icao24,
        "callsign": callsign,
        "origin_country": "",
        "time_position": time_position,
        "last_contact": last_contact,
        "longitude": longitude,
        "latitude": latitude,
        "baro_altitude": _altitude_ft_to_m(alt_baro),
        "on_ground": bool(
            aircraft.get("ground")
            or aircraft.get("on_ground")
            or (isinstance(alt_baro, str) and alt_baro.lower() == "ground")
        ),
        "velocity": _speed_kt_to_ms(aircraft.get("gs")),
        "true_track": _to_float(aircraft.get("track")),
        "vertical_rate": _rate_fpm_to_ms(
            aircraft.get("baro_rate")
            if aircraft.get("baro_rate") is not None
            else aircraft.get("geom_rate")
        ),
        "sensors": None,
        "geo_altitude": _altitude_ft_to_m(aircraft.get("alt_geom")),
        "squawk": str(squawk).strip() if squawk else None,
        "spi": bool(aircraft.get("spi", False)),
        "position_source": _position_source(aircraft.get("type")),
        "category": _normalize_category(aircraft.get("category")),
        "data_source": "",  # set by caller
    }


# Major global aviation hubs to query regional traffic (radius up to 250 nm).
# Point queries keep public aggregator use bounded while improving coverage
# beyond the single-network OpenSky feed.
POINT_HUBS = [
    (40.7128, -74.0060, 250, "New York"),
    (51.5074, -0.1278, 250, "London"),
    (35.6762, 139.6503, 250, "Tokyo"),
    (34.0522, -118.2437, 250, "Los Angeles"),
    (50.1109, 8.6821, 250, "Frankfurt"),
    (28.6139, 77.2090, 250, "Delhi"),
    (25.2048, 55.2708, 250, "Dubai"),
    (1.3521, 103.8198, 250, "Singapore"),
    (-33.8688, 151.2093, 250, "Sydney"),
    (-23.5505, -46.6333, 250, "Sao Paulo"),
    (-26.2041, 28.0473, 250, "Johannesburg"),
    (43.6532, -79.3832, 250, "Toronto"),
]


def _fetch_adsbx_source(url, source_name, source_tag=""):
    try:
        response = requests.get(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        aircraft = payload.get("ac") or payload.get("aircraft") or []
        source_now = payload.get("now")
        normalized = []

        for item in aircraft:
            state = normalize_adsbx_aircraft(item, source_now=source_now)
            if state is not None:
                state["data_source"] = source_tag
                normalized.append(state)

        logger.info("Fetched %d flight states from %s", len(normalized), source_name)
        return normalized
    except Exception as exc:
        logger.warning("%s fetch failed: %s", source_name, exc)
        return []



def _fetch_point_hub_states(base_url, source_name, source_tag, sleep_seconds):
    """Query all POINT_HUBS for an ADS-B aggregator endpoint and deduplicate."""
    all_states = []
    seen_icaos = set()

    for lat, lon, rad, name in POINT_HUBS:
        url = f"{base_url}/point/{lat}/{lon}/{rad}"
        states = _fetch_adsbx_source(url, f"{source_name} ({name})", source_tag=source_tag)
        for s in states:
            icao = s.get("icao24")
            if icao and icao not in seen_icaos:
                seen_icaos.add(icao)
                all_states.append(s)
        time.sleep(sleep_seconds)

    logger.info("%s point query total: %d unique aircraft", source_name, len(all_states))
    return all_states


def fetch_adsb_one_states():
    """Fetch and normalize aircraft from adsb.one using regional point queries.

    The global /v2/all endpoint returns 403 Forbidden on public access, so we
    use the same multi-hub point-query strategy as the other supplemental sources
    to get broad global coverage instead of a single New York region.
    """
    return _fetch_point_hub_states(
        base_url="https://api.adsb.one/v2",
        source_name="ADSB-One",
        source_tag="adsb_one",
        sleep_seconds=0.5,
    )


def fetch_airplanes_live_states():
    """Fetch and normalize current aircraft from airplanes.live point hubs."""
    return _fetch_point_hub_states(
        base_url="https://api.airplanes.live/v2",
        source_name="Airplanes.live",
        source_tag="airplanes_live",
        sleep_seconds=1.0,
    )


def fetch_adsb_lol_states():
    """Fetch and normalize current aircraft from ADSB.lol public point hubs."""
    return _fetch_point_hub_states(
        base_url=ADSB_LOL_URL,
        source_name="ADSB.lol",
        source_tag="adsb_lol",
        sleep_seconds=0.7,
    )
