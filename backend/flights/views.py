"""
SkyWatch API views.

Provides REST endpoints for flights, anomalies, routes, analytics,
and predictions.
"""

import time
import logging
import math
import re
from datetime import datetime, timedelta, timezone as datetime_timezone
from django.contrib.auth import get_user_model
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone
from django.db import connection
from django.db.models import Count, Avg, OuterRef, Subquery
from django.db.models.functions import TruncDay, TruncHour
from django.utils.dateparse import parse_datetime
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.pagination import PageNumberPagination
from rest_framework.permissions import AllowAny, IsAuthenticated

from .models import (
    Aircraft,
    FlightState,
    FlightRoute,
    FlightPosition,
    AnomalyEvent,
    SystemMetrics,
    AlertRule,
    IngestionAudit,
    IngestionSourceHealth,
    MLModelVersion,
)
from .serializers import (
    FlightStateLiveSerializer,
    FlightRouteSerializer,
    AnomalyEventSerializer,
    AnomalyEventCompactSerializer,
    AircraftSerializer,
    SystemMetricsSerializer,
    FlightPositionSerializer,
    AlertRuleSerializer,
    IngestionAuditSerializer,
    IngestionSourceHealthSerializer,
    MLModelVersionSerializer,
)
from .services.cache import get_current_flights
from .services.anomaly_detector import detect_all
from .services.demo_data import build_demo_flight_payload
from .services.source_adapters import annotate_state_source_quality, source_health_payload

logger = logging.getLogger(__name__)

EARTH_RADIUS_KM = 6371.0
ROUTE_GAP_MINUTES = 45
MAX_REASONABLE_SEGMENT_KM = 950
ICAO24_RE = re.compile(r"^[0-9a-f]{6}$")
MAX_LIVE_POSITION_AGE_SECONDS = 180


def _normalize_icao24(value):
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized if ICAO24_RE.fullmatch(normalized) else None


def _state_age_seconds(state, now_seconds=None):
    now_seconds = now_seconds or time.time()
    timestamp = state.get("time_position") or state.get("last_contact")
    if not isinstance(timestamp, (int, float)):
        return None
    return max(0, now_seconds - timestamp)


def _fresh_states(states, max_age_seconds=MAX_LIVE_POSITION_AGE_SECONDS):
    now_seconds = time.time()
    fresh = []
    stale_count = 0
    max_age = 0
    for state in states:
        age = _state_age_seconds(state, now_seconds)
        if age is None or age > max_age_seconds:
            stale_count += 1
            continue
        max_age = max(max_age, age)
        fresh.append(state)
    return fresh, stale_count, max_age


def _freshness_response(payload, status_code=status.HTTP_200_OK):
    response = Response(payload, status=status_code)
    response["Cache-Control"] = "no-store, max-age=0"
    return response


def _analytics_db_alias():
    return getattr(settings, "ANALYTICS_DB_ALIAS", "default")


def _cached_payload(key, ttl_seconds, builder):
    payload = cache.get(key)
    if payload is not None:
        return payload
    payload = builder()
    cache.set(key, payload, ttl_seconds)
    return payload


def _alert_rule_owner(request):
    if request.user and request.user.is_authenticated:
        return request.user

    username = getattr(settings, "ANONYMOUS_ALERT_RULE_USERNAME", "skywatch-local-operator")
    User = get_user_model()
    lookup = {User.USERNAME_FIELD: username}
    defaults = {}
    if hasattr(User, "email"):
        defaults["email"] = "skywatch-local@example.invalid"
    user, _ = User.objects.get_or_create(defaults=defaults, **lookup)
    return user


def _parse_iso_datetime(value):
    parsed = parse_datetime(value or "")
    if parsed is None:
        return None
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, datetime_timezone.utc)
    return parsed


def _int_query_param(request, name, default, minimum, maximum):
    raw_value = request.query_params.get(name, default)
    try:
        value = int(raw_value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(value, maximum))


def _to_epoch_ms(value):
    if value is None:
        return 0
    if hasattr(value, "timestamp"):
        return int(value.timestamp() * 1000)
    if isinstance(value, (int, float)):
        return int(value * 1000 if value < 10_000_000_000 else value)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if timezone.is_naive(parsed):
                parsed = timezone.make_aware(parsed, timezone=datetime_timezone.utc)
            return int(parsed.timestamp() * 1000)
        except ValueError:
            return 0
    return 0


def _distance_km(a, b):
    lat1 = math.radians(a["lat"])
    lat2 = math.radians(b["lat"])
    dlat = math.radians(b["lat"] - a["lat"])
    dlon = math.radians(b["lon"] - a["lon"])
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return EARTH_RADIUS_KM * 2 * math.atan2(math.sqrt(h), math.sqrt(1 - h))


def _number_values(points, key):
    return [
        point[key]
        for point in points
        if isinstance(point.get(key), (int, float)) and math.isfinite(point[key])
    ]


def _avg(values):
    return sum(values) / len(values) if values else None


def _valid_point(point):
    lat = point.get("lat")
    lon = point.get("lon")
    return (
        isinstance(lat, (int, float))
        and isinstance(lon, (int, float))
        and -90 <= lat <= 90
        and -180 <= lon <= 180
        and _to_epoch_ms(point.get("time")) > 0
    )


def _polyline_distance_km(points):
    total = 0.0
    previous = None
    for point in [p for p in points if _valid_point(p)]:
        if previous:
            segment_km = _distance_km(previous, point)
            time_gap_minutes = abs(_to_epoch_ms(point.get("time")) - _to_epoch_ms(previous.get("time"))) / 60000
            if segment_km <= MAX_REASONABLE_SEGMENT_KM or time_gap_minutes <= 20:
                total += segment_km
        previous = point
    return total


def _point_from_state(state):
    timestamp = state.get("timestamp")
    return {
        "lat": state.get("latitude"),
        "lon": state.get("longitude"),
        "alt": state.get("baro_altitude"),
        "speed": state.get("velocity"),
        "heading": state.get("true_track"),
        "time": timestamp.isoformat() if hasattr(timestamp, "isoformat") else timestamp,
        "onGround": bool(state.get("on_ground", False)),
        "dataSource": state.get("data_source") or "",
    }


def _normalize_route_point(point):
    normalized = {
        "lat": point.get("lat", point.get("latitude")),
        "lon": point.get("lon", point.get("longitude")),
        "alt": point.get("alt", point.get("altitude")),
        "speed": point.get("speed"),
        "heading": point.get("heading", point.get("true_track")),
        "time": point.get("time"),
        "onGround": bool(point.get("onGround", point.get("on_ground", False))),
        "dataSource": point.get("dataSource", point.get("data_source", "")),
    }
    return normalized if _valid_point(normalized) else None


