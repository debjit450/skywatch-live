"""SkyWatch URL configuration."""

import base64
import os
import secrets
from datetime import timedelta

from celery import current_app
from django.conf import settings
from django.contrib import admin
from django.core.cache import cache
from django.db import connection
from django.http import HttpResponse, JsonResponse
from django.urls import path, include
from django.utils import timezone
from flights import views as flight_views


def healthz(_request):
    """Liveness probe that avoids downstream dependencies."""
    return JsonResponse({"status": "ok"})


def health_live(_request):
    return JsonResponse({"status": "ok"})


def readyz(_request):
    """Readiness probe for runtime dependencies used by the API process."""
    checks = {"database": "ok", "cache": "ok"}
    status_code = 200

    try:
        connection.ensure_connection()
    except Exception:
        checks["database"] = "error"
        status_code = 503

    try:
        cache_key = "skywatch:readyz"
        cache.set(cache_key, "ok", timeout=5)
        if cache.get(cache_key) != "ok":
            raise RuntimeError("cache round trip failed")
    except Exception:
        checks["cache"] = "error"
        status_code = 503

    return JsonResponse(
        {"status": "ok" if status_code == 200 else "error", "checks": checks},
        status=status_code,
    )


def health_ready(_request):
    checks = {"database": "ok", "redis": "ok", "celery": "ok"}
    status_code = 200

    try:
        connection.ensure_connection()
    except Exception as exc:
        checks["database"] = str(exc)
        status_code = 503

    try:
        cache_key = "skywatch:health:ready"
        cache.set(cache_key, "ok", timeout=5)
        if cache.get(cache_key) != "ok":
            raise RuntimeError("cache round trip failed")
    except Exception as exc:
        checks["redis"] = str(exc)
        status_code = 503

    try:
        if not current_app.control.ping(timeout=1.0):
            raise RuntimeError("no celery worker responded")
    except Exception as exc:
        checks["celery"] = str(exc)
        status_code = 503

    return JsonResponse(
        {"status": "ok" if status_code == 200 else "error", "checks": checks},
        status=status_code,
    )


def health_metrics(_request):
    from flights.models import Aircraft, AnomalyEvent
    from flights.services.cache import get_cache_stats, _get_redis

    now = timezone.now()
    ws_connections = 0
    cache_stats = get_cache_stats()
    redis = _get_redis()
    if redis:
        try:
            ws_connections = int(redis.get("metrics:ws:connections") or 0)
        except Exception:
            ws_connections = 0

    total_anomalies = AnomalyEvent.objects.count()
    false_positive_count = AnomalyEvent.objects.filter(feedback="false_positive").count()
    return JsonResponse({
        "current_flight_count": Aircraft.objects.filter(
            last_seen__gte=now - timedelta(minutes=5)
        ).count(),
        "anomaly_count_last_hour": AnomalyEvent.objects.filter(
            detected_at__gte=now - timedelta(hours=1)
        ).count(),
        "websocket_connection_count": ws_connections,
        "cache": cache_stats,
        "cache_hit_ratio": cache_stats["hit_ratio"],
        "false_positive_rate": false_positive_count / total_anomalies if total_anomalies else 0,
    })


def prometheus_metrics(request):
    user = getattr(settings, "METRICS_USER", None) or os.environ.get("METRICS_USER", "")
    password = getattr(settings, "METRICS_PASSWORD", None) or os.environ.get("METRICS_PASSWORD", "")
    if user or password:
        auth = request.headers.get("Authorization", "")
        expected = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
        if not secrets.compare_digest(auth, expected):
            response = HttpResponse("authentication required", status=401)
            response["WWW-Authenticate"] = 'Basic realm="skywatch-metrics"'
            return response
    try:
        from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

        return HttpResponse(generate_latest(), content_type=CONTENT_TYPE_LATEST)
    except Exception:
        return HttpResponse("# prometheus_client not installed\n", content_type="text/plain")


urlpatterns = [
    path("healthz/", healthz, name="healthz"),
    path("readyz/", readyz, name="readyz"),
    path("health/live", health_live, name="health-live"),
    path("health/ready", health_ready, name="health-ready"),
    path("health/metrics", health_metrics, name="health-metrics"),
    path("metrics", prometheus_metrics, name="prometheus-metrics"),
    path("admin/", admin.site.urls),
    path("api/weather/metar", flight_views.MetarWeatherView.as_view(), name="weather-metar-legacy"),
    path("api/airspace/tfr", flight_views.TfrAirspaceView.as_view(), name="airspace-tfr-legacy"),
    path("api/airspace/restrictions", flight_views.AirspaceRestrictionsView.as_view(), name="airspace-restrictions-legacy"),
    path("api/playback", flight_views.PlaybackView.as_view(), name="playback-legacy"),
    path("api/v1/", include("flights.urls")),
]
