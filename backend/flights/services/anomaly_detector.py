"""
ML-powered anomaly detection using a 3-model ensemble.

Combines:
  1. Isolation Forest — global outlier detection
  2. Local Outlier Factor — density-based anomaly detection
  3. Autoencoder (MLP) — reconstruction-error anomaly detection

with conservative rule-based detection (squawk emergencies, stale
unidentified tracks, flight-envelope outliers).

Each model outputs a normalized score in [0, 1].
The meta-score is a weighted combination with configurable weights.
"""

import logging
import math
import os
import time as _time
import numpy as np
from pathlib import Path

logger = logging.getLogger(__name__)

# Try importing ML libraries — graceful fallback if not installed yet
try:
    from sklearn.ensemble import IsolationForest
    from sklearn.neighbors import LocalOutlierFactor
    from sklearn.neural_network import MLPRegressor
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    import joblib
    ML_AVAILABLE = True
except ImportError:
    ML_AVAILABLE = False
    logger.warning("scikit-learn not installed — ML anomaly detection disabled")


# ---------------------------------------------------------------------------
# Ensemble weights and thresholds
# ---------------------------------------------------------------------------

ENSEMBLE_WEIGHTS = {
    "isolation_forest": 0.40,
    "lof": 0.30,
    "autoencoder": 0.30,
}

# Per-category contamination rates (adaptive)
CATEGORY_CONTAMINATION = {
    0: 0.015,   # unknown
    2: 0.020,   # light — more variance
    3: 0.015,   # small
    4: 0.012,   # large — tighter
    5: 0.012,   # high vortex
    6: 0.010,   # heavy — very predictable
    7: 0.008,   # high performance
    8: 0.025,   # rotorcraft — high variance
    9: 0.030,   # glider — very variable
    14: 0.020,  # UAV
}
DEFAULT_CONTAMINATION = 0.015

# Anomaly score thresholds
ML_ANOMALY_THRESHOLD = -0.50  # strong outlier required
ML_ANOMALY_HIGH_THRESHOLD = -0.70  # very strong outlier

# ---------------------------------------------------------------------------
# Rule-based anomaly detection
# ---------------------------------------------------------------------------

RULE_ANOMALIES = {
    "ghost": {"label": "Ghost Flight", "severity": "medium"},
    "squawk_7500": {"label": "Hijack (7500)", "severity": "critical"},
    "squawk_7600": {"label": "Radio Failure (7600)", "severity": "high"},
    "squawk_7700": {"label": "Emergency (7700)", "severity": "critical"},
    "low_fast": {"label": "Low & Fast", "severity": "high"},
    "rapid_descent": {"label": "Rapid Descent", "severity": "high"},
    "signal_lost": {"label": "Signal Lost", "severity": "low"},
    "speed_anomaly": {"label": "Unusual Speed", "severity": "medium"},
    "altitude_anomaly": {"label": "Unusual Altitude", "severity": "medium"},
    "heading_anomaly": {"label": "Unusual Heading Change", "severity": "medium"},
    "position_anomaly": {"label": "Position Jump", "severity": "high"},
    "circling": {"label": "Circling / Loitering", "severity": "medium"},
    "trajectory_deviation": {"label": "Trajectory Deviation", "severity": "medium"},
    "geofence": {"label": "Restricted Airspace", "severity": "high"},
    "proximity": {"label": "Proximity Alert", "severity": "critical"},
    "altitude_bust": {"label": "Altitude Bust", "severity": "high"},
    "speed_envelope": {"label": "Speed Envelope Violation", "severity": "medium"},
    "behavioral": {"label": "Behavioral Deviation", "severity": "medium"},
}


