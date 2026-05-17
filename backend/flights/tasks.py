"""
Celery tasks for periodic data ingestion, anomaly detection,
route building, and model retraining.
"""

import logging
import time
import hashlib
import re
from datetime import timedelta
from celery import shared_task
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import models, transaction
from django.utils import timezone

logger = logging.getLogger(__name__)
ICAO24_RE = re.compile(r"^[0-9a-f]{6}$")


def _normalize_icao24(value):
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized if ICAO24_RE.fullmatch(normalized) else None


def _last_contact_value(state):
    try:
        return float(state.get("last_contact") or 0)
    except (TypeError, ValueError):
        return 0


def _merge_flight_states(opensky_states, supplemental_states):
    """Merge OpenSky and supplemental states, keeping newest last_contact per ICAO24."""
    merged_by_icao = {}
    opensky_icaos = set()

    for state in opensky_states:
        if not isinstance(state, dict):
            continue
        icao24 = _normalize_icao24(state.get("icao24"))
        if not icao24:
            continue
        state["icao24"] = icao24
        opensky_icaos.add(icao24)
        merged_by_icao[icao24] = state

    for state in supplemental_states:
        if not isinstance(state, dict):
            continue
        icao24 = _normalize_icao24(state.get("icao24"))
        if not icao24:
            continue
        state["icao24"] = icao24
        existing = merged_by_icao.get(icao24)
        if existing is None or _last_contact_value(state) > _last_contact_value(existing):
            merged_by_icao[icao24] = state

    net_new = sum(1 for icao24 in merged_by_icao if icao24 not in opensky_icaos)
    return list(merged_by_icao.values()), net_new


def _broadcast_to_flights(event_type, data):
    """Send an event to connected flight WebSocket clients."""
    try:
        channel_layer = get_channel_layer()
        if channel_layer is None:
            logger.warning("No Channels layer configured; skipped %s broadcast", event_type)
            return False
        async_to_sync(channel_layer.group_send)(
            "flights",
            {
                "type": event_type,
                "data": data,
            },
        )
        return True
    except Exception as exc:
        logger.warning("Failed to broadcast %s: %s", event_type, exc)
        return False


def _publish_current_flights(result):
    """Update Redis/cache and push the same payload over WebSockets."""
    from .services.cache import set_current_flights, set_flight_state

    states = result.get("states", [])
    set_current_flights(result)
    for state in states:
        icao24 = state.get("icao24")
        if icao24:
            set_flight_state(icao24, state)

    _broadcast_to_flights(
        "flight_update",
        {
            "time": result.get("time", int(time.time())),
            "flights": states,
            "authenticated": result.get("authenticated", False),
            "source": "backend",
            "count": len(states),
        },
    )


def _serialize_anomaly(event):
    return {
        "id": event.id,
        "icao24": event.aircraft_id,
        "callsign": event.aircraft.callsign if event.aircraft_id and event.aircraft else "",
        "origin_country": event.aircraft.origin_country if event.aircraft_id and event.aircraft else "",
        "anomaly_type": event.anomaly_type,
        "severity": event.severity,
        "confidence_score": event.confidence_score,
        "ml_score": event.ml_score,
        "details": event.details,
        "detected_at": event.detected_at.isoformat(),
        "resolved_at": event.resolved_at.isoformat() if event.resolved_at else None,
        "is_active": event.is_active,
        "latitude": event.latitude,
        "longitude": event.longitude,
        "altitude": event.altitude,
        "velocity": event.velocity,
    }


def _publish_anomaly_alert(events):
    if not events:
        return
    _broadcast_to_flights(
        "anomaly_alert",
        {
            "time": int(time.time()),
            "anomalies": [_serialize_anomaly(event) for event in events],
        },
    )


