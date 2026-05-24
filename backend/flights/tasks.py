"""
Celery tasks for periodic data ingestion, anomaly detection,
route building, and model retraining.
"""

import logging
import os
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


def _state_source(state):
    source = state.get("data_source") if isinstance(state, dict) else None
    return source or "unknown"


def _position_delta_km(left, right):
    if not isinstance(left, dict) or not isinstance(right, dict):
        return None
    lat1 = left.get("latitude")
    lon1 = left.get("longitude")
    lat2 = right.get("latitude")
    lon2 = right.get("longitude")
    if not all(isinstance(value, (int, float)) for value in (lat1, lon1, lat2, lon2)):
        return None
    return _haversine(lat1, lon1, lat2, lon2)


def _merge_state_metadata(existing, candidate):
    provenance = set(existing.get("source_provenance") or [_state_source(existing)])
    provenance.add(_state_source(candidate))
    conflicts = list(existing.get("source_conflicts") or [])
    distance_km = _position_delta_km(existing, candidate)
    last_contact_delta = abs(_last_contact_value(existing) - _last_contact_value(candidate))
    if distance_km is not None and (distance_km > 8 or last_contact_delta > 45):
        conflicts.append({
            "existing_source": _state_source(existing),
            "candidate_source": _state_source(candidate),
            "distance_km": round(distance_km, 3),
            "last_contact_delta_seconds": round(last_contact_delta, 1),
        })
    existing["source_provenance"] = sorted(provenance)
    existing["source_conflicts"] = conflicts[-5:]
    return existing


def _merge_flight_states(opensky_states, supplemental_states):
    """Merge OpenSky and supplemental states, keeping newest last_contact per ICAO24."""
    merged_by_icao = {}
    opensky_icaos = set()
    conflict_count = 0

    for state in opensky_states:
        if not isinstance(state, dict):
            continue
        icao24 = _normalize_icao24(state.get("icao24"))
        if not icao24:
            continue
        state["icao24"] = icao24
        state["source_provenance"] = state.get("source_provenance") or [_state_source(state)]
        state["source_conflicts"] = state.get("source_conflicts") or []
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
        state["source_provenance"] = state.get("source_provenance") or [_state_source(state)]
        state["source_conflicts"] = state.get("source_conflicts") or []
        if existing is None:
            merged_by_icao[icao24] = state
        else:
            before = len(existing.get("source_conflicts") or [])
            _merge_state_metadata(existing, state)
            conflict_count += max(0, len(existing.get("source_conflicts") or []) - before)
            if _last_contact_value(state) > _last_contact_value(existing):
                state = _merge_state_metadata(state, existing)
                merged_by_icao[icao24] = state

    net_new = sum(1 for icao24 in merged_by_icao if icao24 not in opensky_icaos)
    return list(merged_by_icao.values()), net_new, conflict_count


def _broadcast_to_flights(event_type, data):
    """Send an event to connected flight WebSocket clients."""
    try:
        data = dict(data or {})
        data.setdefault("sequence", _next_stream_sequence())
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


def _next_stream_sequence():
    try:
        from django.core.cache import cache

        key = "skywatch:stream:sequence"
        try:
            return cache.incr(key)
        except ValueError:
            cache.set(key, 1, timeout=None)
            return 1
    except Exception:
        return int(time.time() * 1000)


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
            "source_counts": result.get("source_counts", {}),
            "source_health": result.get("source_health", {}),
            "source_conflict_count": result.get("source_conflict_count", 0),
            "degraded": result.get("degraded", False),
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
        "detector_type": event.detector_type,
        "evidence": event.evidence,
        "source_quality": event.source_quality,
        "source": event.source,
        "explanation": event.explanation,
        "detected_at": event.detected_at.isoformat(),
        "resolved_at": event.resolved_at.isoformat() if event.resolved_at else None,
        "is_active": event.is_active,
        "latitude": event.latitude,
        "longitude": event.longitude,
        "altitude": event.altitude,
        "velocity": event.velocity,
    }