def _route_bounds(points):
    valid = [point for point in points if _valid_point(point)]
    if not valid:
        return None
    return {
        "north": max(point["lat"] for point in valid),
        "south": min(point["lat"] for point in valid),
        "east": max(point["lon"] for point in valid),
        "west": min(point["lon"] for point in valid),
    }


def _route_summary(points):
    valid = sorted(
        [point for point in points if _valid_point(point)],
        key=lambda point: _to_epoch_ms(point.get("time")),
    )
    altitudes = _number_values(valid, "alt")
    speeds = _number_values(valid, "speed")
    started = valid[0]["time"] if valid else None
    ended = valid[-1]["time"] if valid else None
    duration = (
        (_to_epoch_ms(ended) - _to_epoch_ms(started)) / 60000
        if started and ended
        else None
    )
    return {
        "points": valid,
        "point_count": len(valid),
        "started_at": started,
        "ended_at": ended,
        "duration_minutes": duration,
        "total_distance_km": _polyline_distance_km(valid) if len(valid) > 1 else 0,
        "bounds": _route_bounds(valid),
        "avg_altitude_m": _avg(altitudes),
        "max_altitude_m": max(altitudes) if altitudes else None,
        "avg_speed_ms": _avg(speeds),
        "max_speed_ms": max(speeds) if speeds else None,
    }


def _split_points_into_sessions(points, gap_minutes):
    sessions = []
    current = []
    previous = None
    for point in sorted(points, key=lambda item: _to_epoch_ms(item.get("time"))):
        if previous:
            gap = (_to_epoch_ms(point.get("time")) - _to_epoch_ms(previous.get("time"))) / 60000
            jump = _distance_km(previous, point)
            if gap > gap_minutes or (gap > 20 and jump > MAX_REASONABLE_SEGMENT_KM):
                if len(current) >= 2:
                    sessions.append(current)
                current = []
        current.append(point)
        previous = point
    if len(current) >= 2:
        sessions.append(current)
    return sessions


def _build_gaps(routes):
    ordered = sorted(
        [route for route in routes if route.get("points")],
        key=lambda route: _to_epoch_ms(route["points"][0].get("time")),
    )
    gaps = []
    for index in range(1, len(ordered)):
        previous = ordered[index - 1]["points"][-1]
        next_point = ordered[index]["points"][0]
        duration = (_to_epoch_ms(next_point.get("time")) - _to_epoch_ms(previous.get("time"))) / 60000
        if duration < ROUTE_GAP_MINUTES:
            continue
        gaps.append({
            "startTime": previous["time"],
            "endTime": next_point["time"],
            "durationMinutes": duration,
            "distanceKm": _distance_km(previous, next_point),
            "startLat": previous["lat"],
            "startLon": previous["lon"],
            "endLat": next_point["lat"],
            "endLon": next_point["lon"],
        })
    return gaps


def _point_is_ground(point):
    alt = point.get("alt")
    speed = point.get("speed")
    return bool(point.get("onGround")) or (
        (alt is None or alt < 160) and (speed is None or speed < 35)
    )


def _classify_phase(point, previous=None):
    if _point_is_ground(point):
        return "ground"
    alt = point.get("alt") or 0
    speed = point.get("speed") or 0
    vertical_rate = None
    if previous and isinstance(previous.get("alt"), (int, float)) and isinstance(point.get("alt"), (int, float)):
        dt = (_to_epoch_ms(point.get("time")) - _to_epoch_ms(previous.get("time"))) / 1000
        if dt > 5:
            vertical_rate = (point["alt"] - previous["alt"]) / dt
    if alt < 900 and speed > 55 and (vertical_rate is None or vertical_rate > -1):
        return "takeoff"
    if vertical_rate is not None and vertical_rate > 2:
        return "climb"
    if vertical_rate is not None and vertical_rate < -2:
        return "approach" if alt < 1500 else "descent"
    if alt > 6100:
        return "cruise"
    if alt < 1500 and speed < 125:
        return "approach"
    return "cruise"


def _build_phase_breakdown(points):
    if not points:
        return []
    phases = []
    current_phase = _classify_phase(points[0])
    current_points = [points[0]]

    def flush():
        if not current_points:
            return
        first = current_points[0]
        last = current_points[-1]
        duration = (_to_epoch_ms(last.get("time")) - _to_epoch_ms(first.get("time"))) / 60000
        phases.append({
            "phase": current_phase,
            "startedAt": first["time"],
            "endedAt": last["time"],
            "durationMinutes": max(0, duration),
            "distanceKm": _polyline_distance_km(current_points),
            "pointCount": len(current_points),
            "avgAltitudeM": _avg(_number_values(current_points, "alt")),
            "avgSpeedMs": _avg(_number_values(current_points, "speed")),
        })

    for index in range(1, len(points)):
        previous = points[index - 1]
        point = points[index]
        phase = _classify_phase(point, previous)
        if phase != current_phase and len(current_points) > 2:
            flush()
            current_phase = phase
            current_points = [previous, point]
        else:
            current_points.append(point)
    flush()
    return phases


def _detect_layovers(routes):
    layovers = []
    for gap in _build_gaps(routes):
        distance = gap["distanceKm"]
        layovers.append({
            "startTime": gap["startTime"],
            "endTime": gap["endTime"],
            "durationMinutes": gap["durationMinutes"],
            "lat": (gap["startLat"] + gap["endLat"]) / 2 if distance < 75 else gap["startLat"],
            "lon": (gap["startLon"] + gap["endLon"]) / 2 if distance < 75 else gap["startLon"],
            "arrivalLat": gap["startLat"],
            "arrivalLon": gap["startLon"],
            "departureLat": gap["endLat"],
            "departureLon": gap["endLon"],
            "distanceKm": distance,
            "confidence": "high" if distance < 25 else "medium" if distance < 100 else "low",
            "source": "segment_gap",
        })
    return layovers


def _quality(points, gaps, duration_minutes):
    score = 100
    reasons = []
    if len(points) < 4:
        score -= 40
        reasons.append("very few track points")
    elif len(points) < 12:
        score -= 18
        reasons.append("sparse track sample")
    if gaps:
        score -= min(32, len(gaps) * 10)
        reasons.append(f"{len(gaps)} signal gap{'s' if len(gaps) != 1 else ''}")
    if duration_minutes and duration_minutes > 20:
        density = len(points) / max(duration_minutes / 60, 0.1)
        if density < 6:
            score -= 15
            reasons.append("low sample density")
    altitude_coverage = len(_number_values(points, "alt")) / max(len(points), 1)
    speed_coverage = len(_number_values(points, "speed")) / max(len(points), 1)
    if altitude_coverage < 0.5:
        score -= 10
        reasons.append("limited altitude data")
    if speed_coverage < 0.35:
        score -= 8
        reasons.append("limited speed data")
    score = max(0, min(100, round(score)))
    label = "excellent" if score >= 85 else "good" if score >= 68 else "limited" if score >= 42 else "poor"
    return {"score": score, "label": label, "reasons": reasons or ["continuous usable track"]}


