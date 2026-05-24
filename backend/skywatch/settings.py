"""Django settings for the SkyWatch backend."""

import os
import importlib.util
import socket
import warnings
from pathlib import Path
from urllib.parse import unquote, urlparse

from django.core.exceptions import ImproperlyConfigured
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_list(name: str, default: list[str] | None = None) -> list[str]:
    value = os.environ.get(name)
    if value is None:
        return default or []
    return [item.strip() for item in value.split(",") if item.strip()]


def module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except ModuleNotFoundError:
        return False


def redis_socket_reachable(url: str, timeout_seconds: float = 0.25) -> bool:
    """Fast local-dev guard so a stale REDIS_URL does not break startup paths."""
    if not url:
        return False

    parsed = urlparse(url)
    if parsed.scheme not in {"redis", "rediss"}:
        return True

    host = parsed.hostname or "localhost"
    port = parsed.port or 6379
    try:
        with socket.create_connection((host, port), timeout=timeout_seconds):
            return True
    except OSError:
        return False


DEBUG = env_bool("DJANGO_DEBUG", False)
SKYWATCH_DEPLOYMENT_PROFILE = os.environ.get(
    "SKYWATCH_DEPLOYMENT_PROFILE",
    "local" if DEBUG else "production",
).strip().lower()
if SKYWATCH_DEPLOYMENT_PROFILE not in {"local", "staging", "production"}:
    raise ImproperlyConfigured("SKYWATCH_DEPLOYMENT_PROFILE must be local, staging, or production.")

SKYWATCH_DEMO_MODE = env_bool("SKYWATCH_DEMO_MODE", False)

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY")
if not SECRET_KEY:
    if DEBUG:
        SECRET_KEY = "django-insecure-local-dev-only-change-me"
    else:
        raise ImproperlyConfigured("DJANGO_SECRET_KEY is required when DJANGO_DEBUG is false.")
if SKYWATCH_DEPLOYMENT_PROFILE == "production" and (
    len(SECRET_KEY) < 50 or SECRET_KEY.startswith("django-insecure") or SECRET_KEY in {"change-me", "local-dev-only-change-before-production"}
):
    raise ImproperlyConfigured("Production DJANGO_SECRET_KEY must be strong and unique.")

ALLOWED_HOSTS = env_list(
    "ALLOWED_HOSTS",
    ["localhost", "127.0.0.1", "[::1]"] if DEBUG else [],
)
if not DEBUG and not ALLOWED_HOSTS:
    raise ImproperlyConfigured("ALLOWED_HOSTS must be set when DJANGO_DEBUG is false.")
if SKYWATCH_DEPLOYMENT_PROFILE == "production" and "*" in ALLOWED_HOSTS:
    raise ImproperlyConfigured("Production ALLOWED_HOSTS cannot contain '*'.")

CSRF_TRUSTED_ORIGINS = env_list("CSRF_TRUSTED_ORIGINS")

# ---------------------------------------------------------------------------
# Application definition
# ---------------------------------------------------------------------------
INSTALLED_APPS = [
    "daphne",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "channels",
    "django_celery_beat",
    "flights",
]

if module_available("django_prometheus"):
    INSTALLED_APPS.insert(0, "django_prometheus")
if module_available("drf_spectacular"):
    INSTALLED_APPS.append("drf_spectacular")

MIDDLEWARE = [
    "skywatch.middleware.RequestIdMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "skywatch.middleware.RateLimitMiddleware",
    "skywatch.middleware.StructlogRequestMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "skywatch.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "skywatch.wsgi.application"
ASGI_APPLICATION = "skywatch.asgi.application"

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
DATABASE_URL = os.environ.get("DJANGO_DATABASE_URL") or os.environ.get("DATABASE_URL", "")
READ_REPLICA_URL = os.environ.get("READ_REPLICA_DATABASE_URL", "")

if DATABASE_URL:
    parsed = urlparse(DATABASE_URL)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise ImproperlyConfigured("Only postgres:// DATABASE_URL values are supported.")

    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": unquote(parsed.path.lstrip("/")),
            "USER": unquote(parsed.username or ""),
            "PASSWORD": unquote(parsed.password or ""),
            "HOST": parsed.hostname or "",
            "PORT": str(parsed.port or 5432),
        },
    }
    if READ_REPLICA_URL:
        replica = urlparse(READ_REPLICA_URL)
        DATABASES["replica"] = {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": unquote(replica.path.lstrip("/")),
            "USER": unquote(replica.username or ""),
            "PASSWORD": unquote(replica.password or ""),
            "HOST": replica.hostname or "",
            "PORT": str(replica.port or 5432),
        }
