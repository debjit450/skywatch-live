"""DRF Serializers for the SkyWatch API."""

from rest_framework import serializers
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


class FlightStateSerializer(serializers.ModelSerializer):
    """Serializes a single flight state snapshot."""

    icao24 = serializers.CharField(source="aircraft_id")
    callsign = serializers.SerializerMethodField()
    origin_country = serializers.SerializerMethodField()

    class Meta:
        model = FlightState
        fields = [
            "icao24",
            "callsign",
            "origin_country",
            "timestamp",
            "latitude",
            "longitude",
            "baro_altitude",
            "geo_altitude",
            "velocity",
            "vertical_rate",
            "true_track",
            "squawk",
            "on_ground",
            "spi",
            "position_source",
            "last_contact",
            "time_position",
            "category",
            "ml_anomaly_score",
            "data_source",
            "predicted_path",
            "prediction_confidence",
        ]

    def get_callsign(self, obj):
        return obj.aircraft.callsign if obj.aircraft else ""

    def get_origin_country(self, obj):
        return obj.aircraft.origin_country if obj.aircraft else ""


class FlightStateLiveSerializer(serializers.Serializer):
    """
    Lightweight serializer for the live flight feed.
    Matches the frontend's expected Flight interface.
    """

    icao24 = serializers.CharField()
    callsign = serializers.CharField(allow_null=True)
    origin_country = serializers.CharField()
    time_position = serializers.FloatField(allow_null=True)
    last_contact = serializers.FloatField()
    longitude = serializers.FloatField(allow_null=True)
    latitude = serializers.FloatField(allow_null=True)
    baro_altitude = serializers.FloatField(allow_null=True)
    on_ground = serializers.BooleanField()
    velocity = serializers.FloatField(allow_null=True)
    true_track = serializers.FloatField(allow_null=True)
    vertical_rate = serializers.FloatField(allow_null=True)
    sensors = serializers.ListField(child=serializers.IntegerField(), allow_null=True)
    geo_altitude = serializers.FloatField(allow_null=True)
    squawk = serializers.CharField(allow_null=True)
    spi = serializers.BooleanField()
    position_source = serializers.IntegerField()
    category = serializers.IntegerField(required=False, default=0)
    ml_anomaly_score = serializers.FloatField(allow_null=True, required=False)
    data_source = serializers.CharField(required=False, default="")
    source_confidence = serializers.FloatField(required=False, default=1.0)
    source_provenance = serializers.ListField(child=serializers.CharField(), required=False, default=list)
    source_conflicts = serializers.ListField(child=serializers.DictField(), required=False, default=list)
    predicted_path = serializers.ListField(child=serializers.DictField(), required=False, default=list)
    prediction_confidence = serializers.FloatField(required=False, default=0.0)


class FlightRouteSerializer(serializers.ModelSerializer):
    """Serializes a flight route with its point array."""

    icao24 = serializers.CharField(source="aircraft_id")

    class Meta:
        model = FlightRoute
        fields = [
            "icao24",
            "session_id",
            "points",
            "started_at",
            "ended_at",
            "point_count",
            "total_distance_km",
        ]


class AnomalyEventSerializer(serializers.ModelSerializer):
    """Full anomaly event detail."""

    icao24 = serializers.CharField(source="aircraft_id")
    callsign = serializers.SerializerMethodField()
    origin_country = serializers.SerializerMethodField()

    class Meta:
        model = AnomalyEvent
        fields = [
            "id",
            "icao24",
            "callsign",
            "origin_country",
            "anomaly_type",
            "severity",
            "confidence_score",
            "detector_type",
            "ml_score",
            "details",
            "evidence",
            "source_quality",
            "explanation",
            "isolation_score",
            "lstm_score",
            "combined_score",
            "source",
            "alert_rule",
            "feedback",
            "detected_at",
            "resolved_at",
            "is_active",
            "latitude",
            "longitude",
            "altitude",
            "velocity",
        ]

    def get_callsign(self, obj):
        return obj.aircraft.callsign if obj.aircraft else ""

    def get_origin_country(self, obj):
        return obj.aircraft.origin_country if obj.aircraft else ""


