"""SkyWatch URL configuration."""

from django.contrib import admin
from django.core.cache import cache
from django.db import connection
from django.http import JsonResponse
from django.urls import path, include


def healthz(_request):
    """Liveness probe that avoids downstream dependencies."""
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


urlpatterns = [
    path("healthz/", healthz, name="healthz"),
    path("readyz/", readyz, name="readyz"),
    path("admin/", admin.site.urls),
    path("api/v1/", include("flights.urls")),
]