elif DEBUG:
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": BASE_DIR / "db.sqlite3",
        },
    }
else:
    raise ImproperlyConfigured("DATABASE_URL is required when DJANGO_DEBUG is false.")

ANALYTICS_DB_ALIAS = "replica" if "replica" in DATABASES else "default"

# ---------------------------------------------------------------------------
# Redis, cache, and channels
# ---------------------------------------------------------------------------
REDIS_URL = os.environ.get("REDIS_URL", "")
ALLOW_IN_MEMORY_CHANNEL_LAYER = env_bool("ALLOW_IN_MEMORY_CHANNEL_LAYER", DEBUG)
if SKYWATCH_DEPLOYMENT_PROFILE == "production" and ALLOW_IN_MEMORY_CHANNEL_LAYER:
    raise ImproperlyConfigured("Production cannot use ALLOW_IN_MEMORY_CHANNEL_LAYER.")

REDIS_AVAILABLE = bool(REDIS_URL)
REDIS_FALLBACK_ACTIVE = False
if REDIS_AVAILABLE and ALLOW_IN_MEMORY_CHANNEL_LAYER and not redis_socket_reachable(REDIS_URL):
    REDIS_AVAILABLE = False
    REDIS_FALLBACK_ACTIVE = True
    warnings.warn(
        "REDIS_URL is configured but Redis is not reachable; using in-memory "
        "cache and channel layer because ALLOW_IN_MEMORY_CHANNEL_LAYER is enabled.",
        RuntimeWarning,
    )

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
    },
}

if REDIS_AVAILABLE:
    CACHES["default"] = {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": REDIS_URL,
    }

if REDIS_AVAILABLE:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [REDIS_URL]},
        },
    }
elif ALLOW_IN_MEMORY_CHANNEL_LAYER:
    CHANNEL_LAYERS = {
        "default": {
            "BACKEND": "channels.layers.InMemoryChannelLayer",
        },
    }
else:
    raise ImproperlyConfigured(
        "Redis is required for Channels outside local in-memory development. "
        "Set REDIS_URL or explicitly set ALLOW_IN_MEMORY_CHANNEL_LAYER=true."
    )

# ---------------------------------------------------------------------------
# Celery
# ---------------------------------------------------------------------------
if REDIS_AVAILABLE:
    CELERY_BROKER_URL = REDIS_URL
    CELERY_RESULT_BACKEND = REDIS_URL
else:
    CELERY_BROKER_URL = "memory://"
    CELERY_RESULT_BACKEND = "cache+memory://"

CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"
CELERY_TIMEZONE = "UTC"
CELERY_BEAT_SCHEDULER = "django_celery_beat.schedulers:DatabaseScheduler"
CELERY_BEAT_SCHEDULE = {
    "fetch-flights-every-15s": {
        "task": "flights.tasks.fetch_flight_states",
        "schedule": 15.0,
    },
    "update-flight-predictions-every-30s": {
        "task": "flights.tasks.update_flight_predictions",
        "schedule": 30.0,
    },
    "evaluate-custom-alert-rules-every-30s": {
        "task": "flights.tasks.evaluate_custom_alert_rules",
        "schedule": 30.0,
    },
    "refresh-airspace-restrictions-every-5m": {
        "task": "flights.tasks.refresh_tfr_cache",
        "schedule": 300.0,
    },
    "synthetic-health-check-every-5m": {
        "task": "flights.tasks.synthetic_health_check",
        "schedule": 300.0,
    },
    "cleanup-old-data-hourly": {
        "task": "flights.tasks.cleanup_old_data",
        "schedule": 3600.0,
    },
    "retrain-model-daily": {
        "task": "flights.tasks.retrain_model",
        "schedule": 86400.0,
    },
    "retrain-lstm-model-weekly": {
        "task": "flights.tasks.retrain_lstm_model",
        "schedule": 604800.0,
    },
}

