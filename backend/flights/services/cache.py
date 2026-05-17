"""
Redis cache layer for flight data.
Falls back to in-memory dict when Redis is unavailable.
"""

import json
import logging
import time

logger = logging.getLogger(__name__)
_memory_cache = {}
_route_memory_expires = {}
MAX_MEMORY_CACHE_ENTRIES = 5000
ROUTE_CACHE_TTL_SECONDS = 3600


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
