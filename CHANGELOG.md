# CHANGELOG

All notable changes to SkyWatch Live will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Leaflet-based interactive map
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

## [Unreleased]

### Planned Features
- User authentication and role-based access control
- Saved flight searches and alerts
- Custom map layers
- Flight comparison tools
- Advanced analytics dashboard
- Mobile app support
- Multi-language support
- Performance optimizations for 100k+ aircraft

### Performance Improvements
- Database query optimization
- WebSocket message batching
- Frontend rendering optimization
- ML model inference acceleration

### Known Limitations
- Public API rate limits may affect coverage
- Flight data sourced from public feeds (no guarantee of continuous coverage)
- Some regions may have sparse receiver networks
- Historical data retention depends on deployment configuration

---

## Versioning Notes

- **Major version (X.0.0)**: Breaking changes to API, database schema, or deployment requirements
- **Minor version (0.X.0)**: New features, backward compatible
- **Patch version (0.0.X)**: Bug fixes and minor improvements

For detailed release notes, see [GitHub Releases](https://github.com/debjit450/skywatch-live/releases).
