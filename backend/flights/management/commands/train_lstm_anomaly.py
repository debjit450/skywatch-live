from datetime import timedelta
from pathlib import Path

from django.core.management.base import BaseCommand
from django.utils import timezone

from flights.models import FlightState
from ml.lstm import FEATURE_COUNT, SEQUENCE_LENGTH, build_sequence, model_path


class Command(BaseCommand):
    help = "Train the optional lightweight LSTM anomaly model."

    def add_arguments(self, parser):
        parser.add_argument("--days", type=int, default=30)

    def handle(self, *args, **options):
        try:
            import numpy as np
            from tensorflow import keras
        except Exception:
            self.stdout.write(self.style.WARNING("TensorFlow/Keras is not installed; skipping LSTM training."))
            return

        cutoff = timezone.now() - timedelta(days=options["days"])
        aircraft_ids = (
            FlightState.objects.filter(timestamp__gte=cutoff, on_ground=False)
            .values_list("aircraft_id", flat=True)
            .distinct()[:2000]
        )

        sequences = []
        for aircraft_id in aircraft_ids:
            states = list(
                FlightState.objects.filter(aircraft_id=aircraft_id, timestamp__gte=cutoff)
                .order_by("timestamp")
                .only("baro_altitude", "geo_altitude", "velocity", "true_track", "vertical_rate")
            )
            for index in range(SEQUENCE_LENGTH, len(states) + 1, SEQUENCE_LENGTH):
                sequences.append(build_sequence(states[index - SEQUENCE_LENGTH:index]))

        if len(sequences) < 100:
            self.stdout.write(self.style.WARNING(f"Not enough sequences to train: {len(sequences)}"))
            return

        x = np.asarray(sequences, dtype="float32")
        # Lightweight sequence autoencoder; reconstruction error is used at inference.
        model = keras.Sequential([
            keras.layers.Input(shape=(SEQUENCE_LENGTH, FEATURE_COUNT)),
            keras.layers.LSTM(16, return_sequences=False),
            keras.layers.RepeatVector(SEQUENCE_LENGTH),
            keras.layers.LSTM(16, return_sequences=True),
            keras.layers.TimeDistributed(keras.layers.Dense(FEATURE_COUNT)),
        ])
        model.compile(optimizer="adam", loss="mse")
        model.fit(x, x, epochs=5, batch_size=64, validation_split=0.1, verbose=1)

        path = model_path()
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        model.save(path)
        self.stdout.write(self.style.SUCCESS(f"Saved LSTM anomaly model to {path}"))