class AnomalyEventCompactSerializer(serializers.ModelSerializer):
    """Compact anomaly for sidebar feed."""

    icao24 = serializers.CharField(source="aircraft_id")
    callsign = serializers.SerializerMethodField()
    origin_country = serializers.SerializerMethodField()

    class Meta:
        model = AnomalyEvent
        fields = [
            "id",
            "icao24",
            "callsign",
            "origin_country",
            "anomaly_type",
            "severity",
            "confidence_score",
            "ml_score",
            "detector_type",
            "source",
            "detected_at",
            "is_active",
        ]

    def get_callsign(self, obj):
        return obj.aircraft.callsign if obj.aircraft else ""

    def get_origin_country(self, obj):
        return obj.aircraft.origin_country if obj.aircraft else ""


class AircraftSerializer(serializers.ModelSerializer):
    """Full aircraft detail with recent anomalies count."""

    class Meta:
        model = Aircraft
        fields = [
            "icao24",
            "callsign",
            "origin_country",
            "first_seen",
            "last_seen",
            "total_states",
            "total_anomalies",
            "category",
            "aircraft_type",
            "registration",
            "manufacturer",
            "owner",
            "data_source",
        ]


class SystemMetricsSerializer(serializers.ModelSerializer):
    class Meta:
        model = SystemMetrics
        fields = "__all__"


class FlightPositionSerializer(serializers.ModelSerializer):
    icao24 = serializers.CharField(source="aircraft_id")

    class Meta:
        model = FlightPosition
        fields = [
            "icao24",
            "timestamp",
            "latitude",
            "longitude",
            "altitude",
            "velocity",
            "heading",
            "vertical_rate",
            "on_ground",
            "data_source",
        ]


class AlertRuleSerializer(serializers.ModelSerializer):
    class Meta:
        model = AlertRule
        fields = ["id", "name", "type", "config", "active", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class AnalyticsSerializer(serializers.Serializer):
    """Dashboard analytics response."""

    total_flights = serializers.IntegerField()
    airborne = serializers.IntegerField()
    on_ground = serializers.IntegerField()
    anomaly_count = serializers.IntegerField()
    anomaly_rate = serializers.FloatField()
    countries_active = serializers.IntegerField()
    avg_ml_score = serializers.FloatField()
    last_updated = serializers.DateTimeField()
    anomaly_by_type = serializers.DictField()
    anomaly_by_severity = serializers.DictField()
    timeline = serializers.ListField()


class IngestionSourceHealthSerializer(serializers.ModelSerializer):
    class Meta:
        model = IngestionSourceHealth
        fields = [
            "source",
            "status",
            "enabled",
            "confidence_score",
            "last_success_at",
            "last_error_at",
            "last_error",
            "consecutive_failures",
            "rate_limited_until",
            "circuit_open_until",
            "latency_ms",
            "aircraft_count",
            "normalized_count",
            "rejected_count",
            "updated_at",
        ]


class IngestionAuditSerializer(serializers.ModelSerializer):
    class Meta:
        model = IngestionAudit
        fields = [
            "id",
            "source",
            "started_at",
            "finished_at",
            "duration_ms",
            "status",
            "upstream_status",
            "aircraft_count",
            "normalized_count",
            "rejected_count",
            "error",
            "metadata",
        ]


class MLModelVersionSerializer(serializers.ModelSerializer):
    class Meta:
        model = MLModelVersion
        fields = [
            "id",
            "model_name",
            "version",
            "detector_type",
            "training_sample_count",
            "trained_at",
            "metrics",
            "thresholds",
            "drift_indicators",
            "artifact_path",
            "is_active",
            "created_at",
        ]
