"""CelesTrak satellite catalog and SGP4 propagation helpers."""

from __future__ import annotations

import logging
import math
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Iterable

import requests

try:
    from sgp4.api import Satrec, jday

    SGP4_AVAILABLE = True
except Exception:  # pragma: no cover - optional dependency guard
    Satrec = None
    jday = None
    SGP4_AVAILABLE = False

logger = logging.getLogger(__name__)


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


CELESTRAK_GP_URL = "https://celestrak.org/NORAD/elements/gp.php"
REQUEST_TIMEOUT = _float_env("CELESTRAK_REQUEST_TIMEOUT_SECONDS", 3.0)
CATALOG_TIMEOUT_SECONDS = _float_env("CELESTRAK_CATALOG_TIMEOUT_SECONDS", 10.0)
TLE_CACHE_TTL_SECONDS = 15 * 60
LIVE_SOURCE_BACKOFF_SECONDS = _float_env("CELESTRAK_LIVE_BACKOFF_SECONDS", 120.0)
WGS84_A_KM = 6378.137
WGS84_E2 = 6.69437999014e-3

SATELLITE_GROUPS = [
    {
        "key": "stations",
        "group": "stations",
        "label": "Space stations",
        "limit": 24,
        "color": "#22c55e",
    },
    {
        "key": "visual",
        "group": "visual",
        "label": "Bright visual",
        "limit": 90,
        "color": "#facc15",
    },
    {
        "key": "weather",
        "group": "weather",
        "label": "Weather",
        "limit": 120,
        "color": "#38bdf8",
    },
    {
        "key": "earth_resources",
        "group": "resource",
        "label": "Earth observation",
        "limit": 140,
        "color": "#4ade80",
    },
    {
        "key": "navigation",
        "group": "gps-ops",
        "label": "GPS",
        "limit": 48,
        "color": "#a78bfa",
    },
    {
        "key": "galileo",
        "group": "galileo",
        "label": "Galileo",
        "limit": 48,
        "color": "#c084fc",
    },
    {
        "key": "beidou",
        "group": "beidou",
        "label": "BeiDou",
        "limit": 64,
        "color": "#fb7185",
    },
    {
        "key": "starlink",
        "group": "starlink",
        "label": "Starlink",
        "limit": 180,
        "color": "#94a3b8",
    },
    {
        "key": "oneweb",
        "group": "oneweb",
        "label": "OneWeb",
        "limit": 90,
        "color": "#60a5fa",
    },
]

_GROUP_BY_KEY = {item["key"]: item for item in SATELLITE_GROUPS}
_GROUP_BY_CELESTRAK_NAME = {item["group"]: item for item in SATELLITE_GROUPS}
_tle_cache: dict[str, tuple[float, list[dict[str, str]]]] = {}
_live_source_backoff_until = 0.0