def detect_rule_based(flight, now_epoch=None):
    """
    Run rule-based anomaly checks on a single flight state dict.

    Returns list of {type, label, severity, confidence_score, details}.
    """
    now = now_epoch or _time.time()
    anomalies = []

    callsign = flight.get("callsign")
    squawk = flight.get("squawk")
    on_ground = flight.get("on_ground", False)
    baro_alt = flight.get("baro_altitude")
    velocity = flight.get("velocity")
    vertical_rate = flight.get("vertical_rate")
    last_contact = flight.get("last_contact", now)
    category = int(flight.get("category", 0) or 0)

    signal_age = max(0, now - last_contact)
    position_age = max(0, now - (flight.get("time_position") or last_contact))

    # Missing callsigns are common in OpenSky. Treat them as anomalous only
    # when the track is also stale.
    if (not callsign or callsign.strip() == "") and not on_ground and signal_age > 300:
        anomalies.append({
            "type": "ghost",
            "label": "Unidentified Stale Track",
            "severity": "low",
            "confidence_score": min(82.0, 48.0 + signal_age * 0.05),
            "details": {"reason": "No callsign and stale signal", "signal_age_seconds": signal_age},
        })

    # Emergency squawks
    if squawk == "7500":
        anomalies.append({
            "type": "squawk_7500",
            "label": "Hijack (7500)",
            "severity": "critical",
            "confidence_score": 99.0,
            "details": {"squawk": "7500"},
        })
    elif squawk == "7600":
        anomalies.append({
            "type": "squawk_7600",
            "label": "Radio Failure (7600)",
            "severity": "high",
            "confidence_score": 95.0,
            "details": {"squawk": "7600"},
        })
    elif squawk == "7700":
        anomalies.append({
            "type": "squawk_7700",
            "label": "Emergency (7700)",
            "severity": "critical",
            "confidence_score": 98.0,
            "details": {"squawk": "7700"},
        })

    # Low & fast — category-aware thresholds
    low_alt_threshold = 220
    fast_speed_threshold = 235
    if category == 8:  # rotorcraft — different envelope
        low_alt_threshold = 50
        fast_speed_threshold = 100
    elif category in (9, 10, 11, 12):  # glider/lighter-than-air/ultralight
        low_alt_threshold = 100
        fast_speed_threshold = 80

    if (
        not on_ground
        and baro_alt is not None
        and baro_alt > 0
        and baro_alt < low_alt_threshold
        and velocity is not None
        and velocity > fast_speed_threshold
    ):
        anomalies.append({
            "type": "low_fast",
            "label": "Low Fast Outlier",
            "severity": "high",
            "confidence_score": 90.0,
            "details": {"altitude_m": baro_alt, "velocity_ms": velocity, "category": category},
        })

    # Rapid descent: normal airline descents can reach 10-15 m/s. Only alert on
    # stronger descent envelopes away from the ground.
    descent_threshold = -24
    if category == 8:
        descent_threshold = -15  # helicopters descend faster normally
    elif category in (9, 12):
        descent_threshold = -10  # gliders/ultralights

    if (
        not on_ground
        and vertical_rate is not None
        and vertical_rate < descent_threshold
        and (baro_alt is None or baro_alt > 900)
        and (velocity is None or velocity > 45)
    ):
        severity = "critical" if vertical_rate < -35 else "high"
        anomalies.append({
            "type": "rapid_descent",
            "label": "Emergency Descent" if vertical_rate < -35 else "Rapid Descent Outlier",
            "severity": severity,
            "confidence_score": min(95.0, 70.0 + abs(vertical_rate) * 0.8),
            "details": {"vertical_rate_ms": vertical_rate, "category": category},
        })

    # Signal lost: require a longer stale window and stale position too.
    if not on_ground and signal_age > 300 and position_age > 240:
        age = signal_age
        anomalies.append({
            "type": "signal_lost",
            "label": "Signal Lost",
            "severity": "medium" if age > 900 else "low",
            "confidence_score": min(90.0, 50.0 + age * 0.1),
            "details": {"signal_age_seconds": age},
        })

    # Speed anomaly — category-aware
    if not on_ground and velocity is not None and baro_alt is not None:
        from ml.features import _category_envelope
        envelope = _category_envelope(category)
        if velocity > envelope["max_speed"] * 1.15:
            anomalies.append({
                "type": "speed_envelope",
                "label": f"Speed Envelope Violation (cat {category})",
                "severity": "medium",
                "confidence_score": min(90.0, 60.0 + (velocity / envelope["max_speed"]) * 20),
                "details": {
                    "velocity_ms": velocity,
                    "max_speed_ms": envelope["max_speed"],
                    "category": category,
                    "overspeed_pct": round((velocity / envelope["max_speed"] - 1) * 100, 1),
                },
            })
        elif baro_alt < 3000 and velocity > 270:
            anomalies.append({
                "type": "speed_anomaly",
                "label": "Unusual Speed",
                "severity": "medium",
                "confidence_score": 75.0,
                "details": {"velocity_ms": velocity, "altitude_m": baro_alt},
            })

    # Altitude bust — aircraft well above category max
    if not on_ground and baro_alt is not None:
        from ml.features import _category_envelope
        envelope = _category_envelope(category)
        if envelope["max_alt"] > 0 and baro_alt > envelope["max_alt"] * 1.2:
            anomalies.append({
                "type": "altitude_bust",
                "label": f"Altitude Bust (cat {category})",
                "severity": "high",
                "confidence_score": min(92.0, 60.0 + (baro_alt / envelope["max_alt"]) * 15),
                "details": {
                    "altitude_m": baro_alt,
                    "max_alt_m": envelope["max_alt"],
                    "category": category,
                },
            })

    return anomalies


