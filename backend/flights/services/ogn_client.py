"""
Open Glider Network (OGN) / FLARM data source client.

Fetches glider and small aircraft positions from the OGN APRS gateway.
Uses a polling HTTP approach via the OGN DDB (device database) and
live APRS-IS feed for real-time positions.

The OGN aggregates FLARM transponder data from a network of ground-based
receivers with a typical range of 20–100 km, primarily covering glider
and ultralight traffic in Europe.
"""

import logging
import hashlib
import math
import re
import socket
import time
import threading

logger = logging.getLogger(__name__)

OGN_APRS_HOST = "aprs.glidernet.org"
OGN_APRS_PORT = 14580
OGN_APRS_FILTER = "r/0/0/25000"  # global radius
REQUEST_TIMEOUT = 15
FT_TO_M = 0.3048
KT_TO_MS = 0.514444
FPM_TO_MS = 0.00508

# OGN device types
DEVICE_TYPES = {
    1: "Glider",
    2: "Tow Plane",
    3: "Helicopter (rotorcraft)",
    4: "Skydiver",
    5: "Drop Plane",
    6: "Hang Glider",
    7: "Paraglider",
    8: "Powered Aircraft",
    9: "Jet Aircraft",
    10: "UFO",
    11: "Balloon",
    12: "Airship",
    13: "UAV/Drone",
    14: "Static Object",
    15: "Emergency Vehicle",
}

# Category mapping for OGN device types
OGN_CATEGORY_MAP = {
    1: 9,   # Glider → B1
    2: 2,   # Tow Plane → A1 (light)
    3: 8,   # Helicopter → A7 (rotorcraft) -- but we use cat 8 internally
    4: 0,   # Skydiver
    5: 2,   # Drop Plane → A1
    6: 9,   # Hang Glider → B1
    7: 9,   # Paraglider → B1
    8: 2,   # Powered Aircraft → A1
    9: 4,   # Jet → A3
    13: 14,  # Drone → B6
}

# Regex for APRS position reports from OGN
_APRS_POSITION_RE = re.compile(
    r"^(?P<callsign>[A-Za-z0-9_-]+)>APRS,"
    r".*?:"
    r"/(?P<time>\d{6})h"
    r"(?P<lat>\d{4}\.\d{2})(?P<lat_ns>[NS])"
    r"."
    r"(?P<lon>\d{5}\.\d{2})(?P<lon_ew>[EW])"
    r"."
    r"(?P<course>\d{3})/(?P<speed>\d{3})"
    r"/A=(?P<alt>\d{6})"
    r"(?P<comment>.*)"
)

# OGN extension fields in APRS comments
_OGN_COMMENT_RE = re.compile(
    r"id(?P<id_type>[0-9A-Fa-f]{2})(?P<id_hex>[0-9A-Fa-f]{6})"
    r"(?:\s+(?P<climb>[+-]?\d+)fpm)?"
    r"(?:\s+(?P<turn>[+-]?\d+(?:\.\d+)?)rot)?"
)


def _parse_aprs_latitude(raw, ns):
    """Convert APRS latitude (DDMM.MM) to decimal degrees."""
    degrees = int(raw[:2])
    minutes = float(raw[2:])
    decimal = degrees + minutes / 60.0
    return -decimal if ns == "S" else decimal


def _parse_aprs_longitude(raw, ew):
    """Convert APRS longitude (DDDMM.MM) to decimal degrees."""
    degrees = int(raw[:3])
    minutes = float(raw[3:])
    decimal = degrees + minutes / 60.0
    return -decimal if ew == "W" else decimal


