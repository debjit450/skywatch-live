# Troubleshooting

Common issues and solutions for SkyWatch Live.

## Installation & Setup

### Docker Not Found

**Problem**: `docker: command not found` or similar error

**Solutions**:
1. Install Docker Desktop from https://www.docker.com/products/docker-desktop
2. Ensure Docker daemon is running
3. On Linux, verify user is in docker group: `sudo usermod -aG docker $USER`
4. Use dockerless mode: `npm run startup:nodock`

### Port Already in Use

**Problem**: `Address already in use` or port conflicts

**Solutions**:
```bash
# Find what's using port (example: 5173)
lsof -i :5173           # macOS/Linux
netstat -ano | findstr :5173  # Windows

# Kill the process or use different ports
npm run dev -- --port 3000    # Use different frontend port
```

### Python Virtual Environment Issues

**Problem**: `ModuleNotFoundError` or package import errors

**Solutions**:
```bash
# Recreate venv
cd backend
rm -rf venv
python -m venv venv
source venv/bin/activate    # macOS/Linux
venv\Scripts\activate       # Windows
pip install -r requirements.txt
```

### Node Modules Issues

**Problem**: `ENOENT: no such file or directory` or dependency errors

**Solutions**:
```bash
# Clear npm cache and reinstall
npm cache clean --force
rm -rf node_modules frontend/node_modules
npm ci
npm --prefix frontend ci
```

## Database & Redis

### Database Connection Error

**Problem**: `could not connect to server`

**Solutions**:

1. **Check if services are running**:
   ```bash
   docker compose ps
   ```

2. **Verify connection string**:
   ```bash
   # Check DATABASE_URL in backend/.env
   echo $DATABASE_URL
   ```

3. **Reset database**:
   ```bash
   npm run db:reset -- --yes
   npm run backend:migrate
   ```

4. **Check PostgreSQL logs**:
   ```bash
   docker compose logs db
   ```

### Redis Connection Issues

**Problem**: `Error: connect ECONNREFUSED 127.0.0.1:6379`

**Solutions**:
```bash
# Start Redis
docker compose up -d redis

# Test connection
redis-cli ping

# Check Redis logs
docker compose logs redis
```

### Database Locked (SQLite)

**Problem**: `database is locked` when using SQLite

**Solutions**:
1. This is normal with concurrent access - use PostgreSQL for production
2. Close all connections: Kill the dev server and try again
3. Remove lock file: `rm backend/db.sqlite3-wal`

## Frontend Issues

### Dashboard Not Loading

**Problem**: Blank page or white screen

**Solutions**:
1. Check browser console for errors (F12 → Console)
2. Verify API URL: `VITE_SKYWATCH_API_BASE` in `frontend/.env.local`
3. Check if backend is running: `http://localhost:8000/api/v1/flights/`
4. Clear browser cache: Ctrl+Shift+Delete (or Cmd+Shift+Delete)

### Map Not Rendering

**Problem**: Map shows gray/blank area

**Solutions**:
1. Verify Leaflet CSS is loaded (check Network tab in DevTools)
2. Check browser console for JavaScript errors
3. Ensure geolocation permissions are granted
4. Try different browser (Chrome, Firefox, Safari)

### Slow Performance / Lag

**Problem**: Dashboard is sluggish, slow to update

**Solutions**:
1. **Reduce aircraft count**: Use filters to show fewer flights
2. **Check system resources**: Open Task Manager/Activity Monitor
3. **Disable unnecessary overlays**: Turn off satellite/weather if not needed
4. **Check network**: Verify WebSocket connection in DevTools → Network
5. **Frontend optimization**:
   ```bash
   npm run build     # Build for production
   npm run preview   # Preview production build
   ```

## Backend Issues

### Celery Workers Not Running

**Problem**: Background jobs not processing, anomaly detection not working

**Solutions**:
```bash
# Start Celery in a new terminal
npm run backend:celery

# Start Beat in another terminal
npm run backend:beat

# Check if tasks are queued
redis-cli KEYS "celery-task-meta-*"
```

### Django Migrations Failed

**Problem**: Migration errors or database schema mismatch

**Solutions**:
```bash
# Check migration status
python manage.py showmigrations

# Rollback to specific migration
python manage.py migrate flights 0006

# Create fresh migrations
python manage.py makemigrations
python manage.py migrate
```

### API Returns 500 Error

**Problem**: Internal Server Error responses

**Solutions**:
1. Check server logs: `docker compose logs api` or terminal where backend runs
2. Check database connection
3. Verify all required environment variables are set
4. Run health check: `curl http://localhost:8000/health/ready`

## Data & Ingestion

### No Aircraft Showing on Map

**Problem**: Map is empty, no flight data

**Solutions**:
1. **Check if Celery is running**: See above
2. **Verify data sources are enabled**:
   ```bash
   # Check .env settings
   grep ENABLED backend/.env
   ```
