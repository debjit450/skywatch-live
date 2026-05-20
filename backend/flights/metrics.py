"""Prometheus metric handles with graceful fallback when not installed."""

from contextlib import contextmanager
from time import perf_counter

try:
    from prometheus_client import Counter, Gauge, Histogram

    active_flights_total = Gauge("skywatch_active_flights_total", "Current active flights")
    anomalies_detected_total = Counter(
        "skywatch_anomalies_detected_total", "Anomalies detected", ["severity"]
    )
    websocket_connections = Gauge("skywatch_websocket_connections", "Open WebSocket connections")
    data_ingestion_latency_seconds = Histogram(
        "skywatch_data_ingestion_latency_seconds", "Data ingestion latency"
    )
    cache_hits_total = Counter("skywatch_cache_hits_total", "Cache hits")
    cache_misses_total = Counter("skywatch_cache_misses_total", "Cache misses")
    celery_task_duration_seconds = Histogram(
        "skywatch_celery_task_duration_seconds", "Celery task duration", ["task_name"]
    )
except Exception:  # pragma: no cover - exercised only without prometheus_client
    class _NoopMetric:
        def labels(self, *args, **kwargs):
            return self

        def inc(self, *args, **kwargs):
            return None

        def dec(self, *args, **kwargs):
            return None

        def set(self, *args, **kwargs):
            return None

        def observe(self, *args, **kwargs):
            return None

    active_flights_total = _NoopMetric()
    anomalies_detected_total = _NoopMetric()
    websocket_connections = _NoopMetric()
    data_ingestion_latency_seconds = _NoopMetric()
    cache_hits_total = _NoopMetric()
    cache_misses_total = _NoopMetric()
    celery_task_duration_seconds = _NoopMetric()


@contextmanager
def task_timer(task_name):
    started = perf_counter()
    try:
        yield
    finally:
        celery_task_duration_seconds.labels(task_name=task_name).observe(perf_counter() - started)
