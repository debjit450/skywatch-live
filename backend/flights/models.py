"""
SkyWatch Pro — Database models.

Stores aircraft identity, time-series flight states, accumulated routes,
anomaly events, and system-level dashboard metrics.
"""

from django.db import models
from django.conf import settings
from django.utils import timezone


class Aircraft(models.Model):
    """Unique aircraft identified by ICAO24 hex code."""

    icao24 = models.CharField(max_length=6, primary_key=True, db_index=True)
    callsign = models.CharField(max_length=10, blank=True, default="")
    origin_country = models.CharField(max_length=100, blank=True, default="")
    first_seen = models.DateTimeField(default=timezone.now)
    last_seen = models.DateTimeField(default=timezone.now, db_index=True)
    total_states = models.PositiveIntegerField(default=0)
    total_anomalies = models.PositiveIntegerField(default=0)
    category = models.PositiveSmallIntegerField(default=0, db_index=True)
    aircraft_type = models.CharField(max_length=100, blank=True, default="", help_text="Aircraft type/model")
    registration = models.CharField(max_length=20, blank=True, default="", help_text="Registration code")
    manufacturer = models.CharField(max_length=100, blank=True, default="")
    owner = models.CharField(max_length=200, blank=True, default="", help_text="Registered owner")
    data_source = models.CharField(max_length=20, blank=True, default="", help_text="Last data source")

    class Meta:
        ordering = ["-last_seen"]
        verbose_name_plural = "Aircraft"
        indexes = [
            models.Index(fields=["icao24"], name="aircraft_icao_hex_idx"),
        ]

    def __str__(self):
        return f"{self.icao24} ({self.callsign or 'N/A'}) — {self.origin_country}"


class FlightState(models.Model):
    """
    A single time-series snapshot of an aircraft's state.
    These accumulate every 30s while the backend is running.
    """

    aircraft = models.ForeignKey(
        Aircraft, on_delete=models.CASCADE, related_name="states", db_index=True
    )
    timestamp = models.DateTimeField(db_index=True)
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    baro_altitude = models.FloatField(null=True, blank=True, help_text="Barometric altitude in meters")
    geo_altitude = models.FloatField(null=True, blank=True, help_text="Geometric altitude in meters")
    velocity = models.FloatField(null=True, blank=True, help_text="Ground speed in m/s")
    vertical_rate = models.FloatField(null=True, blank=True, help_text="Vertical rate in m/s")
    true_track = models.FloatField(null=True, blank=True, help_text="True heading in degrees")
    squawk = models.CharField(max_length=4, blank=True, null=True)
    on_ground = models.BooleanField(default=False)
    spi = models.BooleanField(default=False)
    position_source = models.SmallIntegerField(default=0)
    last_contact = models.FloatField(default=0, help_text="Unix epoch of last contact")
    time_position = models.FloatField(null=True, blank=True, help_text="Unix epoch of last position")
    category = models.PositiveSmallIntegerField(default=0, db_index=True)
    data_source = models.CharField(
        max_length=20, blank=True, default="",
        help_text="Source: opensky, adsb_one, airplanes_live, ogn, faa_radar, uat, satellite",
    )
    status = models.CharField(max_length=20, blank=True, default="active", db_index=True)
    updated_at = models.DateTimeField(default=timezone.now, db_index=True)
    origin_airport = models.CharField(max_length=8, blank=True, default="", db_index=True)
    destination_airport = models.CharField(max_length=8, blank=True, default="", db_index=True)
    predicted_path = models.JSONField(default=list, blank=True)
    prediction_confidence = models.FloatField(default=0.0)

    # ML anomaly score for this state
    ml_anomaly_score = models.FloatField(null=True, blank=True, help_text="Isolation Forest score (-1 to 1)")

    class Meta:
        ordering = ["-timestamp"]
        indexes = [
            models.Index(fields=["aircraft", "timestamp"]),
            models.Index(fields=["timestamp"]),
            models.Index(fields=["status", "-updated_at"], name="flight_status_updated_idx"),
            models.Index(fields=["origin_airport", "destination_airport"], name="flight_route_airports_idx"),
        ]
        get_latest_by = "timestamp"

    def __str__(self):
        return f"{self.aircraft_id} @ {self.timestamp.isoformat()}"


