# Deployment Guide

How to deploy SkyWatch Live to production.

## Overview

SkyWatch Live is designed for flexible deployment:
- **Lightweight**: Frontend-only mode for dashboard visualization
- **Full-stack**: Complete backend with persistence, ingestion, and ML
- **Enterprise**: Clustered deployment with multiple workers

See [docs/production.md](docs/production.md) for detailed production setup.

## Quick Reference

| Deployment Type | Use Case | Complexity |
| :--- | :--- | :--- |
| Frontend-only | Dashboard for live public APIs | Low |
| Single-machine | Small-scale monitoring | Medium |
| Docker Compose | Small production (< 100k aircraft) | Medium |
| Kubernetes | Large-scale enterprise | High |

## Pre-Deployment Checklist

### Security
- [ ] Change all default credentials
- [ ] Generate strong `DJANGO_SECRET_KEY`
- [ ] Configure HTTPS/TLS certificates
- [ ] Set `DJANGO_DEBUG=False`
- [ ] Review environment variables in `.env`
- [ ] Enable security headers (HSTS, CSP)
- [ ] Configure firewall rules
- [ ] Set up rate limiting

### Infrastructure
- [ ] PostgreSQL database ready (with backups)
- [ ] Redis instance deployed
- [ ] Storage for logs and metrics
- [ ] Monitoring stack (Prometheus/Grafana)
- [ ] Reverse proxy configured (nginx, Caddy)
- [ ] Backup strategy in place
- [ ] Load testing completed

### Application
- [ ] Run `npm run backend:check-deploy`
- [ ] Run `npm test`
- [ ] Build frontend: `npm run build`
- [ ] Database migrations tested
- [ ] API endpoints verified
- [ ] WebSocket connectivity tested

## Common Deployment Methods

### 1. Docker Compose (Recommended for Production)

```bash
# Build images
docker compose build

# Start services
docker compose up -d

# Check status
docker compose ps

# View logs
docker compose logs -f
```

See `docker-compose.yml` for all configured services.

### 2. Manual Installation

#### Backend Setup

```bash
cd backend

# Create Python virtual environment
python3.11 -m venv venv
source venv/bin/activate  # Linux/macOS
# or venv\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env with production values

# Run migrations
python manage.py migrate

# Collect static files
python manage.py collectstatic --noinput

# Run security checks
python manage.py check --deploy
```

#### Frontend Setup

```bash
cd frontend

# Install dependencies
npm ci

# Build for production
npm run build

# Configure environment
cp .env.example .env.local
# Edit .env.local with production API URL
```

#### Run Services

```bash
# Backend (in one terminal)
cd backend
daphne -b 0.0.0.0 -p 8000 skywatch.asgi:application

# Celery worker (in another terminal)
cd backend
celery -A skywatch worker --loglevel=INFO

# Celery beat (in another terminal)
cd backend
celery -A skywatch beat --loglevel=INFO

# Frontend (requires Node.js serving)
# Use a web server like nginx to serve the build/
```

### 3. Kubernetes Deployment

For large-scale deployments, use Kubernetes:

```bash
# Example Helm chart setup (create your own or use community charts)
helm install skywatch ./helm-chart --values values-prod.yaml
```

Key considerations:
- Use Helm for templating
- Configure resource limits
- Set up horizontal pod autoscaling
- Use persistent volumes for databases
- Configure ingress for traffic routing

### 4. Platform as a Service (Heroku, Railway, etc.)

Some platforms offer simplified deployments:

```bash
# Example: Heroku
heroku create skywatch-live
heroku addons:create heroku-postgresql:standard-0
heroku addons:create heroku-redis:premium-0

git push heroku main
heroku run python manage.py migrate
```

Adjust commands based on your chosen platform.

## Environment Configuration

### Essential Variables

```env
# Django
DJANGO_SECRET_KEY=your-super-secret-key-here-change-this
DJANGO_DEBUG=False
ALLOWED_HOSTS=api.example.com,example.com
DJANGO_ADMIN_URL_PATH=hidden-admin-path/

# CORS & Security
CSRF_TRUSTED_ORIGINS=https://api.example.com,https://example.com
CORS_ALLOWED_ORIGINS=https://example.com
DJANGO_SECURE_SSL_REDIRECT=True
DJANGO_SECURE_HSTS_SECONDS=31536000
DJANGO_SECURE_HSTS_INCLUDE_SUBDOMAINS=True
DJANGO_SECURE_HSTS_PRELOAD=True

# Database (Use managed service in production)
DATABASE_URL=postgres://user:password@prod-db-host:5432/skywatch

# Redis (Use managed service in production)
REDIS_URL=redis://default:password@prod-redis-host:6379/0

# Metrics
METRICS_USER=metrics-user
METRICS_PASSWORD=strong-password-here

# Optional: API Credentials
OPENSKY_CLIENT_ID=your-opensky-id
OPENSKY_CLIENT_SECRET=your-opensky-secret
```

