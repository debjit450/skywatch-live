from django.contrib import admin
from .models import Aircraft, FlightState, FlightRoute, AnomalyEvent, SystemMetrics


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


@admin.register(AnomalyEvent)
class AnomalyEventAdmin(admin.ModelAdmin):
    list_display = ["aircraft", "anomaly_type", "severity", "confidence_score", "ml_score", "detected_at", "is_active"]
    list_filter = ["anomaly_type", "severity", "is_active"]
    search_fields = ["aircraft__icao24"]
    date_hierarchy = "detected_at"


@admin.register(SystemMetrics)
class SystemMetricsAdmin(admin.ModelAdmin):
    list_display = ["timestamp", "total_flights", "airborne", "anomaly_count", "anomaly_rate"]
    date_hierarchy = "timestamp"
