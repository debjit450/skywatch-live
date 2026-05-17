"""
Advanced feature engineering pipeline for flight anomaly detection.

Extracts 30-dimensional normalized feature vectors from flight state data
organized into six feature groups: kinematic, temporal derivatives,
aircraft-type-normalized, geospatial, interaction, and phase-aware.
"""

import math
import time
import numpy as np


# ─── Feature group names for interpretability ────────────────────────────────

KINEMATIC_FEATURES = [
    "velocity_ms",
    "baro_altitude_m",
    "vertical_rate_ms",
    "heading_sin",
    "heading_cos",
    "ground_speed_ratio",
    "mach_estimate",
    "altitude_rate_of_change",
]

TEMPORAL_FEATURES = [
    "acceleration_proxy",
    "altitude_jerk",
    "heading_rate",
    "signal_freshness_decay",
    "position_staleness",
    "contact_gap_ratio",
]

CATEGORY_FEATURES = [
    "velocity_z_for_category",
    "altitude_z_for_category",
    "vertical_rate_z_for_category",
    "speed_envelope_violation",
]

GEOSPATIAL_FEATURES = [
    "latitude_band",
    "longitude_band",
    "heading_consistency",
    "ground_track_curvature",
]

INTERACTION_FEATURES = [
    "altitude_velocity_product",
    "vertical_energy_rate",
    "kinetic_energy_proxy",
    "drag_coefficient_proxy",
]

PHASE_FEATURES = [
    "estimated_flight_phase",
    "phase_altitude_deviation",
    "phase_speed_deviation",
    "altitude_speed_ratio",
]

FEATURE_NAMES = (
    KINEMATIC_FEATURES
    + TEMPORAL_FEATURES
    + CATEGORY_FEATURES
    + GEOSPATIAL_FEATURES
    + INTERACTION_FEATURES
    + PHASE_FEATURES
)

NUM_FEATURES = len(FEATURE_NAMES)  # 30

# ─── Aircraft category speed/altitude envelopes ──────────────────────────────

# Typical max speed (m/s) and max altitude (m) per ICAO ADS-B category
CATEGORY_ENVELOPES = {
    0:  {"max_speed": 300, "max_alt": 15000, "label": "unknown"},
    1:  {"max_speed": 100, "max_alt": 5000,  "label": "no_category"},
    2:  {"max_speed": 80,  "max_alt": 6000,  "label": "light"},
    3:  {"max_speed": 170, "max_alt": 10000, "label": "small"},
    4:  {"max_speed": 260, "max_alt": 13000, "label": "large"},
    5:  {"max_speed": 270, "max_alt": 13000, "label": "high_vortex"},
    6:  {"max_speed": 290, "max_alt": 14000, "label": "heavy"},
    7:  {"max_speed": 340, "max_alt": 18000, "label": "high_performance"},
    8:  {"max_speed": 90,  "max_alt": 4500,  "label": "rotorcraft"},
    9:  {"max_speed": 70,  "max_alt": 8000,  "label": "glider"},
    10: {"max_speed": 40,  "max_alt": 6000,  "label": "lighter_than_air"},
    11: {"max_speed": 30,  "max_alt": 4500,  "label": "parachutist"},
    12: {"max_speed": 50,  "max_alt": 5000,  "label": "ultralight"},
    14: {"max_speed": 100, "max_alt": 6000,  "label": "uav"},
    15: {"max_speed": 300, "max_alt": 100000,"label": "space"},
    16: {"max_speed": 40,  "max_alt": 0,     "label": "surface_emergency"},
    17: {"max_speed": 30,  "max_alt": 0,     "label": "surface_service"},
}

# ISA constants for Mach estimation
ISA_T0 = 288.15
ISA_LAPSE = 0.0065
ISA_GAMMA = 1.4
ISA_R = 287.05


def _safe_float(value, default=0.0):
    """Convert to float safely, returning default for None/NaN."""
    if value is None:
        return default
    try:
        v = float(value)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _estimate_mach(velocity_ms, baro_alt_m):
    """Estimate Mach number using ISA temperature lapse."""
    if velocity_ms <= 0 or baro_alt_m is None:
        return 0.0
    alt_clamped = min(max(_safe_float(baro_alt_m), 0), 11000)
    temp_k = ISA_T0 - ISA_LAPSE * alt_clamped
    if temp_k <= 0:
        return 0.0
    speed_of_sound = math.sqrt(ISA_GAMMA * ISA_R * temp_k)
    return velocity_ms / speed_of_sound


