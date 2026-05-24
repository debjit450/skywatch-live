"""Source adapter contract, health tracking, and resilience helpers."""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Callable

from django.utils import timezone

SOURCE_BASE_CONFIDENCE = {
    "opensky": 0.96,
    "adsb_one": 0.9,
    "airplanes_live": 0.9,
    "adsb_lol": 0.86,
    "ogn": 0.82,
    "faa_radar": 0.78,
    "uat": 0.8,
    "satellite": 0.74,
    "demo": 0.99,
}


@dataclass
class SourceFetchResult:
    source: str
    status: str
    payload: Any
    duration_ms: int = 0
    aircraft_count: int = 0
    normalized_count: int = 0
    rejected_count: int = 0
    error: str = ""
    confidence_score: float = 0.0


def _count_payload(payload: Any) -> int:
    if payload is None:
        return 0
    if isinstance(payload, list):
        return len(payload)
    if isinstance(payload, dict):
        states = payload.get("states") or payload.get("aircraft") or payload.get("flights")
        if isinstance(states, list):
            return len(states)
    return 0


def _health_confidence(source: str, status: str, failures: int) -> float:
    base = SOURCE_BASE_CONFIDENCE.get(source, 0.72)
    if status == "ok":
        return base
    if status == "disabled":
        return 0.0
    if status in {"rate_limited", "circuit_open"}:
        return round(base * 0.35, 3)
    return round(max(0.05, base - min(0.55, failures * 0.12)), 3)


def run_source_fetch(
    source: str,
    fetcher: Callable[[], Any],
    *,
    enabled: bool = True,
    empty_value: Any = None,
    required: bool = False,
    circuit_breaker_failures: int = 3,
    circuit_breaker_seconds: int = 120,
    rate_limit_seconds: int = 120,
) -> SourceFetchResult:
    """Run a source fetch and persist health/audit state."""

    from flights.metrics import (
        source_aircraft_normalized_total,
        source_confidence,
        source_fetch_latency_seconds,
        source_fetch_total,
    )
    from flights.models import IngestionAudit, IngestionSourceHealth

    started_at = timezone.now()
    started_perf = time.perf_counter()
    empty = [] if empty_value is None else empty_value

    health, _ = IngestionSourceHealth.objects.get_or_create(source=source)
    if not enabled:
        health.enabled = False
        health.status = "disabled"
        health.confidence_score = 0.0
        health.save(update_fields=["enabled", "status", "confidence_score", "updated_at"])
        IngestionAudit.objects.create(source=source, started_at=started_at, finished_at=timezone.now(), status="disabled")
        source_fetch_total.labels(source=source, status="disabled").inc()
        return SourceFetchResult(source=source, status="disabled", payload=empty)

    now = timezone.now()
    if health.circuit_open_until and health.circuit_open_until > now:
        status = "circuit_open"
        confidence = _health_confidence(source, status, health.consecutive_failures)
        health.status = status
        health.confidence_score = confidence
        health.save(update_fields=["status", "confidence_score", "updated_at"])
        IngestionAudit.objects.create(
            source=source,
            started_at=started_at,
            finished_at=now,
            status=status,
            error=f"circuit open until {health.circuit_open_until.isoformat()}",
        )
        source_fetch_total.labels(source=source, status=status).inc()
        if required:
            raise RuntimeError(f"{source} circuit breaker is open")
        return SourceFetchResult(source=source, status=status, payload=empty, confidence_score=confidence)

    try:
        payload = fetcher()
        duration_seconds = time.perf_counter() - started_perf
        duration_ms = int(duration_seconds * 1000)

        if payload is None:
            status = "rate_limited"
            count = 0
            health.consecutive_failures += 1
            health.rate_limited_until = timezone.now() + timedelta(seconds=rate_limit_seconds)
            health.last_error_at = timezone.now()
            health.last_error = "source returned no payload; treated as rate limited or skipped"
        else:
            status = "ok"
            count = _count_payload(payload)
            health.consecutive_failures = 0
            health.last_success_at = timezone.now()
            health.last_error = ""
            health.rate_limited_until = None
            health.circuit_open_until = None

        confidence = _health_confidence(source, status, health.consecutive_failures)
        health.enabled = True
        health.status = status
        health.confidence_score = confidence
        health.latency_ms = duration_ms
        health.aircraft_count = count
        health.normalized_count = count
        health.rejected_count = 0
        health.save()

        IngestionAudit.objects.create(
            source=source,
            started_at=started_at,
            finished_at=timezone.now(),
            duration_ms=duration_ms,
            status=status,
            aircraft_count=count,
            normalized_count=count,
            metadata={"required": required},
        )
        source_fetch_total.labels(source=source, status=status).inc()
        source_fetch_latency_seconds.labels(source=source).observe(duration_seconds)
        source_aircraft_normalized_total.labels(source=source).inc(count)
        source_confidence.labels(source=source).set(confidence)

        if payload is None and required:
            raise RuntimeError(f"{source} returned no payload")

        return SourceFetchResult(
            source=source,
            status=status,
            payload=payload if payload is not None else empty,
            duration_ms=duration_ms,
            aircraft_count=count,
            normalized_count=count,
            confidence_score=confidence,
        )
    except Exception as exc:
        duration_seconds = time.perf_counter() - started_perf
        duration_ms = int(duration_seconds * 1000)
        health.consecutive_failures += 1
        status = "error"
        if health.consecutive_failures >= circuit_breaker_failures:
            status = "circuit_open"
            health.circuit_open_until = timezone.now() + timedelta(seconds=circuit_breaker_seconds)
        confidence = _health_confidence(source, status, health.consecutive_failures)
        health.enabled = True
        health.status = status
        health.confidence_score = confidence
        health.last_error_at = timezone.now()
        health.last_error = str(exc)[:2000]
        health.latency_ms = duration_ms
        health.save()
        IngestionAudit.objects.create(
            source=source,
            started_at=started_at,
            finished_at=timezone.now(),
            duration_ms=duration_ms,
            status=status,
            error=str(exc)[:4000],
            metadata={"required": required},
        )
        source_fetch_total.labels(source=source, status=status).inc()
        source_fetch_latency_seconds.labels(source=source).observe(duration_seconds)
        source_confidence.labels(source=source).set(confidence)
        if required:
            raise
        return SourceFetchResult(
            source=source,
            status=status,
            payload=empty,
            duration_ms=duration_ms,
            error=str(exc),
            confidence_score=confidence,
        )


