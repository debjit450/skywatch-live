"""Generate plain-English anomaly explanations from recent state context."""

import math


def _factor(factor, value, deviation, description, severity="medium"):
    return {
        "factor": factor,
        "value": value,
        "deviation": deviation,
        "description": description,
        "severity": severity,
    }


def explain_anomaly(flight, anomaly, history=None):
    history = history or []
    factors = []
    altitude = flight.get("baro_altitude")
    speed = flight.get("velocity")
    vertical_rate = flight.get("vertical_rate")

    if anomaly.get("type") == "rapid_descent" or (vertical_rate is not None and vertical_rate < -20):
        fpm = vertical_rate * 196.8504 if vertical_rate is not None else 0
        factors.append(_factor(
            "Altitude",
            round(fpm),
            f"{round(fpm):,} ft/min",
            f"Altitude dropped at {round(abs(fpm)):,} ft/min.",
            "high" if fpm < -5000 else "medium",
        ))

    if speed is not None and speed > 270:
        factors.append(_factor(
            "Speed",
            round(speed * 1.94384),
            "above expected envelope",
            "Speed is above the typical cruise envelope for this altitude/category.",
            "medium",
        ))

    headings = [item.true_track for item in history if item.true_track is not None]
    if len(headings) >= 2:
        diff = abs((headings[-1] - headings[0] + 180) % 360 - 180)
        if diff > 70:
            factors.append(_factor(
                "Heading",
                round(diff),
                f"{round(diff)} deg",
                f"Heading changed {round(diff)} degrees over the recent track window.",
                "medium",
            ))

    details = anomaly.get("details") or {}
    for key in ("signal_age_seconds", "distance_nm", "overspeed_pct", "velocity_z_score", "altitude_z_score"):
        value = details.get(key)
        if isinstance(value, (int, float)) and math.isfinite(value):
            factors.append(_factor(
                key.replace("_", " ").title(),
                round(value, 2),
                "model/rule contribution",
                f"{key.replace('_', ' ')} contributed to the anomaly score.",
                anomaly.get("severity", "medium"),
            ))

    if not factors:
        factors.append(_factor(
            anomaly.get("label") or anomaly.get("type", "Anomaly"),
            round(anomaly.get("confidence_score", 0), 2),
            "combined detector agreement",
            "The combined detector found this track outside normal operating patterns.",
            anomaly.get("severity", "medium"),
        ))
    return factors
