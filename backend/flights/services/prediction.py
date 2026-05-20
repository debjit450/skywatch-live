"""Short-horizon flight path prediction helpers."""

import math
from datetime import timedelta

EARTH_RADIUS_M = 6_371_000


def _destination_point(lat_deg, lon_deg, bearing_deg, distance_m):
    """Project a point along a great-circle bearing."""
    lat1 = math.radians(lat_deg)
    lon1 = math.radians(lon_deg)
    bearing = math.radians(bearing_deg)
    angular_distance = distance_m / EARTH_RADIUS_M

    lat2 = math.asin(
        math.sin(lat1) * math.cos(angular_distance)
        + math.cos(lat1) * math.sin(angular_distance) * math.cos(bearing)
    )
    lon2 = lon1 + math.atan2(
        math.sin(bearing) * math.sin(angular_distance) * math.cos(lat1),
        math.cos(angular_distance) - math.sin(lat1) * math.sin(lat2),
    )

    return math.degrees(lat2), ((math.degrees(lon2) + 540) % 360) - 180


def _heading_delta(a, b):
    return abs((a - b + 180) % 360 - 180)


def prediction_confidence(states, now):
    """Score prediction confidence from recency and heading stability."""
    if not states:
        return 0.0
    latest = states[0]
    age_seconds = max(0, (now - latest.timestamp).total_seconds())
    recency = max(0.0, 1.0 - age_seconds / 180.0)

    headings = [s.true_track for s in states if isinstance(s.true_track, (int, float))]
    if len(headings) >= 2:
        deltas = [_heading_delta(headings[i - 1], headings[i]) for i in range(1, len(headings))]
        stability = max(0.0, 1.0 - (sum(deltas) / len(deltas)) / 45.0)
    else:
        stability = 0.6

    return round(max(0.0, min(1.0, recency * 0.65 + stability * 0.35)), 3)


def build_predicted_path(states, now):
    """
    Extrapolate T+1, T+3, T+5, T+10 minute positions from recent states.

    The latest state provides speed/heading/vertical rate while the previous
    two states damp confidence when heading is unstable.
    """
    if not states:
        return [], 0.0
    latest = states[0]
    if latest.latitude is None or latest.longitude is None or latest.on_ground:
        return [], 0.0

    speed = latest.velocity or 0
    heading = latest.true_track or 0
    vertical_rate = latest.vertical_rate or 0
    if speed <= 1:
        return [], 0.0

    confidence = prediction_confidence(states, now)
    base_alt = latest.baro_altitude if latest.baro_altitude is not None else latest.geo_altitude
    base_alt = base_alt or 0
    path = []
    for minutes in (1, 3, 5, 10):
        seconds = minutes * 60
        lat, lon = _destination_point(latest.latitude, latest.longitude, heading, speed * seconds)
        path.append({
            "lat": lat,
            "lon": lon,
            "alt": max(0, base_alt + vertical_rate * seconds),
            "timestamp": (now + timedelta(minutes=minutes)).isoformat(),
            "minutes_ahead": minutes,
            "confidence": confidence,
        })
    return path, confidence
