"""
Advanced detection rules for flight anomalies.

Provides detection capabilities beyond basic threshold checks:
  - Circling / Loitering detection
  - Trajectory deviation
  - Proximity alerts
  - Geofence incursion (restricted airspace)
  - Altitude bust detection
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


# ─── Restricted airspace zones (sample set — extend as needed) ────────────

RESTRICTED_ZONES = [
    # (name, lat, lon, radius_km, severity)
    ("Washington DC SFRA", 38.8977, -77.0365, 55, "critical"),
    ("Camp David P-40", 39.6480, -77.4650, 18, "critical"),
    ("Area 51 R-4808", 37.2350, -115.8111, 42, "high"),
    ("Pantex Plant", 35.3175, -101.5570, 18, "high"),
    ("White Sands R-5107", 32.9500, -106.4200, 65, "high"),
    ("Nellis Range R-4806", 37.0000, -115.5000, 55, "high"),
    ("Edwards AFB R-2515", 34.9054, -117.8840, 45, "medium"),
    ("Groom Lake R-4807", 37.2431, -115.7930, 30, "high"),
    ("Kremlin TFR", 55.7520, 37.6175, 25, "critical"),
    ("Beijing TFR", 39.9042, 116.4074, 30, "critical"),
    ("Pyongyang TFR", 39.0392, 125.7625, 55, "critical"),
    ("Buckingham Palace", 51.5014, -0.1419, 2.5, "high"),
    ("Élysée Palace", 48.8704, 2.3167, 2.5, "high"),
    ("Vatican City", 41.9029, 12.4534, 1.5, "high"),
    ("Dimona Nuclear", 31.0036, 35.1444, 30, "critical"),
]


def detect_geofence(flight, now_epoch=None):
    """
    Check if aircraft is inside a restricted airspace zone.

    Returns list of anomaly dicts.
    """
    on_ground = flight.get("on_ground", False)

    if on_ground:
        return []

    raw_lat = flight.get("latitude")
    raw_lon = flight.get("longitude")
    if raw_lat is None or raw_lon is None:
        return []

    lat = _safe_float(raw_lat)
    lon = _safe_float(raw_lon)
    alt = _safe_float(flight.get("baro_altitude"))

    anomalies = []
    for name, z_lat, z_lon, radius_km, severity in RESTRICTED_ZONES:
        dist = _haversine_km(lat, lon, z_lat, z_lon)
        if dist <= radius_km:
            # Only alert if airborne and within the zone
            anomalies.append({
                "type": "geofence",
                "label": f"Restricted Airspace: {name}",
                "severity": severity,
                "confidence_score": min(98.0, 80.0 + (1 - dist / radius_km) * 20),
                "details": {
                    "zone_name": name,
                    "zone_center": [z_lat, z_lon],
                    "zone_radius_km": radius_km,
                    "distance_km": round(dist, 2),
                    "penetration_pct": round((1 - dist / radius_km) * 100, 1),
                    "altitude_m": alt,
                },
            })

    return anomalies


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

    # Circling: > 720° of heading change in < 10 minutes (two full circles)
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

    for other in other_flights:
        if other.get("icao24") == flight.get("icao24"):
            continue
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

        # Quick lat/lon pre-filter (1° ≈ 111km)
        if abs(lat - o_lat) > 0.5 or abs(lon - o_lon) > 0.5:
            continue

        dist_km = _haversine_km(lat, lon, o_lat, o_lon)
        alt_diff_m = abs(alt - o_alt)

        # Horizontal within threshold AND vertical within 300m (≈1000ft)
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
            deviations.append(f"speed {vel_z:.1f}σ from mean")
        if alt_z > 3.5:
            deviations.append(f"altitude {alt_z:.1f}σ from mean")

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

    # Geofence check
    anomalies.extend(detect_geofence(flight, now_epoch))

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
