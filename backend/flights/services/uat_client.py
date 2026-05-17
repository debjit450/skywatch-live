"""
UAT (Universal Access Transceiver, 978 MHz) data source client.

Fetches positions for US general aviation aircraft operating
below FL180 (18,000 ft) that use 978 MHz UAT transponders
instead of 1090 MHz ADS-B.

This is a growing data source primarily used by smaller GA
aircraft in the United States.
"""

import logging
import requests
import time

from .adsb_sources import normalize_adsbx_aircraft

logger = logging.getLogger(__name__)

# airplanes.live exposes UAT traffic via the main endpoint;
# we filter by the `type` field which indicates "adsb_icao_uat"
# or similar UAT source indicators.
AIRPLANES_LIVE_URL = "https://api.airplanes.live/v2/all"
REQUEST_TIMEOUT = 30

_last_fetch_time = 0
MIN_FETCH_INTERVAL = 30  # seconds

# UAT type indicators in the airplanes.live data
UAT_TYPES = {
    "adsb_icao_uat",
    "adsb_other_uat",
    "adsr_icao_uat",
    "tisb_icao",
    "tisb_trackfile",
    "tisb_other",
    "uat",
}


def _is_uat_aircraft(aircraft):
    """Check if an aircraft entry is from a UAT source."""
    if not isinstance(aircraft, dict):
        return False
    ac_type = str(aircraft.get("type") or "").lower()
    # Check direct UAT type match
    if ac_type in UAT_TYPES:
        return True
    if "uat" in ac_type:
        return True
    # TIS-B (Traffic Information Service-Broadcast) is UAT-related
    if "tisb" in ac_type:
        return True
    return False


# Major US aviation hubs to query regional traffic (primary UAT zone)
POINT_HUBS = [
    (40.7128, -74.0060, 250, "New York"),
    (34.0522, -118.2437, 250, "Los Angeles"),
    (41.8781, -87.6298, 250, "Chicago"),
    (29.7604, -95.3698, 250, "Houston"),
    (37.7749, -122.4194, 250, "San Francisco"),
]


def fetch_uat_states():
    """
    Fetch UAT aircraft positions.

    Filters the airplanes.live regional feeds for aircraft using
    UAT transponders. Returns normalized flight state dicts
    with position_source=5 (UAT) and data_source='uat'.
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
                if not _is_uat_aircraft(item):
                    continue
                icao = item.get("hex") or item.get("icao24")
                if icao:
                    icao = icao.strip().lower()
                if icao and icao not in seen_icaos:
                    state = normalize_adsbx_aircraft(item, source_now=source_now)
                    if state is not None:
                        state["position_source"] = 5  # UAT
                        state["data_source"] = "uat"
                        seen_icaos.add(icao)
                        all_normalized.append(state)

        except Exception as exc:
            logger.warning("UAT fetch failed for hub %s: %s", name, exc)

    logger.info("UAT: fetched %d unique aircraft from regional hubs", len(all_normalized))
    return all_normalized
