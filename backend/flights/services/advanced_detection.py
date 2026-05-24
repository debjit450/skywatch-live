"""
Advanced detection rules for flight anomalies.

Provides detection capabilities beyond basic threshold checks:
  - Circling / Loitering detection
  - Proximity alerts
  - Behavioral profile deviation
"""

import logging
import math
import time as _time

logger = logging.getLogger(__name__)

EARTH_RADIUS_KM = 6371.0


def _safe_float(value, default=0.0):
    if value is None:
        return default
    try:
        v = float(value)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance in km."""
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return EARTH_RADIUS_KM * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _bearing_deg(lat1, lon1, lat2, lon2):
    """Initial bearing in degrees from point 1 to point 2."""
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _heading_diff(h1, h2):
    """Smallest signed heading difference in degrees."""
    d = (h2 - h1 + 540) % 360 - 180
    return d


def detect_circling(heading_history, now_epoch=None):
    """
    Detect circling/loitering from heading history.

    Args:
        heading_history: list of (timestamp, heading_degrees) tuples,
                         ordered chronologically

    Returns list of anomaly dicts.
    """
    if not heading_history or len(heading_history) < 8:
        return []

    # Look at last 10 minutes of heading data
    now = now_epoch or _time.time()
    cutoff = now - 600
    recent = [(t, h) for t, h in heading_history if t >= cutoff]

    if len(recent) < 6:
        return []

    # Sum absolute heading changes
    total_heading_change = 0
    for i in range(1, len(recent)):
        diff = abs(_heading_diff(recent[i - 1][1], recent[i][1]))
        total_heading_change += diff

    duration_s = recent[-1][0] - recent[0][0]
    if duration_s < 120:
        return []

    # Circling: > 720 degrees of heading change in < 10 minutes (two full circles)
    if total_heading_change > 720:
        avg_turn_rate = total_heading_change / duration_s
        return [{
            "type": "circling",
            "label": "Circling / Loitering Detected",
            "severity": "medium",
            "confidence_score": min(92.0, 55.0 + total_heading_change * 0.04),
            "details": {
                "total_heading_change_deg": round(total_heading_change, 1),
                "duration_seconds": round(duration_s, 0),
                "avg_turn_rate_deg_s": round(avg_turn_rate, 2),
                "estimated_circles": round(total_heading_change / 360, 1),
            },
        }]

    # Holding pattern: 2+ reversals in heading
    reversals = 0
    direction = None
    for i in range(1, len(recent)):
        diff = _heading_diff(recent[i - 1][1], recent[i][1])
        if abs(diff) < 2:
            continue
        new_dir = "right" if diff > 0 else "left"
        if direction and new_dir != direction:
            reversals += 1
        direction = new_dir

    if reversals >= 3 and duration_s < 600:
        return [{
            "type": "circling",
            "label": "Possible Holding Pattern",
            "severity": "low",
            "confidence_score": min(78.0, 45.0 + reversals * 8),
            "details": {
                "reversals": reversals,
                "duration_seconds": round(duration_s, 0),
                "total_heading_change_deg": round(total_heading_change, 1),
            },
        }]

    return []


_spatial_grid_cache = {"timestamp": None, "grid": None}


def _get_spatial_grid(other_flights, timestamp):
    """
    Build a spatial grid hash index once per ingestion batch.
    Replicates flights into all 9 overlapping boundary buckets for O(1) neighbors lookup.
    """
    global _spatial_grid_cache
    if _spatial_grid_cache["timestamp"] == timestamp and _spatial_grid_cache["grid"] is not None:
        return _spatial_grid_cache["grid"]

    grid = {}
    for other in other_flights:
        if other.get("on_ground", False):
            continue
        o_raw_lat = other.get("latitude")
        o_raw_lon = other.get("longitude")
        o_raw_alt = other.get("baro_altitude")
        if o_raw_lat is None or o_raw_lon is None or o_raw_alt is None:
            continue
        o_lat = _safe_float(o_raw_lat)
        o_lon = _safe_float(o_raw_lon)
        o_alt = _safe_float(o_raw_alt)

        # 0.5 degrees grid binning (~55km buckets)
        lat_bin = int(o_lat / 0.5)
        lon_bin = int(o_lon / 0.5)

        # Replicate in 9 overlapping bins to perfectly handle boundary cases
        for dl in [-1, 0, 1]:
            for dln in [-1, 0, 1]:
                bin_key = (lat_bin + dl, lon_bin + dln)
                if bin_key not in grid:
                    grid[bin_key] = []
                grid[bin_key].append((other, o_lat, o_lon, o_alt))

    _spatial_grid_cache["timestamp"] = timestamp
    _spatial_grid_cache["grid"] = grid
    return grid


def detect_proximity(flight, other_flights, min_distance_nm=5.0, now_epoch=None):
    """
    Detect dangerously close aircraft.

    Args:
        flight: the primary flight state dict
        other_flights: list of all other flight state dicts
        min_distance_nm: alert threshold in nautical miles

    Returns list of anomaly dicts.
    """
    on_ground = flight.get("on_ground", False)

    if on_ground:
        return []

    raw_lat = flight.get("latitude")
    raw_lon = flight.get("longitude")
    raw_alt = flight.get("baro_altitude")
    
    if raw_lat is None or raw_lon is None or raw_alt is None:
        return []

    lat = _safe_float(raw_lat)
    lon = _safe_float(raw_lon)
    alt = _safe_float(raw_alt)

    anomalies = []
    min_distance_km = min_distance_nm * 1.852
    now = now_epoch or _time.time()

    # Retrieve or build spatial grid hash bucket index
    grid = _get_spatial_grid(other_flights, now)
    lat_bin = int(lat / 0.5)
    lon_bin = int(lon / 0.5)
    bin_key = (lat_bin, lon_bin)

    # Fetch neighbors strictly from the single matching bin bucket (highly optimized)
    neighbors = grid.get(bin_key, [])

    for other, o_lat, o_lon, o_alt in neighbors:
        if other.get("icao24") == flight.get("icao24"):
            continue

        dist_km = _haversine_km(lat, lon, o_lat, o_lon)
        alt_diff_m = abs(alt - o_alt)

        # Horizontal within threshold AND vertical within 300m (roughly 1000ft)
        if dist_km <= min_distance_km and alt_diff_m < 300:
            dist_nm = dist_km / 1.852
            severity = "critical" if dist_nm < 2 else "high" if dist_nm < 3.5 else "medium"
            anomalies.append({
                "type": "proximity",
                "label": f"Proximity Alert ({dist_nm:.1f} NM)",
                "severity": severity,
                "confidence_score": min(98.0, 85.0 + (1 - dist_nm / min_distance_nm) * 15),
                "details": {
                    "other_icao24": other.get("icao24"),
                    "other_callsign": other.get("callsign"),
                    "distance_nm": round(dist_nm, 2),
                    "distance_km": round(dist_km, 2),
                    "altitude_diff_m": round(alt_diff_m, 1),
                    "own_altitude_m": alt,
                    "other_altitude_m": o_alt,
                },
            })
            # Only report closest encounter
            break

    return anomalies


def detect_behavioral_deviation(flight, profile, now_epoch=None):
    """
    Detect deviations from an aircraft's historical behavioral profile.

    Args:
        flight: current flight state dict
        profile: dict with {avg_velocity, std_velocity, avg_altitude, std_altitude,
                           observation_count} or None

    Returns list of anomaly dicts.
    """
    if not profile or profile.get("observation_count", 0) < 20:
        return []

    velocity = _safe_float(flight.get("velocity"))
    altitude = _safe_float(flight.get("baro_altitude"))
    on_ground = flight.get("on_ground", False)

    if on_ground or velocity <= 0:
        return []

    anomalies = []
    avg_vel = _safe_float(profile.get("avg_velocity"))
    std_vel = max(_safe_float(profile.get("std_velocity")), 5)
    avg_alt = _safe_float(profile.get("avg_altitude"))
    std_alt = max(_safe_float(profile.get("std_altitude")), 500)

    vel_z = abs(velocity - avg_vel) / std_vel if avg_vel > 0 else 0
    alt_z = abs(altitude - avg_alt) / std_alt if avg_alt > 0 else 0

    if vel_z > 3.5 or alt_z > 3.5:
        deviations = []
        if vel_z > 3.5:
            deviations.append(f"speed {vel_z:.1f} sigma from mean")
        if alt_z > 3.5:
            deviations.append(f"altitude {alt_z:.1f} sigma from mean")

        anomalies.append({
            "type": "behavioral",
            "label": "Behavioral Profile Deviation",
            "severity": "medium" if max(vel_z, alt_z) < 5 else "high",
            "confidence_score": min(90.0, 50.0 + max(vel_z, alt_z) * 8),
            "details": {
                "deviations": deviations,
                "velocity_z_score": round(vel_z, 2),
                "altitude_z_score": round(alt_z, 2),
                "profile_avg_velocity": avg_vel,
                "profile_avg_altitude": avg_alt,
                "current_velocity": velocity,
                "current_altitude": altitude,
                "observation_count": profile.get("observation_count", 0),
            },
        })

    return anomalies


def detect_all_advanced(flight, other_flights=None, profile=None,
                        heading_history=None, now_epoch=None):
    """
    Run all advanced detection rules on a single flight.

    Returns combined list of anomaly dicts.
    """
    anomalies = []

    # Proximity check (if peers provided)
    if other_flights:
        anomalies.extend(detect_proximity(flight, other_flights, now_epoch=now_epoch))

    # Behavioral deviation (if profile available)
    if profile:
        anomalies.extend(detect_behavioral_deviation(flight, profile, now_epoch))

    # Circling detection (if heading history available)
    if heading_history:
        anomalies.extend(detect_circling(heading_history, now_epoch))

    return anomalies