## Scaling Considerations

### Vertical Scaling (Bigger Machines)

- Increase Django worker count
- Allocate more Celery workers
- Increase PostgreSQL shared_buffers
- Increase Redis maxmemory

### Horizontal Scaling (More Machines)

- Run multiple Django app servers behind load balancer
- Run multiple Celery workers with message queue
- Use managed PostgreSQL with read replicas
- Configure Redis cluster for HA

### Database Optimization

```sql
-- Important indexes
CREATE INDEX idx_aircraft_icao24 ON flights_aircraft(icao24);
CREATE INDEX idx_flightstate_updated ON flights_flightstate(updated DESC);
CREATE INDEX idx_flightposition_timestamp ON flights_flightposition(timestamp DESC);

-- Archive old data
DELETE FROM flights_flightposition WHERE timestamp < NOW() - INTERVAL '30 days';
```

### WebSocket Scaling

For multiple app servers, configure Redis Channels layer:

```python
# backend/skywatch/settings.py
CHANNEL_LAYERS = {
    'default': {
        'BACKEND': 'channels_redis.core.RedisChannelLayer',
        'CONFIG': {
            'hosts': [('redis-prod-host', 6379)],
            'capacity': 10000,
        },
    },
}
```

## Monitoring & Observability

### Health Checks

```bash
# Liveness (is the service up?)
curl http://your-api/health/live

# Readiness (is it ready to handle traffic?)
curl http://your-api/health/ready

# Metrics
curl http://your-api/metrics
```

### Logging

Configure centralized logging:

```env
LOG_LEVEL=INFO
SENTRY_DSN=https://your-sentry-dsn
DJANGO_ENV=production
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4317
```

### Metrics Collection

```bash
# Prometheus scrapes from:
http://your-api/metrics
```

Configure Grafana dashboards from `grafana/provisioning/`.

## Backup Strategy

### Database Backups

```bash
# PostgreSQL dumps
pg_dump -h prod-db-host -U skywatch skywatch > backup.sql

# Automated with pg_basebackup
pg_basebackup -h prod-db-host -D /backup/skywatch
```

### Redis Persistence

Ensure Redis `appendonly yes` is enabled:

```conf
# redis.conf
appendonly yes
appendfsync everysec
dir /data
```

### Restore Procedures

```bash
# Restore PostgreSQL
psql -h prod-db-host -U skywatch skywatch < backup.sql

# Restore Redis
redis-cli shutdown
cp backup.rdb /var/lib/redis/
redis-server
```

## Maintenance & Updates

### Zero-Downtime Deployments

1. Deploy new version to staging
2. Run migrations with blue-green deployment
3. Test endpoints
4. Switch traffic to new version
5. Keep old version ready for rollback

### Security Updates

```bash
# Check for vulnerabilities
npm audit --prefix frontend
npm run backend:check-deploy

# Update dependencies
npm update
pip install --upgrade -r requirements.txt
```

### Log Rotation

Configure log rotation to prevent disk space issues:

```bash
# logrotate configuration
/var/log/skywatch/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    create 640 skywatch skywatch
    sharedscripts
}
```

## Troubleshooting

### Common Production Issues

1. **High latency**: Check database query performance, add indexes
2. **Memory leaks**: Monitor with `memory_profiler`, restart workers periodically
3. **Database locks**: Verify connection pooling (PgBouncer), kill long queries
4. **WebSocket drops**: Check Redis connection, increase timeout settings

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for detailed solutions.

## Performance Tuning

### Django Settings

```python
# Increase from default
CONN_MAX_AGE = 600
DATABASE_POOL_SIZE = 20

# Caching
CACHES = {
    'default': {
        'BACKEND': 'django_redis.cache.RedisCache',
        'LOCATION': 'redis://...',
    }
}
```

### PostgreSQL Tuning

```sql
-- Increase for production
ALTER SYSTEM SET shared_buffers = '4GB';
ALTER SYSTEM SET effective_cache_size = '12GB';
ALTER SYSTEM SET maintenance_work_mem = '1GB';
ALTER SYSTEM SET checkpoint_completion_target = 0.9;

SELECT pg_reload_conf();
```

### Celery Tuning

```bash
# Start with specific concurrency
celery -A skywatch worker \
  --concurrency=8 \
  --prefetch-multiplier=4 \
  --max-tasks-per-child=1000
```

## Support & Help

For deployment assistance:

📧 **debjitdey450@gmail.com**

Include:
- Deployment platform
- Number of aircraft
- Expected traffic
- Performance requirements
- Current bottlenecks

See also:
- [docs/production.md](docs/production.md) - Detailed production setup
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) - Common issues
- [SUPPORT.md](SUPPORT.md) - Getting help

---

**Last Updated**: May 2024
