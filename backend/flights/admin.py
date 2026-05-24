from django.contrib import admin
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


@admin.register(Aircraft)
class AircraftAdmin(admin.ModelAdmin):
    list_display = ["icao24", "callsign", "origin_country", "last_seen", "total_states", "total_anomalies"]
    search_fields = ["icao24", "callsign", "origin_country"]
    list_filter = ["origin_country"]


@admin.register(FlightState)
class FlightStateAdmin(admin.ModelAdmin):
    list_display = ["aircraft", "timestamp", "latitude", "longitude", "baro_altitude", "velocity", "on_ground"]
    list_filter = ["on_ground", "timestamp"]
    search_fields = ["aircraft__icao24"]
    date_hierarchy = "timestamp"


@admin.register(FlightRoute)
class FlightRouteAdmin(admin.ModelAdmin):
    list_display = ["aircraft", "session_id", "started_at", "ended_at", "point_count", "total_distance_km"]
    search_fields = ["aircraft__icao24", "session_id"]


@admin.register(FlightPosition)
class FlightPositionAdmin(admin.ModelAdmin):
    list_display = ["aircraft", "timestamp", "latitude", "longitude", "altitude", "velocity"]
    search_fields = ["aircraft__icao24"]
    date_hierarchy = "timestamp"


@admin.register(AnomalyEvent)
class AnomalyEventAdmin(admin.ModelAdmin):
    list_display = ["aircraft", "anomaly_type", "severity", "source", "confidence_score", "ml_score", "detected_at", "is_active"]
    list_filter = ["anomaly_type", "severity", "source", "feedback", "is_active"]
    search_fields = ["aircraft__icao24"]
    date_hierarchy = "detected_at"


@admin.register(SystemMetrics)
class SystemMetricsAdmin(admin.ModelAdmin):
    list_display = ["timestamp", "total_flights", "airborne", "anomaly_count", "anomaly_rate"]
    date_hierarchy = "timestamp"


@admin.register(AlertRule)
class AlertRuleAdmin(admin.ModelAdmin):
    list_display = ["name", "type", "user", "active", "updated_at"]
    list_filter = ["type", "active"]
    search_fields = ["name", "user__username"]


@admin.register(IngestionSourceHealth)
class IngestionSourceHealthAdmin(admin.ModelAdmin):
    list_display = ["source", "status", "confidence_score", "last_success_at", "consecutive_failures", "latency_ms"]
    list_filter = ["status", "enabled"]
    search_fields = ["source", "last_error"]


@admin.register(IngestionAudit)
class IngestionAuditAdmin(admin.ModelAdmin):
    list_display = ["source", "status", "started_at", "duration_ms", "aircraft_count", "normalized_count"]
    list_filter = ["source", "status"]
    search_fields = ["source", "error"]
    date_hierarchy = "started_at"


@admin.register(MLModelVersion)
class MLModelVersionAdmin(admin.ModelAdmin):
    list_display = ["model_name", "version", "detector_type", "is_active", "trained_at", "created_at"]
    list_filter = ["model_name", "detector_type", "is_active"]
    search_fields = ["model_name", "version"]