# Public CelesTrak-style bootstrap records used only when the live source is
# unreachable. They keep the map useful in offline/local development while the
# stale TLE quality badge makes the lower precision explicit.
FALLBACK_TLE_GROUPS: dict[str, list[dict[str, str]]] = {
    "stations": [
        {
            "satnum": "25544",
            "name": "ISS (ZARYA)",
            "line1": "1 25544U 98067A   21275.51041667  .00002182  00000-0  50365-4 0  9993",
            "line2": "2 25544  51.6445  21.2947 0003456  88.8090  44.7201 15.48915324306411",
        },
        {
            "satnum": "48274",
            "name": "CSS (TIANHE)",
            "line1": "1 48274U 21035A   21275.47692130  .00016717  00000-0  18979-3 0  9996",
            "line2": "2 48274  41.4697 116.4504 0005304  39.2292 320.8911 15.62092622 24453",
        },
    ],
    "visual": [
        {
            "satnum": "20580",
            "name": "HST",
            "line1": "1 20580U 90037B   21275.59097222  .00000500  00000-0  19827-4 0  9994",
            "line2": "2 20580  28.4699 264.6238 0002852  74.1049 286.0268 15.09299830477275",
        },
        {
            "satnum": "25338",
            "name": "NOAA 15",
            "line1": "1 25338U 98030A   21275.48198843  .00000055  00000-0  53184-4 0  9992",
            "line2": "2 25338  98.7092 302.0538 0011228 187.9963 172.1062 14.25996389214174",
        },
    ],
    "weather": [
        {
            "satnum": "33591",
            "name": "NOAA 19",
            "line1": "1 33591U 09005A   21275.48563382  .00000058  00000-0  59431-4 0  9990",
            "line2": "2 33591  99.1945 304.9613 0014080 235.5730 124.4096 14.12516450652914",
        },
        {
            "satnum": "28654",
            "name": "NOAA 18",
            "line1": "1 28654U 05018A   21275.51296467  .00000074  00000-0  66778-4 0  9997",
            "line2": "2 28654  99.0334 316.0682 0013908 122.0142 238.2381 14.12506171844621",
        },
    ],
    "resource": [
        {
            "satnum": "39084",
            "name": "LANDSAT 8",
            "line1": "1 39084U 13008A   21275.49420139  .00000295  00000-0  71548-4 0  9998",
            "line2": "2 39084  98.2204 347.7113 0001276  89.7485 270.3862 14.57110888459628",
        },
        {
            "satnum": "25994",
            "name": "TERRA",
            "line1": "1 25994U 99068A   21275.52394444  .00000115  00000-0  32214-4 0  9997",
            "line2": "2 25994  98.2068 350.2217 0001285  91.0026 269.1325 14.57111758158542",
        },
    ],
    "gps-ops": [
        {
            "satnum": "24876",
            "name": "GPS BIIR-2",
            "line1": "1 24876U 97035A   21275.14512416  .00000040  00000-0  00000-0 0  9995",
            "line2": "2 24876  55.5537 205.5573 0147989  55.1852 306.1903  2.00563585177617",
        },
        {
            "satnum": "32711",
            "name": "GPS BIIRM-6",
            "line1": "1 32711U 08012A   21275.23152778 -.00000028  00000-0  00000-0 0  9991",
            "line2": "2 32711  54.9446  86.3822 0086408  49.6258 311.1534  2.00563448 99321",
        },
    ],
}


def _parse_tle_payload(payload: str) -> list[dict[str, str]]:
    lines = [line.strip() for line in payload.replace("\r", "").split("\n") if line.strip()]
    parsed: list[dict[str, str]] = []
    index = 0

    while index + 2 < len(lines):
        name = lines[index]
        line1 = lines[index + 1]
        line2 = lines[index + 2]

        if not line1.startswith("1 ") or not line2.startswith("2 "):
            index += 1
            continue

        satnum = line1[2:7].strip()
        parsed.append(
            {
                "satnum": satnum,
                "name": name,
                "line1": line1,
                "line2": line2,
            }
        )
        index += 3

    return parsed


def _fallback_tle_group(group: str) -> list[dict[str, str]]:
    return [dict(record) for record in FALLBACK_TLE_GROUPS.get(group, [])]


def _fetch_tle_group(group: str, timeout_seconds: float | None = None) -> list[dict[str, str]]:
    now = time.time()
    cached = _tle_cache.get(group)
    if cached and now - cached[0] < TLE_CACHE_TTL_SECONDS:
        return cached[1]

    request_timeout = max(0.5, min(REQUEST_TIMEOUT, timeout_seconds or REQUEST_TIMEOUT))
    try:
        response = requests.get(
            CELESTRAK_GP_URL,
            params={"GROUP": group, "FORMAT": "tle"},
            headers={"Accept": "text/plain", "User-Agent": "skywatch-live/1.0"},
            timeout=request_timeout,
        )
        response.raise_for_status()
        tles = _parse_tle_payload(response.text)
        _tle_cache[group] = (now, tles)
        return tles
    except Exception:
        if cached:
            logger.warning("Using stale CelesTrak cache for group %s", group)
            return cached[1]
        raise


def _parse_float_slice(value: str, start: int, end: int):
    try:
        return float(value[start:end].strip())
    except (TypeError, ValueError):
        return None


