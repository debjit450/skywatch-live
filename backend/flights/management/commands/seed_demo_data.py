from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = "Seed deterministic SkyWatch demo aircraft, positions, anomalies, and model metadata."

    def handle(self, *args, **options):
        from flights.services.demo_data import seed_demo_records

        result = seed_demo_records()
        self.stdout.write(self.style.SUCCESS(f"Seeded demo data: {result}"))