@shared_task(bind=True, max_retries=2, default_retry_delay=10)
def fetch_flight_states(self):
    """Fetch flight states from all sources, merge, store in DB and cache."""
    from django.conf import settings
    from .services.opensky import fetch_all_states
    from .services.adsb_sources import fetch_adsb_one_states, fetch_airplanes_live_states
    from .services.cache import increment_api_calls
    from .models import Aircraft, FlightState

    try:
        increment_api_calls()
        result = fetch_all_states()
        if result is None:
            logger.info("Skipped fetch (rate limited or too soon)")
            return {"status": "skipped"}

        states = []
        for state in result.get("states", []):
            if not isinstance(state, dict):
                continue
            icao24 = _normalize_icao24(state.get("icao24"))
            if not icao24:
                continue
            state["icao24"] = icao24
            states.append(state)
        result["states"] = states
        # Tag OpenSky states with their data source
        for s in states:
            if not s.get("data_source"):
                s["data_source"] = "opensky"

        supplemental_states = []

        # ── ADS-B supplemental sources ──
        if getattr(settings, "ADSBONE_ENABLED", True):
            try:
                adsb_one_states = fetch_adsb_one_states()
                logger.info("ADSB-One returned %d aircraft", len(adsb_one_states))
                supplemental_states.extend(adsb_one_states)
            except Exception as exc:
                logger.warning("ADSB-One supplemental fetch failed: %s", exc)
        else:
            logger.info("ADSB-One supplemental feed disabled")

        if getattr(settings, "AIRPLANESLIVE_ENABLED", True):
            try:
                airplanes_live_states = fetch_airplanes_live_states()
                logger.info("Airplanes.live returned %d aircraft", len(airplanes_live_states))
                supplemental_states.extend(airplanes_live_states)
            except Exception as exc:
                logger.warning("Airplanes.live supplemental fetch failed: %s", exc)
        else:
            logger.info("Airplanes.live supplemental feed disabled")

        # ── OGN / FLARM (gliders, small aircraft) ──
        if getattr(settings, "OGN_ENABLED", True):
            try:
                from .services.ogn_client import fetch_ogn_states
                ogn_states = fetch_ogn_states()
                logger.info("OGN/FLARM returned %d aircraft", len(ogn_states))
                supplemental_states.extend(ogn_states)
            except Exception as exc:
                logger.warning("OGN fetch failed: %s", exc)

        # ── FAA / Military radar ──
        if getattr(settings, "FAA_RADAR_ENABLED", True):
            try:
                from .services.faa_radar import fetch_faa_radar_states
                radar_states = fetch_faa_radar_states()
                logger.info("FAA/Mil radar returned %d aircraft", len(radar_states))
                supplemental_states.extend(radar_states)
            except Exception as exc:
                logger.warning("FAA radar fetch failed: %s", exc)

        # ── UAT (978 MHz, US GA traffic) ──
        if getattr(settings, "UAT_ENABLED", True):
            try:
                from .services.uat_client import fetch_uat_states
                uat_states = fetch_uat_states()
                logger.info("UAT returned %d aircraft", len(uat_states))
                supplemental_states.extend(uat_states)
            except Exception as exc:
                logger.warning("UAT fetch failed: %s", exc)

        # ── Satellite ADS-B (oceanic) ──
        if getattr(settings, "SATELLITE_ADSB_ENABLED", True):
            try:
                from .services.satellite_adsb import fetch_satellite_adsb_states
                sat_states = fetch_satellite_adsb_states()
                logger.info("Satellite ADS-B returned %d aircraft", len(sat_states))
                supplemental_states.extend(sat_states)
            except Exception as exc:
                logger.warning("Satellite ADS-B fetch failed: %s", exc)

        if supplemental_states:
            states, net_new = _merge_flight_states(states, supplemental_states)
            result["states"] = states
        else:
            net_new = 0

        logger.info("All supplemental sources added %d net new aircraft after dedup", net_new)

        # ── Aggregate source counts ──
        source_counts = {}
        for s in states:
            src = s.get("data_source") or "unknown"
            source_counts[src] = source_counts.get(src, 0) + 1
        result["source_counts"] = source_counts
        logger.info("Source breakdown: %s", source_counts)

        now = timezone.now()
        bulk_states = []
        aircraft_updates = {}

        for s in states:
            icao24 = s["icao24"]
            ds = s.get("data_source") or ""

            # Track aircraft
            aircraft_updates[icao24] = {
                "callsign": s.get("callsign") or "",
                "origin_country": s.get("origin_country", ""),
                "last_seen": now,
                "category": s.get("category", 0),
                "data_source": ds,
            }

            # Create FlightState record
            bulk_states.append(FlightState(
                aircraft_id=icao24,
                timestamp=now,
                latitude=s.get("latitude"),
                longitude=s.get("longitude"),
                baro_altitude=s.get("baro_altitude"),
                geo_altitude=s.get("geo_altitude"),
                velocity=s.get("velocity"),
                vertical_rate=s.get("vertical_rate"),
                true_track=s.get("true_track"),
                squawk=s.get("squawk"),
                on_ground=s.get("on_ground", False),
                spi=s.get("spi", False),
                position_source=s.get("position_source", 0),
                last_contact=s.get("last_contact", 0),
                time_position=s.get("time_position"),
                category=s.get("category", 0),
                data_source=ds,
            ))

        with transaction.atomic():
            # Bulk upsert Aircraft
            if aircraft_updates:
                aircraft_objs = [
                    Aircraft(
                        icao24=icao24,
                        callsign=data["callsign"],
                        origin_country=data["origin_country"],
                        last_seen=data["last_seen"],
                        category=data["category"],
                        data_source=data["data_source"],
                    )
                    for icao24, data in aircraft_updates.items()
                ]
                Aircraft.objects.bulk_create(
                    aircraft_objs,
                    update_conflicts=True,
                    unique_fields=["icao24"],
                    update_fields=["callsign", "origin_country", "last_seen", "category", "data_source"]
                )

            # Bulk create FlightState records
            if bulk_states:
                FlightState.objects.bulk_create(bulk_states, ignore_conflicts=True)

            # Update total_states count
            if aircraft_updates:
                Aircraft.objects.filter(
                    icao24__in=list(aircraft_updates.keys())
                ).update(total_states=models.F("total_states") + 1)

            transaction.on_commit(lambda: _after_flight_ingest_commit(result, len(bulk_states)))

        logger.info("Stored %d flight states from %d sources", len(bulk_states), len(source_counts))

        return {"status": "ok", "count": len(bulk_states), "sources": source_counts}

    except Exception as exc:
        logger.error("fetch_flight_states failed: %s", exc)
        raise self.retry(exc=exc)


