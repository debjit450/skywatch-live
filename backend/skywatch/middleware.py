"""Request correlation and lightweight Redis-backed rate limiting."""

import json
import logging
import time
import uuid
from contextvars import ContextVar

from django.conf import settings
from django.http import JsonResponse

request_id_var = ContextVar("request_id", default=None)


class RequestIdMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
        token = request_id_var.set(request_id)
        request.request_id = request_id
        try:
            response = self.get_response(request)
            response["X-Request-ID"] = request_id
            return response
        finally:
            request_id_var.reset(token)


class RateLimitMiddleware:
    """Fixed-window per-IP limiter using Redis when available."""

    def __init__(self, get_response):
        self.get_response = get_response
        self._memory = {}

    def _client_ip(self, request):
        forwarded = request.META.get("HTTP_X_FORWARDED_FOR")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return request.META.get("REMOTE_ADDR", "unknown")

    def _memory_incr(self, key, window_seconds):
        now = time.time()
        count, expires = self._memory.get(key, (0, now + window_seconds))
        if expires <= now:
            count, expires = 0, now + window_seconds
        count += 1
        self._memory[key] = (count, expires)
        return count, max(1, int(expires - now))

    def _redis_incr(self, key, window_seconds):
        try:
            from flights.services.cache import _get_redis

            redis = _get_redis()
            if not redis:
                return None
            count = redis.incr(key)
            if count == 1:
                redis.expire(key, window_seconds)
            ttl = redis.ttl(key)
            return count, ttl if ttl > 0 else window_seconds
        except Exception:
            return None

    def __call__(self, request):
        if request.path.startswith("/health/") or request.path in {"/healthz/", "/readyz/", "/metrics"}:
            return self.get_response(request)

        limit = 500 if getattr(request, "user", None) and request.user.is_authenticated else 100
        window_seconds = 60
        bucket = int(time.time() // window_seconds)
        key = f"ratelimit:{self._client_ip(request)}:{bucket}"
        result = self._redis_incr(key, window_seconds)
        if result is None:
            result = self._memory_incr(key, window_seconds)
        count, retry_after = result

        if count > limit:
            response = JsonResponse(
                {"detail": "Rate limit exceeded", "limit": limit, "window_seconds": window_seconds},
                status=429,
            )
            response["Retry-After"] = str(retry_after)
            response["Content-Type"] = "application/json"
            return response

        return self.get_response(request)


class StructlogRequestMiddleware:
    """Bind request context to structlog when structlog is installed."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        started = time.perf_counter()
        try:
            import structlog

            structlog.contextvars.clear_contextvars()
            structlog.contextvars.bind_contextvars(
                request_id=getattr(request, "request_id", None),
                path=request.path,
                method=request.method,
            )
        except Exception:
            pass
        response = self.get_response(request)
        try:
            from flights.metrics import api_latency_seconds

            match = getattr(request, "resolver_match", None)
            metric_path = getattr(match, "url_name", None) or request.path
            api_latency_seconds.labels(
                method=request.method,
                path=str(metric_path),
                status=str(response.status_code),
            ).observe(time.perf_counter() - started)
        except Exception:
            pass
        return response


class JsonLogFormatter(logging.Formatter):
    def format(self, record):
        payload = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "component": record.name,
            "event": record.getMessage(),
        }
        for field in ("request_id", "flight_id", "task_id"):
            value = getattr(record, field, None)
            if value:
                payload[field] = value
        reserved = {
            "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
            "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
            "created", "msecs", "relativeCreated", "thread", "threadName",
            "processName", "process",
        }
        for key, value in record.__dict__.items():
            if key not in reserved and key not in payload:
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)
