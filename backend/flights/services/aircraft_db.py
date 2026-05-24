"""
Local Aircraft Database Service.

Downloads and caches the OpenSky aircraft database CSV to provide
fast local lookups for aircraft metadata (type, registration, owner, manufacturer).
Falls back to the adsbdb API if not found locally.
"""

import csv
import logging
import os
import time
from urllib import request, error
from urllib.error import URLError
import json
import re

logger = logging.getLogger(__name__)

# Cache the database locally
CACHE_FILE = os.path.join(os.path.dirname(__file__), "aircraftDatabase.csv")
# Fallback local json DB for testing if download fails
FALLBACK_CACHE = os.path.join(os.path.dirname(__file__), "aircraftDatabase_fallback.json")
OPENSKY_CSV_URL = "https://opensky-network.org/datasets/metadata/aircraftDatabase.csv"
REFRESH_INTERVAL_DAYS = 7

# Memory cache for fast lookups
_db_cache = {}
_db_loaded = False
ICAO24_RE = re.compile(r"^[0-9a-f]{6}$")


def _normalize_icao24(value):
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized if ICAO24_RE.fullmatch(normalized) else None


def _download_database():
    """Download the latest OpenSky aircraft database CSV."""
    logger.info("Downloading OpenSky aircraft database (this may take a minute)...")
    try:
        # Since it's a large file, we use urllib.request directly
        request.urlretrieve(OPENSKY_CSV_URL, CACHE_FILE)
        logger.info("Successfully downloaded aircraft database to %s", CACHE_FILE)
        return True
    except URLError as exc:
        logger.warning("Failed to download OpenSky database: %s", exc)
        return False


def _load_database():
    """Load the CSV database into memory."""
    global _db_loaded, _db_cache
    
    if _db_loaded:
        return

    # Check if file exists and is recent enough
    needs_download = True
    if os.path.exists(CACHE_FILE):
        file_age_days = (time.time() - os.path.getmtime(CACHE_FILE)) / (24 * 3600)
        if file_age_days < REFRESH_INTERVAL_DAYS:
            needs_download = False
            
    if needs_download:
        success = _download_database()
        if not success and not os.path.exists(CACHE_FILE):
            logger.error("No aircraft database available.")
            _db_loaded = True  # Prevent constant retries
            return

    logger.info("Loading aircraft database into memory...")
    loaded_count = 0
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                icao24 = row.get("icao24", "").strip().lower()
                if not icao24:
                    continue
                    
                _db_cache[icao24] = {
                    "registration": row.get("registration", "").strip(),
                    "manufacturer": row.get("manufacturername", "").strip(),
                    "aircraft_type": row.get("model", "").strip(),
                    "owner": row.get("owner", "").strip(),
                }
                loaded_count += 1
        logger.info("Loaded %d aircraft records into memory.", loaded_count)
    except Exception as exc:
        logger.error("Error reading aircraft database: %s", exc)
        
    _db_loaded = True


def _lookup_adsbdb(icao24):
    """Fallback lookup via adsbdb.com API."""
    import requests
    icao24 = _normalize_icao24(icao24)
    if not icao24:
        return None
    url = f"https://api.adsbdb.com/v0/aircraft/{icao24}"
    try:
        resp = requests.get(url, timeout=5)
        if resp.status_code == 200:
            data = resp.json().get("response", {}).get("aircraft", {})
            return {
                "registration": data.get("registration", ""),
                "manufacturer": data.get("manufacturer", ""),
                "aircraft_type": data.get("type", ""),
                "owner": data.get("registered_owner", ""),
            }
    except Exception as exc:
        logger.debug("adsbdb lookup failed for %s: %s", icao24, exc)
    return None


def _lookup_planespotters(icao24):
    """Fallback lookup via planespotters.net public JSON API."""
    import requests
    icao24 = _normalize_icao24(icao24)
    if not icao24:
        return None
    url = f"https://api.planespotters.net/pub/photos/hex/{icao24}"
    try:
        resp = requests.get(
            url,
            headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            timeout=5
        )
        if resp.status_code == 200:
            data = resp.json()
            photos = data.get("photos") or []
            if photos:
                ac = photos[0].get("aircraft", {})
                airline = ac.get("airline", {})
                return {
                    "registration": ac.get("registration", ""),
                    "manufacturer": ac.get("type", "").split()[0] if ac.get("type") else "",
                    "aircraft_type": ac.get("type", ""),
                    "owner": airline.get("name", ""),
                }
    except Exception as exc:
        logger.debug("planespotters lookup failed for %s: %s", icao24, exc)
    return None


def _lookup_aircraft_uncached(icao24):
    """
    Lookup aircraft metadata by ICAO24 hex code.
    Returns dict with registration, manufacturer, aircraft_type, owner.
    """
    icao24 = _normalize_icao24(icao24)
    if not icao24:
        return None
    
    if not _db_loaded:
        _load_database()
        
    # Check local DB
    if icao24 in _db_cache:
        cached = _db_cache[icao24]
        if cached and cached.get("aircraft_type") and cached.get("registration"):
            return cached
        
    # Fallback 1: adsbdb API
    api_result = _lookup_adsbdb(icao24)
    if api_result and api_result.get("aircraft_type") and api_result.get("registration"):
        _db_cache[icao24] = api_result
        return api_result
        
    # Fallback 2: planespotters API
    planespotters_result = _lookup_planespotters(icao24)
    if planespotters_result and planespotters_result.get("aircraft_type") and planespotters_result.get("registration"):
        _db_cache[icao24] = planespotters_result
        return planespotters_result
        
    # If we got partial results from adsbdb, return it as last resort
    if api_result:
        _db_cache[icao24] = api_result
        return api_result
        
    # If we got partial results from planespotters, return it
    if planespotters_result:
        _db_cache[icao24] = planespotters_result
        return planespotters_result
        
    return None


def lookup_aircraft(icao24):
    """Lookup aircraft metadata with the shared Redis metadata cache."""
    from .cache import get_aircraft_metadata

    return get_aircraft_metadata(icao24, _lookup_aircraft_uncached)