3. **Check ingestion task logs**:
   ```bash
   docker compose logs api | grep "fetch_flight_states"
   ```
4. **Manual test**:
   ```bash
   npm run backend:shell
   >>> from flights.services.opensky import fetch_all_states
   >>> states = fetch_all_states()
   >>> len(states)  # Should show number of aircraft
   ```

### Old Data in Dashboard

**Problem**: Map shows outdated flight information

**Solutions**:
1. **Clear cache**:
   ```bash
   redis-cli FLUSHALL
   ```
2. **Restart Celery workers**: Kill and restart
3. **Check cache settings**: Verify `REDIS_URL` in backend/.env

### API Rate Limiting

**Problem**: Getting 429 Too Many Requests

**Solutions**:
1. **OpenSky Network**: Register for API credentials
   ```bash
   # Set in backend/.env
   OPENSKY_CLIENT_ID=your_id
   OPENSKY_CLIENT_SECRET=your_secret
   ```
2. **Space requests**: Celery job runs every 15 seconds (configurable)
3. **Use supplemental sources**: Enable ADS-B One, Airplanes.live, etc.

## WebSocket & Real-Time

### No Real-Time Updates

**Problem**: Dashboard shows static data, doesn't update in real-time

**Solutions**:
1. **Check WebSocket connection**:
   - DevTools → Network → WS (WebSocket tab)
   - Should show connection to `/ws/flights/`
2. **Verify Redis Channels**:
   ```bash
   redis-cli SUBSCRIBE celery-task-meta-*
   ```
3. **Check if Celery is running and sending updates**
4. **Browser console**: Look for connection errors

### WebSocket Connection Drops

**Problem**: Frequent disconnects or connection timeouts

**Solutions**:
1. **Increase timeout values** in `backend/skywatch/settings.py`:
   ```python
   CHANNEL_LAYERS = {
       'default': {
           'TIMEOUT': 60,  # Increase from default
       }
   }
   ```
2. **Check network stability**: Test with ping/latency tools
3. **Verify Redis is stable**: Check Redis logs
4. **Restart services**: Sometimes helps with stale connections

## Performance Tuning

### High CPU Usage

**Problem**: Backend CPU constantly at 100%

**Solutions**:
1. **Reduce ingestion frequency**: Adjust in `backend/skywatch/celery.py`
2. **Disable unused sources**: Set `*_ENABLED=False` in `.env`
3. **Scale workers**: Run multiple Celery workers
4. **Database indexing**: Verify indexes are created

### High Memory Usage

**Problem**: System running out of RAM

**Solutions**:
1. **Reduce flight history retention**: Configure in settings
2. **Enable data cleanup**: `cleanup-old-data-hourly` task
3. **Optimize queries**: Use Django debug toolbar in development
4. **Scale vertically**: Add more RAM or split services

### Slow Queries

**Problem**: API endpoints respond slowly

**Solutions**:
```bash
# Enable query logging
DJANGO_DEBUG=True
# Check Django Debug Toolbar (development only)

# Profile with Django
python manage.py shell_plus --print-sql

# Check PostgreSQL slow queries
docker compose logs db | grep "duration"
```

## Docker Issues

### Container Won't Start

**Problem**: Docker container exits immediately

**Solutions**:
```bash
# Check logs
docker compose logs service_name

# Verify image exists
docker images

# Rebuild image
docker compose build --no-cache service_name

# Try full restart
docker compose down
docker compose up --build
```

### Out of Disk Space

**Problem**: Docker running out of storage

**Solutions**:
```bash
# Clean up unused images/containers
docker system prune -a

# Check disk usage
docker system df

# Remove specific container data
docker compose down -v  # Warning: deletes volumes
```

## Production Issues

### SSL/TLS Certificate Problems

**Problem**: `SSL: CERTIFICATE_VERIFY_FAILED`

**Solutions**:
1. Verify certificate is valid and not expired
2. Check certificate chain is complete
3. Ensure reverse proxy is configured correctly
4. Test: `curl -I https://your-domain.com`

### Environment Variable Not Loading

**Problem**: Configuration settings ignored

**Solutions**:
```bash
# Verify .env file exists and is readable
ls -la backend/.env

# Check if variables are exported
env | grep DJANGO

# Reload environment
source backend/.env  # Unix/Linux/macOS
```

## Still Having Issues?

If you can't find your problem here:

1. **Search existing GitHub issues**: https://github.com/debjit450/skywatch-live/issues
2. **Check documentation**: [README.md](README.md), [docs/](docs/)
3. **Contact support**: debjitdey450@gmail.com
   - Include error messages
   - Describe steps to reproduce
   - Provide system information (OS, versions)
   - Relevant logs or screenshots

---

**Last Updated**: May 2024