class FlightRoute(models.Model):
    """
    An accumulated route built from sequential FlightState snapshots.
    A new route session starts when an aircraft reappears after being
    absent for more than 10 minutes.
    """

    aircraft = models.ForeignKey(
        Aircraft, on_delete=models.CASCADE, related_name="routes", db_index=True
    )
    session_id = models.CharField(max_length=64, db_index=True)
    points = models.JSONField(
        default=list,
        help_text="Array of {lat, lon, alt, time, speed} objects",
    )
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField()
    point_count = models.PositiveIntegerField(default=0)
    total_distance_km = models.FloatField(default=0.0)

    class Meta:
        ordering = ["-started_at"]
        indexes = [
            models.Index(fields=["aircraft", "session_id"]),
        ]

    def __str__(self):
        return f"Route {self.session_id} for {self.aircraft_id} ({self.point_count} pts)"


class FlightPosition(models.Model):
    """Append-only position history for historical playback queries."""

    aircraft = models.ForeignKey(
        Aircraft, on_delete=models.CASCADE, related_name="positions", db_index=True
    )
    timestamp = models.DateTimeField(db_index=True)
    latitude = models.FloatField()
    longitude = models.FloatField()
    altitude = models.FloatField(null=True, blank=True)
    velocity = models.FloatField(null=True, blank=True)
    heading = models.FloatField(null=True, blank=True)
    vertical_rate = models.FloatField(null=True, blank=True)
    on_ground = models.BooleanField(default=False)
    data_source = models.CharField(max_length=20, blank=True, default="")

    class Meta:
        ordering = ["timestamp"]
        indexes = [
            models.Index(fields=["aircraft", "timestamp"], name="flight_position_lookup_idx"),
        ]

    def __str__(self):
        return f"Position {self.aircraft_id} @ {self.timestamp.isoformat()}"