# ---------------------------------------------------------------------------
# REST Framework
# ---------------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_RENDERER_CLASSES": [
        "rest_framework.renderers.JSONRenderer",
    ],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 50,
    "DEFAULT_THROTTLE_CLASSES": [
        "rest_framework.throttling.AnonRateThrottle",
        "rest_framework.throttling.ScopedRateThrottle",
    ],
    "DEFAULT_THROTTLE_RATES": {
        "anon": "120/minute",
        "playback": "30/minute",
        "alert_mutation": "60/minute",
        "enrichment": "120/minute",
    },
    "EXCEPTION_HANDLER": "skywatch.api.exception_handler",
}
if module_available("drf_spectacular"):
    REST_FRAMEWORK["DEFAULT_SCHEMA_CLASS"] = "drf_spectacular.openapi.AutoSchema"

SPECTACULAR_SETTINGS = {
    "TITLE": "SkyWatch Live API",
    "DESCRIPTION": "Flight surveillance, anomaly, weather, airspace, source health, and satellite APIs.",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
}

# ---------------------------------------------------------------------------
# CORS and transport security
# ---------------------------------------------------------------------------
CORS_ALLOW_ALL_ORIGINS = env_bool("CORS_ALLOW_ALL_ORIGINS", False)
if CORS_ALLOW_ALL_ORIGINS and not DEBUG:
    raise ImproperlyConfigured("CORS_ALLOW_ALL_ORIGINS cannot be enabled when DJANGO_DEBUG is false.")

CORS_ALLOWED_ORIGINS = env_list(
    "CORS_ALLOWED_ORIGINS",
    [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ] if DEBUG else [],
)
CORS_ALLOWED_ORIGIN_REGEXES = env_list(
    "CORS_ALLOWED_ORIGIN_REGEXES",
    [
        r"^http://localhost:\d+$",
        r"^http://127\.0\.0\.1:\d+$",
    ] if DEBUG else [],
)
CORS_ALLOW_CREDENTIALS = env_bool("CORS_ALLOW_CREDENTIALS", True)

SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SESSION_COOKIE_SECURE = env_bool("DJANGO_SESSION_COOKIE_SECURE", not DEBUG)
CSRF_COOKIE_SECURE = env_bool("DJANGO_CSRF_COOKIE_SECURE", not DEBUG)
SECURE_SSL_REDIRECT = env_bool("DJANGO_SECURE_SSL_REDIRECT", False)
SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_SECURE_HSTS_SECONDS", "0" if DEBUG else "31536000"))
SECURE_HSTS_INCLUDE_SUBDOMAINS = env_bool(
    "DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS",
    not DEBUG and SECURE_HSTS_SECONDS > 0,
)
SECURE_HSTS_PRELOAD = env_bool("DJANGO_SECURE_HSTS_PRELOAD", False)

# ---------------------------------------------------------------------------
# OpenSky credentials
# ---------------------------------------------------------------------------
OPENSKY_CLIENT_ID = os.environ.get("OPENSKY_CLIENT_ID", "")
OPENSKY_CLIENT_SECRET = os.environ.get("OPENSKY_CLIENT_SECRET", "")
OPENSKY_USERNAME = os.environ.get("OPENSKY_USERNAME", "")
OPENSKY_PASSWORD = os.environ.get("OPENSKY_PASSWORD", "")
ADSBONE_ENABLED = env_bool("ADSBONE_ENABLED", True)
AIRPLANESLIVE_ENABLED = env_bool("AIRPLANESLIVE_ENABLED", True)
ADSBLOL_ENABLED = env_bool("ADSBLOL_ENABLED", True)
OGN_ENABLED = env_bool("OGN_ENABLED", True)
FAA_RADAR_ENABLED = env_bool("FAA_RADAR_ENABLED", True)
UAT_ENABLED = env_bool("UAT_ENABLED", True)
SATELLITE_ADSB_ENABLED = env_bool("SATELLITE_ADSB_ENABLED", True)
CELESTRAK_SATELLITES_ENABLED = env_bool("CELESTRAK_SATELLITES_ENABLED", True)
TFR_GEOJSON_URL = os.environ.get("TFR_GEOJSON_URL", "")
WEBSOCKET_PERMESSAGE_DEFLATE = env_bool("WEBSOCKET_PERMESSAGE_DEFLATE", True)
WEBSOCKET_COMPRESSION_THRESHOLD_BYTES = int(os.environ.get("WEBSOCKET_COMPRESSION_THRESHOLD_BYTES", "1024"))
METRICS_USER = os.environ.get("METRICS_USER", "")
METRICS_PASSWORD = os.environ.get("METRICS_PASSWORD", "")
if SKYWATCH_DEPLOYMENT_PROFILE == "production" and (not METRICS_USER or not METRICS_PASSWORD):
    raise ImproperlyConfigured("Production metrics must be protected with METRICS_USER and METRICS_PASSWORD.")
