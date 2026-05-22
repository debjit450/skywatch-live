import type { LucideIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Clock,
  Cloud,
  CloudLightning,
  CloudSun,
  Compass,
  Crosshair,
  Eye,
  Gauge,
  Globe,
  Hash,
  History,
  Layers,
  MapPin,
  Minimize2,
  Mountain,
  Navigation,
  Navigation2,
  Plane,
  Radio,
  Route as RouteIcon,
  Ruler,
  Satellite,
  Signal,
  Sun,
  Target,
  Thermometer,
  Timer,
  TrendingDown,
  TrendingUp,
  Wind,
  X,
  Zap,
} from "lucide-react";
import { useAirports } from "@/hooks/useAirports";
import type { Flight } from "@/lib/opensky";
import type { AnomalousFlight } from "@/lib/anomaly";
import type { EnrichmentData, RouteAirport } from "@/lib/enrichment-types";
import type {
  FlightLayover,
  FlightTrackData,
  FlightTrackPhase,
  FlightTrackPoint,
} from "@/lib/flightTrack";
import { fetchBackendJson } from "@/lib/backend-api";
import HelicopterIcon from "@/components/HelicopterIcon";
import { getAirportCode, type Airport } from "@/lib/airports";
import { anomalyIcons } from "@/lib/icons";
import { predictFlightState } from "@/lib/prediction";
import {
  airlineFromCallsign,
  altitudeFt,
  countryCode,
  estimateMach,
  flightLevel,
  fmt,
  formatClock,
  formatDateTimeSeconds,
  headingCompass,
  speedKmh,
  speedKt,
  speedMph,
  toDMS,
  vsFpm,
  M_TO_FT,
  NM_TO_KM,
  getAircraftCategoryLabel,
  isaTemperatureK,
  isaPressurePa,
  isaDensity,
  speedOfSound,
  estimateTAS,
  estimateCAS,
  dynamicPressure,
  pressureAltitudeFt,
  densityAltitudeFt,
  estimateTurnRate,
  standardRateBankAngle,
  loadFactorAtBank,
  standardRateTurnRadius,
  gcDistanceKm,
  gcDistanceNm,
  gcBearing,
  crossTrackDistanceKm,
  gcMidpoint,
  signalFreshnessLabel,
  positionSourceQuality,
  squawkMeaning,
  isNotableSquawk,
} from "@/lib/format";
import { getDataSourceInfo, positionSourceLabel } from "@/lib/data-sources";

interface Props {
  flight: Flight;
  anomaly: AnomalousFlight | undefined;
  onClose: () => void;
  onMinimize: () => void;
  enrichment: EnrichmentData | null | undefined;
  enrichmentLoading: boolean;
  flightTrack?: FlightTrackData | null;
  flightTrackLoading?: boolean;
  anomalyHistory?: Array<{
    time: number;
    altitude: number | null;
    speed: number | null;
    heading: number | null;
  }>;
  style?: React.CSSProperties;
}

const sevStyles: Record<string, string> = {
  critical: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  high: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  low: "bg-blue-500/10 text-blue-400 border-blue-500/20",
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function parseTrackTime(point: FlightTrackPoint): number {
  const ms = Date.parse(point.time);
  return Number.isFinite(ms) ? ms : 0;
}

function formatTrackDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "--";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(1)} hr`;
}

function formatTrackTime(value: string | null | undefined): string {
  if (!value) return "--";
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? formatClock(ms) : "--";
}

function routeAirportCodes(airport: RouteAirport | null | undefined): string {
  if (!airport) return "--";
  return [airport.iataCode, airport.icaoCode].filter(Boolean).join(" / ") || "--";
}

function routeAirportLocation(airport: RouteAirport | null | undefined): string {
  if (!airport) return "--";
  return [airport.municipality, airport.countryIso || airport.countryName]
    .filter(Boolean)
    .join(", ");
}

function routeSourceLabel(source: string | null | undefined): string {
  if (source === "opensky") return "OpenSky aircraft history";
  if (source === "adsbdb") return "ADSBdb callsign route";
  return "Unknown";
}

function nearestAirportToPoint(
  airports: Airport[],
  lat: number,
  lon: number,
  maxDistanceKm = 140,
): { airport: Airport; distanceKm: number } | null {
  let best: { airport: Airport; distanceKm: number } | null = null;
  for (const airport of airports) {
    if (airport.type === "closed_airport") continue;
    const distanceKm = gcDistanceKm(lat, lon, airport.lat, airport.lon);
    if (distanceKm > maxDistanceKm) continue;
    if (!best || distanceKm < best.distanceKm) best = { airport, distanceKm };
  }
  return best;
}

interface PanelLayover extends FlightLayover {
  airportCode: string;
  airportName: string;
  airportDistanceKm: number | null;
  airportCodes: string;
}

interface WeatherMetar {
  station: string;
  raw: string;
  wind_direction: number | null;
  wind_speed: number | null;
  visibility: number | null;
  ceiling: number | null;
  temperature: number | null;
  flight_category: string;
}

interface WeatherPayload {
  weather?: Record<string, WeatherMetar>;
}

function getWeatherCategoryConfig(category: string) {
  const cat = (category || "").toUpperCase();
  if (cat === "VFR") {
    return {
      icon: Sun,
      label: "VFR",
      description: "Visual Flight Rules",
      colorClass: "text-emerald-400 border-emerald-500/20 bg-emerald-500/10",
      badgeColor: "#10b981",
    };
  }
  if (cat === "MVFR") {
    return {
      icon: CloudSun,
      label: "MVFR",
      description: "Marginal VFR",
      colorClass: "text-blue-400 border-blue-500/20 bg-blue-500/10",
      badgeColor: "#3b82f6",
    };
  }
  if (cat === "IFR") {
    return {
      icon: Cloud,
      label: "IFR",
      description: "Instrument Flight Rules",
      colorClass: "text-rose-400 border-rose-500/20 bg-rose-500/10",
      badgeColor: "#ef4444",
    };
  }
  if (cat === "LIFR") {
    return {
      icon: CloudLightning,
      label: "LIFR",
      description: "Low IFR",
      colorClass: "text-fuchsia-400 border-fuchsia-500/20 bg-fuchsia-500/10",
      badgeColor: "#d946ef",
    };
  }
  return {
    icon: CloudSun,
    label: cat || "UNK",
    description: "Unknown",
    colorClass: "text-zinc-400 border-zinc-500/20 bg-zinc-500/10",
    badgeColor: "#71717a",
  };
}

function AirportWeatherCard({
  label,
  airportCode,
  weather,
}: {
  label: string;
  airportCode: string;
  weather: WeatherMetar | null;
}) {
  if (!weather) {
    return (
      <div className="bg-[var(--sw-surface-strong)] border border-[var(--sw-border)] rounded-xl p-3 flex flex-col justify-center min-h-[75px]">
        <div className="flex justify-between items-center mb-1">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-[var(--sw-muted)]">
            {label} Weather
          </span>
          <span className="font-mono text-[10px] font-semibold text-[var(--sw-text)]">
            {airportCode}
          </span>
        </div>
        <span className="text-[9px] text-[var(--sw-muted)] italic">
          No real-time weather available
        </span>
      </div>
    );
  }

  const catConfig = getWeatherCategoryConfig(weather.flight_category);

  return (
    <div className="bg-[var(--sw-surface-strong)] border border-[var(--sw-border)] rounded-xl p-3.5 flex flex-col">
      <div className="flex justify-between items-center mb-3">
        <div>
          <span className="block text-[8px] font-bold uppercase tracking-wider text-[var(--sw-muted)] leading-none mb-1">
            {label} Terminal
          </span>
          <strong className="block text-xs font-semibold text-[var(--sw-text)] tracking-tight leading-none font-mono">
            {airportCode}
          </strong>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[9px] font-bold tracking-wider border ${catConfig.colorClass}`}
        >
          <catConfig.icon className="w-3.5 h-3.5 flex-shrink-0" />
          {catConfig.label}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-[9px] border-b border-[var(--sw-border)] pb-2.5 mb-2.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Wind className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
          <span className="text-[var(--sw-text)] truncate font-mono">
            {weather.wind_direction !== null ? (
              <span className="inline-flex items-center gap-1">
                <Navigation2
                  className="w-2.5 h-2.5 text-blue-400 fill-current"
                  style={{ transform: `rotate(${weather.wind_direction}deg)` }}
                />
                {weather.wind_direction}°/{weather.wind_speed}kt
              </span>
            ) : (
              "Calm"
            )}
          </span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <Thermometer className="w-3.5 h-3.5 text-orange-400 flex-shrink-0" />
          <span className="text-[var(--sw-text)] truncate font-mono">
            {weather.temperature !== null ? `${weather.temperature} °C` : "--"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <Eye className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
          <span className="text-[var(--sw-text)] truncate font-mono">
            {weather.visibility !== null ? `${weather.visibility} sm` : "--"}
          </span>
        </div>
        <div className="flex items-center gap-1.5 min-w-0">
          <Cloud className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
          <span className="text-[var(--sw-text)] truncate font-mono">
            {weather.ceiling !== null ? `${weather.ceiling.toLocaleString()} ft` : "Clear"}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[8px] font-semibold uppercase tracking-widest text-[var(--sw-muted)] leading-none">
          Raw METAR
        </span>
        <p className="text-[9px] font-mono text-[var(--sw-muted)] bg-[var(--sw-surface-soft)] p-2 rounded-lg leading-relaxed break-words border border-[var(--sw-border)] select-text">
          {weather.raw}
        </p>
      </div>
    </div>
  );
}

