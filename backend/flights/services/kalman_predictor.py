"""
Extended Kalman Filter for flight position prediction.

6-state EKF with state vector:
    [latitude, longitude, velocity, heading, vertical_rate, altitude]

Advantages over linear dead-reckoning:
  - Models turn rate → curved trajectory prediction
  - Models acceleration → speed changes during climb/descent
  - Measurement noise filtering → smoother position estimates
  - Adaptive process noise → uncertainty grows correctly with time
  - Per-source measurement noise → ADS-B trusted more than MLAT
"""

import math
import logging
import numpy as np

logger = logging.getLogger(__name__)

EARTH_RADIUS_M = 6_371_000
DEG_TO_RAD = math.pi / 180
RAD_TO_DEG = 180 / math.pi

# Per-source measurement noise (position std in meters)
SOURCE_NOISE = {
    0: 50,    # ADS-B — high quality
    1: 120,   # ASTERIX
    2: 350,   # MLAT — lower quality
    3: 180,   # FLARM
    4: 200,   # Radar
    5: 100,   # UAT
    6: 500,   # Satellite
}
DEFAULT_NOISE = 300


class KalmanPredictor:
    """
    Extended Kalman Filter for single-aircraft trajectory prediction.

    State: [lat, lon, velocity_ms, heading_deg, vertical_rate_ms, altitude_m]
    """

    def __init__(self, position_source=0):
        self.state = np.zeros(6)  # [lat, lon, vel, hdg, vr, alt]
        self.P = np.eye(6) * 1000  # Large initial uncertainty
        self.initialized = False
        self.last_update_time = 0
        self.position_source = position_source

        # Process noise tuning
        self.q_position = 0.00001   # lat/lon process noise
        self.q_velocity = 2.0       # m/s² velocity noise
        self.q_heading = 0.5        # deg/s heading noise
        self.q_vertical = 1.0       # m/s² vertical rate noise
        self.q_altitude = 5.0       # m altitude noise

    def _state_transition(self, dt):
        """
        Non-linear state transition for dt seconds.
        Returns predicted state.
        """
        lat = self.state[0]
        lon = self.state[1]
        vel = self.state[2]
        hdg = self.state[3]
        vr = self.state[4]
        alt = self.state[5]

        hdg_rad = hdg * DEG_TO_RAD
        distance = vel * dt

        # Great-circle forward projection
        lat_rad = lat * DEG_TO_RAD
        ang_dist = distance / EARTH_RADIUS_M

        new_lat_rad = math.asin(
            math.sin(lat_rad) * math.cos(ang_dist)
            + math.cos(lat_rad) * math.sin(ang_dist) * math.cos(hdg_rad)
        )
        new_lon_rad = lon * DEG_TO_RAD + math.atan2(
            math.sin(hdg_rad) * math.sin(ang_dist) * math.cos(lat_rad),
            math.cos(ang_dist) - math.sin(lat_rad) * math.sin(new_lat_rad),
        )

        new_lat = new_lat_rad * RAD_TO_DEG
        new_lon = ((new_lon_rad * RAD_TO_DEG + 180) % 360) - 180
        new_alt = max(0, alt + vr * dt)

        return np.array([new_lat, new_lon, vel, hdg, vr, new_alt])

    def _jacobian_F(self, dt):
        """
        Linearized state transition Jacobian (6×6).
        """
        vel = self.state[2]
        hdg = self.state[3] * DEG_TO_RAD
        lat = self.state[0] * DEG_TO_RAD

        F = np.eye(6)
        # Partial derivatives of position w.r.t. velocity and heading
        dlat_dvel = dt * math.cos(hdg) / EARTH_RADIUS_M * RAD_TO_DEG
        dlat_dhdg = -dt * vel * math.sin(hdg) / EARTH_RADIUS_M * RAD_TO_DEG * DEG_TO_RAD
        cos_lat = max(math.cos(lat), 0.01)
        dlon_dvel = dt * math.sin(hdg) / (EARTH_RADIUS_M * cos_lat) * RAD_TO_DEG
        dlon_dhdg = dt * vel * math.cos(hdg) / (EARTH_RADIUS_M * cos_lat) * RAD_TO_DEG * DEG_TO_RAD

        F[0, 2] = dlat_dvel
        F[0, 3] = dlat_dhdg
        F[1, 2] = dlon_dvel
        F[1, 3] = dlon_dhdg
        F[5, 4] = dt  # altitude changes with vertical rate

        return F

    def _process_noise(self, dt):
        """Build process noise covariance matrix Q."""
        Q = np.diag([
            self.q_position * dt ** 2,
            self.q_position * dt ** 2,
            self.q_velocity * dt,
            self.q_heading * dt,
            self.q_vertical * dt,
            self.q_altitude * dt,
        ])
        return Q

    def _measurement_noise(self, position_source=None):
        """Build measurement noise covariance matrix R."""
        src = position_source if position_source is not None else self.position_source
        pos_noise = SOURCE_NOISE.get(src, DEFAULT_NOISE)
        # Convert position noise from meters to approximate degrees
        pos_noise_deg = pos_noise / 111_000  # ~111km per degree

        R = np.diag([
            pos_noise_deg ** 2,     # lat noise
            pos_noise_deg ** 2,     # lon noise
            25.0,                    # velocity noise (m/s)²
            9.0,                     # heading noise (deg)²
            4.0,                     # vertical rate noise (m/s)²
            100.0,                   # altitude noise (m)²
        ])
        return R

    def initialize(self, lat, lon, velocity, heading, vertical_rate, altitude,
                   timestamp, position_source=0):
        """Initialize filter with first observation."""
        self.state = np.array([
            lat, lon, velocity or 0, heading or 0,
            vertical_rate or 0, altitude or 0
        ], dtype=np.float64)
        self.position_source = position_source
        self.last_update_time = timestamp

        pos_noise = SOURCE_NOISE.get(position_source, DEFAULT_NOISE)
        pos_noise_deg = pos_noise / 111_000
        self.P = np.diag([
            pos_noise_deg ** 2,
            pos_noise_deg ** 2,
            100.0,
            25.0,
            9.0,
            400.0,
        ])
        self.initialized = True

    def predict(self, target_time):
        """
        Predict state at target_time without updating.

        Returns dict with predicted state and uncertainty.
        """
        if not self.initialized:
            return None

        dt = max(0, target_time - self.last_update_time)
        if dt > 600:  # > 10 minutes — prediction unreliable
            return None

        predicted_state = self._state_transition(dt)

        # Propagate uncertainty
        F = self._jacobian_F(dt)
        Q = self._process_noise(dt)
        predicted_P = F @ self.P @ F.T + Q

        # Position uncertainty in meters
        lat_std = math.sqrt(predicted_P[0, 0]) * 111_000
        lon_std = math.sqrt(predicted_P[1, 1]) * 111_000 * max(
            math.cos(math.radians(predicted_state[0])), 0.01
        )
        position_uncertainty_m = math.sqrt(lat_std ** 2 + lon_std ** 2)

        return {
            "latitude": predicted_state[0],
            "longitude": predicted_state[1],
            "velocity": predicted_state[2],
            "heading": predicted_state[3] % 360,
            "vertical_rate": predicted_state[4],
            "altitude": max(0, predicted_state[5]),
            "uncertainty_m": position_uncertainty_m,
            "uncertainty_nm": position_uncertainty_m / 1852,
            "dt_seconds": dt,
            "confidence": max(0.05, 1.0 - dt / 600),
        }

    def update(self, lat, lon, velocity, heading, vertical_rate, altitude,
               timestamp, position_source=None):
        """
        Update filter with a new measurement.

        Performs predict-then-update (standard EKF cycle).
        """
        if not self.initialized:
            self.initialize(lat, lon, velocity, heading, vertical_rate,
                          altitude, timestamp, position_source or 0)
            return

        dt = timestamp - self.last_update_time
        if dt <= 0:
            return
        if dt > 600:
            # Gap too large — reinitialize
            self.initialize(lat, lon, velocity, heading, vertical_rate,
                          altitude, timestamp, position_source or self.position_source)
            return

        # ── Predict step ──
        predicted_state = self._state_transition(dt)
        F = self._jacobian_F(dt)
        Q = self._process_noise(dt)
        predicted_P = F @ self.P @ F.T + Q

        # ── Update step ──
        measurement = np.array([
            lat, lon, velocity or predicted_state[2],
            heading or predicted_state[3],
            vertical_rate if vertical_rate is not None else predicted_state[4],
            altitude or predicted_state[5],
        ])

        # Handle heading wraparound
        hdg_diff = measurement[3] - predicted_state[3]
        if hdg_diff > 180:
            measurement[3] -= 360
        elif hdg_diff < -180:
            measurement[3] += 360

        H = np.eye(6)  # Direct observation of all states
        R = self._measurement_noise(position_source)

        innovation = measurement - predicted_state
        S = H @ predicted_P @ H.T + R
        try:
            K = predicted_P @ H.T @ np.linalg.inv(S)
        except np.linalg.LinAlgError:
            logger.warning("Kalman gain computation failed — using prediction only")
            self.state = predicted_state
            self.P = predicted_P
            self.last_update_time = timestamp
            return

        self.state = predicted_state + K @ innovation
        self.P = (np.eye(6) - K @ H) @ predicted_P

        # Normalize heading
        self.state[3] = self.state[3] % 360
        # Clamp altitude
        self.state[5] = max(0, self.state[5])

        self.last_update_time = timestamp
        if position_source is not None:
            self.position_source = position_source