def _after_flight_ingest_commit(result, count):
    """Publish committed state and enqueue dependent tasks."""
    try:
        _publish_current_flights(result)
        logger.debug("Published %d committed flight states", count)
    except Exception as exc:
        logger.warning("Post-commit flight publish failed: %s", exc)

    try:
        run_anomaly_detection.delay()
        build_flight_routes.delay()
        enrich_aircraft_metadata.delay()
    except Exception as exc:
        logger.warning("Failed to enqueue post-ingest tasks: %s", exc)


@shared_task
def run_anomaly_detection():
    """Run ML + rule-based anomaly detection on cached flight states."""
    from .services.cache import get_current_flights
    from .services.anomaly_detector import detect_all, score_flights
    from .services.advanced_detection import detect_all_advanced
    from .services.flight_profiler import bulk_update_profiles
    from .models import AnomalyEvent, Aircraft, AircraftProfile, FlightState

    data = get_current_flights()
    if not data:
        return {"status": "no_data"}

    states = data.get("states", [])
    if not states:
        return {"status": "empty"}

    valid_states = []
    for state in states:
        if not isinstance(state, dict):
            continue
        icao24 = _normalize_icao24(state.get("icao24"))
        if not icao24:
            continue
        state["icao24"] = icao24
        valid_states.append(state)
    states = valid_states
    data["states"] = states
    if not states:
        return {"status": "empty"}

    now = timezone.now()
    now_epoch = time.time()
    new_anomalies = 0
    new_events = []
    current_types_by_icao = {}
    active_icaos = {s["icao24"] for s in states}
    grounded_icaos = {s["icao24"] for s in states if s.get("on_ground", False)}

    # Score all flights with ML at once for efficiency
    scored = score_flights(states)

    # Fetch existing behavioral profiles
    profiles = {}
    if active_icaos:
        for p in AircraftProfile.objects.filter(aircraft_id__in=active_icaos):
            profiles[p.aircraft_id] = {
                "avg_velocity": p.avg_velocity,
                "std_velocity": p.std_velocity,
                "avg_altitude": p.avg_altitude,
                "std_altitude": p.std_altitude,
                "avg_vertical_rate": p.avg_vertical_rate,
                "var_heading": p.typical_heading_variance,
                "observation_count": p.observation_count,
            }
            profiles[p.aircraft_id].update(p.profile_data)

    # Fetch heading history for circling detection
    heading_histories = {}
    history_cutoff = now - timedelta(minutes=10)
    for fs in FlightState.objects.filter(
        aircraft_id__in=active_icaos,
        timestamp__gte=history_cutoff,
        on_ground=False,
    ).only("aircraft_id", "timestamp", "true_track").order_by("timestamp"):
        if fs.true_track is not None:
            if fs.aircraft_id not in heading_histories:
                heading_histories[fs.aircraft_id] = []
            heading_histories[fs.aircraft_id].append((fs.timestamp.timestamp(), fs.true_track))

    latest_states = {}
    if active_icaos:
        latest_cutoff = now - timedelta(minutes=5)
        for fs in (
            FlightState.objects.filter(
                aircraft_id__in=active_icaos,
                timestamp__gte=latest_cutoff,
            )
            .order_by("-timestamp")
            .only("id", "aircraft_id", "ml_anomaly_score")
        ):
            if fs.aircraft_id not in latest_states:
                latest_states[fs.aircraft_id] = fs
            if len(latest_states) == len(active_icaos):
                break

    # Fetch active anomalies mapping before transaction
    active_event_map = {}
    if active_icaos:
        active_events_qs = AnomalyEvent.objects.filter(
            aircraft_id__in=active_icaos, is_active=True
        ).values("id", "aircraft_id", "anomaly_type", "confidence_score", "ml_score", "details", "detected_at")

        for event in active_events_qs:
            key = (event["aircraft_id"], event["anomaly_type"])
            if key not in active_event_map or event["detected_at"] > active_event_map[key]["detected_at"]:
                active_event_map[key] = event

    with transaction.atomic():
        states_to_update = []
        anomalies_to_update = []
        anomalies_to_create = []
        aircraft_anomaly_increments = set()

        for flight, ml_score in scored:
            icao24 = flight["icao24"]
            flight["ml_anomaly_score"] = ml_score

            latest_state = latest_states.get(icao24)
            if latest_state and latest_state.ml_anomaly_score != ml_score:
                latest_state.ml_anomaly_score = ml_score
                states_to_update.append(latest_state)

            # Core detection (Rule-based + ML Ensemble)
            anomalies = detect_all(flight, now_epoch, ml_score=ml_score)

            # Advanced detection (Geofence, Proximity, Circling, Behavioral)
            prof = profiles.get(icao24)
            hist = heading_histories.get(icao24)
            adv_anomalies = detect_all_advanced(
                flight=flight,
                other_flights=states,
                profile=prof,
                heading_history=hist,
                now_epoch=now_epoch
            )
            for adv_anom in adv_anomalies:
                adv_anom["ml_score"] = ml_score
                anomalies.append(adv_anom)

            current_types_by_icao[icao24] = {anomaly["type"] for anomaly in anomalies}

            for anomaly in anomalies:
                # Check if similar anomaly already active (dedup)
                existing_dict = active_event_map.get((icao24, anomaly["type"]))

                if existing_dict:
                    update_obj = AnomalyEvent(id=existing_dict["id"])
                    update_obj.confidence_score = anomaly.get("confidence_score", 0)
                    update_obj.ml_score = anomaly.get("ml_score", ml_score)
                    update_obj.details = anomaly.get("details", existing_dict.get("details", {}))
                    anomalies_to_update.append(update_obj)
                else:
                    anomalies_to_create.append(AnomalyEvent(
                        aircraft_id=icao24,
                        anomaly_type=anomaly["type"],
                        severity=anomaly.get("severity", "medium"),
                        confidence_score=anomaly.get("confidence_score", 0),
                        ml_score=anomaly.get("ml_score", ml_score),
                        details=anomaly.get("details", {}),
                        detected_at=now,
                        latitude=flight.get("latitude"),
                        longitude=flight.get("longitude"),
                        altitude=flight.get("baro_altitude"),
                        velocity=flight.get("velocity"),
                    ))
                    new_anomalies += 1
                    aircraft_anomaly_increments.add(icao24)

        if states_to_update:
            FlightState.objects.bulk_update(
                states_to_update,
                ["ml_anomaly_score"],
                batch_size=1000,
            )

        if anomalies_to_update:
            AnomalyEvent.objects.bulk_update(
                anomalies_to_update,
                ["confidence_score", "ml_score", "details"],
                batch_size=1000,
            )

        if anomalies_to_create:
            created_events = AnomalyEvent.objects.bulk_create(
                anomalies_to_create,
                batch_size=1000,
            )
            new_events.extend(created_events)

        if aircraft_anomaly_increments:
            Aircraft.objects.filter(icao24__in=aircraft_anomaly_increments).update(
                total_anomalies=models.F("total_anomalies") + 1
            )

        # Update behavioral profiles in bulk
        updated_icaos = bulk_update_profiles(profiles, states)
        if updated_icaos:
            profiles_to_save = []
            for icao24 in updated_icaos:
                pd = profiles[icao24]
                profiles_to_save.append(AircraftProfile(
                    aircraft_id=icao24,
                    avg_velocity=pd.get("avg_velocity", 0),
                    std_velocity=pd.get("std_velocity", 0),
                    avg_altitude=pd.get("avg_altitude", 0),
                    std_altitude=pd.get("std_altitude", 0),
                    avg_vertical_rate=pd.get("avg_vertical_rate", 0),
                    typical_heading_variance=pd.get("var_heading", 0),
                    observation_count=pd.get("observation_count", 0),
                    profile_data=pd,
                ))
            if profiles_to_save:
                # Use bulk_create with update_conflicts for fast upsert (Django 4.1+)
                AircraftProfile.objects.bulk_create(
                    profiles_to_save,
                    update_conflicts=True,
                    unique_fields=["aircraft_id"],
                    update_fields=[
                        "avg_velocity", "std_velocity", "avg_altitude", "std_altitude",
                        "avg_vertical_rate", "typical_heading_variance",
                        "observation_count", "profile_data", "last_updated"
                    ]
                )

        # Only resolve an active anomaly after the aircraft is seen on ground
        # and the same anomaly is no longer present in the current state.
        resolved = []
        if grounded_icaos:
            active_ground_events = AnomalyEvent.objects.filter(
                is_active=True,
                aircraft_id__in=grounded_icaos,
            )
            for event in active_ground_events:
                active_types = current_types_by_icao.get(event.aircraft_id, set())
                if event.anomaly_type not in active_types:
                    event.is_active = False
                    event.resolved_at = now
                    resolved.append(event)
            if resolved:
                AnomalyEvent.objects.bulk_update(
                    resolved,
                    ["is_active", "resolved_at"],
                    batch_size=1000,
                )

        # Resolve active anomalies for aircraft that haven't been seen in over 10 minutes (signal lost)
        stale_cutoff = now - timedelta(minutes=10)
        AnomalyEvent.objects.filter(
            is_active=True,
            aircraft__last_seen__lt=stale_cutoff
        ).update(
            is_active=False,
            resolved_at=now
        )

        transaction.on_commit(lambda: _after_anomaly_detection_commit(data, new_events))

    # Record system metrics outside the transaction to avoid locking
    from .models import SystemMetrics
    anomaly_count = AnomalyEvent.objects.filter(is_active=True).count()
    airborne = sum(1 for s in states if not s.get("on_ground", False))
    countries = len({s.get("origin_country", "") for s in states})

    # Aggregate source counts
    source_counts = {}
    for s in states:
        src = s.get("data_source") or "unknown"
        source_counts[src] = source_counts.get(src, 0) + 1

    SystemMetrics.objects.create(
        total_flights=len(states),
        airborne=airborne,
        on_ground=len(states) - airborne,
        anomaly_count=anomaly_count,
        anomaly_rate=(anomaly_count / max(len(states), 1)) * 100,
        countries_active=countries,
        source_counts=source_counts,
    )

    logger.info("Anomaly detection: %d new anomalies from %d flights", new_anomalies, len(states))
    return {"status": "ok", "new_anomalies": new_anomalies}


