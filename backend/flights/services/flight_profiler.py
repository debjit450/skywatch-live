"""
Per-aircraft behavioral profiling using Exponential Moving Average (EMA).

Tracks rolling statistics per ICAO24: mean velocity, mean altitude,
typical heading variance, and operating patterns. Flags when current
behavior deviates significantly from the aircraft's own historical profile.
"""

import logging
import math

logger = logging.getLogger(__name__)

# EMA smoothing factor (0 < alpha < 1). Lower = more history weight.
EMA_ALPHA = 0.05
MIN_OBSERVATIONS = 20


def _safe_float(value, default=0.0):
    if value is None:
        return default
    try:
        v = float(value)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def update_profile(profile_data, flight_state):
    """
    Update an aircraft's behavioral profile with a new observation.

    Args:
        profile_data: dict with current profile stats (mutated in place)
        flight_state: dict with current flight state

    Returns:
        updated profile_data dict
    """
    if flight_state.get("on_ground", False):
        return profile_data

    velocity = _safe_float(flight_state.get("velocity"))
    altitude = _safe_float(flight_state.get("baro_altitude"))
    vertical_rate = _safe_float(flight_state.get("vertical_rate"))
    heading = _safe_float(flight_state.get("true_track"))

    if velocity <= 0 and altitude <= 0:
        return profile_data

    count = profile_data.get("observation_count", 0)
    alpha = EMA_ALPHA

    if count == 0:
        # First observation — initialize
        profile_data["avg_velocity"] = velocity
        profile_data["avg_altitude"] = altitude
        profile_data["avg_vertical_rate"] = abs(vertical_rate)
        profile_data["var_velocity"] = 0.0
        profile_data["var_altitude"] = 0.0
        profile_data["var_heading"] = 0.0
        profile_data["min_velocity"] = velocity
        profile_data["max_velocity"] = velocity
        profile_data["min_altitude"] = altitude
        profile_data["max_altitude"] = altitude
        profile_data["heading_sin_sum"] = math.sin(math.radians(heading))
        profile_data["heading_cos_sum"] = math.cos(math.radians(heading))
    else:
        # EMA update
        old_avg_vel = profile_data.get("avg_velocity", velocity)
        old_avg_alt = profile_data.get("avg_altitude", altitude)
        old_avg_vr = profile_data.get("avg_vertical_rate", abs(vertical_rate))

        new_avg_vel = old_avg_vel * (1 - alpha) + velocity * alpha
        new_avg_alt = old_avg_alt * (1 - alpha) + altitude * alpha
        new_avg_vr = old_avg_vr * (1 - alpha) + abs(vertical_rate) * alpha

        # EMA variance (Welford-like for EMA)
        old_var_vel = profile_data.get("var_velocity", 0)
        old_var_alt = profile_data.get("var_altitude", 0)

        new_var_vel = (1 - alpha) * (old_var_vel + alpha * (velocity - old_avg_vel) ** 2)
        new_var_alt = (1 - alpha) * (old_var_alt + alpha * (altitude - old_avg_alt) ** 2)

        profile_data["avg_velocity"] = new_avg_vel
        profile_data["avg_altitude"] = new_avg_alt
        profile_data["avg_vertical_rate"] = new_avg_vr
        profile_data["var_velocity"] = new_var_vel
        profile_data["var_altitude"] = new_var_alt

        # Track extremes
        profile_data["min_velocity"] = min(profile_data.get("min_velocity", velocity), velocity)
        profile_data["max_velocity"] = max(profile_data.get("max_velocity", velocity), velocity)
        profile_data["min_altitude"] = min(profile_data.get("min_altitude", altitude), altitude)
        profile_data["max_altitude"] = max(profile_data.get("max_altitude", altitude), altitude)

        # Heading variance via circular statistics
        h_sin = profile_data.get("heading_sin_sum", 0) * (1 - alpha) + math.sin(math.radians(heading)) * alpha
        h_cos = profile_data.get("heading_cos_sum", 0) * (1 - alpha) + math.cos(math.radians(heading)) * alpha
        profile_data["heading_sin_sum"] = h_sin
        profile_data["heading_cos_sum"] = h_cos
        # Circular variance: 1 - R (where R = sqrt(sin² + cos²))
        R = math.sqrt(h_sin ** 2 + h_cos ** 2)
        profile_data["var_heading"] = 1.0 - min(R, 1.0)

    profile_data["observation_count"] = count + 1

    # Computed std deviations
    profile_data["std_velocity"] = math.sqrt(max(profile_data.get("var_velocity", 0), 0))
    profile_data["std_altitude"] = math.sqrt(max(profile_data.get("var_altitude", 0), 0))

    return profile_data


def get_profile_summary(profile_data):
    """
    Get a summary dict suitable for anomaly detection.

    Returns dict compatible with detect_behavioral_deviation().
    """
    if not profile_data or profile_data.get("observation_count", 0) < MIN_OBSERVATIONS:
        return None

    return {
        "avg_velocity": profile_data.get("avg_velocity", 0),
        "std_velocity": max(profile_data.get("std_velocity", 10), 5),
        "avg_altitude": profile_data.get("avg_altitude", 0),
        "std_altitude": max(profile_data.get("std_altitude", 500), 200),
        "avg_vertical_rate": profile_data.get("avg_vertical_rate", 0),
        "typical_heading_variance": profile_data.get("var_heading", 0),
        "observation_count": profile_data.get("observation_count", 0),
        "velocity_range": [
            profile_data.get("min_velocity", 0),
            profile_data.get("max_velocity", 0),
        ],
        "altitude_range": [
            profile_data.get("min_altitude", 0),
            profile_data.get("max_altitude", 0),
        ],
    }


def bulk_update_profiles(aircraft_profiles, flight_states):
    """
    Update profiles for a batch of flight states.

    Args:
        aircraft_profiles: dict of {icao24: profile_data}
        flight_states: list of flight state dicts

    Returns:
        set of icao24s that were updated
    """
    updated = set()

    for state in flight_states:
        icao24 = state.get("icao24")
        if not icao24 or state.get("on_ground", False):
            continue

        if icao24 not in aircraft_profiles:
            aircraft_profiles[icao24] = {}

        update_profile(aircraft_profiles[icao24], state)
        updated.add(icao24)

    return updated