def _estimate_phase(altitude, velocity, vertical_rate, on_ground):
    """
    Estimate flight phase as a numeric encoding.
    0=ground, 1=takeoff, 2=climb, 3=cruise, 4=descent, 5=approach
    """
    if on_ground:
        return 0.0
    alt = _safe_float(altitude)
    spd = _safe_float(velocity)
    vr = _safe_float(vertical_rate)

    if alt < 900 and spd > 55 and vr >= -1:
        return 1.0  # takeoff
    if vr > 2:
        return 2.0  # climb
    if vr < -2:
        return 5.0 if alt < 1500 else 4.0  # approach or descent
    if alt > 6100:
        return 3.0  # cruise
    if alt < 1500 and spd < 125:
        return 5.0  # approach
    return 3.0  # cruise


def _category_envelope(category):
    """Get the speed/altitude envelope for a category."""
    return CATEGORY_ENVELOPES.get(int(category) if category else 0,
                                   CATEGORY_ENVELOPES[0])


def extract_features(flight_state, now_epoch=None, category_stats=None):
    """
    Extract 30-dimensional feature vector from a single flight state dict.

    Args:
        flight_state: dict with flight fields
        now_epoch: current epoch seconds (defaults to time.time())
        category_stats: optional dict of {category: {mean_speed, std_speed, mean_alt, std_alt, mean_vr, std_vr}}
                        for z-score normalization

    Returns:
        numpy array of shape (30,)
    """
    now = now_epoch or time.time()

    # ── Raw values ────────────────────────────────────────────────────────
    velocity = _safe_float(flight_state.get("velocity"))
    baro_alt = _safe_float(flight_state.get("baro_altitude"))
    geo_alt = _safe_float(flight_state.get("geo_altitude"))
    altitude = baro_alt if baro_alt != 0 else geo_alt
    vertical_rate = _safe_float(flight_state.get("vertical_rate"))
    true_track = _safe_float(flight_state.get("true_track"))
    on_ground = bool(flight_state.get("on_ground", False))
    last_contact = _safe_float(flight_state.get("last_contact"), now)
    time_position = _safe_float(flight_state.get("time_position"), last_contact)
    category = int(_safe_float(flight_state.get("category", 0)))
    latitude = _safe_float(flight_state.get("latitude"))
    longitude = _safe_float(flight_state.get("longitude"))

    signal_age = max(0, now - last_contact)
    position_age = max(0, now - time_position) if time_position else signal_age
    envelope = _category_envelope(category)

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP 1: Kinematic features (8)
    # ═══════════════════════════════════════════════════════════════════════
    heading_rad = math.radians(true_track) if true_track else 0
    heading_sin = math.sin(heading_rad)
    heading_cos = math.cos(heading_rad)
    ground_speed_ratio = velocity / max(envelope["max_speed"], 1)
    mach = _estimate_mach(velocity, baro_alt)
    alt_rate = vertical_rate  # direct vertical rate as altitude rate of change

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP 2: Temporal derivative features (6)
    # ═══════════════════════════════════════════════════════════════════════
    # Without historical state, these are proxy values
    acceleration_proxy = abs(vertical_rate) / max(velocity, 1.0)
    altitude_jerk = abs(vertical_rate) / max(altitude, 100)  # rate relative to altitude

    # ALWAYS_CONSTANT: These temporal features require state history to calculate properly.
    # They are hardcoded to 0.0 for now until the state buffer is fully integrated.
    heading_rate = 0.0
    signal_decay = 1.0 / (1.0 + signal_age / 60.0)  # exponential decay
    position_stale = min(position_age / 600.0, 1.0)  # normalized [0, 1]
    contact_gap = min(signal_age, 600) / 600.0 if signal_age > 0 else 0.0

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP 3: Aircraft-type-normalized features (4)
    # ═══════════════════════════════════════════════════════════════════════
    if category_stats and category in category_stats:
        stats = category_stats[category]
        vel_z = (velocity - stats.get("mean_speed", 200)) / max(stats.get("std_speed", 50), 1)
        alt_z = (altitude - stats.get("mean_alt", 8000)) / max(stats.get("std_alt", 3000), 1)
        vr_z = (abs(vertical_rate) - stats.get("mean_vr", 2)) / max(stats.get("std_vr", 5), 0.1)
    else:
        # Fallback: use envelope-based normalization
        vel_z = (velocity - envelope["max_speed"] * 0.6) / max(envelope["max_speed"] * 0.3, 1)
        alt_z = (altitude - envelope["max_alt"] * 0.5) / max(envelope["max_alt"] * 0.3, 1)
        vr_z = abs(vertical_rate) / 10.0  # 10 m/s as typical scale

    speed_envelope_violation = max(0, velocity - envelope["max_speed"]) / max(envelope["max_speed"], 1)

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP 4: Geospatial features (4)
    # ═══════════════════════════════════════════════════════════════════════
    # Latitude band: -1 (polar) to 1 (equatorial)
    lat_band = 1.0 - abs(latitude) / 90.0 if abs(latitude) <= 90 else 0.5
    # Longitude band: normalized to [-1, 1]
    lon_band = longitude / 180.0 if abs(longitude) <= 180 else 0.0

    # ALWAYS_CONSTANT: These geospatial features require heading history to calculate properly.
    # They are hardcoded to constant values until the state buffer is fully integrated.
    heading_consistency = 1.0
    curvature = 0.0

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP 5: Interaction features (4)
    # ═══════════════════════════════════════════════════════════════════════
    alt_vel_product = (altitude * velocity) / 1e6  # scaled product
    vertical_energy = vertical_rate * velocity / 1e4 if velocity > 0 else 0
    kinetic_energy = 0.5 * velocity * velocity / 1e4  # scaled KE proxy
    drag_proxy = velocity * velocity / max(altitude, 100) / 1e3  # crude drag estimate

    # ═══════════════════════════════════════════════════════════════════════
    # GROUP 6: Phase-aware features (4)
    # ═══════════════════════════════════════════════════════════════════════
    phase = _estimate_phase(altitude, velocity, vertical_rate, on_ground)

    # Phase-typical altitude and speed
    PHASE_TYPICAL = {
        0: (0, 0),
        1: (500, 80),
        2: (4000, 180),
        3: (10000, 240),
        4: (6000, 200),
        5: (1000, 120),
    }
    typical_alt, typical_speed = PHASE_TYPICAL.get(int(phase), (5000, 150))
    phase_alt_dev = (altitude - typical_alt) / max(typical_alt, 100)
    phase_speed_dev = (velocity - typical_speed) / max(typical_speed, 10)
    alt_speed_ratio = altitude / max(velocity, 1.0)

    return np.array([
        # Kinematic (8)
        velocity,
        baro_alt,
        vertical_rate,
        heading_sin,
        heading_cos,
        ground_speed_ratio,
        mach,
        alt_rate,
        # Temporal (6)
        acceleration_proxy,
        altitude_jerk,
        heading_rate,
        signal_decay,
        position_stale,
        contact_gap,
        # Category-normalized (4)
        vel_z,
        alt_z,
        vr_z,
        speed_envelope_violation,
        # Geospatial (4)
        lat_band,
        lon_band,
        heading_consistency,
        curvature,
        # Interaction (4)
        alt_vel_product,
        vertical_energy,
        kinetic_energy,
        drag_proxy,
        # Phase (4)
        phase / 5.0,  # normalize to [0, 1]
        phase_alt_dev,
        phase_speed_dev,
        alt_speed_ratio,
    ], dtype=np.float64)