def _after_anomaly_detection_commit(data, new_events):
    """Publish ML-scored state and any anomaly alerts after DB commit."""
    try:
        _publish_current_flights(data)
        _publish_anomaly_alert(new_events)
    except Exception as exc:
        logger.warning("Post-commit anomaly publish failed: %s", exc)


@shared_task
def build_flight_routes():
    """Build route polylines from accumulated FlightState snapshots."""
    from django.conf import settings
    from .models import FlightState, FlightRoute, AnomalyEvent
    from django.db.models import Max, Exists, OuterRef, BooleanField

    now = timezone.now()
    lookback_hours = getattr(settings, "FLIGHT_ROUTE_LOOKBACK_HOURS", 12)
    session_gap_minutes = getattr(settings, "FLIGHT_ROUTE_SESSION_GAP_MINUTES", 90)
    cutoff = now - timedelta(hours=lookback_hours)
    session_gap = timedelta(minutes=session_gap_minutes)

    # Get distinct aircraft with recent states, prioritized by active anomalies and recency
    active_anomaly_aircraft = AnomalyEvent.objects.filter(
        aircraft_id=OuterRef("aircraft_id"), is_active=True
    ).values("aircraft_id")

    recent_icaos = (
        FlightState.objects.filter(timestamp__gte=cutoff, on_ground=False)
        .values("aircraft_id")
        .annotate(
            last_seen=Max("timestamp"),
            has_anomaly=Exists(active_anomaly_aircraft),
        )
        .order_by("-has_anomaly", "-last_seen")
        .values_list("aircraft_id", flat=True)[:2000]
    )

    routes_updated = 0

    recent_icaos_list = list(recent_icaos)

    states_qs = (
        FlightState.objects.filter(
            aircraft_id__in=recent_icaos_list,
            timestamp__gte=cutoff,
            latitude__isnull=False,
            longitude__isnull=False,
            on_ground=False,
        )
        .order_by("aircraft_id", "timestamp")
        .values("aircraft_id", "latitude", "longitude", "baro_altitude", "velocity", "true_track", "timestamp")
    )

    import itertools
    from operator import itemgetter
    grouped_states = itertools.groupby(states_qs, key=itemgetter("aircraft_id"))

    for icao24, group in grouped_states:
        states = list(group)

        if len(states) < 2:
            continue

        sessions = []
        current = []
        previous_time = None
        for state in states:
            if previous_time and state["timestamp"] - previous_time > session_gap:
                if len(current) >= 2:
                    sessions.append(current)
                current = []
            current.append(state)
            previous_time = state["timestamp"]

        if len(current) >= 2:
            sessions.append(current)

        for session in sessions:
            session_id = hashlib.md5(
                f"{icao24}-{session[0]['timestamp'].isoformat()}".encode()
            ).hexdigest()[:12]

            points = []
            total_dist = 0.0
            prev = None

            for s in session:
                point = {
                    "lat": s["latitude"],
                    "lon": s["longitude"],
                    "alt": s["baro_altitude"],
                    "speed": s["velocity"],
                    "heading": s["true_track"],
                    "time": s["timestamp"].isoformat(),
                }
                points.append(point)

                if prev:
                    total_dist += _haversine(
                        prev["lat"], prev["lon"], point["lat"], point["lon"]
                    )
                prev = point

            FlightRoute.objects.update_or_create(
                aircraft_id=icao24,
                session_id=session_id,
                defaults={
                    "points": points,
                    "started_at": session[0]["timestamp"],
                    "ended_at": session[len(session) - 1]["timestamp"],
                    "point_count": len(points),
                    "total_distance_km": total_dist,
                },
            )
            routes_updated += 1

    return {"status": "ok", "routes_updated": routes_updated}


