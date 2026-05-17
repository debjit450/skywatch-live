"""
Model training script for the 3-model ensemble.

Train and evaluate the Isolation Forest + LOF + Autoencoder
anomaly detection ensemble. Can be run standalone or called
from Celery tasks.
"""

import os
import sys
import logging

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "skywatch.settings")

logger = logging.getLogger(__name__)


def train_from_database(contamination=0.015, max_samples=50000):
    """Train the ensemble model using accumulated FlightState data from the database."""
    import django
    django.setup()

    from datetime import timedelta
    from django.utils import timezone
    from flights.models import FlightState
    from flights.services.anomaly_detector import train_model

    cutoff = timezone.now() - timedelta(days=7)
    states = FlightState.objects.filter(
        timestamp__gte=cutoff,
        on_ground=False,
        velocity__isnull=False,
    ).values(
        "velocity", "baro_altitude", "geo_altitude", "vertical_rate",
        "true_track", "on_ground", "last_contact", "time_position",
        "category", "latitude", "longitude",
    )[:max_samples]

    flight_dicts = list(states)
    logger.info("Loaded %d flight states for training", len(flight_dicts))

    if len(flight_dicts) < 100:
        logger.error("Not enough data for training (need 100+, got %d)", len(flight_dicts))
        return None

    model = train_model(flight_dicts, contamination=contamination)
    if model:
        logger.info("Ensemble model trained successfully!")
    return model


