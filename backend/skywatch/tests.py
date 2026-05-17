from django.test import SimpleTestCase, TestCase
from django.urls import reverse


class HealthEndpointTests(SimpleTestCase):
    def test_healthz_returns_ok(self):
        response = self.client.get(reverse("healthz"), secure=True)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})


class ReadinessEndpointTests(TestCase):
    def test_readyz_checks_runtime_dependencies(self):
        response = self.client.get(reverse("readyz"), secure=True)

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["checks"]["database"], "ok")
        self.assertEqual(payload["checks"]["cache"], "ok")