ADMIN_URL_PATH = os.environ.get("DJANGO_ADMIN_URL_PATH", "admin/" if DEBUG else "skywatch-admin/")
if not ADMIN_URL_PATH.endswith("/"):
    ADMIN_URL_PATH = f"{ADMIN_URL_PATH}/"
if SKYWATCH_DEPLOYMENT_PROFILE == "production" and ADMIN_URL_PATH == "admin/":
    raise ImproperlyConfigured("Set DJANGO_ADMIN_URL_PATH to a non-default path in production.")

# ---------------------------------------------------------------------------
# ML model
# ---------------------------------------------------------------------------
ML_MODEL_DIR = BASE_DIR / "ml" / "models"

FLIGHT_ROUTE_LOOKBACK_HOURS = int(os.environ.get("FLIGHT_ROUTE_LOOKBACK_HOURS", "12"))
FLIGHT_ROUTE_SESSION_GAP_MINUTES = int(os.environ.get("FLIGHT_ROUTE_SESSION_GAP_MINUTES", "90"))
FLIGHT_STATE_RETENTION_DAYS = int(os.environ.get("FLIGHT_STATE_RETENTION_DAYS", "7"))
FLIGHT_POSITION_RETENTION_DAYS = int(os.environ.get("FLIGHT_POSITION_RETENTION_DAYS", "7"))
SYSTEM_METRICS_RETENTION_DAYS = int(os.environ.get("SYSTEM_METRICS_RETENTION_DAYS", "14"))
RESOLVED_ANOMALY_RETENTION_DAYS = int(os.environ.get("RESOLVED_ANOMALY_RETENTION_DAYS", "30"))

# ---------------------------------------------------------------------------
# Standard Django
# ---------------------------------------------------------------------------
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")

SENTRY_DSN = os.environ.get("SENTRY_DSN", "")
DJANGO_ENV = os.environ.get("DJANGO_ENV", "development" if DEBUG else "production")
if SENTRY_DSN and module_available("sentry_sdk"):
    import sentry_sdk
    from sentry_sdk.integrations.celery import CeleryIntegration
    from sentry_sdk.integrations.django import DjangoIntegration

    sentry_sdk.init(
        dsn=SENTRY_DSN,
        environment=DJANGO_ENV,
        traces_sample_rate=0.1,
        integrations=[DjangoIntegration(), CeleryIntegration()],
    )
    sentry_sdk.set_tag("app", "skywatch")
    sentry_sdk.set_tag("component", "backend")

OTEL_EXPORTER_OTLP_ENDPOINT = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317")
if module_available("opentelemetry.sdk"):
    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.celery import CeleryInstrumentor
        from opentelemetry.instrumentation.django import DjangoInstrumentor
        from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor
        from opentelemetry.instrumentation.redis import RedisInstrumentor
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        trace.set_tracer_provider(
            TracerProvider(resource=Resource.create({"service.name": "skywatch-backend"}))
        )
        trace.get_tracer_provider().add_span_processor(
            BatchSpanProcessor(OTLPSpanExporter(endpoint=OTEL_EXPORTER_OTLP_ENDPOINT))
        )
        DjangoInstrumentor().instrument()
        CeleryInstrumentor().instrument()
        RedisInstrumentor().instrument()
        PsycopgInstrumentor().instrument()
    except Exception:
        pass

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json": {"()": "skywatch.middleware.JsonLogFormatter"},
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
            "formatter": "json",
        },
    },
    "root": {"handlers": ["console"], "level": LOG_LEVEL},
    "loggers": {
        "flights": {"handlers": ["console"], "level": LOG_LEVEL, "propagate": False},
        "django": {"handlers": ["console"], "level": "INFO", "propagate": False},
    },
}