def train_from_synthetic(n_samples=10000, contamination=0.015):
    """
    Train with synthetic data when no historical data is available.
    Generates realistic flight state distributions for initial bootstrap
    across multiple aircraft categories.
    """
    import numpy as np
    from flights.services.anomaly_detector import train_model

    np.random.seed(42)

    normal_flights = []

    # ── Commercial aircraft (categories 3-6) ──
    for _ in range(int(n_samples * 0.55)):
        cat = np.random.choice([3, 4, 5, 6], p=[0.15, 0.35, 0.15, 0.35])
        alt_band = np.random.choice(["low", "cruise", "high"], p=[0.15, 0.7, 0.15])
        if alt_band == "low":
            alt = np.random.uniform(300, 3000)
            speed = np.random.uniform(60, 150)
        elif alt_band == "cruise":
            alt = np.random.uniform(8000, 12500)
            speed = np.random.uniform(200, 280)
        else:
            alt = np.random.uniform(12000, 15000)
            speed = np.random.uniform(220, 265)

        normal_flights.append({
            "velocity": speed + np.random.normal(0, 10),
            "baro_altitude": alt + np.random.normal(0, 100),
            "geo_altitude": alt + np.random.normal(0, 120),
            "vertical_rate": np.random.normal(0, 2),
            "true_track": np.random.uniform(0, 360),
            "on_ground": False,
            "last_contact": 0,
            "time_position": 0,
            "category": int(cat),
            "latitude": np.random.uniform(-60, 70),
            "longitude": np.random.uniform(-180, 180),
        })

    # ── Light / Small GA (category 2) ──
    for _ in range(int(n_samples * 0.15)):
        alt = np.random.uniform(300, 4500)
        speed = np.random.uniform(30, 75)
        normal_flights.append({
            "velocity": speed + np.random.normal(0, 5),
            "baro_altitude": alt + np.random.normal(0, 50),
            "geo_altitude": alt + np.random.normal(0, 60),
            "vertical_rate": np.random.normal(0, 1.5),
            "true_track": np.random.uniform(0, 360),
            "on_ground": False,
            "last_contact": 0,
            "time_position": 0,
            "category": 2,
            "latitude": np.random.uniform(-50, 60),
            "longitude": np.random.uniform(-180, 180),
        })

    # ── Rotorcraft / Helicopter (category 8) ──
    for _ in range(int(n_samples * 0.10)):
        alt = np.random.uniform(100, 3000)
        speed = np.random.uniform(20, 80)
        normal_flights.append({
            "velocity": speed + np.random.normal(0, 8),
            "baro_altitude": alt + np.random.normal(0, 40),
            "geo_altitude": alt + np.random.normal(0, 50),
            "vertical_rate": np.random.normal(0, 3),
            "true_track": np.random.uniform(0, 360),
            "on_ground": False,
            "last_contact": 0,
            "time_position": 0,
            "category": 8,
            "latitude": np.random.uniform(-40, 60),
            "longitude": np.random.uniform(-180, 180),
        })

    # ── Gliders (category 9) ──
    for _ in range(int(n_samples * 0.05)):
        alt = np.random.uniform(500, 5000)
        speed = np.random.uniform(15, 55)
        normal_flights.append({
            "velocity": speed + np.random.normal(0, 4),
            "baro_altitude": alt + np.random.normal(0, 80),
            "geo_altitude": alt + np.random.normal(0, 90),
            "vertical_rate": np.random.normal(-0.5, 2),
            "true_track": np.random.uniform(0, 360),
            "on_ground": False,
            "last_contact": 0,
            "time_position": 0,
            "category": 9,
            "latitude": np.random.uniform(-40, 55),
            "longitude": np.random.uniform(-180, 180),
        })

    # ── High performance / Military (category 7) ──
    for _ in range(int(n_samples * 0.08)):
        alt = np.random.uniform(3000, 16000)
        speed = np.random.uniform(150, 340)
        normal_flights.append({
            "velocity": speed + np.random.normal(0, 15),
            "baro_altitude": alt + np.random.normal(0, 200),
            "geo_altitude": alt + np.random.normal(0, 200),
            "vertical_rate": np.random.normal(0, 4),
            "true_track": np.random.uniform(0, 360),
            "on_ground": False,
            "last_contact": 0,
            "time_position": 0,
            "category": 7,
            "latitude": np.random.uniform(-50, 70),
            "longitude": np.random.uniform(-180, 180),
        })

    # ── UAV (category 14) ──
    for _ in range(int(n_samples * 0.05)):
        alt = np.random.uniform(100, 4000)
        speed = np.random.uniform(10, 80)
        normal_flights.append({
            "velocity": speed + np.random.normal(0, 5),
            "baro_altitude": alt + np.random.normal(0, 30),
            "geo_altitude": alt + np.random.normal(0, 35),
            "vertical_rate": np.random.normal(0, 2),
            "true_track": np.random.uniform(0, 360),
            "on_ground": False,
            "last_contact": 0,
            "time_position": 0,
            "category": 14,
            "latitude": np.random.uniform(-30, 55),
            "longitude": np.random.uniform(-180, 180),
        })

    # ── Unknown / No Category (category 0, 1) ──
    for _ in range(int(n_samples * 0.02)):
        alt = np.random.uniform(500, 12000)
        speed = np.random.uniform(50, 260)
        normal_flights.append({
            "velocity": speed + np.random.normal(0, 10),
            "baro_altitude": alt + np.random.normal(0, 100),
            "geo_altitude": alt + np.random.normal(0, 100),
            "vertical_rate": np.random.normal(0, 2),
            "true_track": np.random.uniform(0, 360),
            "on_ground": False,
            "last_contact": 0,
            "time_position": 0,
            "category": np.random.choice([0, 1]),
            "latitude": np.random.uniform(-60, 70),
            "longitude": np.random.uniform(-180, 180),
        })

    model = train_model(normal_flights, contamination=contamination)
    return model


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    import argparse
    parser = argparse.ArgumentParser(description="Train SkyWatch ML ensemble")
    parser.add_argument("--synthetic", action="store_true", help="Use synthetic data")
    parser.add_argument("--samples", type=int, default=10000)
    parser.add_argument("--contamination", type=float, default=0.015)
    args = parser.parse_args()

    if args.synthetic:
        train_from_synthetic(args.samples, args.contamination)
    else:
        train_from_database(args.contamination, args.samples)
