from django.db import migrations, models
import django.utils.timezone


class Migration(migrations.Migration):

    dependencies = [
        ("flights", "0006_quickwins_realtime_observability"),
    ]

    operations = [
        migrations.AddField(
            model_name="anomalyevent",
            name="detector_type",
            field=models.CharField(blank=True, db_index=True, default="rule", help_text="rule, statistical, ml, ensemble, custom", max_length=20),
        ),
        migrations.AddField(
            model_name="anomalyevent",
            name="evidence",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name="anomalyevent",
            name="source_quality",
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.CreateModel(
            name="IngestionAudit",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("source", models.CharField(db_index=True, max_length=40)),
                ("started_at", models.DateTimeField(db_index=True, default=django.utils.timezone.now)),
                ("finished_at", models.DateTimeField(blank=True, null=True)),
                ("duration_ms", models.PositiveIntegerField(default=0)),
                ("status", models.CharField(choices=[("ok", "OK"), ("disabled", "Disabled"), ("skipped", "Skipped"), ("rate_limited", "Rate limited"), ("circuit_open", "Circuit open"), ("error", "Error")], db_index=True, max_length=20)),
                ("upstream_status", models.CharField(blank=True, default="", max_length=80)),
                ("aircraft_count", models.PositiveIntegerField(default=0)),
                ("normalized_count", models.PositiveIntegerField(default=0)),
                ("rejected_count", models.PositiveIntegerField(default=0)),
                ("error", models.TextField(blank=True, default="")),
                ("metadata", models.JSONField(blank=True, default=dict)),
            ],
            options={
                "ordering": ["-started_at"],
            },
        ),
        migrations.CreateModel(
            name="IngestionSourceHealth",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("source", models.CharField(max_length=40, unique=True)),
                ("status", models.CharField(choices=[("ok", "OK"), ("disabled", "Disabled"), ("rate_limited", "Rate limited"), ("degraded", "Degraded"), ("circuit_open", "Circuit open"), ("error", "Error")], db_index=True, default="ok", max_length=20)),
                ("enabled", models.BooleanField(default=True)),
                ("confidence_score", models.FloatField(default=1.0)),
                ("last_success_at", models.DateTimeField(blank=True, null=True)),
                ("last_error_at", models.DateTimeField(blank=True, null=True)),
                ("last_error", models.TextField(blank=True, default="")),
                ("consecutive_failures", models.PositiveIntegerField(default=0)),
                ("rate_limited_until", models.DateTimeField(blank=True, null=True)),
                ("circuit_open_until", models.DateTimeField(blank=True, null=True)),
                ("latency_ms", models.PositiveIntegerField(default=0)),
                ("aircraft_count", models.PositiveIntegerField(default=0)),
                ("normalized_count", models.PositiveIntegerField(default=0)),
                ("rejected_count", models.PositiveIntegerField(default=0)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["source"],
            },
        ),
        migrations.CreateModel(
            name="MLModelVersion",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("model_name", models.CharField(max_length=80)),
                ("version", models.CharField(max_length=80)),
                ("detector_type", models.CharField(default="ml", max_length=30)),
                ("training_sample_count", models.PositiveIntegerField(default=0)),
                ("trained_at", models.DateTimeField(blank=True, null=True)),
                ("metrics", models.JSONField(blank=True, default=dict)),
                ("thresholds", models.JSONField(blank=True, default=dict)),
                ("drift_indicators", models.JSONField(blank=True, default=dict)),
                ("artifact_path", models.CharField(blank=True, default="", max_length=255)),
                ("is_active", models.BooleanField(db_index=True, default=False)),
                ("created_at", models.DateTimeField(default=django.utils.timezone.now)),
            ],
            options={
                "ordering": ["-created_at"],
            },
        ),
        migrations.AddIndex(
            model_name="flightstate",
            index=models.Index(fields=["data_source", "timestamp"], name="flight_state_source_time_idx"),
        ),
        migrations.AddIndex(
            model_name="flightstate",
            index=models.Index(fields=["aircraft", "status", "-timestamp"], name="flight_state_air_status_idx"),
        ),
        migrations.AddIndex(
            model_name="flightroute",
            index=models.Index(fields=["aircraft", "-ended_at"], name="flight_route_recent_idx"),
        ),
        migrations.AddIndex(
            model_name="flightposition",
            index=models.Index(fields=["data_source", "timestamp"], name="flight_position_source_idx"),
        ),
        migrations.AddIndex(
            model_name="anomalyevent",
            index=models.Index(fields=["severity", "is_active", "-detected_at"], name="anomaly_severity_status_idx"),
        ),
        migrations.AddIndex(
            model_name="anomalyevent",
            index=models.Index(fields=["source", "-detected_at"], name="anomaly_source_time_idx"),
        ),
        migrations.AddIndex(
            model_name="systemmetrics",
            index=models.Index(fields=["timestamp"], name="system_metrics_time_idx"),
        ),
        migrations.AddIndex(
            model_name="ingestionaudit",
            index=models.Index(fields=["source", "-started_at"], name="ingest_audit_source_time_idx"),
        ),
        migrations.AddIndex(
            model_name="ingestionaudit",
            index=models.Index(fields=["status", "-started_at"], name="ingest_audit_status_time_idx"),
        ),
        migrations.AddIndex(
            model_name="ingestionsourcehealth",
            index=models.Index(fields=["status", "updated_at"], name="source_health_status_idx"),
        ),
        migrations.AddIndex(
            model_name="mlmodelversion",
            index=models.Index(fields=["model_name", "is_active"], name="ml_model_active_idx"),
        ),
    ]
