"""
FAA / Military radar data source client.

Fetches radar-derived aircraft positions primarily for:
- Military/government aircraft tracked by FAA radar
- North American radar coverage filling ADS-B gaps

Uses the airplanes.live military endpoint which aggregates
FAA SWIM data and radar feeds.
"""

import logging
import requests
import time

from .adsb_sources import normalize_adsbx_aircraft

logger = logging.getLogger(__name__)

MIL_URL = "https://api.airplanes.live/v2/mil"
REQUEST_TIMEOUT = 30

_last_fetch_time = 0
MIN_FETCH_INTERVAL = 30  # seconds — be respectful of the API


def fetch_faa_radar_states():
    """
    Fetch military/radar-tracked aircraft from the airplanes.live
    military endpoint.

    Returns a list of normalized flight state dicts with
    position_source=4 (radar) and data_source='faa_radar'.
    """
    global _last_fetch_time

    now = time.time()
    if now - _last_fetch_time < MIN_FETCH_INTERVAL:
        return []
    _last_fetch_time = now

    try:
        response = requests.get(
            MIL_URL,
            headers={"Accept": "application/json"},
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        payload = response.json()
        aircraft_list = payload.get("ac") or payload.get("aircraft") or []
        source_now = payload.get("now")

        normalized = []
        for item in aircraft_list:
            state = normalize_adsbx_aircraft(item, source_now=source_now)
            if state is not None:
                # Override source info
                state["position_source"] = 4  # radar
                state["data_source"] = "faa_radar"
                normalized.append(state)

        logger.info("FAA/Mil radar: fetched %d aircraft", len(normalized))
        return normalized

    except Exception as exc:
        logger.warning("FAA radar fetch failed: %s", exc)
        return []