def _build_track_intelligence(routes):
    points = sorted(
        [point for route in routes for point in route.get("points", []) if _valid_point(point)],
        key=lambda point: _to_epoch_ms(point.get("time")),
    )
    if not points:
        return {
            "startedAt": None,
            "endedAt": None,
            "durationMinutes": None,
            "distanceKm": None,
            "segmentCount": len(routes),
            "pointCount": 0,
            "gapCount": 0,
            "gaps": [],
            "phaseBreakdown": [],
            "currentPhase": "unknown",
            "bounds": None,
            "quality": {"score": 0, "label": "poor", "reasons": ["no usable points"]},
        }

    first = points[0]
    last = points[-1]
    duration = (_to_epoch_ms(last.get("time")) - _to_epoch_ms(first.get("time"))) / 60000
    total_distance = sum(route.get("total_distance_km") or 0 for route in routes)
    if total_distance <= 0:
        total_distance = _polyline_distance_km(points)
    straight_line = _distance_km(first, last) if len(points) > 1 else None
    gaps = _build_gaps(routes)
    altitudes = _number_values(points, "alt")
    speeds = _number_values(points, "speed")
    vertical_rates = []
    for index in range(1, len(points)):
        prev = points[index - 1]
        point = points[index]
        if not isinstance(prev.get("alt"), (int, float)) or not isinstance(point.get("alt"), (int, float)):
            continue
        dt = (_to_epoch_ms(point.get("time")) - _to_epoch_ms(prev.get("time"))) / 1000
        if 5 < dt <= 900:
            vertical_rates.append((point["alt"] - prev["alt"]) / dt)
    airborne = [point for point in points if not point.get("onGround")]

    return {
        "startedAt": first["time"],
        "endedAt": last["time"],
        "durationMinutes": max(0, duration),
        "airborneMinutes": (len(airborne) / max(len(points), 1)) * max(0, duration),
        "distanceKm": total_distance if total_distance > 0 else None,
        "straightLineKm": straight_line,
        "trackEfficiency": straight_line / total_distance if total_distance > 0 and straight_line else None,
        "pointDensityPerHour": len(points) / max(duration / 60, 0.1) if duration > 0 else None,
        "maxAltitudeM": max(altitudes) if altitudes else None,
        "minAltitudeM": min(altitudes) if altitudes else None,
        "avgAltitudeM": _avg(altitudes),
        "maxSpeedMs": max(speeds) if speeds else None,
        "avgSpeedMs": _avg(speeds),
        "maxVerticalRateMs": max(vertical_rates) if vertical_rates else None,
        "minVerticalRateMs": min(vertical_rates) if vertical_rates else None,
        "segmentCount": len(routes),
        "pointCount": len(points),
        "gapCount": len(gaps),
        "gaps": gaps,
        "phaseBreakdown": _build_phase_breakdown(points),
        "currentPhase": _classify_phase(last, points[-2] if len(points) > 1 else None),
        "bounds": _route_bounds(points),
        "quality": _quality(points, gaps, duration),
    }


def _serialize_route(session_id, points, source, started_at=None, ended_at=None, total_distance_km=None):
    summary = _route_summary(points)
    distance = total_distance_km if total_distance_km is not None else summary["total_distance_km"]
    return {
        "session_id": session_id,
        "points": summary["points"],
        "started_at": started_at or summary["started_at"],
        "ended_at": ended_at or summary["ended_at"],
        "point_count": summary["point_count"],
        "total_distance_km": distance,
        "source": source,
        "duration_minutes": summary["duration_minutes"],
        "bounds": summary["bounds"],
        "avg_altitude_m": summary["avg_altitude_m"],
        "max_altitude_m": summary["max_altitude_m"],
        "avg_speed_ms": summary["avg_speed_ms"],
        "max_speed_ms": summary["max_speed_ms"],
    }


