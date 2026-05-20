"""
Redis cache layer for flight data.
Falls back to in-memory dict when Redis is unavailable.
"""

import json
import logging
import time
from functools import wraps

logger = logging.getLogger(__name__)
_memory_cache = {}
_route_memory_expires = {}
_cache_stats = {"hits": 0, "misses": 0}
MAX_MEMORY_CACHE_ENTRIES = 5000
ROUTE_CACHE_TTL_SECONDS = 3600
AIRPORT_METADATA_TTL_SECONDS = 30 * 60
AIRCRAFT_METADATA_TTL_SECONDS = 15 * 60


def _prune_memory_cache():
    now = time.time()

    for key, value in list(_memory_cache.items()):
        if (
            isinstance(value, tuple)
            and len(value) == 2
            and isinstance(value[1], (int, float))
            and value[1] <= now
        ):
            _memory_cache.pop(key, None)

    for key, expires in list(_route_memory_expires.items()):
        if expires <= now:
            _route_memory_expires.pop(key, None)
            _memory_cache.pop(key, None)

    while len(_memory_cache) > MAX_MEMORY_CACHE_ENTRIES:
        key = next(iter(_memory_cache))
        _route_memory_expires.pop(key, None)
        _memory_cache.pop(key, None)


_redis_client = None
_redis_initialized = False

def _get_redis():
    global _redis_client, _redis_initialized
    if _redis_initialized:
        return _redis_client

    _redis_initialized = True
    try:
        from django.conf import settings
        if getattr(settings, "REDIS_AVAILABLE", False):
            import redis
            _redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)
    except Exception as exc:
        logger.warning("Failed to initialize Redis client: %s", exc)

    return _redis_client


def _record_cache_hit(hit):
    key = "hits" if hit else "misses"
    _cache_stats[key] += 1
    r = _get_redis()
    if r:
        try:
            r.incr(f"metrics:cache:{key}")
        except Exception:
            pass


def _set_json(key, value, ttl):
    _prune_memory_cache()
    payload = json.dumps(value)
    r = _get_redis()
    if r:
        try:
            r.setex(key, ttl, payload)
            return
        except Exception as exc:
            logger.debug("Redis set failed for %s: %s", key, exc)
    _memory_cache[key] = (payload, time.time() + ttl)


def _get_json(key):
    _prune_memory_cache()
    r = _get_redis()
    if r:
        try:
            data = r.get(key)
            if data is not None:
                _record_cache_hit(True)
                return json.loads(data)
        except Exception as exc:
            logger.debug("Redis get failed for %s: %s", key, exc)

    cached = _memory_cache.get(key)
    if cached and isinstance(cached, tuple):
        payload, expires = cached
        if time.time() < expires:
            _record_cache_hit(True)
            return json.loads(payload)
        _memory_cache.pop(key, None)

    _record_cache_hit(False)
    return None


def delete_cache_key(key):
    """Invalidate one logical cache key in Redis and the local fallback."""
    r = _get_redis()
    if r:
        try:
            r.delete(key)
        except Exception:
            pass
    _memory_cache.pop(key, None)
    _route_memory_expires.pop(key, None)


def airport_cache_key(icao_code):
    return f"airport:{str(icao_code).strip().upper()}"


def aircraft_cache_key(icao_hex):
    return f"aircraft:{str(icao_hex).strip().lower()}"


def get_airport_metadata(icao_code, lookup_func):
    """Cache airport metadata lookups by ICAO code for 30 minutes."""
    key = airport_cache_key(icao_code)
    cached = _get_json(key)
    if cached is not None:
        return cached
    value = lookup_func(icao_code)
    if value is not None:
        _set_json(key, value, AIRPORT_METADATA_TTL_SECONDS)
    return value


def get_aircraft_metadata(icao_hex, lookup_func):
    """Cache aircraft metadata lookups by ICAO hex for 15 minutes."""
    key = aircraft_cache_key(icao_hex)
    cached = _get_json(key)
    if cached is not None:
        return cached
    value = lookup_func(icao_hex)
    if value is not None:
        _set_json(key, value, AIRCRAFT_METADATA_TTL_SECONDS)
    return value


def invalidate_airport_metadata(icao_code):
    delete_cache_key(airport_cache_key(icao_code))