def extract_batch(flight_states, now_epoch=None, category_stats=None):
    """
    Extract features for a batch of flight states.

    Returns numpy array of shape (N, 30).
    """
    features = np.array([
        extract_features(s, now_epoch, category_stats) for s in flight_states
    ])
    features = np.nan_to_num(features, nan=0.0, posinf=1e6, neginf=-1e6)
    return features


def compute_category_stats(flight_states):
    """
    Compute per-category statistics from a batch of flight states.

    Returns dict of {category: {mean_speed, std_speed, mean_alt, std_alt, mean_vr, std_vr}}.
    """
    from collections import defaultdict
    buckets = defaultdict(lambda: {"speeds": [], "alts": [], "vrs": []})

    for s in flight_states:
        if s.get("on_ground"):
            continue
        cat = int(_safe_float(s.get("category", 0)))
        v = _safe_float(s.get("velocity"))
        a = _safe_float(s.get("baro_altitude"))
        vr = _safe_float(s.get("vertical_rate"))
        if v > 0:
            buckets[cat]["speeds"].append(v)
        if a > 0:
            buckets[cat]["alts"].append(a)
        buckets[cat]["vrs"].append(abs(vr))

    stats = {}
    for cat, data in buckets.items():
        if len(data["speeds"]) < 10:
            continue
        speeds = np.array(data["speeds"])
        alts = np.array(data["alts"]) if data["alts"] else np.array([0])
        vrs = np.array(data["vrs"])
        stats[cat] = {
            "mean_speed": float(np.mean(speeds)),
            "std_speed": float(np.std(speeds)) or 1.0,
            "mean_alt": float(np.mean(alts)),
            "std_alt": float(np.std(alts)) or 1.0,
            "mean_vr": float(np.mean(vrs)),
            "std_vr": float(np.std(vrs)) or 0.1,
        }
    return stats


def normalize_features(features, scaler=None):
    """
    Optionally normalize features using StandardScaler.

    Args:
        features: numpy array of shape (N, 30)
        scaler: fitted StandardScaler, or None for raw features

    Returns:
        normalized features, scaler
    """
    if scaler is None:
        from sklearn.preprocessing import StandardScaler
        scaler = StandardScaler()
        normalized = scaler.fit_transform(features)
        return normalized, scaler
    return scaler.transform(features), scaler