def source_health_payload() -> dict[str, dict[str, Any]]:
    from flights.models import IngestionSourceHealth
    from flights.metrics import source_confidence, source_staleness_seconds

    payload: dict[str, dict[str, Any]] = {}
    now = timezone.now()
    for item in IngestionSourceHealth.objects.all():
        if item.last_success_at:
            source_staleness_seconds.labels(source=item.source).set(
                max(0, (now - item.last_success_at).total_seconds())
            )
        source_confidence.labels(source=item.source).set(item.confidence_score)
        payload[item.source] = {
            "status": item.status,
            "enabled": item.enabled,
            "confidence_score": item.confidence_score,
            "last_success_at": item.last_success_at.isoformat() if item.last_success_at else None,
            "last_error_at": item.last_error_at.isoformat() if item.last_error_at else None,
            "last_error": item.last_error,
            "consecutive_failures": item.consecutive_failures,
            "rate_limited_until": item.rate_limited_until.isoformat() if item.rate_limited_until else None,
            "circuit_open_until": item.circuit_open_until.isoformat() if item.circuit_open_until else None,
            "latency_ms": item.latency_ms,
            "aircraft_count": item.aircraft_count,
            "normalized_count": item.normalized_count,
            "rejected_count": item.rejected_count,
            "updated_at": item.updated_at.isoformat() if item.updated_at else None,
        }
    return payload


def annotate_state_source_quality(states: list[dict[str, Any]], health: dict[str, dict[str, Any]] | None = None) -> None:
    health = health or source_health_payload()
    for state in states:
        source = state.get("data_source") or "unknown"
        source_health = health.get(source, {})
        state["source_confidence"] = source_health.get(
            "confidence_score",
            SOURCE_BASE_CONFIDENCE.get(source, 0.72),
        )
        state.setdefault("source_provenance", [source])
        state.setdefault("source_conflicts", [])