def invalidate_aircraft_metadata(icao_hex):
    delete_cache_key(aircraft_cache_key(icao_hex))


def cached_lookup(key_builder, ttl):
    """Decorator for small metadata lookups where the cache key is data-derived."""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            key = key_builder(*args, **kwargs)
            cached = _get_json(key)
            if cached is not None:
                return cached
            value = func(*args, **kwargs)
            if value is not None:
                _set_json(key, value, ttl)
            return value

        return wrapper

    return decorator


def get_cache_stats():
    """Return aggregate cache hit/miss counters and hit ratio."""
    hits = _cache_stats["hits"]
    misses = _cache_stats["misses"]
    r = _get_redis()
    if r:
        try:
            hits = int(r.get("metrics:cache:hits") or hits)
            misses = int(r.get("metrics:cache:misses") or misses)
        except Exception:
            pass
    total = hits + misses
    return {
        "hits": hits,
        "misses": misses,
        "hit_ratio": (hits / total) if total else 0.0,
    }


def set_current_flights(flights_data):
    _prune_memory_cache()
    r = _get_redis()
    payload = json.dumps(flights_data)
    if r:
        try:
            r.setex("flights:current", 90, payload)
            r.set("flights:last_update", str(time.time()))
            return
        except Exception as exc:
            logger.warning("Redis set failed: %s", exc)
    _memory_cache["flights:current"] = (payload, time.time() + 90)


def get_current_flights():
    _prune_memory_cache()
    r = _get_redis()
    if r:
        try:
            data = r.get("flights:current")
            if data:
                return json.loads(data)
        except Exception:
            pass
    cached = _memory_cache.get("flights:current")
    if cached:
        payload, expires = cached
        if time.time() < expires:
            return json.loads(payload)
    return None


def set_flight_state(icao24, state_data, ttl=120):
    _prune_memory_cache()
    r = _get_redis()
    payload = json.dumps(state_data)
    if r:
        try:
            r.setex(f"flights:state:{icao24}", ttl, payload)
            return
        except Exception:
            pass
    _memory_cache[f"flights:state:{icao24}"] = (payload, time.time() + ttl)


def get_flight_state(icao24):
    _prune_memory_cache()
    r = _get_redis()
    if r:
        try:
            data = r.get(f"flights:state:{icao24}")
            if data:
                return json.loads(data)
        except Exception:
            pass
    cached = _memory_cache.get(f"flights:state:{icao24}")
    if cached:
        payload, expires = cached
        if time.time() < expires:
            return json.loads(payload)
    return None


def append_route_point(icao24, session_id, point):
    _prune_memory_cache()
    r = _get_redis()
    key = f"route:{icao24}:{session_id}"
    payload = json.dumps(point)
    if r:
        try:
            r.rpush(key, payload)
            r.expire(key, 3600)
            return
        except Exception:
            pass
    if key not in _memory_cache or _route_memory_expires.get(key, 0) <= time.time():
        _memory_cache[key] = []
    _route_memory_expires[key] = time.time() + ROUTE_CACHE_TTL_SECONDS
    _memory_cache[key].append(payload)


def get_route_points(icao24, session_id):
    _prune_memory_cache()
    r = _get_redis()
    key = f"route:{icao24}:{session_id}"
    if r:
        try:
            points = r.lrange(key, 0, -1)
            return [json.loads(p) for p in points]
        except Exception:
            pass
    if _route_memory_expires.get(key, 0) <= time.time():
        _route_memory_expires.pop(key, None)
        _memory_cache.pop(key, None)
        return []
    cached = _memory_cache.get(key, [])
    return [json.loads(p) for p in cached]


def increment_api_calls():
    _prune_memory_cache()
    r = _get_redis()
    if r:
        try:
            key = "api:opensky:calls_today"
            count = r.incr(key)
            if count == 1:
                import datetime
                now = datetime.datetime.utcnow()
                midnight = now.replace(hour=0, minute=0, second=0) + datetime.timedelta(days=1)
                r.expireat(key, int(midnight.timestamp()))
            return count
        except Exception:
            pass
    key = "api:opensky:calls_today"
    _memory_cache[key] = _memory_cache.get(key, 0) + 1
    return _memory_cache[key]