@shared_task
def cleanup_old_data():
    """Prune old flight states and resolved anomalies."""
    from .models import FlightState, AnomalyEvent, SystemMetrics

    cutoff_states = timezone.now() - timedelta(days=7)
    cutoff_anomalies = timezone.now() - timedelta(days=30)
    cutoff_metrics = timezone.now() - timedelta(days=14)

    deleted_states = FlightState.objects.filter(timestamp__lt=cutoff_states).delete()
    deleted_anomalies = AnomalyEvent.objects.filter(
        detected_at__lt=cutoff_anomalies, is_active=False
    ).delete()
    deleted_metrics = SystemMetrics.objects.filter(
        timestamp__lt=cutoff_metrics
    ).delete()

    logger.info(
        "Cleanup: deleted %s states, %s anomalies, %s metrics",
        deleted_states, deleted_anomalies, deleted_metrics,
    )


@shared_task
def retrain_model():
    """Retrain the Isolation Forest on accumulated historical data."""
    from .models import FlightState
    from .services.anomaly_detector import train_model

    cutoff = timezone.now() - timedelta(days=3)
    states = FlightState.objects.filter(
        timestamp__gte=cutoff, on_ground=False
    ).values(
        "velocity", "baro_altitude", "vertical_rate", "true_track",
        "on_ground", "last_contact", "time_position",
    )[:50000]

    flight_dicts = list(states)
    if len(flight_dicts) >= 100:
        train_model(flight_dicts)
        logger.info("Model retrained on %d samples", len(flight_dicts))
    else:
        logger.info("Not enough data for retraining: %d samples", len(flight_dicts))


