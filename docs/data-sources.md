# Data Sources & Source Reliability Contract

SkyWatch Live gathers data from several public aviation feeds, APRS socket feeds, meteorological reports, and space catalogs. These sources are inherently volatile; the application is built from the ground up to assume all sources can fail independently, treating missing sources as degraded regional coverage rather than a system-wide failure.

---

## 1. Registered Sources Catalog

| Source | Identifier | Confidence | Ingestion Strategy / API Contract | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **OpenSky Network** | `opensky` | **0.96** | REST HTTP GET to `/states/all` (extended properties). OAuth client credentials or legacy basic auth improves rate limits. | Primary baseline feed. Public queries rate-limit and throttle frequently. |
| **ADS-B One** | `adsb_one` | **0.90** | Concurrent regional point queries (`/v2/point/{lat}/{lon}/{rad}`) around key hubs. | Deduplicated by ICAO24 against OpenSky. |
| **Airplanes.live** | `airplanes_live` | **0.90** | Regional point queries mapped to OpenSky structure. | Solid secondary ADSB aggregator. |
| **ADSB.lol** | `adsb_lol` | **0.86** | Regional point queries. | Excellent supplemental receiver community. |
| **Open Glider Network** | `ogn` | **0.82** | Raw TCP connection to APRS-IS glider sockets (`aprs.glidernet.org:14580`). | Captures gliders, small FLARM transponders. |
| **FAA / Mil Radar** | `faa_radar` | **0.78** | REST HTTP GET call to `/v2/mil` endpoint. | Decodes government/military and state aircraft. |
| **UAT / TIS-B** | `uat` | **0.80** | Multi-point query targeting major US hubs, filtering UAT markers (`adsb_icao_uat`, etc.). | Identifies small US General Aviation (978 MHz). |
| **Satellite ADS-B** | `satellite` | **0.74** | Oceanic point queries, filtering explicit satellite metadata flags. | Tracks ocean crossings (Honolulu, Azores, Fiji, etc.). |
| **Aviation Weather Center** | `weather` | N/A | REST requests to `/api/data/metar` and `/api/data/isigmet`. | Decodes meteorological reports and weather cards. |
| **FAA TFR** | `tfr` | N/A | FAA WFS GeoJSON feed endpoints. | Renders live temporary airspace restrictions. |
| **ADSBDB Metadata** | `adsbdb` | N/A | REST HTTP GET to `api.adsbdb.com/v0`. | Used for aircraft photos and manufacturer lookups. |

---

## 2. Ingestion Merging & Prioritization

To resolve geographical overlapping and source metadata conflicts, the ingestion engine uses a strict prioritization contract:
1. **Deduplication:** The primary key is the lowercase 6-character ICAO24 hex address.
2. **Prioritization:** If an aircraft is found across multiple feeds during a single ingestion cycle, the record from the feed with the **highest Base Confidence Score** is preserved.
3. **Provenance Annotation:** The final saved flight state metadata registers the active `data_source` and preserves the `source_provenance` array tracking all feeds that captured the aircraft in the current window.
4. **Source Conflicts:** If critical discrepancies (such as differing callsigns or >1 NM altitude/position splits) are encountered during deduplication, a `source_conflict_count` is logged for auditing.

---

## 3. Source Reliability Contract & Circuit Breaker Logic

The `IngestionSourceHealth` and `source_adapters.py` wrapper regulates all source ingestion tasks to enforce service reliability:

### Health Contract Metric Variables
Each source health adapter tracks:
* `status`: One of `"ok"`, `"error"`, `"rate_limited"`, `"circuit_open"`, or `"disabled"`.
* `confidence_score`: Calculated dynamically from base confidence and failures.
* `consecutive_failures`: Incremented on network timeout or HTTP error.
* `latency_ms`: Duration of the last API call.
* `aircraft_count`: Total aircraft vectors returned.
* `rate_limited_until`: Future timestamp indicating when upstream throttling expires.
* `circuit_open_until`: Future timestamp indicating when the circuit breaker closes.

### Circuit Breaker Mechanics
* **Trigger:** If a source experiences **3 consecutive failures** (or 2 for OpenSky due to its critical nature), its circuit breaker state switches to `"circuit_open"`.
* **Execution Bypass:** For the next **120 seconds** (`circuit_breaker_seconds`), all ingestion calls to that source are immediately aborted and returned as an empty list, protecting the ingestion task from long HTTP hanging timeouts.
* **Confidence Decay:** When a source enters an unhealthy state, its confidence score decays:
  $$\text{Confidence} = \max(0.05, \text{Base Confidence} - (\text{Consecutive Failures} \times 0.12))$$
* **Rate Limits:** If an HTTP 429 is encountered, the source status becomes `"rate_limited"` and is bypassed for **120 seconds**.

