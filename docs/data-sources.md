# Data Sources and Source Reliability Contract

Last reviewed: 2026-05-24.

SkyWatch Live reads from public aviation feeds, APRS socket feeds, meteorological reports, satellite catalogs, and metadata/photo sources. These upstreams are volatile by design. The application treats feed loss as degraded coverage, not as a global application failure.

## Registered Sources

| Source | Identifier | Base confidence | Code path | Endpoint / protocol | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| OpenSky Network | `opensky` | `0.96` | `backend/flights/services/opensky.py`, `frontend/src/routes/api/flights.ts` | `https://opensky-network.org/api/states/all?extended=1` | Primary baseline feed. OAuth client credentials or legacy username/password improve rate limits. |
| ADS-B One | `adsb_one` | `0.90` | `backend/flights/services/adsb_sources.py` | `https://api.adsb.one/v2/point/{lat}/{lon}/{rad}` | Regional hub point queries, normalized to the OpenSky-shaped object. |
| Airplanes.live ADS-B | `airplanes_live` | `0.90` | `backend/flights/services/adsb_sources.py` | `https://api.airplanes.live/v2/point/{lat}/{lon}/{rad}` | Supplemental ADS-B point-feed coverage. |
| ADSB.lol | `adsb_lol` | `0.86` | `backend/flights/services/adsb_sources.py` | `https://api.adsb.lol/v2/point/{lat}/{lon}/{rad}` | Supplemental public receiver network. |
| Open Glider Network | `ogn` | `0.82` | `backend/flights/services/ogn_client.py` | APRS-IS at `aprs.glidernet.org:14580` | FLARM/OGN gliders and small aircraft. |
| UAT / TIS-B | `uat` | `0.80` | `backend/flights/services/uat_client.py` | Airplanes.live point feeds | US hub queries filtered by UAT/TIS-B type markers. |
| FAA / military radar aggregate | `faa_radar` | `0.78` | `backend/flights/services/faa_radar.py` | `https://api.airplanes.live/v2/mil` | Public military/government aircraft aggregate from Airplanes.live. |
| Satellite ADS-B | `satellite` | `0.74` | `backend/flights/services/satellite_adsb.py` | Airplanes.live oceanic point feeds | Oceanic hub queries filtered by satellite flags and remote-position heuristics. |
| CelesTrak | `celestrak` | N/A | `backend/flights/services/celestrak.py`, `frontend/src/routes/api/satellites.ts` | `https://celestrak.org/NORAD/elements/gp.php` | TLE/GP element catalog used for SGP4 sub-satellite propagation. |
| Aviation Weather Center | `weather` | N/A | `backend/flights/services/weather.py`, `backend/flights/services/airspace_restrictions.py` | `aviationweather.gov/api/data/metar`, `airsigmet`, `isigmet` | METAR cards and SIGMET airspace overlays. |
| FAA TFR | `tfr` | N/A | `backend/flights/services/airspace_restrictions.py` | FAA WFS GeoJSON feed, overrideable with `TFR_GEOJSON_URL` | Temporary flight restriction GeoJSON overlay. |
| ADSBDB | `adsbdb` | N/A | `frontend/src/routes/api/enrichment.ts`, `frontend/src/routes/api/photo.ts`, `backend/flights/services/aircraft_db.py` | `https://api.adsbdb.com/v0` | Aircraft metadata and photo proxy support. Backend metadata can also use the OpenSky aircraft database CSV. |

## Merge and Deduplication Contract

The current ingestion implementation lives in `backend/flights/tasks.py`.

1. OpenSky is fetched first. The result is treated as the required baseline source.
2. Enabled supplemental sources are fetched through `run_source_fetch`.
3. Invalid rows are rejected unless they contain a lowercase-normalizable 6-character ICAO24 hex address.
4. Rows are merged by ICAO24. If multiple rows report the same aircraft, the row with the newest `last_contact` wins.
5. `source_provenance` preserves the set of sources that reported the aircraft during the current cycle.
6. `source_conflicts` records recent conflicts when position distance exceeds 8 km or last-contact deltas exceed 45 seconds.
7. `data_source`, `source_confidence`, `source_provenance`, `source_conflicts`, `source_counts`, and `source_health` are surfaced to the frontend.

Source confidence is an operational quality signal. It is not the only merge priority and does not override a fresher contact timestamp.

## Reliability Contract

`backend/flights/services/source_adapters.py` wraps each upstream fetch and persists health state in `IngestionSourceHealth` plus append-only rows in `IngestionAudit`.

| Field | Meaning |
| :--- | :--- |
| `status` | One of `ok`, `disabled`, `rate_limited`, `degraded`, `circuit_open`, or `error`. |
| `enabled` | Whether the source is configured for ingestion. |
| `confidence_score` | Base confidence adjusted by the current health state. |
| `consecutive_failures` | Network or response failures since the last successful fetch. |
| `latency_ms` | Duration of the most recent fetch. |
| `aircraft_count` | Number of source rows returned. |
| `normalized_count` | Number of rows normalized by the source adapter. |
| `rejected_count` | Number of rows rejected during normalization. |
| `rate_limited_until` | Cooldown timestamp for HTTP 429 or skipped payloads. |
| `circuit_open_until` | Cooldown timestamp for open circuit breakers. |

## Circuit Breaker Behavior

- A source opens its circuit after 3 consecutive failures. OpenSky uses a stricter threshold of 2 because it is the baseline feed.
- An open circuit is bypassed for 120 seconds by default.
- HTTP 429 or no-payload responses are treated as rate-limited and bypassed for 120 seconds by default.
- Required source failures are raised to the calling task; optional source failures return an empty payload and mark the source degraded.
- Confidence scores decay from the base score when the source is unhealthy and drop to `0.0` when disabled.

## Frontend-Only Data Path

Frontend-only mode uses TanStack Start server routes instead of the Django ingestion pipeline:

| Route | Source |
| :--- | :--- |
| `/api/flights` | OpenSky states with optional OAuth token and stale-position filtering. |
| `/api/satellites` | CelesTrak TLE groups with bundled bootstrap fallback records. |
| `/api/enrichment` | ADSBDB and route metadata helpers. |
| `/api/photo` | Aircraft image proxy restricted by `ALLOWED_AIRCRAFT_IMAGE_HOSTS`. |
| `/api/flight-track` | OpenSky aircraft track lookup. |

This mode has no PostgreSQL history, Celery ingestion, Redis cache, or WebSocket fanout.

## Operational Caveats

- Public receiver networks do not guarantee full geographic coverage.
- API quotas, throttling, and upstream schema changes can reduce live coverage without breaking the application.
- Do not use this project as the sole source for safety-of-life, air traffic control, emergency response, or regulatory decisions.
- Review every upstream source's current usage terms before operating a public or commercial deployment.