def _parse_ogn_beacon(line):
    """Parse a single OGN APRS beacon line into a flight state dict."""
    if not line or line.startswith("#"):
        return None

    match = _APRS_POSITION_RE.match(line)
    if not match:
        return None

    d = match.groupdict()
    latitude = _parse_aprs_latitude(d["lat"], d["lat_ns"])
    longitude = _parse_aprs_longitude(d["lon"], d["lon_ew"])
    if not (
        math.isfinite(latitude)
        and math.isfinite(longitude)
        and -90 <= latitude <= 90
        and -180 <= longitude <= 180
    ):
        return None
    altitude_ft = int(d["alt"])
    altitude_m = altitude_ft * FT_TO_M
    speed_kt = int(d["speed"])
    speed_ms = speed_kt * KT_TO_MS
    course = int(d["course"])

    # Parse OGN-specific fields from comment
    comment = d.get("comment", "")
    ogn_match = _OGN_COMMENT_RE.search(comment)

    icao24 = None
    vertical_rate = None
    device_type = 0
    category = 0

    if ogn_match:
        gd = ogn_match.groupdict()
        id_type_byte = int(gd["id_type"], 16)
        device_type = (id_type_byte >> 2) & 0x0F
        category = OGN_CATEGORY_MAP.get(device_type, 0)
        # Use the 6-char hex ID as a pseudo-ICAO24
        icao24 = gd["id_hex"].lower()

        if gd.get("climb"):
            vertical_rate = int(gd["climb"]) * FPM_TO_MS
    else:
        # Use callsign hash as pseudo-ICAO24
        raw_callsign = d["callsign"]
        icao24 = hashlib.sha1(raw_callsign.encode("utf-8")).hexdigest()[:6]

    if not icao24 or not re.fullmatch(r"[0-9a-f]{6}", icao24):
        return None

    now = time.time()
    callsign = d["callsign"].replace("_", " ").strip()[:8] or None

    on_ground = altitude_m < 50 and speed_ms < 5

    return {
        "icao24": icao24,
        "callsign": callsign,
        "origin_country": "",
        "time_position": now,
        "last_contact": now,
        "longitude": longitude,
        "latitude": latitude,
        "baro_altitude": altitude_m,
        "on_ground": on_ground,
        "velocity": speed_ms,
        "true_track": float(course) if course > 0 else None,
        "vertical_rate": vertical_rate,
        "sensors": None,
        "geo_altitude": altitude_m,
        "squawk": None,
        "spi": False,
        "position_source": 3,  # FLARM
        "category": category,
        "data_source": "ogn",
    }


# In-memory buffer of latest OGN positions
_ogn_buffer = {}
_ogn_lock = threading.Lock()
_ogn_thread = None
_ogn_running = False


def _ogn_listener():
    """Background thread that connects to OGN APRS-IS and buffers positions."""
    global _ogn_running
    while _ogn_running:
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(REQUEST_TIMEOUT)
            sock.connect((OGN_APRS_HOST, OGN_APRS_PORT))

            # Login (read-only, no verification needed)
            login = f"user SKYWAT pass -1 vers SkyWatch 1.0 filter {OGN_APRS_FILTER}\r\n"
            sock.sendall(login.encode())

            buffer = ""
            while _ogn_running:
                try:
                    data = sock.recv(4096)
                    if not data:
                        break
                    buffer += data.decode("ascii", errors="ignore")
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip()
                        if not line or line.startswith("#"):
                            continue
                        state = _parse_ogn_beacon(line)
                        if state:
                            with _ogn_lock:
                                _ogn_buffer[state["icao24"]] = state
                except socket.timeout:
                    # Send keepalive
                    try:
                        sock.sendall(b"#keepalive\r\n")
                    except Exception:
                        break
        except Exception as exc:
            logger.warning("OGN APRS connection failed: %s — retrying in 30s", exc)
            time.sleep(30)
        finally:
            try:
                sock.close()
            except Exception:
                pass


def start_ogn_listener():
    """Start the OGN background listener thread."""
    global _ogn_thread, _ogn_running
    
    import sys
    import os
    if "celery" in sys.argv[0] or os.environ.get("CELERY_WORKER_RUNNING"):
        return

    if _ogn_thread and _ogn_thread.is_alive():
        return
    _ogn_running = True
    _ogn_thread = threading.Thread(target=_ogn_listener, daemon=True, name="ogn-aprs")
    _ogn_thread.start()
    logger.info("OGN APRS listener started")


def stop_ogn_listener():
    """Stop the OGN background listener thread."""
    global _ogn_running
    _ogn_running = False


def fetch_ogn_states():
    """
    Return current OGN aircraft states.

    If the background listener is running, returns buffered positions.
    Otherwise starts the listener and returns an empty list on the first call.
    """
    start_ogn_listener()

    now = time.time()
    max_age = 120  # discard positions older than 2 minutes

    with _ogn_lock:
        states = []
        stale_keys = []
        for icao24, state in _ogn_buffer.items():
            age = now - state.get("last_contact", 0)
            if age > max_age:
                stale_keys.append(icao24)
            else:
                states.append(state)
        for key in stale_keys:
            del _ogn_buffer[key]

    logger.info("OGN: returning %d positions (%d stale removed)", len(states), len(stale_keys))
    return states