class FlightListView(APIView):
    """
    GET /api/v1/flights/
    Returns current flight states from cache (or DB fallback).
    Compatible with the frontend's expected format.
    """

    def get(self, request):
        if getattr(settings, "SKYWATCH_DEMO_MODE", False) or request.query_params.get("demo") == "1":
            payload = build_demo_flight_payload()
            return _freshness_response(payload)

        # Try cache first
        cached = get_current_flights()
        if cached:
            states = cached.get("states", [])
            if not isinstance(states, list):
                states = []
            states, stale_count, max_age = _fresh_states(states)
            source_counts = cached.get("source_counts", {})
            # Build source_counts from live states if not stored separately
            if not source_counts and states:
                for state in states:
                    src = state.get("data_source") or "unknown"
                    source_counts[src] = source_counts.get(src, 0) + 1
            health_payload = cached.get("source_health") or source_health_payload()
            annotate_state_source_quality(states, health_payload)
            return _freshness_response({
                "time": cached.get("time", int(time.time())),
                "flights": states,
                "authenticated": cached.get("authenticated", False),
                "source": "cache",
                "count": len(states),
                "stale_count": stale_count,
                "max_age_seconds": round(max_age, 1),
                "source_counts": source_counts,
                "source_health": health_payload,
                "source_conflict_count": cached.get("source_conflict_count", 0),
                "degraded": cached.get("degraded", False),
            })

        try:
            from .services.opensky import fetch_all_states
            from .services.cache import set_current_flights

            live = fetch_all_states()
            if live and live.get("states"):
                set_current_flights(live)
                live_states, stale_count, max_age = _fresh_states(live.get("states", []))
                source_counts = {}
                for state in live_states:
                    src = state.get("data_source") or "unknown"
                    source_counts[src] = source_counts.get(src, 0) + 1
                health_payload = source_health_payload()
                annotate_state_source_quality(live_states, health_payload)
                return _freshness_response({
                    "time": live.get("time", int(time.time())),
                    "flights": live_states,
                    "authenticated": live.get("authenticated", False),
                    "source": "opensky",
                    "count": len(live_states),
                    "stale_count": stale_count,
                    "max_age_seconds": round(max_age, 1),
                    "source_counts": source_counts,
                    "source_health": health_payload,
                    "source_conflict_count": 0,
                    "degraded": any(item.get("status") not in {"ok", "disabled"} for item in health_payload.values()),
                })
        except Exception as exc:
            logger.warning("Live OpenSky fetch failed before database fallback: %s", exc)

        # Fallback: fetch from DB (last 2 minutes of states)
        cutoff = timezone.now() - timedelta(minutes=2)
        base = (
            FlightState.objects.filter(timestamp__gte=cutoff)
            .select_related("aircraft")
            .only(
                "aircraft_id",
                "timestamp",
                "time_position",
                "last_contact",
                "longitude",
                "latitude",
                "baro_altitude",
                "geo_altitude",
                "on_ground",
                "velocity",
                "true_track",
                "vertical_rate",
                "squawk",
                "spi",
                "position_source",
                "category",
                "ml_anomaly_score",
                "data_source",
                "predicted_path",
                "prediction_confidence",
                "aircraft__callsign",
                "aircraft__origin_country",
            )
        )

        if connection.vendor == "postgresql":
            flights = list(
                base.order_by("aircraft_id", "-timestamp").distinct("aircraft_id")[:10000]
            )
        else:
            all_states = base.order_by("-timestamp")[:30000]
            seen_icaos = set()
            flights = []
            for state in all_states:
                if state.aircraft_id not in seen_icaos:
                    seen_icaos.add(state.aircraft_id)
                    flights.append(state)
                    if len(flights) >= 10000:
                        break

        states = []
        for fs in flights:
            states.append({
                "icao24": fs.aircraft_id,
                "callsign": fs.aircraft.callsign if fs.aircraft else None,
                "origin_country": fs.aircraft.origin_country if fs.aircraft else "",
                "time_position": fs.time_position,
                "last_contact": fs.last_contact,
                "longitude": fs.longitude,
                "latitude": fs.latitude,
                "baro_altitude": fs.baro_altitude,
                "on_ground": fs.on_ground,
                "velocity": fs.velocity,
                "true_track": fs.true_track,
                "vertical_rate": fs.vertical_rate,
                "sensors": None,
                "geo_altitude": fs.geo_altitude,
                "squawk": fs.squawk,
                "spi": fs.spi,
                "position_source": fs.position_source,
                "category": fs.category,
                "ml_anomaly_score": fs.ml_anomaly_score,
                "predicted_path": fs.predicted_path,
                "prediction_confidence": fs.prediction_confidence,
                "data_source": fs.data_source or (
                    "opensky" if fs.position_source in (0, 1)
                    else "mlat" if fs.position_source == 2
                    else "ogn" if fs.position_source == 3
                    else "faa_radar" if fs.position_source == 4
                    else "uat" if fs.position_source == 5
                    else "satellite" if fs.position_source == 6
                    else "unknown"
                ),
            })

        states, stale_count, max_age = _fresh_states(states)
        health_payload = source_health_payload()
        annotate_state_source_quality(states, health_payload)
        response_time = int(time.time())
        if states:
            response_time = int(max((state.get("time_position") or state.get("last_contact") or 0) for state in states))

        return _freshness_response({
            "time": response_time,
            "flights": states,
            "authenticated": False,
            "source": "database",
            "count": len(states),
            "stale_count": stale_count,
            "max_age_seconds": round(max_age, 1),
            "source_health": health_payload,
            "source_conflict_count": sum(len(state.get("source_conflicts", [])) for state in states),
            "degraded": any(item.get("status") not in {"ok", "disabled"} for item in health_payload.values()),
        })


