from datetime import timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings
from django.urls import reverse
from django.utils import timezone

from flights.models import Aircraft, FlightPosition, IngestionSourceHealth
from flights.tasks import _merge_flight_states


class FlightApiTests(TestCase):
    @override_settings(SKYWATCH_DEMO_MODE=True)
    def test_demo_flight_feed_is_deterministic_and_fresh(self):
        response = self.client.get(reverse("flight-list"), secure=True)

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["source"], "demo")
        self.assertGreaterEqual(payload["count"], 3)
        self.assertIn("source_health", payload)

    def test_source_health_endpoint(self):
        IngestionSourceHealth.objects.create(source="opensky", status="ok", confidence_score=0.96)

        response = self.client.get(reverse("source-health"), secure=True)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["sources"][0]["source"], "opensky")

    def test_playback_requires_authentication(self):
        response = self.client.get(reverse("playback"), secure=True)

        self.assertEqual(response.status_code, 403)

    def test_playback_returns_positions_for_authenticated_user(self):
        User = get_user_model()
        user = User.objects.create_user(username="operator", password="test-pass")
        self.client.force_login(user)
        aircraft = Aircraft.objects.create(icao24="a1b2c3", callsign="TEST1")
        now = timezone.now()
        FlightPosition.objects.create(
            aircraft=aircraft,
            timestamp=now,
            latitude=40.0,
            longitude=-73.0,
            altitude=1000,
            data_source="demo",
        )

        response = self.client.get(
            reverse("playback"),
            {
                "flight_id": "a1b2c3",
                "start": (now - timedelta(minutes=1)).isoformat(),
                "end": (now + timedelta(minutes=1)).isoformat(),
            },
            secure=True,
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["positions"]), 1)


class IngestionMergeTests(TestCase):
    def test_merge_preserves_provenance_and_conflicts(self):
        left = {
            "icao24": "a1b2c3",
            "latitude": 40.0,
            "longitude": -73.0,
            "last_contact": 100,
            "data_source": "opensky",
        }
        right = {
            "icao24": "a1b2c3",
            "latitude": 41.0,
            "longitude": -74.0,
            "last_contact": 200,
            "data_source": "adsb_one",
        }

        states, net_new, conflicts = _merge_flight_states([left], [right])

        self.assertEqual(net_new, 0)
        self.assertEqual(conflicts, 1)
        self.assertEqual(states[0]["data_source"], "adsb_one")
        self.assertEqual(states[0]["source_provenance"], ["adsb_one", "opensky"])