def _tle_epoch(line1: str) -> datetime | None:
    try:
        year = int(line1[18:20])
        day_of_year = float(line1[20:32])
    except (TypeError, ValueError):
        return None

    full_year = 2000 + year if year < 57 else 1900 + year
    start = datetime(full_year, 1, 1, tzinfo=timezone.utc)
    return start + timedelta(days=day_of_year - 1)


def _gmst_radians(julian_date: float) -> float:
    t = (julian_date - 2451545.0) / 36525.0
    seconds = (
        67310.54841
        + (876600 * 3600 + 8640184.812866) * t
        + 0.093104 * t * t
        - 6.2e-6 * t * t * t
    )
    return math.radians((seconds / 240.0) % 360.0)


def _eci_to_geodetic(position_km: tuple[float, float, float], julian_date: float):
    theta = _gmst_radians(julian_date)
    cos_t = math.cos(theta)
    sin_t = math.sin(theta)
    x_eci, y_eci, z = position_km

    x = cos_t * x_eci + sin_t * y_eci
    y = -sin_t * x_eci + cos_t * y_eci

    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - WGS84_E2))
    alt = 0.0

    for _ in range(6):
        sin_lat = math.sin(lat)
        n = WGS84_A_KM / math.sqrt(1 - WGS84_E2 * sin_lat * sin_lat)
        alt = p / max(math.cos(lat), 1e-12) - n
        lat = math.atan2(z, p * (1 - WGS84_E2 * n / (n + alt)))

    return math.degrees(lat), ((math.degrees(lon) + 540) % 360) - 180, alt


def _orbit_quality(epoch_age_hours: float | None) -> str:
    if epoch_age_hours is None:
        return "unknown"
    if epoch_age_hours <= 24:
        return "fresh"
    if epoch_age_hours <= 72:
        return "nominal"
    if epoch_age_hours <= 168:
        return "degraded"
    return "stale"


def _satellite_state_from_tle(tle: dict[str, str], group_info: dict, now: datetime):
    if not SGP4_AVAILABLE or Satrec is None or jday is None:
        return None

    satrec = Satrec.twoline2rv(tle["line1"], tle["line2"])
    seconds = now.second + now.microsecond / 1_000_000
    jd, fr = jday(now.year, now.month, now.day, now.hour, now.minute, seconds)
    error, position, velocity = satrec.sgp4(jd, fr)
    if error != 0:
        return None

    lat, lon, altitude_km = _eci_to_geodetic(position, jd + fr)
    if not (math.isfinite(lat) and math.isfinite(lon) and math.isfinite(altitude_km)):
        return None

    velocity_kms = math.sqrt(sum(component * component for component in velocity))
    inclination = _parse_float_slice(tle["line2"], 8, 16)
    mean_motion = _parse_float_slice(tle["line2"], 52, 63)
    period_minutes = 1440.0 / mean_motion if mean_motion and mean_motion > 0 else None
    epoch = _tle_epoch(tle["line1"])
    epoch_age_hours = (
        abs((now - epoch).total_seconds()) / 3600 if epoch is not None else None
    )

    return {
        "id": tle["satnum"],
        "name": tle["name"],
        "group": group_info["key"],
        "group_label": group_info["label"],
        "latitude": round(lat, 5),
        "longitude": round(lon, 5),
        "altitude_km": round(altitude_km, 2),
        "velocity_kms": round(velocity_kms, 4),
        "inclination_deg": round(inclination, 3) if inclination is not None else None,
        "period_minutes": round(period_minutes, 2) if period_minutes is not None else None,
        "mean_motion_rev_day": round(mean_motion, 8) if mean_motion is not None else None,
        "tle_epoch": epoch.isoformat() if epoch else None,
        "epoch_age_hours": round(epoch_age_hours, 2) if epoch_age_hours is not None else None,
        "orbit_quality": _orbit_quality(epoch_age_hours),
        "source": "celestrak",
        "propagator": "sgp4",
    }