def _haversine(lat1, lon1, lat2, lon2):
    """Calculate distance in km between two coordinates."""
    import math
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@shared_task
def enrich_aircraft_metadata():
    """Backfill missing aircraft type/registration using local DB."""
    from .models import Aircraft
    from .services.aircraft_db import lookup_aircraft
    from django.db.models import Q

    # Find aircraft missing metadata that have been seen recently
    recent_cutoff = timezone.now() - timedelta(hours=24)
    missing_metadata = Aircraft.objects.filter(
        Q(aircraft_type="") | Q(registration="")
    ).filter(
        last_seen__gte=recent_cutoff
    ).order_by("-last_seen")[:500]

    updated_count = 0

    for aircraft in missing_metadata:
        info = lookup_aircraft(aircraft.icao24)
        if info and (info.get("aircraft_type") or info.get("registration")):
            aircraft.aircraft_type = info.get("aircraft_type", "")
            aircraft.registration = info.get("registration", "")
            aircraft.manufacturer = info.get("manufacturer", "")
            aircraft.owner = info.get("owner", "")
            aircraft.save(update_fields=["aircraft_type", "registration", "manufacturer", "owner"])
            updated_count += 1

    if updated_count > 0:
        logger.info("Enriched %d aircraft with metadata", updated_count)

    return {"status": "ok", "updated": updated_count}


# Import models for F expressions
from django.db import models