// ─── Main Panel ────────────────────────────────────────────────────────────────

function FlightDetailPanel({
  flight,
  anomaly,
  onClose,
  onMinimize,
  enrichment,
  enrichmentLoading,
  flightTrack,
  flightTrackLoading = false,
  anomalyHistory = [],
  style,
}: Props) {
  const { airports } = useAirports();
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [imageError, setImageError] = useState(false);
  const [terminalWeather, setTerminalWeather] = useState<{
    origin: WeatherMetar | null;
    destination: WeatherMetar | null;
    loading: boolean;
  }>({ origin: null, destination: null, loading: false });

  useEffect(() => {
    setImageError(false);
  }, [flight.icao24]);

  useEffect(() => {
    const id = window.setInterval(() => setClockNow(Date.now()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const panelAirports = useMemo(
    () => airports.filter((airport) => airport.type !== "closed_airport"),
    [airports],
  );
  const divertCandidateAirports = useMemo(
    () =>
      panelAirports.filter(
        (airport) => airport.type === "large_airport" || airport.type === "medium_airport",
      ),
    [panelAirports],
  );

  useEffect(() => {
    const origIcao = enrichment?.route?.origin?.icaoCode || enrichment?.route?.origin?.iataCode;
    const destIcao =
      enrichment?.route?.destination?.icaoCode || enrichment?.route?.destination?.iataCode;

    if (!origIcao && !destIcao) {
      setTerminalWeather({ origin: null, destination: null, loading: false });
      return;
    }

    const codes = [origIcao, destIcao].filter(
      (c): c is string => typeof c === "string" && c.length >= 3,
    );
    if (codes.length === 0) {
      setTerminalWeather({ origin: null, destination: null, loading: false });
      return;
    }

    setTerminalWeather((curr) => ({ ...curr, loading: true }));
    let active = true;

    fetchBackendJson<WeatherPayload>(`/api/v1/weather/metar/?airports=${codes.join(",")}`)
      .then((data) => {
        if (!active) return;
        const weather = data.weather || {};
        const originKey = origIcao?.toUpperCase();
        const destKey = destIcao?.toUpperCase();
        const entries = Object.values(weather);
        const originMetar = originKey
          ? weather[originKey] ||
            entries.find((item) => item.station?.toUpperCase().endsWith(originKey)) ||
            null
          : null;
        const destMetar = destKey
          ? weather[destKey] ||
            entries.find((item) => item.station?.toUpperCase().endsWith(destKey)) ||
            null
          : null;

        setTerminalWeather({
          origin: originMetar,
          destination: destMetar,
          loading: false,
        });
      })
      .catch(() => {
        if (active) {
          setTerminalWeather({ origin: null, destination: null, loading: false });
        }
      });

    return () => {
      active = false;
    };
  }, [enrichment?.route]);

  const callsign = flight.callsign?.trim() || "UNKNOWN";
  const airline = airlineFromCallsign(flight.callsign);
  const rt = enrichment?.route ?? null;

  const prediction = predictFlightState(flight, clockNow / 1000);
  const altFt = altitudeFt(prediction.baroAltitude);
  const reportedAltFt = altitudeFt(flight.baro_altitude);
  const geoAltFt = altitudeFt(flight.geo_altitude);
  const speed = speedKt(flight.velocity);
  const verticalSpeed = vsFpm(flight.vertical_rate);
  const mach = estimateMach(flight.velocity, flight.baro_altitude);
  const fl = flightLevel(flight.baro_altitude);
  const climb = (flight.vertical_rate ?? 0) > 1;
  const descend = (flight.vertical_rate ?? 0) < -1;
  const signalAgeSeconds = Math.max(0, Math.floor(clockNow / 1000 - flight.last_contact));
  const altDiffM =
    flight.baro_altitude !== null && flight.geo_altitude !== null
      ? flight.geo_altitude - flight.baro_altitude
      : null;
  const altDiffFt = altDiffM !== null ? altDiffM * M_TO_FT : null;
  const ac = enrichment?.aircraft ?? null;
  const sourceQuality = positionSourceQuality(flight.position_source);
  const sqMeaning = squawkMeaning(flight.squawk);

  const progress = useMemo(() => {
    const orig = rt?.origin;
    const dest = rt?.destination;
    if (!orig || !dest || flight.latitude === null || flight.longitude === null) return null;
    const gc = (lat1: number, lon1: number, lat2: number, lon2: number) => {
      const toRad = (d: number) => (d * Math.PI) / 180;
      const p = toRad(lat1),
        q = toRad(lat2),
        dl = toRad(lon2 - lon1);
      const a = Math.sin((q - p) / 2) ** 2 + Math.cos(p) * Math.cos(q) * Math.sin(dl / 2) ** 2;
      return 6371 * 2 * Math.asin(Math.sqrt(a));
    };
    const total = gc(orig.latitude, orig.longitude, dest.latitude, dest.longitude);
    const flown = gc(orig.latitude, orig.longitude, flight.latitude, flight.longitude);
    const remaining = gc(flight.latitude, flight.longitude, dest.latitude, dest.longitude);
    if (total < 10) return null;
    const pct = Math.min(100, Math.max(0, (flown / total) * 100));
    const speedKmhV = flight.velocity ? flight.velocity * 3.6 : null;
    const etaMinutes = speedKmhV && speedKmhV > 50 ? (remaining / speedKmhV) * 60 : null;
    const xtrackKm = crossTrackDistanceKm(
      orig.latitude,
      orig.longitude,
      dest.latitude,
      dest.longitude,
      flight.latitude,
      flight.longitude,
    );
    const xtrackNm = xtrackKm / 1.852;
    const brgDest = gcBearing(flight.latitude, flight.longitude, dest.latitude, dest.longitude);
    const brgOrig = gcBearing(flight.latitude, flight.longitude, orig.latitude, orig.longitude);
    return { pct, total, flown, remaining, etaMinutes, xtrackKm, xtrackNm, brgOrig, brgDest };
  }, [rt, flight]);

  const isRouteLikelyIncorrect = useMemo(() => {
    if (!rt || !progress || flight.latitude === null || flight.longitude === null) {
      return false;
    }

    const lat = Number(flight.latitude);
    const lon = Number(flight.longitude);
    const track = flight.true_track !== null ? Number(flight.true_track) : null;

    const orig = rt.origin;
    const dest = rt.destination;
    if (!orig || !dest) return false;

    const origLat = Number(orig.latitude);
    const origLon = Number(orig.longitude);
    const destLat = Number(dest.latitude);
    const destLon = Number(dest.longitude);

    // Calculate shortest angle difference
    const angleDiff = (a: number, b: number) => {
      const d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    };

    // 1. Heading towards origin when close to origin (landing/approaching instead of departing)
    const distToOrigin = progress.flown;
    if (distToOrigin < 150 && track !== null) {
      const brgOrig = gcBearing(lat, lon, origLat, origLon);
      const diffOrig = angleDiff(track, brgOrig);
      if (diffOrig < 80) {
        return true;
      }
    }

    // 2. Heading away from destination when far from destination
    if (progress.remaining > 100 && track !== null) {
      const brgDest = gcBearing(lat, lon, destLat, destLon);
      const diffDest = angleDiff(track, brgDest);
      if (diffDest > 90) {
        return true;
      }
    }
    // 3. Physical flight phase mismatch check (e.g. descending rapidly at the very start of a long route)
    if (progress.total > 300 && progress.pct < 30) {
      const vSpeed = flight.vertical_rate !== null ? Number(flight.vertical_rate) * 196.85 : 0; // m/s -> fpm
      const alt = flight.baro_altitude !== null ? Number(flight.baro_altitude) * 3.28084 : 0; // m -> ft
      if (vSpeed < -800 && alt < 18000) {
        return true;
      }
    }

    // 4. Backend reported low confidence override
    if (rt.routeConfidence === "low") {
      return true;
    }

    return false;
  }, [rt, progress, flight]);

  const trackSummary = useMemo(() => {
    if (!flightTrack || flightTrack.pointCount < 2) return null;
    const points = flightTrack.segments
      .flatMap((s) => s.points)
      .sort((a, b) => parseTrackTime(a) - parseTrackTime(b));
    const first = points[0];
    const last = points[points.length - 1];
    const durationMinutes =
      first && last ? Math.max(0, (parseTrackTime(last) - parseTrackTime(first)) / 60_000) : null;
    return {
      first,
      last,
      durationMinutes: flightTrack.intelligence?.durationMinutes ?? durationMinutes,
      recentPoints: points.slice(-6).reverse(),
    };
  }, [flightTrack]);

  const trackIntel = flightTrack?.intelligence ?? null;

  const enrichedLayovers = useMemo<PanelLayover[]>(() => {
    return (flightTrack?.layovers ?? []).map((layover, index) => {
      const nearest = nearestAirportToPoint(panelAirports, layover.lat, layover.lon);
      const airport = nearest?.airport ?? null;
      const airportCode =
        layover.airportCode || (airport ? getAirportCode(airport) : "") || `STOP ${index + 1}`;
      const airportCodes =
        [
          layover.airportIata || airport?.iata,
          layover.airportIcao || airport?.icao || airport?.ident,
        ]
          .filter(Boolean)
          .join(" / ") || airportCode;
      return {
        ...layover,
        airportCode,
        airportName: layover.airportName || airport?.name || "Unresolved stopover",
        airportDistanceKm: nearest?.distanceKm ?? null,
        airportCodes,
      };
    });
  }, [panelAirports, flightTrack?.layovers]);

  const physics = useMemo(() => {
    const v = flight.velocity;
    const a = flight.baro_altitude ?? flight.geo_altitude;
    return {
      tas: estimateTAS(v, a),
      cas: estimateCAS(v, a),
      q: dynamicPressure(v, a),
      isaT: isaTemperatureK(a),
      rho: isaDensity(a),
      bank: standardRateBankAngle(estimateTAS(v, a)),
      gLoad: loadFactorAtBank(standardRateBankAngle(estimateTAS(v, a))),
      turnRadius: standardRateTurnRadius(estimateTAS(v, a)),
    };
  }, [flight.velocity, flight.baro_altitude, flight.geo_altitude]);

  const divertStatus = useMemo(() => {
    if (
      flight.squawk !== "7700" ||
      !progress ||
      flight.latitude === null ||
      flight.longitude === null ||
      flight.true_track === null
    )
      return null;
    const angleDiff = (a: number | null, b: number | null) => {
      if (a === null || b === null) return 0;
      const d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    };
    const diff = angleDiff(flight.true_track, progress.brgDest);
    if (diff > 60 && progress.remaining > 50) {
      let nearest = null,
        minD = Infinity;
      for (const a of divertCandidateAirports) {
        const d = gcDistanceKm(flight.latitude, flight.longitude, a.lat, a.lon);
        const brg = gcBearing(flight.latitude, flight.longitude, a.lat, a.lon);
        if (angleDiff(flight.true_track, brg) < 60 && d < minD) {
          minD = d;
          nearest = a;
        }
      }
      return nearest ? `Possible divert → ${nearest.iata || nearest.icao}` : "Possible divert";
    }
    return null;
  }, [
    flight.squawk,
    flight.latitude,
    flight.longitude,
    flight.true_track,
    progress,
    divertCandidateAirports,
  ]);

  const isEmergency = ["7500", "7600", "7700"].includes(flight.squawk || "");
  const shouldShowRouteContext =
    !isRouteLikelyIncorrect &&
    (rt?.origin || rt?.destination || rt?.airline || rt?.callsignIata || enrichmentLoading);
  const displayCallsign =
    !isRouteLikelyIncorrect && rt?.callsignIata && rt.callsignIata !== callsign
      ? `${rt.callsignIata} / ${callsign}`
      : callsign;

  return (
    <div
      style={style}
      className="
      sw-flight-detail-panel fixed w-[460px] max-h-[min(620px,calc(100svh-48px))]
      bg-[rgba(4,15,8,0.45)] border border-[var(--sw-border-strong)] rounded-2xl
      shadow-2xl ring-1 ring-[var(--sw-border)]
      flex flex-col backdrop-blur-md
      font-sans text-[var(--sw-text)] overflow-hidden
    "
    >
      {/* ── Emergency / Divert Banner ── */}
      {(isEmergency || divertStatus) && (
        <div
          className={`
          flex items-center gap-3 px-5 py-3 text-[10px] font-semibold tracking-wider uppercase
          border-b
          ${
            isEmergency
              ? "bg-[var(--sw-danger-soft)] border border-[var(--sw-danger-soft)] text-[var(--sw-rose)]"
              : "bg-[var(--sw-warning-soft)] border border-[var(--sw-warning-soft)] text-[var(--sw-amber)]"
          }
        `}
        >
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0
            ${isEmergency ? "bg-rose-500 animate-pulse shadow-[0_0_8px_rgba(244,63,94,0.6)]" : "bg-amber-500"}`}
          />
          <span className="flex-1 truncate">
            {isEmergency
              ? `SQUAWK ${flight.squawk} — ${sqMeaning?.toUpperCase() || "EMERGENCY ACTIVE"}`
              : divertStatus?.toUpperCase()}
          </span>
          <ChevronRight className="w-4 h-4 opacity-50 flex-shrink-0" />
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* Aircraft icon */}
          <div
            className="
            relative flex-shrink-0 w-9 h-9 rounded-lg
            bg-[var(--sw-surface-soft)] border border-[var(--sw-border)] shadow-inner
            flex items-center justify-center
          "
          >
            {flight.category === 8 ? (
              <HelicopterIcon
                className="w-4 h-4 text-[var(--sw-text)]"
                style={{
                  transform: `rotate(${(flight.true_track ?? 0) - 90}deg)`,
                  transition: "transform 0.7s ease",
                }}
              />
            ) : (
              <Plane
                className="w-4 h-4 text-[var(--sw-text)]"
                style={{
                  transform: `rotate(${(flight.true_track ?? 0) - 45}deg)`,
                  transition: "transform 0.7s ease",
                }}
              />
            )}
            {/* Live pulse indicator */}
            <span className="absolute -top-0.5 -right-0.5 flex w-2.5 h-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full w-2.5 h-2.5 bg-emerald-500 border-2 border-[var(--sw-surface-strong)]"></span>
            </span>
          </div>

          {/* Identity */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <h2 className="text-xs font-semibold text-[var(--sw-text)] leading-none truncate">
                {displayCallsign}
              </h2>
              <span className="flex-shrink-0 px-1.5 py-0.5 rounded bg-[var(--sw-surface-soft)] border border-[var(--sw-border)] font-mono text-[8px] text-[var(--sw-text)] tracking-wider">
                {flight.icao24.toUpperCase()}
              </span>
            </div>
            <p className="text-[9px] text-[var(--sw-muted)] font-medium flex items-center gap-1">
              <span className="truncate">{airline || "Unregistered"}</span>
              <span className="text-[var(--sw-dim)] px-0.5">•</span>
              <span className="truncate">{flight.origin_country}</span>
              <span className="text-[var(--sw-dim)] px-0.5">•</span>
              <span className="text-blue-400 font-semibold">{fl}</span>
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onMinimize}
            aria-label="Minimize"
            className="w-6.5 h-6.5 rounded-md flex items-center justify-center text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-6.5 h-6.5 rounded-md flex items-center justify-center text-[var(--sw-muted)] hover:text-[var(--sw-rose)] hover:bg-[var(--sw-danger-soft)] transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Primary Metrics ── */}
      <div className="grid grid-cols-4 divide-x divide-[var(--sw-border)] border-y border-[var(--sw-border)] bg-[var(--sw-surface-soft)]">
        <MetricTile
          label="Altitude"
          value={fmt(altFt, { suffix: " ft", digits: 0 })}
          sub={fl}
          pct={altFt ? Math.min(100, (altFt / 45000) * 100) : 0}
        />
        <MetricTile
          label="Speed"
          value={fmt(speed, { suffix: " kt", digits: 0 })}
          sub={`M${fmt(mach, { digits: 3 })}`}
          pct={speed ? Math.min(100, (speed / 600) * 100) : 0}
        />
        <MetricTile
          label="Vert/S"
          value={fmt(verticalSpeed, { suffix: " fpm", sign: true, digits: 0 })}
          sub={climb ? "Climbing" : descend ? "Descending" : "Level"}
          pct={verticalSpeed ? Math.min(100, (Math.abs(verticalSpeed) / 4000) * 100) : 0}
          color={descend ? "amber" : "blue"}
          trend={climb ? "up" : descend ? "down" : undefined}
        />
        <MetricTile
          label="Heading"
          value={fmt(flight.true_track, { suffix: "°", digits: 0 })}
          sub={headingCompass(flight.true_track)}
          pct={flight.true_track === null ? 0 : (flight.true_track / 360) * 100}
        />
      </div>

      {/* ── Scrollable Body ── */}
      <div className="overflow-y-auto overscroll-contain flex-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-[var(--sw-border)]">
        {/* Anomaly & Alert Flags Deck */}
        {(anomaly || flight.squawk) && (
          <div className="px-6 py-4 border-b border-[var(--sw-border)] bg-[var(--sw-surface-strong)]">
            <p className="text-[9px] font-bold text-[var(--sw-muted)] uppercase tracking-wider mb-2.5">
              Detected Anomalies & Squawk Flags
            </p>
            <div className="flex flex-wrap gap-2">
              {flight.squawk && (
                <span
                  className={`inline-flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider px-2.5 py-1 rounded border ${
                    isEmergency
                      ? "bg-[var(--sw-danger-soft)] border border-[var(--sw-danger-soft)] text-[var(--sw-rose)]"
                      : "bg-[var(--sw-surface-soft)] border border-[var(--sw-border)] text-[var(--sw-text)]"
                  }`}
                >
                  <Activity className="w-3 h-3" />
                  SQUAWK {flight.squawk}
                </span>
              )}
              {anomaly &&
                anomaly.anomalies.map((item) => {
                  const Icon = anomalyIcons[item.type];
                  return (
                    <span
                      key={item.type}
                      className={`
                      inline-flex items-center gap-1.5
                      text-[9px] font-bold uppercase tracking-wider
                      px-2.5 py-1 rounded border
                      ${sevStyles[item.severity] ?? sevStyles.low}
                    `}
                    >
                      <Icon className="w-3 h-3" />
                      {item.label}
                    </span>
                  );
                })}
            </div>
          </div>
        )}

        {/* Flight path progress strip */}
        {progress && rt?.origin && rt?.destination && !isRouteLikelyIncorrect && (
          <FlightPath progress={progress} origin={rt.origin} destination={rt.destination} />
        )}

        {/* Aircraft photo */}
        {ac && (ac.photoUrl || ac.photoThumbUrl) && !imageError && (
          <div
            className="relative border-b border-[var(--sw-border)] overflow-hidden"
            style={{ height: 160 }}
          >
            <img
              src={`/api/photo?url=${encodeURIComponent(ac.photoUrl || ac.photoThumbUrl || "")}`}
              alt={ac.type || "Aircraft"}
              className="w-full h-full object-cover opacity-70 transition-opacity duration-500 hover:opacity-100"
              loading="lazy"
              onError={() => setImageError(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[var(--sw-surface)] via-[var(--sw-surface)]/40 to-transparent pointer-events-none" />
            <div className="absolute bottom-4 left-5 right-5 flex items-end justify-between">
              <div>
                <p className="font-mono text-[10px] font-bold text-[var(--sw-text)] tracking-widest uppercase">
                  {ac.registration || flight.icao24.toUpperCase()}
                </p>
                <p className="text-[10px] text-[var(--sw-muted)] mt-1">
                  {ac.type || "Unknown type"}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="p-3 space-y-3">
          {/* Route & Logistics */}
          {shouldShowRouteContext && (
            <Section title="Flight Plan & Route Context" icon={Navigation}>
              {enrichmentLoading && !rt ? (
                <LoadingRow label="Fetching route intelligence" />
              ) : (
                <>
                  {!isRouteLikelyIncorrect && (
                    <>
                      <FullRow
                        icon={MapPin}
                        label="Origin Airport"
                        value={rt?.origin?.name || "--"}
                        sub={`${routeAirportLocation(rt?.origin)} • elev ${fmt(rt?.origin?.elevation ?? null, { digits: 0, suffix: " ft" })}${
                          rt?.origin?.latitude !== undefined && rt?.origin?.longitude !== undefined
                            ? ` • [${toDMS(rt.origin.latitude, true)} ${toDMS(rt.origin.longitude, false)}]`
                            : ""
                        }`}
                        code={routeAirportCodes(rt?.origin)}
                      />
                      <FullRow
                        icon={MapPin}
                        label="Destination Airport"
                        value={rt?.destination?.name || "--"}
                        sub={`${routeAirportLocation(rt?.destination)} • elev ${fmt(rt?.destination?.elevation ?? null, { digits: 0, suffix: " ft" })}${
                          rt?.destination?.latitude !== undefined &&
                          rt?.destination?.longitude !== undefined
                            ? ` • [${toDMS(rt.destination.latitude, true)} ${toDMS(rt.destination.longitude, false)}]`
                            : ""
                        }`}
                        code={routeAirportCodes(rt?.destination)}
                      />
                    </>
                  )}
                  <div className="flex flex-col gap-1.5 mt-3">
                    <Row
                      icon={Signal}
                      label="Airline"
                      value={rt?.airline?.name || airline || "N/A"}
                    />
                    <Row
                      icon={Hash}
                      label="Flight Number"
                      value={rt?.callsignIata || rt?.callsign || "N/A"}
                      mono
                    />
                    {rt?.airline?.callsign && (
                      <Row
                        icon={Radio}
                        label="Telephony Designator"
                        value={rt.airline.callsign.toUpperCase()}
                        highlight
                      />
                    )}
                    {rt?.airline?.icao && (
                      <Row
                        icon={Hash}
                        label="Airline ICAO / IATA"
                        value={`${rt.airline.icao} / ${rt.airline.iata || "--"}`}
                        mono
                      />
                    )}
                    {rt?.airline?.country && (
                      <Row
                        icon={Globe}
                        label="State of Operator"
                        value={`${rt.airline.country} (${rt.airline.countryIso || "--"})`}
                      />
                    )}
                    {rt?.routeSource && (
                      <Row
                        icon={Activity}
                        label="Route Source"
                        value={routeSourceLabel(rt.routeSource)}
                      />
                    )}
                    {rt?.routeConfidence && (
                      <Row
                        icon={Target}
                        label="Route Confidence Level"
                        value={rt.routeConfidence.toUpperCase()}
                        highlight={rt.routeConfidence === "high"}
                        warn={rt.routeConfidence === "low"}
                      />
                    )}
                  </div>
                  {rt?.routeWarning && (
                    <div className="mt-2">
                      <NoticeRow icon={AlertTriangle} value={rt.routeWarning} tone="warn" />
                    </div>
                  )}
                  {!isRouteLikelyIncorrect && progress?.total ? (
                    <div className="flex flex-col gap-1.5 mt-2">
                      <Row
                        icon={Ruler}
                        label="Direct Route Distance"
                        value={`${fmt(progress.total, { digits: 0, suffix: " km" })}`}
                        mono
                      />
                      <Row
                        icon={Timer}
                        label="Estimated Time Enroute"
                        value={formatTrackDuration(progress.etaMinutes)}
                        mono
                      />
                      <Row
                        icon={RouteIcon}
                        label="Distance Flown"
                        value={fmt(progress.flown, { digits: 0, suffix: " km" })}
                        mono
                      />
                      <Row
                        icon={Crosshair}
                        label="Cross-Track Deviation"
                        value={fmt(progress.xtrackNm, { digits: 2, suffix: " NM" })}
                        mono
                        warn={progress.xtrackNm > 10}
                      />
                    </div>
                  ) : null}
                </>
              )}
            </Section>
          )}

          {/* Terminal Weather Section */}
          {!isRouteLikelyIncorrect && (rt?.origin || rt?.destination) && (
            <Section title="Meteorological Aerodrome Report (METAR)" icon={Cloud}>
              {terminalWeather.loading ? (
                <LoadingRow label="Fetching METAR reports" />
              ) : (
                <div className="flex flex-col gap-3">
                  {rt?.origin && (
                    <AirportWeatherCard
                      label="Departure"
                      airportCode={rt.origin.icaoCode || rt.origin.iataCode || "DEP"}
                      weather={terminalWeather.origin}
                    />
                  )}
                  {rt?.destination && (
                    <AirportWeatherCard
                      label="Arrival"
                      airportCode={rt.destination.icaoCode || rt.destination.iataCode || "ARR"}
                      weather={terminalWeather.destination}
                    />
                  )}
                </div>
              )}
            </Section>
          )}

          {enrichmentLoading && !rt && !ac && <LoadingRow label="Analyzing aircraft signature" />}

          {/* Track Log */}
          {trackSummary ? (
            <Section title="Historical Telemetry Log" icon={History}>
              <div className="flex flex-col gap-1.5">
                <Row
                  icon={RouteIcon}
                  label="Telemetry Source"
                  value={flightTrack?.source === "opensky" ? "Live track" : "State log"}
                  highlight
                />
                <Row
                  icon={Hash}
                  label="Recorded Trajectory Points"
                  value={flightTrack?.pointCount.toLocaleString() ?? "0"}
                  mono
                />
                <Row
                  icon={Timer}
                  label="Tracked Duration"
                  value={formatTrackDuration(trackSummary.durationMinutes)}
                  mono
                />
                <Row
                  icon={Ruler}
                  label="Observed Distance"
                  value={fmt(trackIntel?.distanceKm ?? flightTrack?.totalDistanceKm, {
                    digits: 0,
                    suffix: " km",
                  })}
                  mono
                />
                <Row
                  icon={Navigation}
                  label="Flight Phase"
                  value={trackIntel?.currentPhase ? trackIntel.currentPhase.toUpperCase() : "--"}
                  highlight
                />
                <Row
                  icon={Activity}
                  label="Signal Integrity Quality"
                  value={trackIntel ? `${trackIntel.quality.score}%` : "--"}
                  warn={trackIntel ? trackIntel.quality.score < 60 : false}
                  highlight={trackIntel ? trackIntel.quality.score >= 75 : false}
                  mono
                />
              </div>

              {trackIntel?.phaseBreakdown?.length ? (
                <div className="mt-4">
                  <TrackPhaseStrip phases={trackIntel.phaseBreakdown} />
                </div>
              ) : null}

              {/* Recent points table */}
              <div className="mt-4 bg-white/[0.02] rounded-lg border border-white/5 overflow-hidden">
                <div className="grid grid-cols-4 px-3 py-2 border-b border-white/5 bg-white/5 text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
                  <span>Time</span>
                  <span>Alt</span>
                  <span>Speed</span>
                  <span>Hdg</span>
                </div>
                <div className="divide-y divide-white/5">
                  {trackSummary.recentPoints.map((point) => (
                    <div
                      key={`${point.time}-${point.lat}-${point.lon}`}
                      className="grid grid-cols-4 px-3 py-2 text-[10px] font-mono text-zinc-300 hover:bg-white/5 transition-colors"
                    >
                      <span className="text-zinc-500">{formatTrackTime(point.time)}</span>
                      <span>{fmt(altitudeFt(point.alt), { digits: 0, suffix: "ft" })}</span>
                      <span>{fmt(speedKt(point.speed), { digits: 0, suffix: "kt" })}</span>
                      <span className="text-blue-400">
                        {point.heading !== null
                          ? fmt(point.heading, { digits: 0, suffix: "°" })
                          : "---"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </Section>
          ) : flightTrackLoading ? (
            <LoadingRow label="Loading path log" />
          ) : null}

          {/* Layovers */}
          {enrichedLayovers.length > 0 && (
            <Section title="Layovers" icon={MapPin}>
              <div className="flex flex-col gap-2">
                {enrichedLayovers.map((layover, index) => (
                  <LayoverCard key={`${layover.startTime}-${index}`} layover={layover} />
                ))}
              </div>
            </Section>
          )}

          {/* Aircraft Intelligence */}
          {ac && (
            <Section title="Aircraft Specifications & Registration" icon={Satellite}>
              <div className="flex flex-col gap-1.5">
                <Row icon={Plane} label="Manufacturer" value={ac.manufacturer ?? "--"} />
                <Row icon={Plane} label="Model" value={ac.type ?? "--"} />
                <Row icon={Plane} label="ICAO Type" value={ac.icaoType ?? "--"} mono />
                <Row
                  icon={Hash}
                  label="Registration Mark"
                  value={ac.registration ?? "--"}
                  mono
                  highlight
                />
                <Row
                  icon={Hash}
                  label="Operator ICAO Code"
                  value={ac.operatorFlagCode ?? "--"}
                  mono
                />
                <Row
                  icon={Globe}
                  label="State of Registry"
                  value={
                    ac.ownerCountry ? `${ac.ownerCountry} (${ac.ownerCountryIso || "--"})` : "--"
                  }
                />
                <Row icon={Signal} label="Owner" value={ac.registeredOwner || "--"} />
                <Row
                  icon={Layers}
                  label="Aircraft Category"
                  value={getAircraftCategoryLabel(flight.category)}
                />
              </div>
            </Section>
          )}

          {/* Aerodynamics */}
          <Section title="Aerodynamic & Flight Dynamics" icon={Zap}>
            <div className="flex flex-col gap-1.5">
              <Row
                icon={Gauge}
                label="Ground Speed (GS)"
                value={fmt(speed, { digits: 1, suffix: " kt" })}
                mono
                highlight
              />
              <Row
                icon={Zap}
                label="Mach Number"
                value={fmt(mach, { digits: 3, suffix: " M" })}
                mono
              />
              <Row
                icon={Wind}
                label="True Airspeed (TAS) Est."
                value={fmt(physics.tas, { digits: 1, suffix: " m/s" })}
                mono
              />
              <Row
                icon={Wind}
                label="Calibrated Airspeed (CAS) Est."
                value={fmt(physics.cas, { digits: 1, suffix: " m/s" })}
                mono
              />
              <Row
                icon={Target}
                label="Estimated Bank Angle"
                value={fmt(physics.bank, { digits: 1, suffix: "°" })}
                mono
              />
              <Row
                icon={Activity}
                label="Normal Load Factor (G)"
                value={fmt(physics.gLoad, { digits: 2, suffix: " G" })}
                mono
              />
              <Row
                icon={Thermometer}
                label="ISA Static Air Temperature"
                value={fmt(physics.isaT ? physics.isaT - 273.15 : null, {
                  digits: 1,
                  suffix: " °C",
                })}
                mono
              />
              <Row
                icon={Ruler}
                label="Standard Rate Turn Radius"
                value={fmt(physics.turnRadius, { digits: 0, suffix: " m" })}
                mono
              />
            </div>
          </Section>

          {/* Navigation */}
          <Section title="Navigation & Surveillance Signal" icon={Compass}>
            <div className="flex flex-col gap-1.5">
              <Row
                icon={Satellite}
                label="Surveillance Source"
                value={
                  flight.data_source
                    ? getDataSourceInfo(flight.data_source).name
                    : positionSourceLabel(flight.position_source)
                }
                highlight
              />
              <Row
                icon={Signal}
                label="Signal Quality Index"
                value={`${sourceQuality.label} (${sourceQuality.accuracy})`}
                highlight
              />
              <Row
                icon={Timer}
                label="Signal Latency / Age"
                value={`${signalAgeSeconds}s`}
                mono
                warn={signalAgeSeconds > 30}
              />
              <Row
                icon={Hash}
                label="SSR Transponder Code (Squawk)"
                value={flight.squawk || "----"}
                mono
                highlight={isNotableSquawk(flight.squawk)}
              />
              <Row
                icon={Radio}
                label="Special Position Identification (SPI)"
                value={flight.spi ? "IDENT" : "STBY"}
                highlight={!!flight.spi}
              />
              <Row
                icon={Activity}
                label="State Estimation Confidence"
                value={fmt(prediction.confidenceScore * 100, { digits: 1, suffix: "%" })}
                warn={prediction.confidence === "low"}
              />
              <Row
                icon={Mountain}
                label="On-Ground Status"
                value={flight.on_ground ? "On Ground" : "Airborne"}
                highlight={flight.on_ground}
              />
              {flight.sensors && (
                <Row
                  icon={Hash}
                  label="Receiving Sensors"
                  value={flight.sensors.length.toString()}
                  mono
                />
              )}
              {flight.latitude !== null && flight.longitude !== null && (
                <Row
                  icon={MapPin}
                  label="Reported Position"
                  value={`${toDMS(flight.latitude, true)} / ${toDMS(flight.longitude, false)}`}
                  mono
                  highlight
                />
              )}
              {flight.time_position && (
                <Row
                  icon={Clock}
                  label="Time of Position (UTC)"
                  value={formatDateTimeSeconds(flight.time_position)}
                  mono
                />
              )}
              {flight.ml_anomaly_score !== null && flight.ml_anomaly_score !== undefined && (
                <Row
                  icon={Activity}
                  label="Anomaly Indicator Score"
                  value={fmt(flight.ml_anomaly_score, { digits: 4 })}
                  warn={flight.ml_anomaly_score < -0.55}
                  highlight={flight.ml_anomaly_score >= -0.55}
                  mono
                />
              )}
            </div>
          </Section>

          {/* System Identity */}
          <Section title="System Identification (ICAO 24-bit)" icon={Hash}>
            <div className="flex flex-col gap-1.5">
              <Row
                icon={Hash}
                label="ICAO 24-bit Address"
                value={flight.icao24.toUpperCase()}
                mono
                highlight
              />
              <Row icon={Globe} label="State of Registry" value={flight.origin_country} />
              <Row
                icon={Mountain}
                label="Barometric Altitude"
                value={fmt(reportedAltFt, { digits: 0, suffix: " ft" })}
                mono
              />
              <Row
                icon={Mountain}
                label="Geometric Altitude"
                value={fmt(geoAltFt, { digits: 0, suffix: " ft" })}
                mono
              />
              <Row
                icon={Layers}
                label="Barometric-Geometric Offset"
                value={fmt(altDiffFt, { digits: 0, suffix: " ft", sign: true })}
                mono
                warn={altDiffFt !== null && Math.abs(altDiffFt) > 500}
              />
              <Row
                icon={History}
                label="Trajectory Estimation Type"
                value={prediction.isPredicted ? "Kinematic" : "Raw ADS-B"}
              />
            </div>
          </Section>

          {/* Incident Timeline */}
          {anomalyHistory.length > 0 && (
            <Section title="Surveillance Anomaly Timeline" icon={History}>
              <div className="bg-white/[0.02] rounded-lg border border-white/5 overflow-hidden">
                <div className="grid grid-cols-4 px-3 py-2 border-b border-white/5 bg-white/5 text-[9px] font-semibold uppercase tracking-wider text-zinc-400">
                  <span>Time</span>
                  <span>Alt</span>
                  <span>Speed</span>
                  <span>Hdg</span>
                </div>
                <div className="divide-y divide-white/5">
                  {[...anomalyHistory]
                    .reverse()
                    .slice(0, 10)
                    .map((snap, i) => (
                      <div
                        key={i}
                        className="grid grid-cols-4 px-3 py-2 text-[10px] font-mono text-zinc-300 hover:bg-white/5 transition-colors"
                      >
                        <span className="text-zinc-500">{formatClock(snap.time * 1000)}</span>
                        <span>
                          {snap.altitude
                            ? fmt(altitudeFt(snap.altitude), { digits: 0, suffix: "ft" })
                            : "---"}
                        </span>
                        <span>
                          {snap.speed
                            ? fmt(speedKt(snap.speed), { digits: 0, suffix: "kt" })
                            : "---"}
                        </span>
                        <span className="text-blue-400">
                          {snap.heading !== null
                            ? fmt(snap.heading, { digits: 0, suffix: "°" })
                            : "---"}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(FlightDetailPanel);

// ─── Sub-components ────────────────────────────────────────────────────────────

/** Primary metric tile */
function MetricTile({
  label,
  value,
  sub,
  pct,
  color = "blue",
  trend,
}: {
  label: string;
  value: string;
  sub: string;
  pct: number;
  color?: "blue" | "amber";
  trend?: "up" | "down";
}) {
  const isAmber = color === "amber";
  const barColor = isAmber ? "bg-amber-500" : "bg-blue-500";
  const valueColor = isAmber ? "text-[var(--sw-amber)]" : "text-[var(--sw-blue)]";

  return (
    <div className="relative flex flex-col justify-center gap-1 px-2 py-2.5 hover:bg-[var(--sw-surface-hover)] transition-colors overflow-hidden group">
      <span className="text-[8px] font-semibold uppercase tracking-wider text-[var(--sw-muted)]">
        {label}
      </span>
      <div className="flex items-center gap-1">
        {trend === "up" && <TrendingUp className={`w-3 h-3 ${valueColor} flex-shrink-0`} />}
        {trend === "down" && <TrendingDown className={`w-3 h-3 ${valueColor} flex-shrink-0`} />}
        <strong
          className={`text-[10px] font-mono font-semibold leading-none tracking-tight text-[var(--sw-text)]`}
        >
          {value}
        </strong>
      </div>
      <span className="text-[8.5px] text-[var(--sw-dim)] truncate leading-none">{sub}</span>
      {/* Subtle indicator bar */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--sw-border)]">
        <div
          className={`h-full ${barColor} transition-all duration-700 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Modern Section Wrapper */
function Section({
  title,
  children,
  icon: Icon,
}: {
  title: string;
  children: React.ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <div
      data-heavy-section
      className="bg-[var(--sw-surface-strong)] border border-[var(--sw-border)] rounded-xl p-4"
    >
      <div className="flex items-center gap-2 mb-4">
        {Icon && <Icon className="w-4 h-4 text-[var(--sw-muted)] flex-shrink-0" />}
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sw-text)]">
          {title}
        </span>
      </div>
      <div>{children}</div>
    </div>
  );
}

/** Data Row (Clean & Dense) */
function Row({
  icon: Icon,
  label,
  value,
  mono,
  highlight,
  warn,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
  warn?: boolean;
}) {
  const valueColor = warn
    ? "text-[var(--sw-amber)]"
    : highlight
      ? "text-[var(--sw-blue)]"
      : "text-[var(--sw-text)]";

  return (
    <div className="flex items-center justify-between py-1.5 px-2 -mx-2 hover:bg-[var(--sw-surface-hover)] rounded-md transition-colors gap-3">
      <span className="flex items-center gap-2 text-[10px] text-[var(--sw-muted)] min-w-0 flex-1">
        <Icon className="w-3.5 h-3.5 flex-shrink-0 opacity-60" />
        <span className="truncate" title={label}>
          {label}
        </span>
      </span>
      <span
        className={`
        text-[10px] font-medium text-right leading-tight max-w-[70%] shrink-0 truncate
        ${mono ? "font-mono tracking-tight" : ""}
        ${valueColor}
      `}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

/** Full-width Card Row */
function FullRow({
  icon: Icon,
  label,
  value,
  sub,
  code,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  code?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 p-3 mb-2 bg-[var(--sw-surface-soft)] border border-[var(--sw-border)] rounded-lg">
      <div className="flex items-start gap-3 min-w-0">
        <div className="mt-0.5 w-6 h-6 rounded bg-[var(--sw-surface-hover)] flex items-center justify-center flex-shrink-0">
          <Icon className="w-3.5 h-3.5 text-[var(--sw-muted)]" />
        </div>
        <div className="min-w-0">
          <span className="block text-[9px] font-semibold uppercase tracking-wider text-[var(--sw-dim)] mb-0.5">
            {label}
          </span>
          <strong className="block text-xs font-medium text-[var(--sw-text)] truncate">
            {value}
          </strong>
          {sub && (
            <span className="block text-[10px] text-[var(--sw-muted)] truncate mt-0.5">{sub}</span>
          )}
        </div>
      </div>
      {code && (
        <span className="flex-shrink-0 px-2 py-1 bg-[var(--sw-surface-hover)] border border-[var(--sw-border)] rounded font-mono text-[10px] font-semibold text-[var(--sw-text)]">
          {code}
        </span>
      )}
    </div>
  );
}

/** Notice banner */
function NoticeRow({
  icon: Icon,
  value,
  tone = "info",
}: {
  icon: LucideIcon;
  value: string;
  tone?: "info" | "warn";
}) {
  const style =
    tone === "warn"
      ? "bg-[var(--sw-warning-soft)] border border-[var(--sw-warning-soft)] text-[var(--sw-amber)]"
      : "bg-[var(--sw-accent-soft)] border border-[var(--sw-accent-muted)] text-[var(--sw-blue)]";
  return (
    <div className={`flex gap-3 px-4 py-3 mb-3 rounded-lg border ${style}`}>
      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
      <p className="text-[10px] leading-relaxed">{value}</p>
    </div>
  );
}

/** Phase color helper */
function phaseColor(phase: string): string {
  switch (phase) {
    case "takeoff":
      return "bg-lime-500";
    case "climb":
      return "bg-emerald-500";
    case "cruise":
      return "bg-blue-500";
    case "descent":
      return "bg-amber-500";
    case "approach":
      return "bg-orange-500";
    case "ground":
      return "bg-zinc-500";
    default:
      return "bg-zinc-700";
  }
}

/** Phase bar strip */
function TrackPhaseStrip({ phases }: { phases: FlightTrackPhase[] }) {
  const total = phases.reduce((sum, p) => sum + Math.max(p.durationMinutes, 0.1), 0);
  if (!phases.length || total <= 0) return null;

  return (
    <div className="pt-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-[var(--sw-border)] gap-0.5">
        {phases.map((phase, i) => (
          <span
            key={`${phase.phase}-${phase.startedAt}-${i}`}
            className={`${phaseColor(phase.phase)}`}
            style={{ width: `${Math.max(2, (phase.durationMinutes / total) * 100)}%` }}
            title={`${phase.phase}: ${formatTrackDuration(phase.durationMinutes)}`}
          />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {phases.slice(-4).map((phase, i) => (
          <span
            key={`${phase.phase}-${phase.endedAt}-${i}`}
            className="px-2 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wider bg-[var(--sw-surface-soft)] border border-[var(--sw-border)] text-[var(--sw-muted)]"
          >
            {phase.phase}{" "}
            <span className="text-[var(--sw-dim)] ml-1">
              {formatTrackDuration(phase.durationMinutes)}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Layover Card */
function LayoverCard({ layover }: { layover: PanelLayover }) {
  return (
    <div className="bg-[var(--sw-warning-soft)] border border-[var(--sw-warning-soft)] rounded-lg p-3">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <strong className="block font-mono text-xs font-semibold text-[var(--sw-amber)] leading-none mb-1">
            {layover.airportCode}
          </strong>
          <span className="text-[10px] text-[var(--sw-muted)] truncate block">
            {layover.airportName}
          </span>
        </div>
        <span className="flex-shrink-0 bg-[var(--sw-warning-soft)] border border-[var(--sw-warning-soft)] px-2 py-1 rounded text-[9px] font-bold uppercase tracking-wider text-[var(--sw-amber)]">
          {formatTrackDuration(layover.durationMinutes)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-y-1.5 gap-x-3 text-[10px] border-t border-[var(--sw-border)] pt-2">
        <span className="text-[var(--sw-muted)]">
          Codes{" "}
          <strong className="font-mono text-[var(--sw-text)] ml-1">{layover.airportCodes}</strong>
        </span>
        <span className="text-[var(--sw-muted)]">
          Match{" "}
          <strong className="font-mono text-[var(--sw-text)] ml-1">
            {fmt(layover.airportDistanceKm, { digits: 1, suffix: " km" })}
          </strong>
        </span>
        <span className="text-[var(--sw-muted)]">
          Start{" "}
          <strong className="font-mono text-[var(--sw-text)] ml-1">
            {formatTrackTime(layover.startTime)}
          </strong>
        </span>
        <span className="text-[var(--sw-muted)]">
          End{" "}
          <strong className="font-mono text-[var(--sw-text)] ml-1">
            {formatTrackTime(layover.endTime)}
          </strong>
        </span>
      </div>
    </div>
  );
}

/** Loading skeleton row */
function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-3 px-2 text-[var(--sw-muted)]">
      <span className="w-3 h-3 rounded-full border-2 border-[var(--sw-dim)] border-t-[var(--sw-muted)] animate-spin flex-shrink-0" />
      <span className="text-[10px] font-medium">{label}…</span>
    </div>
  );
}

/** Route progress strip */
function FlightPath({
  progress,
  origin,
  destination,
}: {
  progress: { pct: number; flown: number; remaining: number; etaMinutes: number | null };
  origin: { iataCode?: string; icaoCode?: string; municipality?: string };
  destination: { iataCode?: string; icaoCode?: string; municipality?: string };
}) {
  const eta =
    progress.etaMinutes !== null
      ? progress.etaMinutes < 60
        ? `${Math.round(progress.etaMinutes)} min`
        : `${(progress.etaMinutes / 60).toFixed(1)} hr`
      : "--";

  return (
    <div className="px-4 py-4 border-b border-[var(--sw-border)] bg-[var(--sw-surface-soft)]">
      {/* Airport codes */}
      <div className="flex items-end justify-between mb-4">
        <div>
          <span className="text-sm font-bold font-mono text-[var(--sw-text)] tracking-tight leading-none">
            {origin.iataCode || origin.icaoCode}
          </span>
          <p className="text-[9px] text-[var(--sw-muted)] mt-0.5 leading-none font-medium">
            {origin.municipality}
          </p>
        </div>
        <div className="flex items-center justify-center flex-1 px-3 text-[var(--sw-dim)]">
          <div className="h-px flex-1 bg-[var(--sw-border)]" />
          <Plane
            className="w-3.5 h-3.5 mx-2 text-blue-500"
            style={{ transform: "rotate(45deg)" }}
          />
          <div className="h-px flex-1 bg-[var(--sw-border)]" />
        </div>
        <div className="text-right">
          <span className="text-sm font-bold font-mono text-[var(--sw-text)] tracking-tight leading-none">
            {destination.iataCode || destination.icaoCode}
          </span>
          <p className="text-[9px] text-[var(--sw-muted)] mt-0.5 leading-none font-medium">
            {destination.municipality}
          </p>
        </div>
      </div>

      {/* Progress track */}
      <div className="relative h-1 rounded-full bg-[var(--sw-border)] mb-3.5">
        <div
          className="absolute left-0 top-0 h-full rounded-full bg-blue-500 transition-all duration-1000 ease-out"
          style={{ width: `${progress.pct}%` }}
        />
        <div
          className="absolute transition-all duration-1000 ease-out"
          style={{ left: `${progress.pct}%`, top: "50%", marginTop: "-5px", marginLeft: "-5px" }}
        >
          <div className="w-2.5 h-2.5 bg-white rounded-full shadow-[0_0_8px_rgba(59,130,246,0.8)] border-2 border-blue-500" />
        </div>
      </div>

      {/* Stats */}
      <div className="flex justify-between items-center text-center">
        <div className="text-left">
          <p className="text-[8px] font-semibold uppercase tracking-wider text-[var(--sw-dim)] mb-0.5">
            Flown
          </p>
          <p className="text-[10px] font-mono font-medium text-[var(--sw-text)]">
            {Math.round(progress.flown)} km
          </p>
        </div>
        <div>
          <p className="text-[8px] font-semibold uppercase tracking-wider text-[var(--sw-dim)] mb-0.5">
            Progress
          </p>
          <p className="text-[10px] font-mono font-medium text-blue-400">
            {progress.pct.toFixed(1)}%
          </p>
        </div>
        <div className="text-right">
          <p className="text-[8px] font-semibold uppercase tracking-wider text-[var(--sw-dim)] mb-0.5">
            ETA
          </p>
          <p className="text-[10px] font-mono font-medium text-[var(--sw-text)]">{eta}</p>
        </div>
      </div>
    </div>
  );
}