# ---------------------------------------------------------------------------
# ML-based anomaly detection (3-model ensemble)
# ---------------------------------------------------------------------------

_model = None
_model_path = None


def _get_model_path():
    from django.conf import settings
    return settings.ML_MODEL_DIR / "ensemble_v2.joblib"


def _get_legacy_model_path():
    from django.conf import settings
    return settings.ML_MODEL_DIR / "isolation_forest.joblib"


def _has_feature_scaler(model):
    """Check if model has a scaler component."""
    if isinstance(model, dict):
        return "scaler" in model
    return hasattr(model, "named_steps") and "scaler" in model.named_steps


def _extract_features(flight):
    """
    Extract the feature vector for a single flight state using the
    advanced 30-feature pipeline.
    """
    from ml.features import extract_features
    return extract_features(flight).tolist()


def load_model():
    """Load the trained ensemble model from disk."""
    global _model, _model_path
    if not ML_AVAILABLE:
        return None

    # Try new ensemble format first
    path = _get_model_path()
    if path.exists():
        try:
            loaded = joblib.load(path)
            if isinstance(loaded, dict) and "scaler" in loaded:
                _model = loaded
                _model_path = path
                logger.info("Loaded ensemble model v2 from %s", path)
                return _model
        except Exception as exc:
            logger.error("Failed to load ensemble model: %s", exc)

    # Fallback to legacy single-model format
    legacy_path = _get_legacy_model_path()
    if legacy_path.exists():
        try:
            loaded = joblib.load(legacy_path)
            if _has_feature_scaler(loaded):
                # Wrap legacy model in ensemble-compatible dict
                _model = {"legacy": loaded, "type": "legacy_pipeline"}
                _model_path = legacy_path
                logger.info("Loaded legacy model from %s (compatibility mode)", legacy_path)
                return _model
        except Exception as exc:
            logger.error("Failed to load legacy model: %s", exc)

    return None