# ─── Predictor cache (per-aircraft) ──────────────────────────────────────────

_predictors = {}
_MAX_PREDICTORS = 5000


def get_predictor(icao24, position_source=0):
    """Get or create a Kalman predictor for an aircraft."""
    if icao24 in _predictors:
        return _predictors[icao24]

    # Evict oldest if cache full
    if len(_predictors) >= _MAX_PREDICTORS:
        oldest_key = min(_predictors, key=lambda k: _predictors[k].last_update_time)
        del _predictors[oldest_key]

    predictor = KalmanPredictor(position_source)
    _predictors[icao24] = predictor
    return predictor


def predict_flight(flight, target_time=None):
    """
    Predict a flight's state using the Kalman filter.

    Args:
        flight: flight state dict
        target_time: target prediction epoch (defaults to now)

    Returns:
        prediction dict or None
    """
    import time
    icao24 = flight.get("icao24")
    if not icao24:
        return None

    lat = flight.get("latitude")
    lon = flight.get("longitude")
    if lat is None or lon is None:
        return None

    velocity = flight.get("velocity")
    heading = flight.get("true_track")
    vr = flight.get("vertical_rate")
    altitude = flight.get("baro_altitude") or flight.get("geo_altitude")
    timestamp = flight.get("time_position") or flight.get("last_contact") or time.time()
    position_source = flight.get("position_source", 0)

    predictor = get_predictor(icao24, position_source)
    predictor.update(lat, lon, velocity, heading, vr, altitude,
                     timestamp, position_source)

    now = target_time or time.time()
    return predictor.predict(now)


def clear_predictors():
    """Clear the predictor cache."""
    global _predictors
    _predictors = {}
