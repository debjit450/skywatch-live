"""METAR lookup and lightweight decode helpers."""

import logging
from urllib.parse import urlencode

import requests

from .cache import cached_lookup, _get_json, _set_json

logger = logging.getLogger(__name__)
AVIATION_WEATHER_METAR_URL = "https://aviationweather.gov/api/data/metar"


def _flight_category(visibility_sm, ceiling_ft):
    if visibility_sm is None or ceiling_ft is None:
        return "VFR"
    if visibility_sm < 1 or ceiling_ft < 500:
        return "LIFR"
    if visibility_sm < 3 or ceiling_ft < 1000:
        return "IFR"
    if visibility_sm <= 5 or ceiling_ft <= 3000:
        return "MVFR"
    return "VFR"


def _decode_metar(record):
    visibility = record.get("visib")
    ceiling = record.get("clouds", [{}])[0].get("base") if record.get("clouds") else None
    try:
        visibility = float(visibility) if visibility not in (None, "10+") else 10.0
    except (TypeError, ValueError):
        visibility = None
    try:
        ceiling = int(ceiling) if ceiling is not None else None
    except (TypeError, ValueError):
        ceiling = None

    return {
        "station": record.get("icaoId"),
        "raw": record.get("rawOb", ""),
        "observed_at": record.get("obsTime"),
        "wind_direction": record.get("wdir"),
        "wind_speed": record.get("wspd"),
        "visibility": visibility,
        "ceiling": ceiling,
        "temperature": record.get("temp"),
        "flight_category": record.get("fltCat") or _flight_category(visibility, ceiling),
    }


def _metar_cache_key(station):
    return f"metar:{str(station).strip().upper()}"


@cached_lookup(_metar_cache_key, 15 * 60)
def fetch_metar_for_station(station):
    station = str(station).strip().upper()
    if not station:
        return None

    try:
        params = urlencode({"ids": station, "format": "json"})
        response = requests.get(f"{AVIATION_WEATHER_METAR_URL}?{params}", timeout=5)
        response.raise_for_status()
        payload = response.json()
        if not payload:
            return None
        return _decode_metar(payload[0])
    except Exception as exc:
        logger.warning("METAR fetch failed for %s: %s", station, exc)
        return None


def fetch_metars(stations):
    result = {}
    uncached_stations = []

    for station in stations:
        station = str(station).strip().upper()
        if not station:
            continue
        key = _metar_cache_key(station)
        cached = _get_json(key)
        if cached is not None:
            result[station] = cached
        else:
            uncached_stations.append(station)

    if uncached_stations:
        try:
            chunk_size = 50
            for i in range(0, len(uncached_stations), chunk_size):
                chunk = uncached_stations[i:i + chunk_size]
                params = urlencode({"ids": ",".join(chunk), "format": "json"})
                response = requests.get(f"{AVIATION_WEATHER_METAR_URL}?{params}", timeout=10)
                response.raise_for_status()
                payload = response.json()
                if payload:
                    for record in payload:
                        try:
                            decoded = _decode_metar(record)
                            station_id = decoded["station"]
                            if station_id:
                                station_id = station_id.upper()
                                result[station_id] = decoded
                                key = _metar_cache_key(station_id)
                                _set_json(key, decoded, 15 * 60)
                        except Exception as record_exc:
                            logger.warning("Failed to decode METAR record %s: %s", record, record_exc)
        except Exception as exc:
            logger.warning("METAR batch fetch failed for %s: %s", uncached_stations, exc)
            # Fallback to individual requests
            for station in uncached_stations:
                decoded = fetch_metar_for_station(station)
                if decoded:
                    result[station] = decoded

    return result
