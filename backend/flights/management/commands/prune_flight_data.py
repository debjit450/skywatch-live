from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone


class Command(BaseCommand):
    help = "Apply retention pruning to high-volume flight and metrics tables."

    def add_arguments(self, parser):
        parser.add_argument("--states-days", type=int, default=7)
        parser.add_argument("--positions-days", type=int, default=7)
        parser.add_argument("--metrics-days", type=int, default=14)
        parser.add_argument("--resolved-anomalies-days", type=int, default=30)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        from flights.models import AnomalyEvent, FlightPosition, FlightState, SystemMetrics

        now = timezone.now()
        targets = [
            ("FlightState", FlightState.objects.filter(timestamp__lt=now - timedelta(days=options["states_days"]))),
            ("FlightPosition", FlightPosition.objects.filter(timestamp__lt=now - timedelta(days=options["positions_days"]))),
            ("SystemMetrics", SystemMetrics.objects.filter(timestamp__lt=now - timedelta(days=options["metrics_days"]))),
            (
                "resolved AnomalyEvent",
                AnomalyEvent.objects.filter(
                    detected_at__lt=now - timedelta(days=options["resolved_anomalies_days"]),
                    is_active=False,
                ),
            ),
        ]

        for label, queryset in targets:
            count = queryset.count()
            if options["dry_run"]:
                self.stdout.write(f"{label}: would delete {count}")
            else:
                deleted, _ = queryset.delete()
                self.stdout.write(f"{label}: deleted {deleted}")