def _select_groups(group_keys: Iterable[str] | None) -> list[dict]:
    if not group_keys:
        return SATELLITE_GROUPS

    selected = []
    seen = set()
    for raw in group_keys:
        key = str(raw or "").strip().lower()
        group = _GROUP_BY_KEY.get(key) or _GROUP_BY_CELESTRAK_NAME.get(key)
        if group and group["key"] not in seen:
            selected.append(group)
            seen.add(group["key"])

    return selected or SATELLITE_GROUPS


def fetch_satellite_catalog(group_keys: Iterable[str] | None = None, max_total: int = 650):
    """Fetch CelesTrak TLE groups and propagate current sub-satellite points."""

    global _live_source_backoff_until

    now = datetime.now(timezone.utc)
    if not SGP4_AVAILABLE:
        return {
            "time": int(now.timestamp()),
            "generated_at": now.isoformat(),
            "source": "celestrak",
            "status": "propagator_unavailable",
            "error": "Install sgp4 to enable satellite propagation",
            "satellites": [],
            "count": 0,
            "source_counts": {},
            "groups": [],
        }

    requested_groups = _select_groups(group_keys)
    max_total = max(1, min(int(max_total or 650), 1500))
    satellites = []
    source_counts: dict[str, int] = {}
    group_summaries = []
    errors = {}
    seen_satnums = set()
    fallback_groups = set()
    deadline = time.monotonic() + max(1.0, CATALOG_TIMEOUT_SECONDS)

    for group_info in requested_groups:
        if len(satellites) >= max_total:
            break

        group_key = group_info["key"]
        propagated_count = 0
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0.5:
            tles = _fallback_tle_group(group_info["group"])
            if not tles:
                errors[group_key] = "Satellite source request budget exceeded"
                break
            fallback_groups.add(group_key)
            errors[group_key] = "Satellite source request budget exceeded; using bundled bootstrap TLE seed"
        else:
            try:
                if time.monotonic() < _live_source_backoff_until:
                    raise RuntimeError("CelesTrak live source in cooldown")
                tles = _fetch_tle_group(group_info["group"], timeout_seconds=remaining_seconds)
                if not tles:
                    raise RuntimeError("CelesTrak returned no TLE records")
            except Exception as exc:
                fallback_tles = _fallback_tle_group(group_info["group"])
                if fallback_tles:
                    logger.warning(
                        "CelesTrak group %s failed; using fallback seed: %s",
                        group_info["group"],
                        exc,
                    )
                    _live_source_backoff_until = time.monotonic() + max(
                        1.0, LIVE_SOURCE_BACKOFF_SECONDS
                    )
                    fallback_groups.add(group_key)
                    errors[group_key] = f"{exc}; using bundled bootstrap TLE seed"
                    tles = fallback_tles
                else:
                    logger.warning("CelesTrak group %s failed: %s", group_info["group"], exc)
                    errors[group_key] = str(exc)
                    continue

        for tle in tles:
            satnum = tle.get("satnum")
            if not satnum or satnum in seen_satnums:
                continue

            state = _satellite_state_from_tle(tle, group_info, now)
            if state is None:
                continue

            if group_key in fallback_groups:
                state["source"] = "celestrak_bootstrap"

            satellites.append(state)
            seen_satnums.add(satnum)
            propagated_count += 1

            if propagated_count >= group_info["limit"] or len(satellites) >= max_total:
                break

        source_counts[group_key] = propagated_count
        group_summaries.append(
            {
                "key": group_key,
                "name": group_info["label"],
                "celestrak_group": group_info["group"],
                "count": propagated_count,
                "color": group_info["color"],
            }
        )

    return {
        "time": int(now.timestamp()),
        "generated_at": now.isoformat(),
        "source": "celestrak",
        "status": "ok" if satellites else "empty",
        "propagator": "sgp4",
        "satellites": satellites,
        "count": len(satellites),
        "source_counts": source_counts,
        "groups": group_summaries,
        "errors": errors,
        "coverage": {
            "public_sources_only": True,
            "source": "CelesTrak NORAD GP element sets",
            "model": "SGP4 propagated TLE sub-satellite point",
            "max_total": max_total,
            "fallback_groups": sorted(fallback_groups),
        },
    }
