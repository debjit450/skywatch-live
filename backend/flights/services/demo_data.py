"""Deterministic demo payloads for local review and staging smoke tests."""

from __future__ import annotations

import time
from datetime import timedelta

from django.utils import timezone


def build_demo_flight_payload(now_epoch: float | None = None) -> dict:
    now_epoch = now_epoch or time.time()
    base = [
        {
            "icao24": "a1b2c3",
            "callsign": "SKY101",
            "origin_country": "United States",
            "latitude": 40.6413,
            "longitude": -73.7781,
            "baro_altitude": 3100,
            "geo_altitude": 3180,
            "velocity": 145,
            "true_track": 72,
            "vertical_rate": 4.2,
            "squawk": "1200",
            "category": 5,
            "data_source": "demo",
        },
        {
            "icao24": "b2c3d4",
            "callsign": "MED770",
            "origin_country": "United States",
            "latitude": 34.0522,
            "longitude": -118.2437,
            "baro_altitude": 950,
            "geo_altitude": 990,
            "velocity": 118,
            "true_track": 282,
            "vertical_rate": -6.4,
            "squawk": "7700",
            "category": 3,
            "data_source": "demo",
        },
        {
            "icao24": "c3d4e5",
            "callsign": "OCEAN5",
            "origin_country": "Iceland",
            "latitude": 63.985,
            "longitude": -22.6056,
            "baro_altitude": 11200,
            "geo_altitude": 11310,
            "velocity": 245,
            "true_track": 244,
            "vertical_rate": 0.1,
            "squawk": "2000",
            "category": 4,
            "data_source": "satellite",
        },
        {
            "icao24": "d4e5f6",
            "callsign": "GLDR42",
            "origin_country": "Germany",
            "latitude": 50.1109,
            "longitude": 8.6821,
            "baro_altitude": 720,
            "geo_altitude": 745,
            "velocity": 34,
            "true_track": 188,
            "vertical_rate": 0.7,
            "squawk": None,
            "category": 1,
            "data_source": "ogn",
            "position_source": 3,
        },
    ]

    states = []
    for index, item in enumerate(base):
        state = {
            "time_position": now_epoch - index * 7,
            "last_contact": now_epoch - index * 5,
            "on_ground": False,
            "sensors": None,
            "spi": False,
            "position_source": item.get("position_source", 0),
            "ml_anomaly_score": -0.72 if item["icao24"] == "b2c3d4" else 0.04,
            "predicted_path": [],
            "prediction_confidence": 0.72,
            "source_confidence": 0.99,
            "source_provenance": [item["data_source"]],
            "source_conflicts": [],
            **item,
        }
        states.append(state)

    source_counts = {}
    for state in states:
        source_counts[state["data_source"]] = source_counts.get(state["data_source"], 0) + 1

    return {
        "time": int(now_epoch),
        "states": states,
        "flights": states,
        "authenticated": False,
        "source": "demo",
        "count": len(states),
        "source_counts": source_counts,
        "source_health": {
            key: {
                "status": "ok",
                "enabled": True,
                "confidence_score": 0.99 if key == "demo" else 0.78,
                "last_success_at": timezone.now().isoformat(),
                "consecutive_failures": 0,
            }
            for key in source_counts
        },
        "coverage": {
            "demo_mode": True,
            "public_sources_only": False,
            "description": "Deterministic sample aircraft and anomalies for offline review.",
        },
    }


def seed_demo_records():
    from flights.models import Aircraft, AnomalyEvent, FlightPosition, FlightState, MLModelVersion

    payload = build_demo_flight_payload()
    now = timezone.now()
    created = {"aircraft": 0, "states": 0, "positions": 0, "anomalies": 0}

    for index, state in enumerate(payload["states"]):
        aircraft, was_created = Aircraft.objects.update_or_create(
            icao24=state["icao24"],
            defaults={
                "callsign": state.get("callsign") or "",
                "origin_country": state.get("origin_country") or "",
                "last_seen": now - timedelta(seconds=index * 5),
                "category": state.get("category", 0),
                "data_source": state.get("data_source", "demo"),
            },
        )
        created["aircraft"] += int(was_created)
        timestamp = now - timedelta(seconds=index * 15)
        FlightState.objects.create(
            aircraft=aircraft,
            timestamp=timestamp,
            updated_at=timestamp,
            latitude=state["latitude"],
            longitude=state["longitude"],
            baro_altitude=state.get("baro_altitude"),
            geo_altitude=state.get("geo_altitude"),
            velocity=state.get("velocity"),
            vertical_rate=state.get("vertical_rate"),
            true_track=state.get("true_track"),
            squawk=state.get("squawk"),
            on_ground=False,
            spi=False,
            position_source=state.get("position_source", 0),
            last_contact=state["last_contact"],
            time_position=state["time_position"],
            category=state.get("category", 0),
            data_source=state.get("data_source", "demo"),
            ml_anomaly_score=state.get("ml_anomaly_score"),
        )
        created["states"] += 1
        FlightPosition.objects.create(
            aircraft=aircraft,
            timestamp=timestamp,
            latitude=state["latitude"],
            longitude=state["longitude"],
            altitude=state.get("baro_altitude"),
            velocity=state.get("velocity"),
            heading=state.get("true_track"),
            vertical_rate=state.get("vertical_rate"),
            data_source=state.get("data_source", "demo"),
        )
        created["positions"] += 1

    emergency = payload["states"][1]
    aircraft = Aircraft.objects.get(icao24=emergency["icao24"])
    event, was_created = AnomalyEvent.objects.update_or_create(
        aircraft=aircraft,
        anomaly_type="squawk_7700",
        is_active=True,
        defaults={
            "severity": "critical",
            "confidence_score": 99,
            "detector_type": "rule",
            "ml_score": emergency.get("ml_anomaly_score"),
            "details": {"squawk": "7700", "demo": True},
            "evidence": {"rule": "emergency_squawk", "observed": "7700"},
            "source_quality": {"source": "demo", "confidence_score": 0.99},
            "explanation": [
                {
                    "factor": "Emergency squawk",
                    "description": "Demo target is broadcasting transponder code 7700.",
                    "severity": "critical",
                }
            ],
            "detected_at": now,
            "latitude": emergency["latitude"],
            "longitude": emergency["longitude"],
            "altitude": emergency.get("baro_altitude"),
            "velocity": emergency.get("velocity"),
        },
    )
    created["anomalies"] += int(was_created)

    MLModelVersion.objects.update_or_create(
        model_name="iforest",
        version="demo-baseline",
        defaults={
            "detector_type": "statistical",
            "training_sample_count": 0,
            "metrics": {"demo": True},
            "thresholds": {"ml_anomaly": -0.55},
            "drift_indicators": {"status": "not_applicable"},
            "is_active": True,
            "trained_at": now,
        },
    )
    return created