def _detector_type_for_anomaly(anomaly):
    source = anomaly.get("source", "")
    anomaly_type = anomaly.get("type", "")
    if source == "custom_rule":
        return "custom"
    if anomaly_type == "ml_anomaly":
        return "ml"
    if source in {"advanced", "behavioral"} or anomaly_type in {"circling", "proximity", "trajectory_deviation", "behavioral"}:
        return "statistical"
    if anomaly.get("ml_score") is not None:
        return "ensemble"
    return "rule"


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
    from .services.adsb_sources import (
        fetch_adsb_lol_states,
        fetch_adsb_one_states,
        fetch_airplanes_live_states,
    )
    from .services.cache import increment_api_calls
    from .models import Aircraft, FlightState, FlightPosition, IngestionAudit
    from .metrics import active_flights_total, data_ingestion_latency_seconds
    from .services.demo_data import build_demo_flight_payload
    from .services.source_adapters import (
        annotate_state_source_quality,
        run_source_fetch,
        source_health_payload,
    )

    try:
        increment_api_calls()
        if getattr(settings, "SKYWATCH_DEMO_MODE", False):
            result = build_demo_flight_payload()
            run_source_fetch("demo", lambda: result, empty_value={"states": []})
        else:
            outcome = run_source_fetch(
                "opensky",
                fetch_all_states,
                empty_value={"states": []},
                required=True,
                circuit_breaker_failures=2,
            )
            result = outcome.payload
        if result is None or not isinstance(result, dict):
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
        if not getattr(settings, "SKYWATCH_DEMO_MODE", False):
            source_specs = [
                ("adsb_one", "ADSB-One", getattr(settings, "ADSBONE_ENABLED", True), fetch_adsb_one_states),
                ("airplanes_live", "Airplanes.live", getattr(settings, "AIRPLANESLIVE_ENABLED", True), fetch_airplanes_live_states),
                ("adsb_lol", "ADSB.lol", getattr(settings, "ADSBLOL_ENABLED", True), fetch_adsb_lol_states),
            ]
            for source_key, source_label, enabled, fetcher in source_specs:
                outcome = run_source_fetch(source_key, fetcher, enabled=enabled, empty_value=[])
                source_states = outcome.payload if isinstance(outcome.payload, list) else []
                logger.info("%s returned %d aircraft (%s)", source_label, len(source_states), outcome.status)
                supplemental_states.extend(source_states)

        # ── OGN / FLARM (gliders, small aircraft) ──
        if not getattr(settings, "SKYWATCH_DEMO_MODE", False):
            from .services.faa_radar import fetch_faa_radar_states
            from .services.ogn_client import fetch_ogn_states
            from .services.satellite_adsb import fetch_satellite_adsb_states
            from .services.uat_client import fetch_uat_states

            specialty_specs = [
                ("ogn", "OGN/FLARM", getattr(settings, "OGN_ENABLED", True), fetch_ogn_states),
                ("faa_radar", "FAA/Mil radar", getattr(settings, "FAA_RADAR_ENABLED", True), fetch_faa_radar_states),
                ("uat", "UAT", getattr(settings, "UAT_ENABLED", True), fetch_uat_states),
                ("satellite", "Satellite ADS-B", getattr(settings, "SATELLITE_ADSB_ENABLED", True), fetch_satellite_adsb_states),
            ]
            for source_key, source_label, enabled, fetcher in specialty_specs:
                outcome = run_source_fetch(source_key, fetcher, enabled=enabled, empty_value=[])
                source_states = outcome.payload if isinstance(outcome.payload, list) else []
                logger.info("%s returned %d aircraft (%s)", source_label, len(source_states), outcome.status)
                supplemental_states.extend(source_states)

        # ── FAA / Military radar ──
        # specialty sources are fetched through run_source_fetch above

        # ── UAT (978 MHz, US GA traffic) ──
        # UAT is fetched through run_source_fetch above

        # ── Satellite ADS-B (oceanic) ──
        # Satellite ADS-B is fetched through run_source_fetch above

        if supplemental_states:
            states, net_new, conflict_count = _merge_flight_states(states, supplemental_states)
            result["states"] = states
        else:
            net_new = 0
            conflict_count = 0

        logger.info("All supplemental sources added %d net new aircraft after dedup", net_new)
        if conflict_count:
            logger.info("Detected %d source conflicts during deduplication", conflict_count)

        # ── Aggregate source counts ──
        source_counts = {}
        for s in states:
            src = s.get("data_source") or "unknown"
            source_counts[src] = source_counts.get(src, 0) + 1
        result["source_counts"] = source_counts
        health_payload = source_health_payload()
        annotate_state_source_quality(states, health_payload)
        result["source_health"] = health_payload
        result["source_conflict_count"] = conflict_count
        result["degraded"] = any(
            item.get("status") not in {"ok", "disabled"}
            for item in health_payload.values()
        )
        logger.info("Source breakdown: %s", source_counts)

        now = timezone.now()
        bulk_states = []
        bulk_positions = []
        aircraft_updates = {}
        ingest_started = time.perf_counter()

        from .services.aircraft_db import lookup_aircraft

        for s in states:
            icao24 = s["icao24"]
            ds = s.get("data_source") or ""

            # Enrich flight state in the list with aircraft details for the frontend
            info = lookup_aircraft(icao24)
            if info:
                s["aircraft_type"] = info.get("aircraft_type") or ""
                s["registration"] = info.get("registration") or ""

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
                updated_at=now,
                status="ground" if s.get("on_ground", False) else "active",
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
            if s.get("latitude") is not None and s.get("longitude") is not None:
                bulk_positions.append(FlightPosition(
                    aircraft_id=icao24,
                    timestamp=now,
                    latitude=s.get("latitude"),
                    longitude=s.get("longitude"),
                    altitude=s.get("baro_altitude") if s.get("baro_altitude") is not None else s.get("geo_altitude"),
                    velocity=s.get("velocity"),
                    heading=s.get("true_track"),
                    vertical_rate=s.get("vertical_rate"),
                    on_ground=s.get("on_ground", False),
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
            if bulk_positions:
                FlightPosition.objects.bulk_create(bulk_positions, ignore_conflicts=True, batch_size=1000)

            # Update total_states count
            if aircraft_updates:
                Aircraft.objects.filter(
                    icao24__in=list(aircraft_updates.keys())
                ).update(total_states=models.F("total_states") + 1)

            transaction.on_commit(lambda: _after_flight_ingest_commit(result, len(bulk_states)))

        logger.info("Stored %d flight states from %d sources", len(bulk_states), len(source_counts))
        active_flights_total.set(len(states))
        data_ingestion_latency_seconds.observe(time.perf_counter() - ingest_started)
        IngestionAudit.objects.create(
            source="merged",
            started_at=now,
            finished_at=timezone.now(),
            duration_ms=int((time.perf_counter() - ingest_started) * 1000),
            status="ok",
            aircraft_count=len(states),
            normalized_count=len(bulk_states),
            rejected_count=0,
            metadata={"source_counts": source_counts, "conflict_count": conflict_count},
        )

        return {
            "status": "ok",
            "count": len(bulk_states),
            "sources": source_counts,
            "source_conflict_count": conflict_count,
            "degraded": result["degraded"],
        }

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
    lstm_scores = {}
    lstm_available = False
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

        try:
            from ml.lstm import build_sequence, score_sequences

            lstm_icaos = list(active_icaos)[:50]
            sequences = []
            sequence_icaos = []
            for icao24 in lstm_icaos:
                history = list(
                    FlightState.objects.filter(aircraft_id=icao24)
                    .order_by("-timestamp")
                    .only("baro_altitude", "geo_altitude", "velocity", "true_track", "vertical_rate")[:30]
                )
                if history:
                    sequences.append(build_sequence(list(reversed(history))))
                    sequence_icaos.append(icao24)
            scores = score_sequences(sequences)
            lstm_available = bool(scores)
            lstm_scores = dict(zip(sequence_icaos, scores))
        except Exception as exc:
            logger.debug("LSTM anomaly scoring unavailable: %s", exc)

    # Fetch active anomalies mapping before transaction
    active_event_map = {}
    if active_icaos:
        active_events_qs = AnomalyEvent.objects.filter(
            aircraft_id__in=active_icaos, is_active=True
        ).values("id", "aircraft_id", "anomaly_type", "confidence_score", "ml_score", "details", "explanation", "detected_at")

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
            lstm_score = lstm_scores.get(icao24)
            flight["ml_anomaly_score"] = ml_score

            latest_state = latest_states.get(icao24)
            if latest_state and latest_state.ml_anomaly_score != ml_score:
                latest_state.ml_anomaly_score = ml_score
                states_to_update.append(latest_state)

            # Core detection (Rule-based + ML Ensemble)
            anomalies = detect_all(flight, now_epoch, ml_score=ml_score)
            if lstm_available and ml_score is not None:
                # Ensemble policy: both models agree, or Isolation Forest is extreme.
                lstm_flags = lstm_score is not None and lstm_score < -0.08
                if anomalies and not (lstm_flags or ml_score < -0.3):
                    anomalies = [
                        anomaly for anomaly in anomalies
                        if anomaly["type"].startswith("squawk_") or anomaly["severity"] == "critical"
                    ]

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
                    update_obj.isolation_score = ml_score
                    update_obj.lstm_score = lstm_score
                    update_obj.combined_score = (
                        ((ml_score or 0) + (lstm_score or 0)) / 2 if lstm_score is not None else ml_score
                    )
                    update_obj.detector_type = _detector_type_for_anomaly(anomaly)
                    update_obj.details = anomaly.get("details", existing_dict.get("details", {}))
                    update_obj.evidence = anomaly.get("evidence", anomaly.get("details", {}))
                    update_obj.source_quality = {
                        "source": flight.get("data_source") or "unknown",
                        "confidence_score": flight.get("source_confidence"),
                        "provenance": flight.get("source_provenance", []),
                        "conflicts": flight.get("source_conflicts", []),
                    }
                    update_obj.explanation = anomaly.get("explanation", existing_dict.get("explanation", []))
                    anomalies_to_update.append(update_obj)
                else:
                    recent_history = []
                    if icao24 in latest_states:
                        recent_history = [latest_states[icao24]]
                    from .services.explainability import explain_anomaly

                    explanation = explain_anomaly(flight, anomaly, recent_history)
                    anomalies_to_create.append(AnomalyEvent(
                        aircraft_id=icao24,
                        anomaly_type=anomaly["type"],
                        severity=anomaly.get("severity", "medium"),
                        confidence_score=anomaly.get("confidence_score", 0),
                        detector_type=_detector_type_for_anomaly(anomaly),
                        ml_score=anomaly.get("ml_score", ml_score),
                        isolation_score=ml_score,
                        lstm_score=lstm_score,
                        combined_score=((ml_score or 0) + (lstm_score or 0)) / 2 if lstm_score is not None else ml_score,
                        explanation=explanation,
                        source=anomaly.get("source", "detector"),
                        details=anomaly.get("details", {}),
                        evidence=anomaly.get("evidence", anomaly.get("details", {})),
                        source_quality={
                            "source": flight.get("data_source") or "unknown",
                            "confidence_score": flight.get("source_confidence"),
                            "provenance": flight.get("source_provenance", []),
                            "conflicts": flight.get("source_conflicts", []),
                        },
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
                [
                    "confidence_score",
                    "ml_score",
                    "isolation_score",
                    "lstm_score",
                    "combined_score",
                    "detector_type",
                    "details",
                    "evidence",
                    "source_quality",
                    "explanation",
                ],
                batch_size=1000,
            )

        if anomalies_to_create:
            created_events = AnomalyEvent.objects.bulk_create(
                anomalies_to_create,
                batch_size=1000,
            )
            new_events.extend(created_events)
            from .metrics import anomalies_detected_total

            for event in created_events:
                anomalies_detected_total.labels(severity=event.severity).inc()
                logger.info(
                    "anomaly_detected",
                    extra={
                        "flight_id": event.aircraft_id,
                        "score": event.combined_score,
                        "severity": event.severity,
                        "model": "iforest+lstm" if event.lstm_score is not None else "iforest",
                    },
                )

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
        .values_list("aircraft_id", flat=True)[:10000]
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
    from django.conf import settings
    from .models import FlightState, FlightPosition, AnomalyEvent, SystemMetrics, IngestionAudit

    cutoff_states = timezone.now() - timedelta(days=getattr(settings, "FLIGHT_STATE_RETENTION_DAYS", 7))
    cutoff_positions = timezone.now() - timedelta(days=getattr(settings, "FLIGHT_POSITION_RETENTION_DAYS", 7))
    cutoff_anomalies = timezone.now() - timedelta(days=getattr(settings, "RESOLVED_ANOMALY_RETENTION_DAYS", 30))
    cutoff_metrics = timezone.now() - timedelta(days=getattr(settings, "SYSTEM_METRICS_RETENTION_DAYS", 14))
    cutoff_audits = timezone.now() - timedelta(days=14)

    deleted_states = FlightState.objects.filter(timestamp__lt=cutoff_states).delete()
    deleted_positions = FlightPosition.objects.filter(timestamp__lt=cutoff_positions).delete()
    deleted_anomalies = AnomalyEvent.objects.filter(
        detected_at__lt=cutoff_anomalies, is_active=False
    ).delete()
    deleted_metrics = SystemMetrics.objects.filter(
        timestamp__lt=cutoff_metrics
    ).delete()
    deleted_audits = IngestionAudit.objects.filter(started_at__lt=cutoff_audits).delete()

    logger.info(
        "Cleanup: deleted %s states, %s positions, %s anomalies, %s metrics, %s audits",
        deleted_states, deleted_positions, deleted_anomalies, deleted_metrics, deleted_audits,
    )


@shared_task
def retrain_model():
    """Retrain the Isolation Forest on accumulated historical data."""
    from .models import FlightState, AnomalyEvent
    from .services.anomaly_detector import train_model

    cutoff = timezone.now() - timedelta(days=3)
    false_positive_icaos = AnomalyEvent.objects.filter(
        feedback="false_positive",
        detected_at__gte=cutoff,
    ).values_list("aircraft_id", flat=True)
    states = FlightState.objects.filter(
        timestamp__gte=cutoff, on_ground=False
    ).exclude(aircraft_id__in=false_positive_icaos).values(
        "velocity", "baro_altitude", "vertical_rate", "true_track",
        "on_ground", "last_contact", "time_position",
    )[:50000]

    flight_dicts = list(states)
    if len(flight_dicts) >= 100:
        train_model(flight_dicts)
        logger.info("Model retrained on %d samples", len(flight_dicts))
    else:
        logger.info("Not enough data for retraining: %d samples", len(flight_dicts))


@shared_task
def retrain_lstm_model():
    """Periodically retrain the optional LSTM sequence autoencoder if TensorFlow/Keras is installed."""
    try:
        import numpy as np
        from tensorflow import keras
    except Exception:
        logger.info("TensorFlow/Keras is not installed; skipped LSTM auto-retraining.")
        return {"status": "skipped", "reason": "no_tensorflow"}

    from .models import FlightState
    from ml.lstm import FEATURE_COUNT, SEQUENCE_LENGTH, build_sequence, model_path
    
    cutoff = timezone.now() - timedelta(days=14)
    aircraft_ids = (
        FlightState.objects.filter(timestamp__gte=cutoff, on_ground=False)
        .values_list("aircraft_id", flat=True)
        .distinct()[:500]
    )

    sequences = []
    for aircraft_id in aircraft_ids:
        states = list(
            FlightState.objects.filter(aircraft_id=aircraft_id, timestamp__gte=cutoff)
            .order_by("timestamp")
            .only("baro_altitude", "geo_altitude", "velocity", "true_track", "vertical_rate")
        )
        for index in range(SEQUENCE_LENGTH, len(states) + 1, SEQUENCE_LENGTH):
            sequences.append(build_sequence(states[index - SEQUENCE_LENGTH:index]))

    if len(sequences) < 50:
        logger.info("Not enough sequences for LSTM auto-retraining: %d", len(sequences))
        return {"status": "skipped", "reason": "not_enough_sequences"}

    x = np.asarray(sequences, dtype="float32")
    model = keras.Sequential([
        keras.layers.Input(shape=(SEQUENCE_LENGTH, FEATURE_COUNT)),
        keras.layers.LSTM(16, return_sequences=False),
        keras.layers.RepeatVector(SEQUENCE_LENGTH),
        keras.layers.LSTM(16, return_sequences=True),
        keras.layers.TimeDistributed(keras.layers.Dense(FEATURE_COUNT)),
    ])
    model.compile(optimizer="adam", loss="mse")
    model.fit(x, x, epochs=3, batch_size=64, validation_split=0.1, verbose=0)

    path = model_path()
    from pathlib import Path
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    model.save(path)
    logger.info("Successfully auto-retrained LSTM model on %d sequences and saved to %s", len(sequences), path)
    return {"status": "ok", "sequences": len(sequences)}


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
    """Backfill missing aircraft type/registration and flight origin/destination metadata."""
    from .models import Aircraft, FlightState
    from .services.aircraft_db import lookup_aircraft
    from .services.opensky import fetch_aircraft_flights
    from django.db.models import Q
    import time

    # 1. Backfill missing aircraft physical metadata (registration, type)
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
            from .services.cache import invalidate_aircraft_metadata

            invalidate_aircraft_metadata(aircraft.icao24)
            updated_count += 1

    if updated_count > 0:
        logger.info("Enriched %d aircraft with physical metadata", updated_count)

    # 2. Backfill missing flight route origin/destination airports
    route_enriched_count = 0
    recent_states = FlightState.objects.filter(
        timestamp__gte=timezone.now() - timedelta(hours=2),
        origin_airport="",
        destination_airport=""
    ).only("aircraft_id", "timestamp").order_by("-timestamp")

    if recent_states.exists():
        # Get distinct active aircraft hexes that are missing route metadata
        icao_hexes = list(dict.fromkeys([fs.aircraft_id for fs in recent_states]))
        
        # Pull cache lookup guards
        from .services.cache import _get_json, _set_json
        
        # Query at most 2 distinct aircraft per execution of this background task (runs every 15s)
        candidates = []
        for icao24 in icao_hexes:
            cache_key = f"opensky:route_lookup:{icao24}"
            if _get_json(cache_key):
                continue
            candidates.append(icao24)
            if len(candidates) >= 2:
                break
                
        for icao24 in candidates:
            # Set cache query guard for 15 minutes to avoid redundant API thrashing
            cache_key = f"opensky:route_lookup:{icao24}"
            _set_json(cache_key, True, 900)
            
            end_ts = int(time.time())
            begin_ts = end_ts - 2 * 3600
            
            flights = fetch_aircraft_flights(icao24, begin_ts, end_ts)
            if flights:
                # Retrieve the latest flight record
                latest_flight = flights[-1]
                origin = latest_flight.get("estDepartureAirport") or ""
                destination = latest_flight.get("estArrivalAirport") or ""
                
                if origin or destination:
                    updated = FlightState.objects.filter(
                        aircraft_id=icao24,
                        timestamp__gte=timezone.now() - timedelta(hours=2),
                        origin_airport="",
                        destination_airport=""
                    ).update(origin_airport=origin, destination_airport=destination)
                    route_enriched_count += updated

        if route_enriched_count > 0:
            logger.info("Enriched %d flight states with origin/destination airports", route_enriched_count)

    return {
        "status": "ok",
        "updated_aircraft": updated_count,
        "updated_routes": route_enriched_count
    }


@shared_task
def update_flight_predictions():
    """Update short-horizon predicted paths for recently active flights."""
    from .models import FlightState
    from .services.cache import get_current_flights, set_current_flights
    from .services.prediction import build_predicted_path

    now = timezone.now()
    cutoff = now - timedelta(minutes=5)
    active_icaos = list(
        FlightState.objects.filter(timestamp__gte=cutoff, on_ground=False)
        .values_list("aircraft_id", flat=True)
        .distinct()[:2000]
    )
    updated = []
    prediction_by_icao = {}
    for icao24 in active_icaos:
        states = list(
            FlightState.objects.filter(aircraft_id=icao24)
            .order_by("-timestamp")
            .only(
                "id",
                "aircraft_id",
                "timestamp",
                "latitude",
                "longitude",
                "baro_altitude",
                "geo_altitude",
                "velocity",
                "vertical_rate",
                "true_track",
                "on_ground",
            )[:3]
        )
        if not states:
            continue
        path, confidence = build_predicted_path(states, now)
        latest = states[0]
        latest.predicted_path = path
        latest.prediction_confidence = confidence
        updated.append(latest)
        prediction_by_icao[icao24] = (path, confidence)

    if updated:
        FlightState.objects.bulk_update(updated, ["predicted_path", "prediction_confidence"], batch_size=1000)

    cached = get_current_flights()
    if cached and isinstance(cached.get("states"), list):
        for state in cached["states"]:
            values = prediction_by_icao.get(state.get("icao24"))
            if values:
                state["predicted_path"], state["prediction_confidence"] = values
        set_current_flights(cached)

    return {"status": "ok", "updated": len(updated)}


def _point_in_polygon(lat, lon, polygon):
    inside = False
    ring = polygon[0] if polygon and isinstance(polygon[0], list) else polygon
    if not ring:
        return False
    j = len(ring) - 1
    for i, point in enumerate(ring):
        xi, yi = point[0], point[1]
        xj, yj = ring[j][0], ring[j][1]
        intersects = (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / max(yj - yi, 1e-9) + xi
        if intersects:
            inside = not inside
        j = i
    return inside


@shared_task
def evaluate_custom_alert_rules():
    """Evaluate active custom rules against cached active flights."""
    from .models import AlertRule, AnomalyEvent
    from .services.cache import get_current_flights

    started = time.perf_counter()
    data = get_current_flights() or {}
    flights = data.get("states", []) if isinstance(data.get("states"), list) else []
    if not flights:
        return {"status": "empty"}

    created = []
    rules = list(AlertRule.objects.filter(active=True).select_related("user")[:200])
    now = timezone.now()
    for rule in rules:
        config = rule.config or {}
        for flight in flights[:2000]:
            icao24 = flight.get("icao24")
            if not icao24:
                continue
            triggered = False
            details = {"rule_id": rule.id, "rule_name": rule.name}

            if rule.type == "threshold":
                field = config.get("field")
                operator = config.get("operator")
                value = config.get("value")
                field_map = {
                    "altitude": flight.get("baro_altitude"),
                    "speed": flight.get("velocity"),
                    "vrate": flight.get("vertical_rate"),
                }
                observed = field_map.get(field)
                if isinstance(observed, (int, float)) and isinstance(value, (int, float)):
                    triggered = observed > value if operator == "gt" else observed < value if operator == "lt" else False
                    details.update({"field": field, "operator": operator, "value": value, "observed": observed})
            elif rule.type == "geofence":
                lat = flight.get("latitude")
                lon = flight.get("longitude")
                polygon = (config.get("polygon") or {}).get("coordinates")
                triggered = isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and _point_in_polygon(lat, lon, polygon)
                details.update({"trigger_on": config.get("trigger_on", "enter")})

            if not triggered:
                continue
            if AnomalyEvent.objects.filter(
                aircraft_id=icao24,
                alert_rule=rule,
                is_active=True,
                detected_at__gte=now - timedelta(minutes=10),
            ).exists():
                continue
            created.append(AnomalyEvent(
                aircraft_id=icao24,
                anomaly_type="custom_rule",
                severity="medium",
                confidence_score=90.0,
                detector_type="custom",
                source="custom_rule",
                alert_rule=rule,
                details=details,
                evidence={"rule": rule.name, "config": config, "observed": details.get("observed")},
                source_quality={
                    "source": flight.get("data_source") or "unknown",
                    "confidence_score": flight.get("source_confidence"),
                    "provenance": flight.get("source_provenance", []),
                    "conflicts": flight.get("source_conflicts", []),
                },
                explanation=[{
                    "factor": rule.name,
                    "value": details.get("observed"),
                    "deviation": "custom rule matched",
                    "description": f"Custom alert rule '{rule.name}' matched this flight.",
                    "severity": "medium",
                }],
                detected_at=now,
                latitude=flight.get("latitude"),
                longitude=flight.get("longitude"),
                altitude=flight.get("baro_altitude"),
                velocity=flight.get("velocity"),
            ))
            if time.perf_counter() - started > 0.1:
                break
        if time.perf_counter() - started > 0.1:
            break

    if created:
        AnomalyEvent.objects.bulk_create(created, batch_size=100)
        _publish_anomaly_alert(created)
    return {"status": "ok", "created": len(created), "elapsed_ms": round((time.perf_counter() - started) * 1000, 2)}


@shared_task
def refresh_tfr_cache():
    from .services.airspace_restrictions import refresh_airspace_restrictions

    payload = refresh_airspace_restrictions()
    return {"status": "ok", "features": len(payload.get("features", []))}


@shared_task
def synthetic_health_check():
    import requests

    from django.conf import settings

    url = os.environ.get("SYNTHETIC_HEALTH_URL", "http://localhost:8000/health/ready")
    key = "synthetic:health:failures"
    try:
        response = requests.get(url, timeout=5)
        ok = response.status_code == 200
    except Exception:
        ok = False

    from .services.cache import _get_redis

    redis = _get_redis()
    failures = 0
    if redis:
        failures = int(redis.get(key) or 0)
        failures = 0 if ok else failures + 1
        redis.setex(key, 3600, failures)
    logger.info("synthetic_health_check", extra={"status": "ok" if ok else "failed"})
    if failures >= 3:
        logger.error("synthetic_health_alert", extra={"status": "failed", "failures": failures})
    return {"status": "ok" if ok else "failed", "failures": failures}


# Import models for F expressions
from django.db import models