class AlertRule(models.Model):
    """User-defined anomaly rule evaluated against live flights."""

    TYPE_CHOICES = [
        ("geofence", "Geofence"),
        ("threshold", "Threshold"),
        ("pattern", "Pattern"),
    ]

    name = models.CharField(max_length=120)
    type = models.CharField(max_length=20, choices=TYPE_CHOICES)
    config = models.JSONField(default=dict, blank=True)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="alert_rules")
    active = models.BooleanField(default=True, db_index=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        indexes = [
            models.Index(fields=["user", "active"], name="flights_ale_user_id_d40d56_idx"),
            models.Index(fields=["type", "active"], name="flights_ale_type_f2aff0_idx"),
        ]

    def __str__(self):
        return f"{self.name} ({self.type})"


class AnomalyEvent(models.Model):
    """A detected anomaly — either rule-based or ML-detected."""

    SEVERITY_CHOICES = [
        ("low", "Low"),
        ("medium", "Medium"),
        ("high", "High"),
        ("critical", "Critical"),
    ]

    TYPE_CHOICES = [
        ("ghost", "Ghost Flight"),
        ("squawk_7500", "Hijack (7500)"),
        ("squawk_7600", "Radio Failure (7600)"),
        ("squawk_7700", "Emergency (7700)"),
        ("low_fast", "Low & Fast"),
        ("rapid_descent", "Rapid Descent"),
        ("signal_lost", "Signal Lost"),
        ("ml_anomaly", "ML-Detected Anomaly"),
        ("speed_anomaly", "Unusual Speed"),
        ("altitude_anomaly", "Unusual Altitude"),
        ("heading_anomaly", "Unusual Heading Change"),
        ("position_anomaly", "Position Jump"),
        ("circling", "Circling / Loitering"),
        ("trajectory_deviation", "Trajectory Deviation"),
        ("geofence", "Restricted Airspace"),
        ("proximity", "Proximity Alert"),
        ("altitude_bust", "Altitude Bust"),
        ("speed_envelope", "Speed Envelope Violation"),
        ("behavioral", "Behavioral Deviation"),
        ("custom_rule", "Custom Alert Rule"),
    ]

    aircraft = models.ForeignKey(
        Aircraft, on_delete=models.CASCADE, related_name="anomaly_events", db_index=True
    )
    anomaly_type = models.CharField(max_length=30, choices=TYPE_CHOICES)
    severity = models.CharField(max_length=10, choices=SEVERITY_CHOICES, default="medium")
    confidence_score = models.FloatField(
        default=0.0, help_text="Combined rule + ML confidence (0-100)"
    )
    ml_score = models.FloatField(
        null=True, blank=True, help_text="Raw Isolation Forest anomaly score"
    )
    isolation_score = models.FloatField(null=True, blank=True)
    lstm_score = models.FloatField(null=True, blank=True)
    combined_score = models.FloatField(null=True, blank=True)
    explanation = models.JSONField(default=list, blank=True)
    feedback = models.CharField(
        max_length=20,
        blank=True,
        default="",
        choices=[
            ("", "Unreviewed"),
            ("true_positive", "True positive"),
            ("false_positive", "False positive"),
        ],
    )
    source = models.CharField(max_length=30, blank=True, default="detector", db_index=True)
    alert_rule = models.ForeignKey(
        AlertRule,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="anomalies",
    )
    details = models.JSONField(default=dict, blank=True)
    detected_at = models.DateTimeField(default=timezone.now, db_index=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    is_active = models.BooleanField(default=True, db_index=True)

    # Snapshot of the state when anomaly was detected
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    altitude = models.FloatField(null=True, blank=True)
    velocity = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ["-detected_at"]
        indexes = [
            models.Index(fields=["is_active", "-detected_at"]),
            models.Index(fields=["anomaly_type", "-detected_at"]),
            models.Index(fields=["-detected_at"], name="anomaly_detected_desc_idx"),
            models.Index(fields=["aircraft", "severity"], name="anomaly_flight_severity_idx"),
        ]

    def __str__(self):
        return f"{self.anomaly_type} on {self.aircraft_id} ({self.severity}) @ {self.detected_at}"


class SystemMetrics(models.Model):
    """Periodic dashboard metrics snapshot."""

    timestamp = models.DateTimeField(default=timezone.now, db_index=True)
    total_flights = models.PositiveIntegerField(default=0)
    airborne = models.PositiveIntegerField(default=0)
    on_ground = models.PositiveIntegerField(default=0)
    anomaly_count = models.PositiveIntegerField(default=0)
    anomaly_rate = models.FloatField(default=0.0, help_text="Anomalies / total flights %")
    avg_ml_score = models.FloatField(default=0.0)
    countries_active = models.PositiveIntegerField(default=0)
    source_counts = models.JSONField(
        default=dict, blank=True,
        help_text="Per-source aircraft counts: {opensky: N, adsb_one: N, ...}",
    )

    class Meta:
        ordering = ["-timestamp"]
        get_latest_by = "timestamp"
        verbose_name_plural = "System metrics"

    def __str__(self):
        return f"Metrics @ {self.timestamp.isoformat()} — {self.total_flights} flights"


class AircraftProfile(models.Model):
    """Per-aircraft behavioral baseline for anomaly detection."""

    aircraft = models.OneToOneField(
        Aircraft, on_delete=models.CASCADE, related_name="profile", primary_key=True
    )
    avg_velocity = models.FloatField(default=0, help_text="EMA mean velocity (m/s)")
    std_velocity = models.FloatField(default=0, help_text="EMA std velocity")
    avg_altitude = models.FloatField(default=0, help_text="EMA mean altitude (m)")
    std_altitude = models.FloatField(default=0, help_text="EMA std altitude")
    avg_vertical_rate = models.FloatField(default=0, help_text="EMA mean |vertical rate|")
    typical_heading_variance = models.FloatField(default=0, help_text="Circular heading variance")
    observation_count = models.PositiveIntegerField(default=0)
    last_updated = models.DateTimeField(auto_now=True)
    profile_data = models.JSONField(default=dict, blank=True, help_text="Full EMA profile stats")

    class Meta:
        verbose_name_plural = "Aircraft profiles"

    def __str__(self):
        return f"Profile for {self.aircraft_id} ({self.observation_count} obs)"
