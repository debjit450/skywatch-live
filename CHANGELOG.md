# CHANGELOG

All notable changes to SkyWatch Live will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Refreshed README, quick start, deployment, testing, troubleshooting, support, security, data-source, production, development, and architecture docs from the current repository state.
- Updated architecture diagrams to reflect MapLibre/deck.gl, TanStack Start server routes, Django REST/Channels, Celery, Redis, PostgreSQL, Prometheus, Grafana, and Jaeger.
- Added third-party licensing and data-source notice coverage in `THIRD_PARTY_NOTICES.md`.
- Aligned local documentation and setup-facing scripts with the configured frontend dev port `8080`.
- Replaced stale map-stack references with the current MapLibre/deck.gl implementation.

### Fixed
- Corrected outdated Docker Compose language. Compose provisions infrastructure services, not backend/frontend application services.
- Corrected source merge documentation to match the code path: normalized ICAO24 records are deduplicated by freshest `last_contact`, with provenance and conflict metadata retained.
- Removed stale last-updated markers and corrupted symbol text from support and troubleshooting docs.

### Planned
- User authentication and role-based access control hardening for operator workflows.
- Saved searches and richer alert management.
- Additional automated frontend test coverage after selecting a test runner.

## [1.0.0] - 2024-05-24

### Added
- Initial open source release
- MIT License
- Comprehensive documentation
- Complete security policy and vulnerability reporting guidelines
- Contributor Code of Conduct
- GitHub issue and pull request templates
- Support documentation with contact information

### Features
- Live aircraft map with real-time tracking from multiple ADS-B sources
- Django REST API with WebSocket support for flight updates
- Anomaly detection using rule-based and ML-based approaches
- Short-horizon route prediction
- Optional LSTM sequence anomaly scoring
- CelesTrak satellite visualization with SGP4 propagation
- METAR weather cards and airspace restriction overlays
- Alert rules system for custom flight monitoring
- Prometheus metrics and Grafana dashboards
- PostgreSQL persistence with Redis caching
- Celery background job processing
- Multi-source flight data aggregation:
  - OpenSky Network (primary)
  - ADS-B One, Airplanes.live, ADSB.lol (supplemental)
  - FAA/military radar data
  - UAT/TIS-B feeds
  - Satellite ADS-B
  - Open Glider Network/FLARM
- Historical flight playback
- JSON logs with request IDs
- Optional Sentry integration
- Optional OpenTelemetry export

### Backend Features
- Django 5.0+ with async support
- Channels for WebSocket broadcasting
- DRF for REST API
- Celery Beat for scheduled tasks
- Advanced anomaly detection with explainability
- Aircraft profile matching
- Route reconstruction and analysis
- Spatial grid indexing for proximity detection

### Frontend Features
- React with TanStack Start SSR
- MapLibre/deck.gl interactive map
- Real-time data visualization
- Aircraft filtering and search
- Detail panels for flight information
- Responsive dashboard layout
- Dark/light theme support
- Historical track playback

### Infrastructure
- Docker Compose setup with all services
- PostgreSQL with PgBouncer connection pooling
- Redis for caching and messaging
- Jaeger tracing support
- Prometheus metrics collection
- Grafana dashboard provisioning
- Health checks and readiness probes

### Documentation
- Architecture documentation
- Development setup guide
- Production deployment runbook
- Data sources documentation
- API reference in README
- Quick start guide
- Contributing guidelines
- Security policy
- Contributors guide

## Versioning Notes

- **Major version (X.0.0)**: Breaking changes to API, database schema, or deployment requirements
- **Minor version (0.X.0)**: New features, backward compatible
- **Patch version (0.0.X)**: Bug fixes and minor improvements

For detailed release notes, see [GitHub Releases](https://github.com/debjit450/skywatch-live/releases).
