import type { LucideIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ChevronRight,
  Clock,
  Cloud,
  Compass,
  Crosshair,
  Gauge,
  Globe,
  Hash,
  History,
  Layers,
  MapPin,
  Minimize2,
  Mountain,
  Navigation,
  Plane,
  Radio,
  Route as RouteIcon,
  Ruler,
  Satellite,
  Signal,
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
}

const sevStyles: Record<string, string> = {
  critical: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  high: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  low: "bg-sky-500/10  text-sky-400  border-sky-500/20",
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
}: Props) {
  const { airports } = useAirports();
  const [now, setNow] = useState(() => Date.now());
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setImageError(false);
  }, [flight.icao24]);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const callsign = flight.callsign?.trim() || "UNKNOWN";
  const airline = airlineFromCallsign(flight.callsign);
  const rt = enrichment?.route ?? null;
  const displayCallsign =
    rt?.callsignIata && rt.callsignIata !== callsign
      ? `${rt.callsignIata} / ${callsign}`
      : callsign;

  const prediction = predictFlightState(flight, now / 1000);
  const altFt = altitudeFt(prediction.baroAltitude);
  const reportedAltFt = altitudeFt(flight.baro_altitude);
  const geoAltFt = altitudeFt(flight.geo_altitude);
  const speed = speedKt(flight.velocity);
  const verticalSpeed = vsFpm(flight.vertical_rate);
  const mach = estimateMach(flight.velocity, flight.baro_altitude);
  const fl = flightLevel(flight.baro_altitude);
  const climb = (flight.vertical_rate ?? 0) > 1;
  const descend = (flight.vertical_rate ?? 0) < -1;
  const signalAgeSeconds = Math.max(0, Math.floor(now / 1000 - flight.last_contact));
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
      const nearest = nearestAirportToPoint(airports, layover.lat, layover.lon);
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
  }, [airports, flightTrack?.layovers]);

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
      for (const a of airports) {
        if (a.type !== "large_airport" && a.type !== "medium_airport") continue;
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
  }, [flight.squawk, flight.latitude, flight.longitude, flight.true_track, progress, airports]);

  const isEmergency = ["7500", "7600", "7700"].includes(flight.squawk || "");

  return (
    <div
      className="
      fixed bottom-4 left-4 z-[1300] w-[460px] max-h-[calc(100vh-160px)]
      bg-black border border-white/[0.15] overflow-hidden
      shadow-[0_0_0_1px_rgba(255,255,255,0.05),0_20px_60px_rgba(0,0,0,0.95)]
      flex flex-col backdrop-blur-sm
    "
    >
      {/* Avionics Scanlines Overlay */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.02] z-[100] mix-blend-screen"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 1px, #fff 1px, #fff 2px)",
        }}
      />

      {/* ── Emergency / Divert Banner ── */}
      {(isEmergency || divertStatus) && (
        <div
          className={`
          flex items-center gap-2.5 px-5 py-2.5 text-[10px] font-bold tracking-[0.12em] uppercase
          border-b
          ${
            isEmergency
              ? "bg-rose-500/[0.08] border-rose-500/20 text-rose-400"
              : "bg-amber-500/[0.08] border-amber-500/20 text-amber-400"
          }
        `}
        >
          <span
            className={`w-1.5 h-1.5 flex-shrink-0
            ${isEmergency ? "bg-rose-400 animate-ping" : "bg-amber-400"}`}
          />
          <span className="flex-1 truncate">
            {isEmergency
              ? `SQUAWK ${flight.squawk} — ${sqMeaning?.toUpperCase() || "EMERGENCY ACTIVE"}`
              : divertStatus?.toUpperCase()}
          </span>
          <ChevronRight className="w-3 h-3 opacity-50 flex-shrink-0" />
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-4 px-5 pt-5 pb-4">
        <div className="flex items-center gap-3.5 min-w-0">
          {/* Aircraft icon */}
          <div
            className="
            relative flex-shrink-0 w-10 h-10
            bg-sky-500/[0.08] border border-sky-400/15
            flex items-center justify-center
          "
          >
            {flight.category === 8 ? (
              <HelicopterIcon
                className="w-[18px] h-[18px] text-sky-400"
                style={{
                  transform: `rotate(${(flight.true_track ?? 0) - 90}deg)`,
                  transition: "transform 0.7s ease",
                }}
              />
            ) : (
              <Plane
                className="w-[18px] h-[18px] text-sky-400 drop-shadow-[0_0_4px_currentColor]"
                style={{
                  transform: `rotate(${(flight.true_track ?? 0) - 45}deg)`,
                  transition: "transform 0.7s ease",
                }}
              />
            )}
            {/* Live pulse ring */}
            <span className="absolute -top-px -right-px w-2 h-2 bg-emerald-400 border border-black shadow-[0_0_6px_rgba(52,211,153,0.7)]" />
          </div>

          {/* Identity */}
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 mb-0.5">
              <h2 className="text-[18px] font-mono font-semibold text-white leading-none tracking-tight truncate drop-shadow-[0_0_6px_rgba(255,255,255,0.4)]">
                {displayCallsign}
              </h2>
              <span className="flex-shrink-0 font-mono text-[10px] text-white/30 tracking-widest">
                {flight.icao24.toUpperCase()}
              </span>
            </div>
            <p className="text-[11px] text-white/35 font-medium flex items-center gap-1.5">
              <span>{airline || "Unregistered"}</span>
              <span className="text-white/15">·</span>
              <span>{flight.origin_country}</span>
              <span className="text-white/15">·</span>
              <span className="text-sky-400 font-semibold tracking-widest">{fl}</span>
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onMinimize}
            aria-label="Minimize"
            className="w-7 h-7 flex items-center justify-center text-white/25 hover:text-white/60 hover:bg-white/[0.05] transition-all duration-150"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 flex items-center justify-center text-white/25 hover:text-rose-400 hover:bg-rose-500/10 transition-all duration-150"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Primary Metrics ── */}
      <div className="grid grid-cols-4 border-t border-b border-white/[0.06]">
        <MetricTile
          label="Altitude"
          value={fmt(altFt, { suffix: " ft", digits: 0 })}
          sub={fl}
          pct={altFt ? Math.min(100, (altFt / 45000) * 100) : 0}
          color="sky"
        />
        <MetricTile
          label="Speed"
          value={fmt(speed, { suffix: " kt", digits: 0 })}
          sub={`M${fmt(mach, { digits: 3 })}`}
          pct={speed ? Math.min(100, (speed / 600) * 100) : 0}
          color="sky"
        />
        <MetricTile
          label="Vert/S"
          value={fmt(verticalSpeed, { suffix: " fpm", sign: true, digits: 0 })}
          sub={climb ? "climbing" : descend ? "descending" : "level"}
          pct={verticalSpeed ? Math.min(100, (Math.abs(verticalSpeed) / 4000) * 100) : 0}
          color={descend ? "amber" : "sky"}
          trend={climb ? "up" : descend ? "down" : undefined}
        />
        <MetricTile
          label="Heading"
          value={fmt(flight.true_track, { suffix: "°", digits: 0 })}
          sub={headingCompass(flight.true_track)}
          pct={flight.true_track === null ? 0 : (flight.true_track / 360) * 100}
          color="sky"
        />
      </div>

      {/* ── Scrollable Body ── */}
      <div className="overflow-y-auto overscroll-contain flex-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
        {/* Flight path progress strip */}
        {progress &&
          rt?.origin &&
          rt?.destination &&
          !(rt.routeConfidence === "low" && rt.routeWarning) && (
            <FlightPath progress={progress} origin={rt.origin} destination={rt.destination} />
          )}

        {/* Aircraft photo */}
        {ac && (ac.photoUrl || ac.photoThumbUrl) && !imageError && (
          <div
            className="relative border-b border-white/[0.05] overflow-hidden"
            style={{ height: 130 }}
          >
            <img
              src={`/api/photo?url=${encodeURIComponent(ac.photoUrl || ac.photoThumbUrl || "")}`}
              alt={ac.type || "Aircraft"}
              className="w-full h-full object-cover opacity-60 hover:opacity-80 transition-opacity duration-500"
              loading="lazy"
              onError={() => setImageError(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent pointer-events-none" />
            <div className="absolute bottom-3 left-4 right-4 flex items-end justify-between">
              <div>
                <p className="font-mono text-[10px] font-bold text-white/50 tracking-widest uppercase">
                  {ac.registration || flight.icao24.toUpperCase()}
                </p>
                <p className="text-[10px] text-white/35 mt-0.5">{ac.type || "Unknown type"}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 bg-emerald-400 animate-pulse shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
                <span className="text-[9px] font-bold uppercase tracking-widest text-emerald-400/60">
                  Live
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Route & Logistics */}
        {(rt?.origin ||
          rt?.destination ||
          rt?.airline ||
          rt?.callsignIata ||
          enrichmentLoading) && (
          <Section title="Route" icon={Navigation}>
            {enrichmentLoading && !rt ? (
              <LoadingRow label="Fetching route intelligence" />
            ) : (
              <>
                {rt?.routeWarning && (
                  <NoticeRow icon={AlertTriangle} tone="warn" value={rt.routeWarning} />
                )}
                <Row
                  icon={MapPin}
                  label="Dep Code"
                  value={routeAirportCodes(rt?.origin)}
                  mono
                  highlight={!!rt?.origin}
                />
                <Row
                  icon={MapPin}
                  label="Arr Code"
                  value={routeAirportCodes(rt?.destination)}
                  mono
                  highlight={!!rt?.destination}
                />
                <FullRow
                  icon={MapPin}
                  label="Departure"
                  value={rt?.origin?.name || "--"}
                  sub={`${routeAirportLocation(rt?.origin)} · elev ${fmt(rt?.origin?.elevation ?? null, { digits: 0, suffix: " ft" })}`}
                  highlight={!!rt?.origin}
                />
                <FullRow
                  icon={MapPin}
                  label="Arrival"
                  value={rt?.destination?.name || "--"}
                  sub={`${routeAirportLocation(rt?.destination)} · elev ${fmt(rt?.destination?.elevation ?? null, { digits: 0, suffix: " ft" })}`}
                  highlight={!!rt?.destination}
                />
                <Row icon={Signal} label="Airline" value={rt?.airline?.name || airline || "N/A"} />
                <Row
                  icon={Hash}
                  label="Flight No."
                  value={rt?.callsignIata || rt?.callsign || "N/A"}
                  mono
                />
                <Row
                  icon={Satellite}
                  label="Route Src"
                  value={routeSourceLabel(rt?.routeSource)}
                  highlight={rt?.routeSource !== "unknown"}
                />
                <Row
                  icon={Activity}
                  label="Confidence"
                  value={rt?.routeConfidence ? rt.routeConfidence.toUpperCase() : "--"}
                  warn={rt?.routeConfidence === "low"}
                  highlight={rt?.routeConfidence === "high"}
                />
                {progress?.total ? (
                  <>
                    <Row
                      icon={Ruler}
                      label="GC Distance"
                      value={`${fmt(progress.total, { digits: 0, suffix: " km" })} / ${fmt(progress.total / NM_TO_KM, { digits: 0, suffix: " NM" })}`}
                      mono
                    />
                    <Row
                      icon={Timer}
                      label="ETA"
                      value={formatTrackDuration(progress.etaMinutes)}
                      mono
                    />
                    <Row
                      icon={RouteIcon}
                      label="Flown"
                      value={fmt(progress.flown, { digits: 0, suffix: " km" })}
                      mono
                    />
                    <Row
                      icon={RouteIcon}
                      label="Remaining"
                      value={fmt(progress.remaining, { digits: 0, suffix: " km" })}
                      mono
                    />
                    <Row
                      icon={Crosshair}
                      label="X-Track Dev"
                      value={fmt(progress.xtrackNm, { digits: 2, suffix: " NM" })}
                      mono
                      warn={progress.xtrackNm > 10}
                    />
                    <Row
                      icon={Compass}
                      label="Brg. Dest"
                      value={`${fmt(progress.brgDest, { digits: 0, suffix: "°" })} ${headingCompass(progress.brgDest)}`}
                      mono
                    />
                  </>
                ) : null}
              </>
            )}
          </Section>
        )}

        {enrichmentLoading && !rt && !ac && <LoadingRow label="Analyzing aircraft signature" />}

        {/* Track Log */}
        {trackSummary ? (
          <Section title="Track Log" icon={History}>
            <Row
              icon={RouteIcon}
              label="Path Source"
              value={flightTrack?.source === "opensky" ? "OpenSky live track" : "Local state log"}
              highlight
            />
            <Row
              icon={Hash}
              label="Log Points"
              value={flightTrack?.pointCount.toLocaleString() ?? "0"}
              mono
            />
            <Row
              icon={Timer}
              label="Observed Time"
              value={formatTrackDuration(trackSummary.durationMinutes)}
              mono
            />
            <Row
              icon={Ruler}
              label="Observed Dist."
              value={fmt(trackIntel?.distanceKm ?? flightTrack?.totalDistanceKm, {
                digits: 0,
                suffix: " km",
              })}
              mono
            />
            <Row
              icon={Activity}
              label="Quality"
              value={
                trackIntel
                  ? `${trackIntel.quality.label.toUpperCase()} ${trackIntel.quality.score}%`
                  : "--"
              }
              warn={trackIntel ? trackIntel.quality.score < 60 : false}
              highlight={trackIntel ? trackIntel.quality.score >= 75 : false}
            />
            <Row
              icon={Layers}
              label="Segments"
              value={`${trackIntel?.segmentCount ?? flightTrack?.segments.length ?? 0}`}
              mono
            />
            <Row
              icon={Signal}
              label="Signal Gaps"
              value={`${trackIntel?.gapCount ?? 0}`}
              mono
              warn={(trackIntel?.gapCount ?? 0) > 0}
            />
            <Row
              icon={Gauge}
              label="Sample Rate"
              value={fmt(trackIntel?.pointDensityPerHour, { digits: 1, suffix: " pts/hr" })}
              mono
            />
            <Row
              icon={Mountain}
              label="Max Alt"
              value={fmt(altitudeFt(trackIntel?.maxAltitudeM ?? null), {
                digits: 0,
                suffix: " ft",
              })}
              mono
            />
            <Row
              icon={Gauge}
              label="Max Speed"
              value={fmt(speedKt(trackIntel?.maxSpeedMs ?? null), { digits: 0, suffix: " kt" })}
              mono
            />
            <Row
              icon={RouteIcon}
              label="Efficiency"
              value={fmt(
                trackIntel?.trackEfficiency !== null && trackIntel?.trackEfficiency !== undefined
                  ? trackIntel.trackEfficiency * 100
                  : null,
                { digits: 1, suffix: "%" },
              )}
              mono
            />
            <Row
              icon={Navigation}
              label="Phase"
              value={trackIntel?.currentPhase ? trackIntel.currentPhase.toUpperCase() : "--"}
              highlight
            />
            <Row
              icon={Clock}
              label="First Log"
              value={formatTrackTime(trackSummary.first?.time)}
              mono
            />
            <Row
              icon={Clock}
              label="Last Log"
              value={formatTrackTime(trackSummary.last?.time)}
              mono
            />
            {enrichedLayovers.length > 0 && (
              <Row icon={MapPin} label="Layovers" value={`${enrichedLayovers.length} detected`} />
            )}
            {trackIntel?.phaseBreakdown?.length ? (
              <div className="col-span-2 mt-1">
                <TrackPhaseStrip phases={trackIntel.phaseBreakdown} />
              </div>
            ) : null}
            {/* Recent points table */}
            <div className="col-span-2 mt-2">
              <div className="overflow-hidden border border-white/[0.05]">
                <div className="grid grid-cols-4 gap-0 px-3 py-2 border-b border-white/[0.04] bg-white/[0.015]">
                  {["Time", "Alt", "Speed", "Hdg"].map((h) => (
                    <span
                      key={h}
                      className="text-[9px] font-bold uppercase tracking-widest text-white/25"
                    >
                      {h}
                    </span>
                  ))}
                </div>
                {trackSummary.recentPoints.map((point) => (
                  <div
                    key={`${point.time}-${point.lat}-${point.lon}`}
                    className="grid grid-cols-4 gap-0 px-3 py-2 border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02] transition-colors"
                  >
                    <span className="text-[10px] font-mono text-white/30">
                      {formatTrackTime(point.time)}
                    </span>
                    <span className="text-[10px] font-mono text-white/55">
                      {fmt(altitudeFt(point.alt), { digits: 0, suffix: "ft" })}
                    </span>
                    <span className="text-[10px] font-mono text-white/55">
                      {fmt(speedKt(point.speed), { digits: 0, suffix: "kt" })}
                    </span>
                    <span className="text-[10px] font-mono text-sky-400">
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
            {enrichedLayovers.map((layover, index) => (
              <LayoverCard
                key={`${layover.startTime}-${layover.endTime}-${index}`}
                layover={layover}
              />
            ))}
          </Section>
        )}

        {/* Aircraft Intelligence */}
        {ac && (
          <Section title="Aircraft" icon={Satellite}>
            <Row icon={Plane} label="Manufacturer" value={ac.manufacturer ?? "--"} />
            <Row icon={Plane} label="Type / Model" value={ac.type ?? "--"} />
            <Row icon={Hash} label="Registration" value={ac.registration ?? "--"} mono highlight />
            <Row icon={Globe} label="Owner Country" value={ac.ownerCountry ?? "--"} />
            <Row icon={Signal} label="Operator" value={ac.registeredOwner || "--"} />
            <Row icon={Layers} label="Category" value={getAircraftCategoryLabel(flight.category)} />
          </Section>
        )}

        {/* Aerodynamics */}
        <Section title="Aerodynamics" icon={Zap}>
          <Row
            icon={Gauge}
            label="Ground Speed"
            value={fmt(speed, { digits: 1, suffix: " kt" })}
            mono
            highlight
          />
          <Row icon={Zap} label="Mach" value={fmt(mach, { digits: 3, suffix: " M" })} mono />
          <Row
            icon={Wind}
            label="TAS (est)"
            value={fmt(physics.tas, { digits: 1, suffix: " m/s" })}
            mono
          />
          <Row
            icon={Wind}
            label="CAS (est)"
            value={fmt(physics.cas, { digits: 1, suffix: " m/s" })}
            mono
          />
          <Row
            icon={Target}
            label="Std Bank"
            value={fmt(physics.bank, { digits: 1, suffix: "°" })}
            mono
          />
          <Row
            icon={Activity}
            label="G-Load"
            value={fmt(physics.gLoad, { digits: 2, suffix: " G" })}
            mono
          />
          <Row
            icon={Thermometer}
            label="ISA Temp"
            value={fmt(physics.isaT ? physics.isaT - 273.15 : null, { digits: 1, suffix: " °C" })}
            mono
          />
          <Row
            icon={Cloud}
            label="Air Density"
            value={fmt(physics.rho, { digits: 4, suffix: " kg/m³" })}
            mono
          />
          <Row
            icon={Ruler}
            label="Turn Radius"
            value={fmt(physics.turnRadius, { digits: 0, suffix: " m" })}
            mono
          />
        </Section>

        {/* Navigation */}
        <Section title="Navigation" icon={Compass}>
          <Row
            icon={Satellite}
            label="Data Source"
            value={
              flight.data_source
                ? getDataSourceInfo(flight.data_source).name
                : positionSourceLabel(flight.position_source)
            }
            highlight
          />
          <Row
            icon={MapPin}
            label="Lat / Lon"
            value={`${fmt(prediction.latitude, { digits: 4 })}, ${fmt(prediction.longitude, { digits: 4 })}`}
            mono
          />
          <Row
            icon={Signal}
            label="Source / Qual"
            value={`${sourceQuality.label} (${sourceQuality.accuracy})`}
            highlight
          />
          <Row
            icon={Timer}
            label="Signal Age"
            value={`${signalAgeSeconds}s`}
            mono
            warn={signalAgeSeconds > 30}
          />
          <Row
            icon={Hash}
            label="Squawk"
            value={flight.squawk || "----"}
            mono
            highlight={isNotableSquawk(flight.squawk)}
          />
          <Row
            icon={Radio}
            label="SPI"
            value={flight.spi ? "IDENT" : "STBY"}
            highlight={!!flight.spi}
          />
          <Row
            icon={Activity}
            label="Pos Confidence"
            value={fmt(prediction.confidenceScore * 100, { digits: 1, suffix: "%" })}
            warn={prediction.confidence === "low"}
          />
          <Row
            icon={Clock}
            label="Last Report"
            value={formatClock(flight.last_contact * 1000)}
            mono
          />
          <Row
            icon={Satellite}
            label="Sensors"
            value={flight.sensors?.length ? `${flight.sensors.length} receivers` : "None"}
          />
        </Section>

        {/* System Identity */}
        <Section title="System Identity" icon={Hash}>
          <Row icon={Hash} label="ICAO24 HEX" value={flight.icao24.toUpperCase()} mono highlight />
          <Row icon={Globe} label="Country" value={flight.origin_country} />
          <Row icon={Mountain} label="Flight Level" value={fl} mono highlight />
          <Row
            icon={Mountain}
            label="Baro Alt"
            value={fmt(reportedAltFt, { digits: 0, suffix: " ft" })}
            mono
          />
          <Row
            icon={Mountain}
            label="Geo Alt"
            value={fmt(geoAltFt, { digits: 0, suffix: " ft" })}
            mono
          />
          <Row
            icon={Layers}
            label="Baro–Geo Δ"
            value={fmt(altDiffFt, { digits: 0, suffix: " ft", sign: true })}
            mono
            warn={altDiffFt !== null && Math.abs(altDiffFt) > 500}
          />
          <Row
            icon={History}
            label="Fix Method"
            value={prediction.isPredicted ? "Kinematic" : "Raw ADS-B"}
          />
        </Section>

        {/* Incident Timeline */}
        {anomalyHistory.length > 0 && (
          <Section title="Incident Timeline" icon={History}>
            <div className="col-span-2 overflow-hidden border border-white/[0.05]">
              <div className="grid grid-cols-4 px-3 py-2 border-b border-white/[0.04] bg-white/[0.015]">
                {["Time", "Alt", "Speed", "Hdg"].map((h) => (
                  <span
                    key={h}
                    className="text-[9px] font-bold uppercase tracking-widest text-white/25"
                  >
                    {h}
                  </span>
                ))}
              </div>
              {[...anomalyHistory]
                .reverse()
                .slice(0, 10)
                .map((snap, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-4 gap-0 px-3 py-2 border-b border-white/[0.03] last:border-0 text-[10px] font-mono hover:bg-white/[0.02] transition-colors"
                  >
                    <span className="text-white/30">{formatClock(snap.time * 1000)}</span>
                    <span className="text-white/55">
                      {snap.altitude
                        ? fmt(altitudeFt(snap.altitude), { digits: 0, suffix: "ft" })
                        : "---"}
                    </span>
                    <span className="text-white/55">
                      {snap.speed ? fmt(speedKt(snap.speed), { digits: 0, suffix: "kt" }) : "---"}
                    </span>
                    <span className="text-sky-400">
                      {snap.heading !== null
                        ? fmt(snap.heading, { digits: 0, suffix: "°" })
                        : "---"}
                    </span>
                  </div>
                ))}
            </div>
          </Section>
        )}

        {/* Anomaly Flags */}
        {anomaly && (
          <div className="px-5 py-4 border-t border-white/[0.05]">
            <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-white/20 mb-3">
              Detected Flags
            </p>
            <div className="flex flex-wrap gap-1.5">
              {anomaly.anomalies.map((item) => {
                const Icon = anomalyIcons[item.type];
                return (
                  <span
                    key={item.type}
                    className={`
                      inline-flex items-center gap-1.5
                      text-[10px] font-bold uppercase tracking-wide
                      px-2.5 py-1 border
                      ${sevStyles[item.severity] ?? sevStyles.low}
                    `}
                  >
                    <Icon className="w-2.5 h-2.5" />
                    {item.label}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        <div className="h-5" />
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
  color = "sky",
  trend,
}: {
  label: string;
  value: string;
  sub: string;
  pct: number;
  color?: "sky" | "amber";
  trend?: "up" | "down";
}) {
  const isAmber = color === "amber";
  const barColor = isAmber ? "bg-amber-400" : "bg-sky-400";
  const valueColor = isAmber ? "text-amber-300" : "text-sky-300";

  return (
    <div
      className="
      relative flex flex-col gap-1 px-3.5 py-3.5
      bg-white/[0.015] hover:bg-white/[0.025]
      border-r border-white/[0.05] last:border-r-0
      transition-colors duration-200 overflow-hidden
    "
    >
      <span className="text-[8.5px] font-bold uppercase tracking-[0.12em] text-white/25">
        {label}
      </span>
      <div className="flex items-center gap-1.5">
        {trend === "up" && (
          <TrendingUp
            className={`w-3 h-3 ${valueColor} flex-shrink-0 drop-shadow-[0_0_4px_currentColor]`}
          />
        )}
        {trend === "down" && (
          <TrendingDown
            className={`w-3 h-3 ${valueColor} flex-shrink-0 drop-shadow-[0_0_4px_currentColor]`}
          />
        )}
        <strong
          className={`text-[14px] font-mono font-semibold leading-none tracking-tight ${valueColor} drop-shadow-[0_0_5px_currentColor]`}
        >
          {value}
        </strong>
      </div>
      <span className="text-[10px] text-white/30 truncate leading-none">{sub}</span>
      {/* gauge bar */}
      <div className="absolute bottom-0 left-0 right-0 h-[1.5px] bg-white/[0.03]">
        <div
          className={`h-full ${barColor} opacity-50 transition-all duration-700`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Section wrapper */
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
    <div className="border-t border-white/[0.06]">
      <div className="flex items-center gap-2 px-5 py-3">
        {Icon && <Icon className="w-3 h-3 text-sky-400/40 flex-shrink-0" />}
        <span className="text-[9px] font-bold uppercase tracking-[0.12em] text-white/25">
          {title}
        </span>
      </div>
      <div className="grid grid-cols-2 px-5 pb-4 gap-x-6 gap-y-0">{children}</div>
    </div>
  );
}

/** Label → value data row */
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
  const valueColor = warn ? "text-amber-400" : highlight ? "text-sky-300" : "text-white/65";

  return (
    <div className="flex items-center justify-between gap-3 py-[7px] border-b border-white/[0.04] last:border-0">
      <span className="flex items-center gap-1.5 text-[10.5px] text-white/30 min-w-0 shrink-0 flex-1">
        <Icon className="w-2.5 h-2.5 flex-shrink-0 opacity-50" />
        <span className="truncate">{label}</span>
      </span>
      <strong
        className={`
        text-[11px] font-semibold text-right leading-tight max-w-[55%] truncate
        ${mono ? "font-mono" : ""}
        ${valueColor}
      `}
      >
        {value}
      </strong>
    </div>
  );
}

/** Full-width airport card row */
function FullRow({
  icon: Icon,
  label,
  value,
  sub,
  mono,
  highlight,
  warn,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
  highlight?: boolean;
  warn?: boolean;
}) {
  const valueColor = warn ? "text-amber-400" : highlight ? "text-sky-300" : "text-white/70";

  return (
    <div className="col-span-2 border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5 mb-1 last:mb-0">
      <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-widest text-white/25 mb-1">
        <Icon className="w-2.5 h-2.5 opacity-50" />
        <span>{label}</span>
      </div>
      <strong className={`block text-[12px] leading-snug ${mono ? "font-mono" : ""} ${valueColor}`}>
        {value}
      </strong>
      {sub && <span className="mt-0.5 block text-[10px] text-white/30 leading-snug">{sub}</span>}
    </div>
  );
}

/** Notice row */
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
      ? "bg-amber-500/[0.06] border-amber-500/15 text-amber-300/70"
      : "bg-sky-500/[0.06] border-sky-500/15 text-sky-200/70";
  return (
    <div className={`col-span-2 flex gap-2.5 border px-3.5 py-2.5 mb-1 ${style}`}>
      <Icon className="mt-px h-3 w-3 flex-shrink-0" />
      <p className="text-[10.5px] leading-relaxed">{value}</p>
    </div>
  );
}

/** Phase color helper */
function phaseColor(phase: string): string {
  switch (phase) {
    case "takeoff":
      return "bg-lime-400";
    case "climb":
      return "bg-emerald-400";
    case "cruise":
      return "bg-sky-400";
    case "descent":
      return "bg-amber-400";
    case "approach":
      return "bg-orange-400";
    case "ground":
      return "bg-slate-500";
    default:
      return "bg-white/25";
  }
}

/** Phase bar strip */
function TrackPhaseStrip({ phases }: { phases: FlightTrackPhase[] }) {
  const total = phases.reduce((sum, p) => sum + Math.max(p.durationMinutes, 0.1), 0);
  if (!phases.length || total <= 0) return null;

  return (
    <div className="border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5">
      <div className="flex items-center justify-between mb-2 text-[9px] uppercase tracking-widest text-white/25">
        <span>Phase Profile</span>
        <span>{phases.length} blocks</span>
      </div>
      <div className="flex h-1.5 overflow-hidden bg-white/[0.05] gap-px">
        {phases.map((phase, i) => (
          <span
            key={`${phase.phase}-${phase.startedAt}-${i}`}
            className={`${phaseColor(phase.phase)}`}
            style={{ width: `${Math.max(3, (phase.durationMinutes / total) * 100)}%` }}
            title={`${phase.phase}: ${formatTrackDuration(phase.durationMinutes)}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {phases.slice(-5).map((phase, i) => (
          <span
            key={`${phase.phase}-${phase.endedAt}-${i}`}
            className="border border-white/[0.05] bg-white/[0.03] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-white/40"
          >
            {phase.phase} {formatTrackDuration(phase.durationMinutes)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Layover card */
function LayoverCard({ layover }: { layover: PanelLayover }) {
  return (
    <div className="col-span-2 border border-amber-500/15 bg-amber-500/[0.03] px-3.5 py-3 mb-1.5 last:mb-0">
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="min-w-0">
          <strong className="block font-mono text-[14px] font-semibold text-amber-300 leading-none mb-0.5">
            {layover.airportCode}
          </strong>
          <span className="text-[11px] text-white/50 truncate block">{layover.airportName}</span>
        </div>
        <span className="flex-shrink-0 border border-amber-400/20 bg-amber-400/[0.08] px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-300">
          {formatTrackDuration(layover.durationMinutes)}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-y-1.5 text-[10px] border-t border-white/[0.04] pt-2.5">
        <span className="text-white/30">
          Codes <strong className="font-mono text-white/55 ml-1">{layover.airportCodes}</strong>
        </span>
        <span className="text-white/30">
          Match{" "}
          <strong className="font-mono text-white/55 ml-1">
            {fmt(layover.airportDistanceKm, { digits: 1, suffix: " km" })}
          </strong>
        </span>
        <span className="text-white/30">
          Start{" "}
          <strong className="font-mono text-white/55 ml-1">
            {formatTrackTime(layover.startTime)}
          </strong>
        </span>
        <span className="text-white/30">
          End{" "}
          <strong className="font-mono text-white/55 ml-1">
            {formatTrackTime(layover.endTime)}
          </strong>
        </span>
        <span className="col-span-2 font-mono text-white/25 text-[9px]">
          {fmt(layover.lat, { digits: 4 })}, {fmt(layover.lon, { digits: 4 })} ·{" "}
          {layover.confidence ?? "reported"} confidence
        </span>
      </div>
    </div>
  );
}

/** Loading skeleton row */
function LoadingRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5 px-5 py-3.5 border-t border-white/[0.05]">
      <span className="w-1.5 h-1.5 bg-sky-400 animate-ping opacity-60 flex-shrink-0" />
      <span className="text-[10.5px] text-white/25 italic">{label}…</span>
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
    <div className="px-5 py-4 border-t border-white/[0.06] bg-white/[0.01]">
      {/* Airport codes */}
      <div className="flex items-end justify-between mb-4">
        <div>
          <span className="text-[18px] font-bold font-mono text-white/75 tracking-tight leading-none">
            {origin.iataCode || origin.icaoCode}
          </span>
          <p className="text-[10px] text-white/25 mt-0.5 leading-none">{origin.municipality}</p>
        </div>
        <div className="flex items-center gap-2 text-white/15">
          <div className="h-px w-12 bg-white/10" />
          <Plane className="w-3 h-3 text-sky-400/50" style={{ transform: "rotate(45deg)" }} />
          <div className="h-px w-12 bg-white/10" />
        </div>
        <div className="text-right">
          <span className="text-[18px] font-bold font-mono text-white/75 tracking-tight leading-none">
            {destination.iataCode || destination.icaoCode}
          </span>
          <p className="text-[10px] text-white/25 mt-0.5 leading-none">
            {destination.municipality}
          </p>
        </div>
      </div>

      {/* Progress track */}
      <div className="relative h-[2px] bg-white/[0.06] mb-4">
        <div
          className="absolute left-0 top-0 h-full bg-sky-400/70 transition-all duration-1000"
          style={{ width: `${progress.pct}%` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 transition-all duration-1000"
          style={{ left: `${progress.pct}%` }}
        >
          <div className="w-3.5 h-3.5 bg-sky-400 border-2 border-black shadow-[0_0_10px_rgba(56,189,248,0.7)] flex items-center justify-center">
            <Plane className="w-1.5 h-1.5 text-black" style={{ transform: "rotate(45deg)" }} />
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 text-center">
        <div>
          <p className="text-[8.5px] font-bold uppercase tracking-[0.12em] text-white/20 mb-1">
            Flown
          </p>
          <p className="text-[12px] font-mono font-semibold text-white/50">
            {Math.round(progress.flown)} km
          </p>
        </div>
        <div>
          <p className="text-[8.5px] font-bold uppercase tracking-[0.12em] text-white/20 mb-1">
            Progress
          </p>
          <p className="text-[12px] font-mono font-semibold text-sky-400">
            {progress.pct.toFixed(1)}%
          </p>
        </div>
        <div>
          <p className="text-[8.5px] font-bold uppercase tracking-[0.12em] text-white/20 mb-1">
            ETA
          </p>
          <p className="text-[12px] font-mono font-semibold text-white/50">{eta}</p>
        </div>
      </div>
    </div>
  );
}