def train_model(flight_states, contamination=None):
    """
    Train a 3-model ensemble on historical flight state data.

    Models:
        1. Isolation Forest — global outlier detection
        2. Local Outlier Factor — density-based
        3. Autoencoder (MLP) — reconstruction error

    Args:
        flight_states: list of flight state dicts
        contamination: expected proportion of anomalies (auto-calculated if None)

    Returns:
        trained ensemble dict
    """
    global _model
    if not ML_AVAILABLE:
        logger.warning("Cannot train — scikit-learn not available")
        return None

    if len(flight_states) < 100:
        logger.warning("Not enough data to train (%d states, need 100+)", len(flight_states))
        return None

    from ml.features import extract_batch, compute_category_stats

    # Compute category statistics for normalization
    category_stats = compute_category_stats(flight_states)

    # Extract 30-dimensional features
    features = extract_batch(flight_states, category_stats=category_stats)

    # Remove rows with NaN/Inf
    mask = np.all(np.isfinite(features), axis=1)
    features = features[mask]

    if len(features) < 50:
        logger.warning("Too few valid samples after cleaning: %d", len(features))
        return None

    # Determine contamination
    if contamination is None:
        contamination = DEFAULT_CONTAMINATION
    contamination = min(max(contamination, 0.005), 0.03)

    # ── Model 1: Standard Scaler + Isolation Forest ──
    scaler = StandardScaler()
    scaled_features = scaler.fit_transform(features)

    isolation_forest = IsolationForest(
        n_estimators=300,
        contamination=contamination,
        max_samples="auto",
        random_state=42,
        n_jobs=-1,
    )
    isolation_forest.fit(scaled_features)
    logger.info("Isolation Forest trained on %d samples", len(scaled_features))

    # ── Model 2: Local Outlier Factor (novelty mode) ──
    lof = LocalOutlierFactor(
        n_neighbors=min(20, max(5, len(scaled_features) // 50)),
        contamination=contamination,
        novelty=True,
        n_jobs=-1,
    )
    lof.fit(scaled_features)
    logger.info("LOF trained on %d samples", len(scaled_features))

    # ── Model 3: Autoencoder (MLP reconstruction) ──
    n_features = scaled_features.shape[1]
    hidden_size = max(8, n_features // 2)
    bottleneck = max(4, n_features // 4)

    autoencoder = MLPRegressor(
        hidden_layer_sizes=(hidden_size, bottleneck, hidden_size),
        activation="relu",
        solver="adam",
        max_iter=200,
        random_state=42,
        early_stopping=True,
        validation_fraction=0.1,
        learning_rate_init=0.001,
    )
    # Train autoencoder to reconstruct its own input
    autoencoder.fit(scaled_features, scaled_features)
    logger.info("Autoencoder trained on %d samples (loss=%.4f)",
                len(scaled_features), autoencoder.loss_)

    # ── Compute reconstruction error baseline ──
    reconstructed = autoencoder.predict(scaled_features)
    reconstruction_errors = np.mean((scaled_features - reconstructed) ** 2, axis=1)
    ae_threshold = np.percentile(reconstruction_errors, (1 - contamination) * 100)

    # ── Build ensemble package ──
    ensemble = {
        "type": "ensemble_v2",
        "scaler": scaler,
        "isolation_forest": isolation_forest,
        "lof": lof,
        "autoencoder": autoencoder,
        "ae_threshold": float(ae_threshold),
        "ae_error_mean": float(np.mean(reconstruction_errors)),
        "ae_error_std": float(np.std(reconstruction_errors)),
        "category_stats": category_stats,
        "contamination": contamination,
        "n_features": n_features,
        "n_samples": len(scaled_features),
        "weights": dict(ENSEMBLE_WEIGHTS),
        "version": 2,
    }

    # Save model
    path = _get_model_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(ensemble, path)
    _model = ensemble

    logger.info(
        "Trained ensemble (IF+LOF+AE) on %d samples with %d features, saved to %s",
        len(scaled_features), n_features, path,
    )
    return ensemble


def _score_ensemble(features_scaled, ensemble):
    """
    Score a batch of scaled features using the full ensemble.

    Returns array of meta-scores in approximately [-1, 1] range.
    Negative = anomalous, positive = normal.
    """
    n = len(features_scaled)
    weights = ensemble.get("weights", ENSEMBLE_WEIGHTS)

    # ── Isolation Forest scores ──
    try:
        if_scores = ensemble["isolation_forest"].decision_function(features_scaled)
    except Exception:
        if_scores = np.zeros(n)

    # ── LOF scores ──
    try:
        lof_scores = ensemble["lof"].decision_function(features_scaled)
    except Exception:
        lof_scores = np.zeros(n)

    # ── Autoencoder reconstruction error ──
    try:
        reconstructed = ensemble["autoencoder"].predict(features_scaled)
        recon_errors = np.mean((features_scaled - reconstructed) ** 2, axis=1)
        ae_mean = ensemble.get("ae_error_mean", 0)
        ae_std = ensemble.get("ae_error_std", 1)
        # Convert error to score: higher error = more negative score
        ae_scores = -(recon_errors - ae_mean) / max(ae_std, 0.001)
    except Exception:
        ae_scores = np.zeros(n)

    # ── Weighted meta-score ──
    meta_scores = (
        weights.get("isolation_forest", 0.4) * if_scores
        + weights.get("lof", 0.3) * lof_scores
        + weights.get("autoencoder", 0.3) * ae_scores
    )

    return meta_scores


def _score_legacy(features_scaled, model):
    """Score using legacy single Pipeline model."""
    try:
        pipeline = model.get("legacy") if isinstance(model, dict) else model
        # Legacy model expects 8 features — can't use 30-feature vectors
        # Fall back to decision_function on the pipeline
        return pipeline.decision_function(features_scaled)
    except Exception:
        return np.zeros(len(features_scaled))


def score_flights(flight_states):
    """
    Score a batch of flight states using the trained ensemble.

    Returns:
        list of (flight_dict, ml_score) tuples.
        ml_score < 0 means anomaly, < -0.5 means strong anomaly.
    """
    global _model
    if not ML_AVAILABLE:
        return [(f, None) for f in flight_states]

    if _model is None:
        load_model()

    if _model is None:
        # No trained model yet — train on current batch
        if len(flight_states) >= 100:
            logger.warning(
                "COLD-START: Training model on current live batch (%d states). "
                "Scores for this cycle are unreliable — model will stabilize after first retrain.",
                len(flight_states)
            )
            train_model(flight_states)
            # Skip scoring for this cycle to avoid biased self-scoring
            return [(f, None) for f in flight_states]
        else:
            logger.info("No trained model found and not enough data to train (%d states)", len(flight_states))
            return [(f, None) for f in flight_states]

    from ml.features import extract_batch

    # Get category stats if available from the ensemble
    category_stats = None
    if isinstance(_model, dict):
        category_stats = _model.get("category_stats")

    features = extract_batch(flight_states, category_stats=category_stats)

    # Handle NaN/Inf
    mask = np.all(np.isfinite(features), axis=1)
    scores = np.zeros(len(flight_states))

    if mask.any():
        valid_features = features[mask]

        if isinstance(_model, dict) and _model.get("type") == "ensemble_v2":
            # Use ensemble scoring
            scaler = _model["scaler"]
            scaled = scaler.transform(valid_features)
            valid_scores = _score_ensemble(scaled, _model)
        elif isinstance(_model, dict) and _model.get("type") == "legacy_pipeline":
            # Legacy compatibility — extract old 8-feature vector
            from ml.features import extract_features as _new_extract
            old_features = []
            valid_states = [s for s, m in zip(flight_states, mask) if m]
            for s in valid_states:
                v = s.get("velocity") or 0
                ba = s.get("baro_altitude") or 0
                vr = s.get("vertical_rate") or 0
                tt = s.get("true_track") or 0
                og = 1.0 if s.get("on_ground") else 0.0
                lc = s.get("last_contact") or _time.time()
                sa = max(0, _time.time() - lc)
                asr = ba / max(v, 1.0)
                vap = abs(vr) / max(v, 1.0)
                old_features.append([v, ba, vr, tt/360, og, min(sa, 600), asr, vap])
            old_arr = np.array(old_features)
            pipeline = _model.get("legacy")
            try:
                valid_scores = pipeline.decision_function(old_arr)
            except Exception:
                valid_scores = np.zeros(len(old_arr))
        else:
            valid_scores = np.zeros(mask.sum())

        scores[mask] = valid_scores

    return list(zip(flight_states, scores.tolist()))


def detect_all(flight, now_epoch=None, ml_score=None):
    """
    Run both rule-based and ML detection on a single flight.

    Returns:
        list of anomaly dicts with combined scoring.
    """
    rule_anomalies = detect_rule_based(flight, now_epoch)

    if ml_score is None:
        scored = score_flights([flight])
        ml_score = scored[0][1] if scored else None

    # Require a strong ensemble outlier before creating ML-only events.
    if ml_score is not None and ml_score < ML_ANOMALY_THRESHOLD and not rule_anomalies:
        confidence = min(95.0, 50.0 + abs(ml_score) * 50)
        severity = "high" if ml_score < ML_ANOMALY_HIGH_THRESHOLD else "medium"
        rule_anomalies.append({
            "type": "ml_anomaly",
            "label": "ML-Detected Anomaly",
            "severity": severity,
            "confidence_score": confidence,
            "ml_score": ml_score,
            "details": {
                "ml_raw_score": ml_score,
                "ensemble_type": "IF+LOF+AE" if isinstance(_model, dict) and _model.get("type") == "ensemble_v2" else "legacy",
            },
        })

    # Attach ML score to existing anomalies
    for a in rule_anomalies:
        if "ml_score" not in a:
            a["ml_score"] = ml_score

    return rule_anomalies
