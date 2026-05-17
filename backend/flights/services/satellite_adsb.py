"""
Satellite-based ADS-B data source client.

Fetches aircraft positions received by satellites equipped
with ADS-B receivers. These are primarily aircraft flying over
oceans and remote areas where ground-based receivers have no
coverage.

Satellite ADS-B is essential for oceanic flight tracking —
without it, aircraft disappear from radar once they leave
the range of coastal ground stations.
"""

import logging
import math
import requests
import time

from .adsb_sources import normalize_adsbx_aircraft

logger = logging.getLogger(__name__)

AIRPLANES_LIVE_URL = "https://api.airplanes.live/v2/all"
REQUEST_TIMEOUT = 30

_last_fetch_time = 0
MIN_FETCH_INTERVAL = 30  # seconds


def _is_satellite_received(aircraft):
    """
    Determine if an aircraft position was received via satellite.

    Some aggregators flag satellite-received positions. We check
    for explicit satellite flags and also infer from MLAT inability
    combined with oceanic position.
    """
    if not isinstance(aircraft, dict):
        return False

    # Explicit satellite flag
    if aircraft.get("sat") is True:
        return True

    # Some feeds use "satellite" in the type field
    ac_type = str(aircraft.get("type") or "").lower()
    if "sat" in ac_type or "satellite" in ac_type:
        return True

    # Check for the "tisb" flag combined with high-altitude oceanic
    # position (satellite TIS-B rebroadcast)
    if aircraft.get("tisb") and _is_oceanic_position(aircraft):
        return True

    return False


def _is_oceanic_position(aircraft):
    """Check if the aircraft is over ocean (rough heuristic)."""
    try:
        lat = float(aircraft.get("lat"))
        lon = float(aircraft.get("lon"))
    except (TypeError, ValueError):
        return False
    if not (
        math.isfinite(lat)
        and math.isfinite(lon)
        and -90 <= lat <= 90
        and -180 <= lon <= 180
    ):
        return False

    # Major ocean regions (very rough bounding boxes)
    # Atlantic: lat -60 to 60, lon -80 to -10
    if -60 < lat < 60 and -80 < lon < -10:
        return True
    # Pacific: lat -60 to 60, lon 130 to 180 or -180 to -100
    if -60 < lat < 60 and (lon > 130 or lon < -100):
        return True
    # Indian Ocean: lat -60 to 25, lon 40 to 100
    if -60 < lat < 25 and 40 < lon < 100:
        return True
    # Arctic/Antarctic
    if abs(lat) > 65:
        return True

    return False


# Major oceanic aviation hubs to query regional traffic (primary Satellite zones)
POINT_HUBS = [
    (21.3069, -157.8583, 250, "Honolulu/Pacific"),
    (64.1466, -21.9426, 250, "Reykjavik/North Atlantic"),
    (37.7412, -25.6756, 250, "Azores/Central Atlantic"),
    (-17.7134, 178.0650, 250, "Fiji/South Pacific"),
]


def fetch_satellite_adsb_states():
    """
    Fetch satellite-received ADS-B positions.

    Filters the airplanes.live regional feeds for aircraft positions
    received via satellite. Returns normalized flight state dicts
    with position_source=6 (satellite) and data_source='satellite'.
    """
    global _last_fetch_time

    now = time.time()
    if now - _last_fetch_time < MIN_FETCH_INTERVAL:
        return []
    _last_fetch_time = now

    all_normalized = []
    seen_icaos = set()

    for lat, lon, rad, name in POINT_HUBS:
        try:
            url = f"https://api.airplanes.live/v2/point/{lat}/{lon}/{rad}"
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
            aircraft_list = payload.get("ac") or payload.get("aircraft") or []
            source_now = payload.get("now")

            for item in aircraft_list:
                if not _is_satellite_received(item):
                    continue
                icao = item.get("hex") or item.get("icao24")
                if icao:
                    icao = icao.strip().lower()
                if icao and icao not in seen_icaos:
                    state = normalize_adsbx_aircraft(item, source_now=source_now)
                    if state is not None:
                        state["position_source"] = 6  # satellite
                        state["data_source"] = "satellite"
                        seen_icaos.add(icao)
                        all_normalized.append(state)

        except Exception as exc:
            logger.warning("Satellite ADS-B fetch failed for hub %s: %s", name, exc)

    logger.info("Satellite ADS-B: fetched %d unique aircraft from oceanic hubs", len(all_normalized))
    return all_normalized