class FlightDetailView(APIView):
    """
    GET /api/v1/flights/<icao24>/
    Returns detailed info for a single aircraft.
    """

    def get(self, request, icao24):
        icao24 = _normalize_icao24(icao24)
        if not icao24:
            return Response(
                {"error": "Valid icao24 parameter required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            aircraft = Aircraft.objects.get(icao24=icao24)
        except Aircraft.DoesNotExist:
            return Response(
                {"error": f"Aircraft {icao24} not found"},
                status=status.HTTP_404_NOT_FOUND,
            )

        # Get latest state
        latest_state = (
            FlightState.objects.filter(aircraft=aircraft)
            .order_by("-timestamp")
            .first()
        )

        # Get recent anomalies
        anomalies = AnomalyEvent.objects.filter(
            aircraft=aircraft,
            detected_at__gte=timezone.now() - timedelta(hours=24),
        ).order_by("-detected_at")[:20]

        # Get routes
        routes = FlightRoute.objects.filter(
            aircraft=aircraft,
            started_at__gte=timezone.now() - timedelta(hours=12),
        ).order_by("-started_at")[:5]

        # Get state history for mini-chart
        state_history = (
            FlightState.objects.filter(
                aircraft=aircraft,
                timestamp__gte=timezone.now() - timedelta(hours=1),
            )
            .order_by("timestamp")
            .values("timestamp", "baro_altitude", "velocity", "vertical_rate")[:120]
        )

        return Response({
            "aircraft": AircraftSerializer(aircraft).data,
            "current_state": {
                "latitude": latest_state.latitude if latest_state else None,
                "longitude": latest_state.longitude if latest_state else None,
                "baro_altitude": latest_state.baro_altitude if latest_state else None,
                "velocity": latest_state.velocity if latest_state else None,
                "true_track": latest_state.true_track if latest_state else None,
                "vertical_rate": latest_state.vertical_rate if latest_state else None,
                "on_ground": latest_state.on_ground if latest_state else False,
                "squawk": latest_state.squawk if latest_state else None,
                "ml_anomaly_score": latest_state.ml_anomaly_score if latest_state else None,
                "timestamp": latest_state.timestamp.isoformat() if latest_state else None,
            } if latest_state else None,
            "anomalies": AnomalyEventCompactSerializer(anomalies, many=True).data,
            "routes": FlightRouteSerializer(routes, many=True).data,
            "state_history": list(state_history),
        })


class FlightRouteView(APIView):
    """
    GET /api/v1/flights/<icao24>/route/
    Returns the full route polyline for an aircraft.
    """

    def get(self, request, icao24):
        icao24 = _normalize_icao24(icao24)
        if not icao24:
            return Response(
                {"error": "Valid icao24 parameter required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        hours = _int_query_param(request, "hours", 12, 1, 72)
        cutoff = timezone.now() - timedelta(hours=hours)

        try:
            routes = FlightRoute.objects.filter(
                aircraft_id=icao24,
                started_at__gte=cutoff,
            ).order_by("-started_at")

            serialized_routes = []
            if routes.exists():
                for route in routes:
                    try:
                        points = [
                            point
                            for point in (
                                _normalize_route_point(raw_point)
                                for raw_point in (route.points or [])
                            )
                            if point is not None
                        ]
                        serialized_routes.append(
                            _serialize_route(
                                route.session_id,
                                points,
                                "route_table",
                                started_at=route.started_at.isoformat(),
                                ended_at=route.ended_at.isoformat(),
                                total_distance_km=route.total_distance_km,
                            )
                        )
                    except Exception as exc:
                        logger.warning("Failed to serialize route %s: %s", route.session_id, exc)
                        continue
            else:
                # Build route from FlightState records on the fly. Include on-ground
                # points so clients can infer stopovers and taxi/arrival phases.
                states = (
                    FlightState.objects.filter(
                        aircraft_id=icao24,
                        timestamp__gte=cutoff,
                        latitude__isnull=False,
                        longitude__isnull=False,
                    )
                    .order_by("timestamp")
                    .values(
                        "latitude",
                        "longitude",
                        "baro_altitude",
                        "velocity",
                        "true_track",
                        "timestamp",
                        "on_ground",
                        "data_source",
                    )
                )

                points = [_point_from_state(state) for state in states]
                points = [point for point in points if _valid_point(point)]

                sessions = _split_points_into_sessions(points, ROUTE_GAP_MINUTES)
                for index, session in enumerate(sessions):
                    try:
                        session_id = (
                            f"states-{_to_epoch_ms(session[0].get('time'))}-{index}"
                            if session
                            else f"states-{index}"
                        )
                        serialized_routes.append(_serialize_route(session_id, session, "states"))
                    except Exception as exc:
                        logger.warning("Failed to serialize session %s: %s", index, exc)
                        continue

            serialized_routes.sort(
                key=lambda route: _to_epoch_ms(route.get("started_at")),
                reverse=True,
            )
            total_distance = sum(route.get("total_distance_km") or 0 for route in serialized_routes)
            point_count = sum(route.get("point_count") or 0 for route in serialized_routes)
            layovers = _detect_layovers(list(reversed(serialized_routes)))
            intelligence = _build_track_intelligence(list(reversed(serialized_routes)))

            return Response({
                "icao24": icao24,
                "routes": serialized_routes,
                "point_count": point_count,
                "total_distance_km": total_distance if total_distance > 0 else None,
                "layovers": layovers,
                "intelligence": intelligence,
                "lookback_hours": hours,
            })
        except Exception as exc:
            logger.error("Flight route API error for %s: %s", icao24, exc, exc_info=True)
            return Response(
                {"error": "Failed to retrieve flight route", "detail": str(exc)},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )


class AnomalyListView(APIView):
    """
    GET /api/v1/anomalies/
    Returns active anomalies with ML scores.
    """

    def get(self, request):
        if getattr(settings, "SKYWATCH_DEMO_MODE", False) or request.query_params.get("demo") == "1":
            payload = build_demo_flight_payload()
            emergency = next((state for state in payload["states"] if state.get("squawk") == "7700"), None)
            return Response({
                "anomalies": [] if emergency is None else [{
                    "id": 1,
                    "icao24": emergency["icao24"],
                    "callsign": emergency["callsign"],
                    "origin_country": emergency["origin_country"],
                    "anomaly_type": "squawk_7700",
                    "severity": "critical",
                    "confidence_score": 99,
                    "detector_type": "rule",
                    "ml_score": emergency.get("ml_anomaly_score"),
                    "details": {"squawk": "7700", "demo": True},
                    "evidence": {"rule": "emergency_squawk", "observed": "7700"},
                    "source_quality": {"source": "demo", "confidence_score": 0.99},
                    "explanation": [{
                        "factor": "Emergency squawk",
                        "description": "Demo target is broadcasting transponder code 7700.",
                        "severity": "critical",
                    }],
                    "source": "demo",
                    "detected_at": timezone.now().isoformat(),
                    "resolved_at": None,
                    "is_active": True,
                    "latitude": emergency["latitude"],
                    "longitude": emergency["longitude"],
                    "altitude": emergency.get("baro_altitude"),
                    "velocity": emergency.get("velocity"),
                }],
                "total": 1 if emergency else 0,
            })

        severity = request.query_params.get("severity")
        anomaly_type = request.query_params.get("type")
        active_only = request.query_params.get("active", "true").lower() == "true"
        valid_severities = {choice[0] for choice in AnomalyEvent.SEVERITY_CHOICES}
        valid_types = {choice[0] for choice in AnomalyEvent.TYPE_CHOICES}

        if severity and severity not in valid_severities:
            return Response({"error": "Invalid severity filter"}, status=status.HTTP_400_BAD_REQUEST)
        if anomaly_type and anomaly_type not in valid_types:
            return Response({"error": "Invalid anomaly type filter"}, status=status.HTTP_400_BAD_REQUEST)

        qs = AnomalyEvent.objects.select_related("aircraft").order_by("-detected_at")

        if active_only:
            qs = qs.filter(is_active=True)
        if severity:
            qs = qs.filter(severity=severity)
        if anomaly_type:
            qs = qs.filter(anomaly_type=anomaly_type)

        anomalies = qs[:100]
        return Response({
            "anomalies": AnomalyEventSerializer(anomalies, many=True).data,
            "total": qs.count(),
        })


class AnomalyHistoryView(APIView):
    """
    GET /api/v1/anomalies/history/
    Paginated historical anomalies.
    """

    def get(self, request):
        hours = _int_query_param(request, "hours", 24, 1, 720)
        cutoff = timezone.now() - timedelta(hours=hours)

        qs = AnomalyEvent.objects.filter(
            detected_at__gte=cutoff
        ).select_related("aircraft").order_by("-detected_at")

        paginator = PageNumberPagination()
        paginator.page_size = 50
        page = paginator.paginate_queryset(qs, request)

        return paginator.get_paginated_response(
            AnomalyEventSerializer(page, many=True).data
        )


class AnalyticsView(APIView):
    """
    GET /api/v1/analytics/
    Dashboard metrics and analytics.
    """

    def get(self, request):
        now = timezone.now()

        # Current stats from cache
        cached = get_current_flights()
        states = cached.get("states", []) if cached else []
        if not isinstance(states, list):
            states = []
        total = len(states)
        airborne = sum(1 for s in states if not s.get("on_ground", False))

        # Anomaly stats
        active_anomalies = AnomalyEvent.objects.filter(is_active=True)
        anomaly_count = active_anomalies.count()

        # By type
        by_type = dict(
            active_anomalies.values_list("anomaly_type")
            .annotate(count=Count("id"))
            .values_list("anomaly_type", "count")
        )

        # By severity
        by_severity = dict(
            active_anomalies.values_list("severity")
            .annotate(count=Count("id"))
            .values_list("severity", "count")
        )

        # Average ML score
        avg_ml = active_anomalies.aggregate(avg=Avg("ml_score"))["avg"] or 0

        # Countries
        countries = len({s.get("origin_country", "") for s in states})

        # Timeline (last 24h, hourly buckets)
        from django.db.models.functions import TruncHour

        timeline = []
        timeline_start = now - timedelta(hours=24)

        hourly_counts = AnomalyEvent.objects.filter(
            detected_at__gte=timeline_start
        ).annotate(
            hour=TruncHour("detected_at")
        ).values("hour").annotate(count=Count("id"))

        count_map = {item["hour"].isoformat(): item["count"] for item in hourly_counts if item["hour"]}

        for i in range(24, -1, -1):
            bucket_start = (now - timedelta(hours=i)).replace(minute=0, second=0, microsecond=0)
            bucket_iso = bucket_start.isoformat()
            timeline.append({
                "time": bucket_iso,
                "count": count_map.get(bucket_iso, 0),
            })

        # Source breakdown
        source_counts = {}
        for s in states:
            src = s.get("data_source") or "unknown"
            source_counts[src] = source_counts.get(src, 0) + 1

        return Response({
            "total_flights": total,
            "airborne": airborne,
            "on_ground": total - airborne,
            "anomaly_count": anomaly_count,
            "anomaly_rate": (anomaly_count / max(total, 1)) * 100,
            "countries_active": countries,
            "avg_ml_score": avg_ml,
            "last_updated": now.isoformat(),
            "anomaly_by_type": by_type,
            "anomaly_by_severity": by_severity,
            "timeline": timeline,
            "source_counts": source_counts,
        })


class AnalyticsTimelineView(APIView):
    """
    GET /api/v1/analytics/timeline/
    Time-series data for charts.
    """

    def get(self, request):
        hours = _int_query_param(request, "hours", 24, 1, 720)
        cutoff = timezone.now() - timedelta(hours=hours)

        metrics = SystemMetrics.objects.filter(
            timestamp__gte=cutoff
        ).order_by("timestamp").values(
            "timestamp", "total_flights", "airborne",
            "anomaly_count", "anomaly_rate", "avg_ml_score",
        )

        return Response({"timeline": list(metrics)})


class TrafficAnalyticsView(APIView):
    """GET /api/v1/analytics/traffic?range=7d."""

    def get(self, request):
        range_value = request.query_params.get("range", "7d")
        days = 7 if range_value != "24h" else 1
        cutoff = timezone.now() - timedelta(days=days)
        alias = _analytics_db_alias()

        def build():
            rows = (
                FlightState.objects.using(alias)
                .filter(timestamp__gte=cutoff)
                .annotate(hour=TruncHour("timestamp"))
                .values("hour")
                .annotate(active_flights=Count("aircraft_id", distinct=True))
                .order_by("hour")
            )
            return {"range": range_value, "points": list(rows)}

        return Response(_cached_payload(f"analytics:traffic:{range_value}", 600, build))


class RouteAnalyticsView(APIView):
    """GET /api/v1/analytics/routes?limit=10."""

    def get(self, request):
        limit = _int_query_param(request, "limit", 10, 1, 50)
        alias = _analytics_db_alias()

        def build():
            rows = (
                FlightState.objects.using(alias)
                .exclude(origin_airport="")
                .exclude(destination_airport="")
                .values("origin_airport", "destination_airport")
                .annotate(flight_count=Count("aircraft_id", distinct=True))
                .order_by("-flight_count")[:limit]
            )
            return {"routes": list(rows), "limit": limit}

        return Response(_cached_payload(f"analytics:routes:{limit}", 600, build))


class AnomalyRateAnalyticsView(APIView):
    """GET /api/v1/analytics/anomaly-rate?range=30d."""

    def get(self, request):
        range_value = request.query_params.get("range", "30d")
        days = 30
        cutoff = timezone.now() - timedelta(days=days)
        alias = _analytics_db_alias()

        def build():
            flight_rows = (
                FlightState.objects.using(alias)
                .filter(timestamp__gte=cutoff)
                .annotate(day=TruncDay("timestamp"))
                .values("day")
                .annotate(flights=Count("aircraft_id", distinct=True))
            )
            anomaly_rows = (
                AnomalyEvent.objects.using(alias)
                .filter(detected_at__gte=cutoff)
                .annotate(day=TruncDay("detected_at"))
                .values("day")
                .annotate(anomalies=Count("id"))
            )
            by_day = {row["day"].date().isoformat(): {"day": row["day"].date().isoformat(), "flights": row["flights"], "anomalies": 0} for row in flight_rows if row["day"]}
            for row in anomaly_rows:
                if not row["day"]:
                    continue
                key = row["day"].date().isoformat()
                by_day.setdefault(key, {"day": key, "flights": 0, "anomalies": 0})
                by_day[key]["anomalies"] = row["anomalies"]
            points = []
            for item in sorted(by_day.values(), key=lambda value: value["day"]):
                flights = max(item["flights"], 1)
                item["anomalies_per_100_flights"] = (item["anomalies"] / flights) * 100
                points.append(item)
            return {"range": range_value, "points": points}

        return Response(_cached_payload(f"analytics:anomaly-rate:{range_value}", 600, build))


class AircraftTypeAnalyticsView(APIView):
    """GET /api/v1/analytics/aircraft-types."""

    def get(self, request):
        alias = _analytics_db_alias()

        def build():
            rows = (
                Aircraft.objects.using(alias)
                .values("aircraft_type")
                .annotate(count=Count("icao24"))
                .order_by("-count")[:25]
            )
            return {
                "types": [
                    {"aircraft_type": row["aircraft_type"] or "Unknown", "count": row["count"]}
                    for row in rows
                ]
            }

        return Response(_cached_payload("analytics:aircraft-types", 600, build))


class PredictionView(APIView):
    """
    GET /api/v1/predictions/<icao24>/
    Predicted position for the next 5 minutes.
    """

    def get(self, request, icao24):
        import math

        icao24 = _normalize_icao24(icao24)
        if not icao24:
            return Response(
                {"error": "Valid icao24 parameter required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        latest = (
            FlightState.objects.filter(aircraft_id=icao24)
            .order_by("-timestamp")
            .first()
        )

        if not latest or latest.on_ground:
            return Response({
                "icao24": icao24,
                "predictions": [],
                "message": "No airborne state available",
            })

        EARTH_R = 6371000
        predictions = []

        for minutes in [1, 2, 3, 5, 10]:
            seconds = minutes * 60
            velocity = latest.velocity or 0
            heading = latest.true_track or 0
            vert_rate = latest.vertical_rate or 0

            if velocity < 1:
                continue

            distance = velocity * seconds
            bearing = math.radians(heading)
            lat1 = math.radians(latest.latitude or 0)
            lon1 = math.radians(latest.longitude or 0)
            ang_dist = distance / EARTH_R

            lat2 = math.asin(
                math.sin(lat1) * math.cos(ang_dist)
                + math.cos(lat1) * math.sin(ang_dist) * math.cos(bearing)
            )
            lon2 = lon1 + math.atan2(
                math.sin(bearing) * math.sin(ang_dist) * math.cos(lat1),
                math.cos(ang_dist) - math.sin(lat1) * math.sin(lat2),
            )

            pred_alt = (latest.baro_altitude or 0) + vert_rate * seconds
            uncertainty_nm = (80 + seconds * 6) / 1852

            predictions.append({
                "minutes_ahead": minutes,
                "latitude": math.degrees(lat2),
                "longitude": math.degrees(lon2),
                "altitude_m": max(0, pred_alt),
                "uncertainty_nm": uncertainty_nm,
                "confidence": max(0.1, 1.0 - (seconds / 900)),
            })

        return Response({
            "icao24": icao24,
            "predictions": predictions,
            "base_state": {
                "latitude": latest.latitude,
                "longitude": latest.longitude,
                "altitude": latest.baro_altitude,
                "velocity": latest.velocity,
                "heading": latest.true_track,
                "timestamp": latest.timestamp.isoformat(),
            },
        })


class MetarWeatherView(APIView):
    """GET /api/v1/weather/metar?airports=KJFK,EGLL."""

    permission_classes = [AllowAny]

    def get(self, request):
        raw_airports = request.query_params.get("airports", "")
        airports = [
            item.strip().upper()
            for item in raw_airports.split(",")
            if 3 <= len(item.strip()) <= 5 and item.strip().isalnum()
        ][:80]
        if not airports:
            return Response({"weather": {}, "count": 0})
        from .services.weather import fetch_metars

        weather = fetch_metars(airports)
        return Response({"weather": weather, "count": len(weather)})


class TfrAirspaceView(APIView):
    """GET /api/v1/airspace/tfr."""

    permission_classes = [AllowAny]

    def get(self, request):
        from .services.airspace_restrictions import get_airspace_restrictions

        return Response(get_airspace_restrictions())


class AirspaceRestrictionsView(APIView):
    """GET /api/v1/airspace/restrictions/."""

    permission_classes = [AllowAny]

    def get(self, request):
        from .services.airspace_restrictions import get_airspace_restrictions

        return Response(get_airspace_restrictions())


class PlaybackView(APIView):
    """GET /api/v1/playback?flight_id=X&start=ISO8601&end=ISO8601."""

    permission_classes = [IsAuthenticated]
    throttle_scope = "playback"

    def get(self, request):
        flight_id = _normalize_icao24(request.query_params.get("flight_id"))
        start = _parse_iso_datetime(request.query_params.get("start"))
        end = _parse_iso_datetime(request.query_params.get("end"))
        if not flight_id or not start or not end:
            return Response(
                {"error": "flight_id, start, and end are required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        now = timezone.now()
        if end <= start:
            return Response({"error": "end must be after start"}, status=status.HTTP_400_BAD_REQUEST)
        if end - start > timedelta(hours=24) or start < now - timedelta(hours=24):
            return Response({"error": "playback is limited to the last 24 hours"}, status=status.HTTP_400_BAD_REQUEST)

        positions = FlightPosition.objects.filter(
            aircraft_id=flight_id,
            timestamp__gte=start,
            timestamp__lte=end,
        ).order_by("timestamp")[:5000]

        if not positions.exists():
            fallback = (
                FlightState.objects.filter(
                    aircraft_id=flight_id,
                    timestamp__gte=start,
                    timestamp__lte=end,
                    latitude__isnull=False,
                    longitude__isnull=False,
                )
                .order_by("timestamp")
                .values(
                    "timestamp",
                    "latitude",
                    "longitude",
                    "baro_altitude",
                    "velocity",
                    "true_track",
                    "vertical_rate",
                    "on_ground",
                    "data_source",
                )[:5000]
            )
            return Response({
                "flight_id": flight_id,
                "positions": [
                    {
                        "timestamp": item["timestamp"],
                        "latitude": item["latitude"],
                        "longitude": item["longitude"],
                        "altitude": item["baro_altitude"],
                        "velocity": item["velocity"],
                        "heading": item["true_track"],
                        "vertical_rate": item["vertical_rate"],
                        "on_ground": item["on_ground"],
                        "data_source": item["data_source"],
                    }
                    for item in fallback
                ],
            })

        return Response({
            "flight_id": flight_id,
            "positions": FlightPositionSerializer(positions, many=True).data,
        })


class AnomalyExplanationView(APIView):
    def get(self, request, pk):
        try:
            event = AnomalyEvent.objects.select_related("aircraft", "alert_rule").get(pk=pk)
        except AnomalyEvent.DoesNotExist:
            return Response({"error": "Anomaly not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response({"id": event.id, "explanation": event.explanation or []})


class AnomalyFeedbackView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "alert_mutation"

    def post(self, request, pk):
        verdict = request.data.get("verdict")
        if verdict not in {"true_positive", "false_positive"}:
            return Response({"error": "Invalid verdict"}, status=status.HTTP_400_BAD_REQUEST)
        try:
            event = AnomalyEvent.objects.get(pk=pk)
        except AnomalyEvent.DoesNotExist:
            return Response({"error": "Anomaly not found"}, status=status.HTTP_404_NOT_FOUND)
        event.feedback = verdict
        event.save(update_fields=["feedback"])
        return Response({"id": event.id, "feedback": event.feedback})


class AlertRuleListView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = "alert_mutation"

    def get(self, request):
        rules = AlertRule.objects.filter(user=_alert_rule_owner(request)).order_by("name")
        return Response({"rules": AlertRuleSerializer(rules, many=True).data})

    def post(self, request):
        serializer = AlertRuleSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(user=_alert_rule_owner(request))
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class AlertRuleDetailView(APIView):
    permission_classes = [AllowAny]
    throttle_scope = "alert_mutation"

    def patch(self, request, pk):
        try:
            rule = AlertRule.objects.get(pk=pk, user=_alert_rule_owner(request))
        except AlertRule.DoesNotExist:
            return Response({"error": "Rule not found"}, status=status.HTTP_404_NOT_FOUND)
        serializer = AlertRuleSerializer(rule, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    def delete(self, request, pk):
        deleted, _ = AlertRule.objects.filter(pk=pk, user=_alert_rule_owner(request)).delete()
        if not deleted:
            return Response({"error": "Rule not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(status=status.HTTP_204_NO_CONTENT)


class DataSourceStatsView(APIView):
    """
    GET /api/v1/sources/
    Returns per-source aircraft counts and metadata.
    """

    def get(self, request):
        cached = get_current_flights()
        states = cached.get("states", []) if cached else []
        if not isinstance(states, list):
            states = []
        health_payload = source_health_payload()

        source_counts = {}
        for s in states:
            src = s.get("data_source") or "unknown"
            source_counts[src] = source_counts.get(src, 0) + 1

        # Source metadata
        source_info = {
            "opensky": {
                "name": "OpenSky Network",
                "type": "ADS-B Ground",
                "description": "Crowdsourced ADS-B ground receiver network",
                "color": "#38bdf8",
            },
            "adsb_one": {
                "name": "ADSB-One",
                "type": "ADS-B Ground",
                "description": "Global ADS-B exchange aggregator",
                "color": "#22d3ee",
            },
            "airplanes_live": {
                "name": "Airplanes.live",
                "type": "ADS-B Ground",
                "description": "ADS-B Exchange community feed",
                "color": "#a78bfa",
            },
            "adsb_lol": {
                "name": "ADSB.lol",
                "type": "ADS-B Ground",
                "description": "Open ADS-B public network point feeds",
                "color": "#06b6d4",
            },
            "ogn": {
                "name": "Open Glider Network",
                "type": "FLARM",
                "description": "FLARM/OGN receiver network for gliders",
                "color": "#4ade80",
            },
            "faa_radar": {
                "name": "FAA / Military Radar",
                "type": "Radar",
                "description": "FAA SWIM and military radar data",
                "color": "#f97316",
            },
            "uat": {
                "name": "UAT (978 MHz)",
                "type": "UAT",
                "description": "US general aviation UAT transponders",
                "color": "#facc15",
            },
            "satellite": {
                "name": "Satellite ADS-B",
                "type": "Satellite",
                "description": "Space-based ADS-B receivers for oceanic coverage",
                "color": "#f472b6",
            },
        }

        sources = []
        for src_key, count in sorted(source_counts.items(), key=lambda x: -x[1]):
            info = source_info.get(src_key, {
                "name": src_key.replace("_", " ").title(),
                "type": "Unknown",
                "description": "Unknown data source",
                "color": "#94a3b8",
            })
            sources.append({
                "key": src_key,
                "count": count,
                "health": health_payload.get(src_key, {}),
                **info,
            })

        return Response({
            "sources": sources,
            "total": len(states),
            "source_count": len(source_counts),
            "health": health_payload,
            "recent_audits": IngestionAuditSerializer(
                IngestionAudit.objects.order_by("-started_at")[:25],
                many=True,
            ).data,
        })


class SourceHealthView(APIView):
    """GET /api/v1/source-health/."""

    def get(self, request):
        rows = IngestionSourceHealth.objects.order_by("source")
        return Response({
            "sources": IngestionSourceHealthSerializer(rows, many=True).data,
            "generated_at": timezone.now().isoformat(),
        })


class IngestionAuditView(APIView):
    """GET /api/v1/ingestion-audits/?source=opensky."""

    def get(self, request):
        source = request.query_params.get("source")
        qs = IngestionAudit.objects.order_by("-started_at")
        if source:
            qs = qs.filter(source=source)
        paginator = PageNumberPagination()
        paginator.page_size = _int_query_param(request, "page_size", 50, 1, 200)
        page = paginator.paginate_queryset(qs, request)
        return paginator.get_paginated_response(IngestionAuditSerializer(page, many=True).data)


class ModelStatusView(APIView):
    """GET /api/v1/model-status/."""

    def get(self, request):
        active_models = MLModelVersion.objects.filter(is_active=True).order_by("model_name")
        try:
            import tensorflow  # noqa: F401

            lstm_available = True
        except Exception:
            lstm_available = False

        return Response({
            "models": MLModelVersionSerializer(active_models, many=True).data,
            "detectors": {
                "rules": {"available": True, "version": "built-in"},
                "statistical": {"available": True, "version": "iforest+profile"},
                "lstm": {
                    "available": lstm_available,
                    "reason": None if lstm_available else "TensorFlow/Keras is not installed or no model is loaded.",
                },
            },
            "generated_at": timezone.now().isoformat(),
        })


class SatelliteCatalogView(APIView):
    """
    GET /api/v1/satellites/
    Returns public CelesTrak satellite positions propagated with SGP4.
    """

    def get(self, request):
        if getattr(settings, "SKYWATCH_DEMO_MODE", False) or request.query_params.get("demo") == "1":
            return _freshness_response({
                "time": int(time.time()),
                "generated_at": timezone.now().isoformat(),
                "source": "demo",
                "status": "ok",
                "propagator": "fixed-demo",
                "satellites": [{
                    "id": "25544",
                    "name": "ISS (DEMO)",
                    "group": "stations",
                    "group_label": "Space stations",
                    "latitude": 18.2,
                    "longitude": 73.8,
                    "altitude_km": 420,
                    "velocity_kms": 7.66,
                    "orbit_quality": "fresh",
                    "source": "demo",
                    "propagator": "fixed-demo",
                }],
                "count": 1,
                "source_counts": {"stations": 1},
                "groups": [{
                    "key": "stations",
                    "name": "Space stations",
                    "celestrak_group": "stations",
                    "count": 1,
                    "color": "#22c55e",
                }],
                "errors": {},
                "coverage": {"demo_mode": True, "public_sources_only": False},
            })

        if not getattr(settings, "CELESTRAK_SATELLITES_ENABLED", True):
            return _freshness_response(
                {"error": "Satellite catalog disabled", "satellites": [], "count": 0},
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        raw_groups = request.query_params.get("groups", "")
        groups = [item.strip() for item in raw_groups.split(",") if item.strip()] or None
        limit = _int_query_param(request, "limit", 650, 1, 1500)

        try:
            from .services.celestrak import fetch_satellite_catalog

            payload = fetch_satellite_catalog(group_keys=groups, max_total=limit)
            status_code = (
                status.HTTP_503_SERVICE_UNAVAILABLE
                if payload.get("status") == "propagator_unavailable"
                else status.HTTP_200_OK
            )
            return _freshness_response(payload, status_code=status_code)
        except Exception as exc:
            logger.warning("Satellite catalog fetch failed: %s", exc)
            return _freshness_response(
                {
                    "error": "Satellite catalog unavailable",
                    "satellites": [],
                    "count": 0,
                },
                status_code=status.HTTP_502_BAD_GATEWAY,
            )
