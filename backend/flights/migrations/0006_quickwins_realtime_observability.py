from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import django.utils.timezone


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("flights", "0005_alter_aircraft_last_seen"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="aircraft",
            index=models.Index(fields=["icao24"], name="aircraft_icao_hex_idx"),
        ),
        migrations.AddField(
            model_name="flightstate",
            name="status",
            field=models.CharField(blank=True, db_index=True, default="active", max_length=20),
        ),
        migrations.AddField(
            model_name="flightstate",
            name="updated_at",
            field=models.DateTimeField(db_index=True, default=django.utils.timezone.now),
        ),
        migrations.AddField(
            model_name="flightstate",
            name="origin_airport",
            field=models.CharField(blank=True, db_index=True, default="", max_length=8),
        ),
        migrations.AddField(
            model_name="flightstate",
            name="destination_airport",
            field=models.CharField(blank=True, db_index=True, default="", max_length=8),
        ),
        migrations.AddField(
            model_name="flightstate",
            name="predicted_path",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="flightstate",
            name="prediction_confidence",
            field=models.FloatField(default=0.0),
        ),
        migrations.CreateModel(
            name="FlightPosition",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("timestamp", models.DateTimeField(db_index=True)),
                ("latitude", models.FloatField()),
                ("longitude", models.FloatField()),
                ("altitude", models.FloatField(blank=True, null=True)),
                ("velocity", models.FloatField(blank=True, null=True)),
                ("heading", models.FloatField(blank=True, null=True)),
                ("vertical_rate", models.FloatField(blank=True, null=True)),
                ("on_ground", models.BooleanField(default=False)),
                ("data_source", models.CharField(blank=True, default="", max_length=20)),
                ("aircraft", models.ForeignKey(db_index=True, on_delete=django.db.models.deletion.CASCADE, related_name="positions", to="flights.aircraft")),
            ],
            options={
                "ordering": ["timestamp"],
            },
        ),
        migrations.CreateModel(
            name="AlertRule",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=120)),
                ("type", models.CharField(choices=[("geofence", "Geofence"), ("threshold", "Threshold"), ("pattern", "Pattern")], max_length=20)),
                ("config", models.JSONField(blank=True, default=dict)),
                ("active", models.BooleanField(db_index=True, default=True)),
                ("created_at", models.DateTimeField(default=django.utils.timezone.now)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("user", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="alert_rules", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "ordering": ["name"],
            },
        ),
        migrations.AddField(
            model_name="anomalyevent",
            name="isolation_score",
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="anomalyevent",
            name="lstm_score",
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="anomalyevent",
            name="combined_score",
            field=models.FloatField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="anomalyevent",
            name="explanation",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="anomalyevent",
            name="feedback",
            field=models.CharField(blank=True, choices=[("", "Unreviewed"), ("true_positive", "True positive"), ("false_positive", "False positive")], default="", max_length=20),
        ),
        migrations.AddField(
            model_name="anomalyevent",
            name="source",
            field=models.CharField(blank=True, db_index=True, default="detector", max_length=30),
        ),
        migrations.AddField(
            model_name="anomalyevent",
            name="alert_rule",
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="anomalies", to="flights.alertrule"),
        ),
        migrations.AlterField(
            model_name="anomalyevent",
            name="anomaly_type",
            field=models.CharField(choices=[("ghost", "Ghost Flight"), ("squawk_7500", "Hijack (7500)"), ("squawk_7600", "Radio Failure (7600)"), ("squawk_7700", "Emergency (7700)"), ("low_fast", "Low & Fast"), ("rapid_descent", "Rapid Descent"), ("signal_lost", "Signal Lost"), ("ml_anomaly", "ML-Detected Anomaly"), ("speed_anomaly", "Unusual Speed"), ("altitude_anomaly", "Unusual Altitude"), ("heading_anomaly", "Unusual Heading Change"), ("position_anomaly", "Position Jump"), ("circling", "Circling / Loitering"), ("trajectory_deviation", "Trajectory Deviation"), ("geofence", "Restricted Airspace"), ("proximity", "Proximity Alert"), ("altitude_bust", "Altitude Bust"), ("speed_envelope", "Speed Envelope Violation"), ("behavioral", "Behavioral Deviation"), ("custom_rule", "Custom Alert Rule")], max_length=30),
        ),
        migrations.AddIndex(
            model_name="flightstate",
            index=models.Index(fields=["status", "-updated_at"], name="flight_status_updated_idx"),
        ),
        migrations.AddIndex(
            model_name="flightstate",
            index=models.Index(fields=["origin_airport", "destination_airport"], name="flight_route_airports_idx"),
        ),
        migrations.AddIndex(
            model_name="flightposition",
            index=models.Index(fields=["aircraft", "timestamp"], name="flight_position_lookup_idx"),
        ),
        migrations.AddIndex(
            model_name="alertrule",
            index=models.Index(fields=["user", "active"], name="flights_ale_user_id_d40d56_idx"),
        ),
        migrations.AddIndex(
            model_name="alertrule",
            index=models.Index(fields=["type", "active"], name="flights_ale_type_f2aff0_idx"),
        ),
        migrations.AddIndex(
            model_name="anomalyevent",
            index=models.Index(fields=["-detected_at"], name="anomaly_detected_desc_idx"),
        ),
        migrations.AddIndex(
            model_name="anomalyevent",
            index=models.Index(fields=["aircraft", "severity"], name="anomaly_flight_severity_idx"),
        ),
    ]
