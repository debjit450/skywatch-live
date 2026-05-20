"""Optional LSTM anomaly scoring.

The module is intentionally import-safe: if TensorFlow/Keras is absent, callers
receive no scores and the Isolation Forest path continues normally.
"""

from pathlib import Path
import logging

logger = logging.getLogger(__name__)
SEQUENCE_LENGTH = 30
FEATURE_COUNT = 4


def _keras():
    try:
        from tensorflow import keras

        return keras
    except Exception:
        try:
            import keras

            return keras
        except Exception:
            return None


def model_path():
    from django.conf import settings

    return Path(getattr(settings, "BASE_DIR", Path.cwd())) / "models" / "lstm_anomaly.h5"


def load_model():
    keras = _keras()
    path = model_path()
    if keras is None or not path.exists():
        return None
    try:
        return keras.models.load_model(path)
    except Exception as exc:
        logger.warning("Failed to load LSTM anomaly model: %s", exc)
        return None


def score_sequences(sequences):
    model = load_model()
    if model is None or not sequences:
        return []
    try:
        import numpy as np

        arr = np.asarray(sequences, dtype="float32")
        reconstructed = model.predict(arr, verbose=0)
        errors = ((arr - reconstructed) ** 2).mean(axis=(1, 2))
        # Convert reconstruction error to a detector-like score where lower is worse.
        return [float(-error) for error in errors]
    except Exception as exc:
        logger.warning("LSTM scoring failed: %s", exc)
        return []


def build_sequence(states):
    """Build a (30, 4) sequence from FlightState rows ordered old-to-new."""
    values = []
    previous_heading = None
    for state in states:
        heading = state.true_track or 0
        heading_rate = 0 if previous_heading is None else abs((heading - previous_heading + 180) % 360 - 180)
        previous_heading = heading
        values.append([
            float(state.baro_altitude or state.geo_altitude or 0),
            float(state.velocity or 0),
            float(heading_rate),
            float(state.vertical_rate or 0),
        ])
    if len(values) < SEQUENCE_LENGTH:
        values = [[0.0] * FEATURE_COUNT] * (SEQUENCE_LENGTH - len(values)) + values
    return values[-SEQUENCE_LENGTH:]
