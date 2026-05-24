import type { PickingInfo } from "@deck.gl/core";
import { MapboxOverlay, type MapboxOverlayProps } from "@deck.gl/mapbox";
import {
  CloudSun,
  Loader2,
  MapPin,
  Navigation2,
  Plane,
  Radar,
  RefreshCw,
  Route,
  Satellite,
  ShieldAlert,
  Tags,
} from "lucide-react";
import maplibregl from "maplibre-gl";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Map, {
  FullscreenControl,
  NavigationControl,
  ScaleControl,
  useControl,
  type MapRef,
} from "react-map-gl/maplibre";
import type { AnomalousFlight } from "@/lib/anomaly";
import { getAirportCode, type Airport } from "@/lib/airports";
import type { FlightRouteInfo } from "@/lib/enrichment-types";
import { fetchBackendJson } from "@/lib/backend-api";
import {
  flightTrackDistanceKm,
  type FlightTrackData,
  type FlightTrackPoint,
} from "@/lib/flightTrack";
import {
  altitudeFt,
  crossTrackDistanceKm,
  flightLevel,
  fmt,
  gcBearing,
  gcDistanceKm,
  headingCompass,
  speedKt,
} from "@/lib/format";
import type { Flight } from "@/lib/opensky";
import { predictFlightState } from "@/lib/prediction";
import type { SatelliteObject } from "@/lib/satellites";
import { createSkywatchDeckLayers, prepareSkywatchDeckData } from "./map/layers";
import {
  createCartoRasterStyle,
  DEFAULT_LAYER_VISIBILITY,
  INITIAL_VIEW_STATE,
  MAP_LIMITS,
} from "./map/layerConfig";
import type {
  DeckAirportPoint,
  DeckFlightPoint,
  DeckLayerVisibility,
  DeckPredictionPath,
  DeckRoutePath,
  DeckSatellitePoint,
  DeckTrackPath,
  DeckWeatherPoint,
  LayerBuildInput,
  LngLatPosition,
  RestrictionFeature,
  SelectedTrackSegment,
  SkywatchPickableObject,
  SkywatchTooltip,
  TfrPayload,
  WeatherPayload,
} from "./map/types";

interface MapViewProps {
  flights: Flight[];
  anomalyMap: Map<string, AnomalousFlight>;
  selectedId: string | null;
  onSelect: (icao24: string | null) => void;
  focus: { lat: number; lng: number; id: string; zoom?: number } | null;
  airports: Airport[];
  enrichmentRoute: FlightRouteInfo | null;
  selectedFlight?: Flight | null;
  selectedFlightTrack?: FlightTrackData | null;
  isolateSelected?: boolean;
  selectedPathVisible?: boolean;
  satellites: SatelliteObject[];
  theme: "dark" | "light";
  isPanelOpen?: boolean;
}

type LayerToggleKey = keyof DeckLayerVisibility;

const TOOLTIP_MOVE_EPSILON_PX = 2;
const VIEWPORT_FLIGHT_MARGIN_DEGREES = 2.5;

interface WebglStatus {
  ok: boolean;
  message: string | null;
}

interface ViewportBounds {
  west: number;
  east: number;
  south: number;
  north: number;
}

function DeckOverlay(props: MapboxOverlayProps) {
  const overlay = useControl<MapboxOverlay>(() => new MapboxOverlay(props));
  overlay.setProps(props);
  return null;
}

function createWebglStatus(): WebglStatus {
  if (typeof document === "undefined") {
    return { ok: false, message: "Map rendering waits for a browser WebGL context." };
  }

  const canvas = document.createElement("canvas");
  const attributes: WebGLContextAttributes = {
    antialias: false,
    alpha: true,
    depth: true,
    stencil: true,
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
    failIfMajorPerformanceCaveat: false,
  };

  const context = canvas.getContext("webgl2", attributes) ?? canvas.getContext("webgl", attributes);
  canvas.width = 1;
  canvas.height = 1;

  if (!context) {
    return {
      ok: false,
      message:
        "WebGL is unavailable or temporarily blocked by the browser. Reload this tab or open a new one, then retry the map.",
    };
  }

  return { ok: true, message: null };
}

function getErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  const nested = [record.error, record.originalEvent, record.message, record.statusMessage]
    .map(getErrorMessage)
    .find(Boolean);

  return nested ?? "";
}

function isWebglFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("webgl") ||
    normalized.includes("context loss") ||
    normalized.includes("context lost") ||
    normalized.includes("webglcontextcreationerror")
  );
}

function isFiniteCoordinate(lat: number | null | undefined, lon: number | null | undefined) {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function readViewportBounds(mapRef: React.RefObject<MapRef | null>): ViewportBounds | null {
  const map = mapRef.current?.getMap();
  if (!map) return null;
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    east: bounds.getEast(),
    south: bounds.getSouth(),
    north: bounds.getNorth(),
  };
}

function longitudeInViewport(longitude: number, bounds: ViewportBounds): boolean {
  const west = Math.max(-180, bounds.west - VIEWPORT_FLIGHT_MARGIN_DEGREES);
  const east = Math.min(180, bounds.east + VIEWPORT_FLIGHT_MARGIN_DEGREES);
  if (west <= east) return longitude >= west && longitude <= east;
  return longitude >= west || longitude <= east;
}

function flightInViewport(flight: Flight, bounds: ViewportBounds): boolean {
  if (!isFiniteCoordinate(flight.latitude, flight.longitude)) return false;
  const latitude = flight.latitude as number;
  const longitude = flight.longitude as number;
  return (
    latitude >= bounds.south - VIEWPORT_FLIGHT_MARGIN_DEGREES &&
    latitude <= bounds.north + VIEWPORT_FLIGHT_MARGIN_DEGREES &&
    longitudeInViewport(longitude, bounds)
  );
}

function finiteCoordinateValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function flightRouteAirportCode(airport: FlightRouteInfo["origin"]): string | null {
  if (!airport) return null;
  return airport.iataCode || airport.icaoCode || null;
}

function routeAirportPosition(airport: FlightRouteInfo["origin"]): LngLatPosition | null {
  if (!airport) return null;
  const latitude = finiteCoordinateValue(airport.latitude);
  const longitude = finiteCoordinateValue(airport.longitude);
  if (!isFiniteCoordinate(latitude, longitude)) return null;
  if (latitude === 0 && longitude === 0) return null;
  return [longitude as number, latitude as number];
}

function angleDifferenceDegrees(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function routeLooksIncorrect(
  flight: Flight | null | undefined,
  route: FlightRouteInfo | null,
  origin: LngLatPosition | null,
  destination: LngLatPosition | null,
): boolean {
  if (!route || !origin || !destination) return false;
  if (route.routeConfidence === "low" || route.routeWarning) return true;
  if (!flight || !isFiniteCoordinate(flight.latitude, flight.longitude)) return false;

  const lat = flight.latitude as number;
  const lon = flight.longitude as number;
  const originLat = origin[1];
  const originLon = origin[0];
  const destLat = destination[1];
  const destLon = destination[0];
  const totalKm = gcDistanceKm(originLat, originLon, destLat, destLon);
  if (totalKm < 10) return true;

  const remainingKm = gcDistanceKm(lat, lon, destLat, destLon);
  const flownKm = gcDistanceKm(originLat, originLon, lat, lon);
  const crossTrackKm = Math.abs(
    crossTrackDistanceKm(originLat, originLon, destLat, destLon, lat, lon),
  );
  if (crossTrackKm > Math.max(120, totalKm * 0.45)) return true;

  if (flight.true_track !== null) {
    const track = Number(flight.true_track);
    if (flownKm < 150) {
      const bearingToOrigin = gcBearing(lat, lon, originLat, originLon);
      if (angleDifferenceDegrees(track, bearingToOrigin) < 80) return true;
    }
    if (remainingKm > 100) {
      const bearingToDestination = gcBearing(lat, lon, destLat, destLon);
      if (angleDifferenceDegrees(track, bearingToDestination) > 90) return true;
    }
  }

  if (totalKm > 300 && flownKm / totalKm < 0.3) {
    const verticalFpm = (flight.vertical_rate ?? 0) * 196.85;
    const altitudeFt = (flight.baro_altitude ?? 0) * 3.28084;
    if (verticalFpm < -800 && altitudeFt < 18_000) return true;
  }

  return false;
}

function liveTrackPointFromFlight(flight: Flight | null | undefined): FlightTrackPoint | null {
  if (!flight) return null;
  const predicted = predictFlightState(flight);
  if (!isFiniteCoordinate(predicted.latitude, predicted.longitude)) return null;

  return {
    lat: predicted.latitude as number,
    lon: predicted.longitude as number,
    alt: predicted.baroAltitude ?? predicted.geoAltitude ?? null,
    speed: flight.velocity ?? null,
    heading: flight.true_track ?? null,
    time: new Date(
      ((flight.time_position ?? flight.last_contact) || Date.now() / 1000) * 1000,
    ).toISOString(),
    onGround: flight.on_ground,
    dataSource: flight.data_source ?? null,
  };
}

function buildSelectedTrackSegments(
  selectedFlight: Flight | null | undefined,
  selectedFlightTrack: FlightTrackData | null,
): SelectedTrackSegment[] {
  const segments: SelectedTrackSegment[] = selectedFlightTrack
    ? selectedFlightTrack.segments
        .map((segment): SelectedTrackSegment => {
          const points = segment.points.filter((point) => isFiniteCoordinate(point.lat, point.lon));
          return {
            id: segment.id,
            source: segment.source,
            points,
            path: points.map((point) => [point.lon, point.lat] as LngLatPosition),
          };
        })
        .filter((segment) => segment.path.length > 0)
    : [];

  const livePoint = liveTrackPointFromFlight(selectedFlight);
  if (!livePoint) return segments.filter((segment) => segment.path.length > 1);

  const lastSegment = segments[segments.length - 1];
  if (!lastSegment) {
    return [
      {
        id: "selected-live-point",
        source: selectedFlight?.data_source ?? "live",
        points: [livePoint],
        path: [[livePoint.lon, livePoint.lat] as LngLatPosition],
      },
    ].filter((segment) => segment.path.length > 1);
  }

  const lastPoint = lastSegment.points[lastSegment.points.length - 1];
  if (!lastPoint || flightTrackDistanceKm(lastPoint, livePoint) >= 0.02) {
    lastSegment.points = [...lastSegment.points, livePoint];
    lastSegment.path = [...lastSegment.path, [livePoint.lon, livePoint.lat]];
  }

  return segments.filter((segment) => segment.path.length > 1);
}

function routeAirportsFor(
  airports: Airport[],
  enrichmentRoute: FlightRouteInfo | null,
  selectedFlightTrack: FlightTrackData | null,
): Airport[] {
  const originIcao = enrichmentRoute?.origin?.icaoCode;
  const destIcao = enrichmentRoute?.destination?.icaoCode;
  const originIata = enrichmentRoute?.origin?.iataCode;
  const destIata = enrichmentRoute?.destination?.iataCode;
  const layovers = selectedFlightTrack?.layovers ?? [];

  return airports.filter((airport) => {
    const matchesRoute =
      (originIcao && [airport.icao, airport.ident, airport.gpsCode].includes(originIcao)) ||
      (destIcao && [airport.icao, airport.ident, airport.gpsCode].includes(destIcao)) ||
      (originIata && airport.iata === originIata) ||
      (destIata && airport.iata === destIata);

    if (matchesRoute) return true;

    return layovers.some(
      (layover) =>
        (layover.airportIcao &&
          [airport.icao, airport.ident, airport.gpsCode].includes(layover.airportIcao)) ||
        (layover.airportIata && airport.iata === layover.airportIata),
    );
  });
}

function fitTrackBounds(mapRef: React.RefObject<MapRef | null>, segments: SelectedTrackSegment[]) {
  const positions = segments.flatMap((segment) => segment.path);
  if (positions.length < 2) return;

  const bounds = positions.reduce(
    (acc, [lon, lat]) => ({
      west: Math.min(acc.west, lon),
      south: Math.min(acc.south, lat),
      east: Math.max(acc.east, lon),
      north: Math.max(acc.north, lat),
    }),
    {
      west: positions[0][0],
      south: positions[0][1],
      east: positions[0][0],
      north: positions[0][1],
    },
  );

  mapRef.current?.fitBounds(
    [
      [bounds.west, bounds.south],
      [bounds.east, bounds.north],
    ],
    { padding: 96, duration: 800, maxZoom: 8 },
  );
}

function normalizeRestrictionFeature(
  feature: Partial<RestrictionFeature>,
): RestrictionFeature | null {
  if (!feature.geometry) return null;
  return {
    type: "Feature",
    geometry: feature.geometry,
    properties: feature.properties ?? {},
  };
}

function visibleWeatherAirports(
  mapRef: React.RefObject<MapRef | null>,
  airports: Airport[],
): Airport[] {
  const important = airports.filter(
    (airport) => airport.type === "large_airport" || airport.type === "medium_airport",
  );
  const map = mapRef.current?.getMap();
  if (!map) return important.slice(0, 60);

  const bounds = map.getBounds();
  return important.filter((airport) => bounds.contains([airport.lon, airport.lat])).slice(0, 70);
}

function airportWeatherCode(airport: Airport): string | null {
  return (
    [airport.icao, airport.gpsCode, airport.ident].find((code) => /^[A-Z]{4}$/.test(code)) ?? null
  );
}

function restrictionProperty(feature: RestrictionFeature, keys: string[], fallback = ""): string {
  const props = feature.properties ?? {};
  for (const key of keys) {
    if (props[key] !== null && props[key] !== undefined && props[key] !== "") {
      return String(props[key]);
    }

    const caseInsensitiveKey = Object.keys(props).find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
    if (
      caseInsensitiveKey &&
      props[caseInsensitiveKey] !== null &&
      props[caseInsensitiveKey] !== undefined &&
      props[caseInsensitiveKey] !== ""
    ) {
      return String(props[caseInsensitiveKey]);
    }
  }
  return fallback;
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function isRestrictionFeature(object: SkywatchPickableObject): object is RestrictionFeature {
  return "type" in object && object.type === "Feature";
}

function pickedFlightId(object: SkywatchPickableObject): string | null {
  if (isRestrictionFeature(object)) return null;
  if (object.objectType === "flight") return (object as DeckFlightPoint).id;
  return null;
}

function TooltipContent({ object }: { object: SkywatchPickableObject }) {
  if (isRestrictionFeature(object)) {
    const name = compactText(
      restrictionProperty(object, ["name", "title", "NOTAM", "notamNumber", "type"], "Restriction"),
      90,
    );
    const risk = compactText(
      restrictionProperty(object, ["riskLevel", "risk_level", "severity"], "Advisory"),
      50,
    );
    const limits = compactText(
      restrictionProperty(object, ["altitudeLimits", "altitude_limits", "altitude"], "SFC-UNL"),
      50,
    );

    return (
      <>
        <strong>{name}</strong>
        <span>{risk}</span>
        <span>{limits}</span>
      </>
    );
  }

  if (object.objectType === "flight") {
    const point = object as DeckFlightPoint;
    const flight = point.flight;
    return (
      <>
        <strong>{point.label}</strong>
        <span>{flight.origin_country || "Unknown origin"}</span>
        <span>
          {flightLevel(point.altitudeMeters)} /{" "}
          {fmt(speedKt(point.speedMetersPerSecond), { suffix: " kt" })}
        </span>
        <span>
          {point.heading !== null
            ? `${Math.round(point.heading)} deg ${headingCompass(point.heading)}`
            : "Heading --"}
        </span>
        {point.anomaly ? (
          <em>{point.anomaly.anomalies.map((item) => item.label).join(", ")}</em>
        ) : null}
      </>
    );
  }

  if (object.objectType === "airport") {
    const point = object as DeckAirportPoint;
    return (
      <>
        <strong>{getAirportCode(point.airport)}</strong>
        <span>{point.airport.name}</span>
        <span>{[point.airport.city, point.airport.countryCode].filter(Boolean).join(", ")}</span>
      </>
    );
  }

  if (object.objectType === "weather") {
    const point = object as DeckWeatherPoint;
    const category = point.metar.flight_category || "WX";
    const station = point.metar.station || getAirportCode(point.airport);
    return (
      <div className="sw-weather-tooltip" data-category={category.toUpperCase()}>
        <div className="sw-weather-tooltip-head">
          <span>
            <small>Terminal weather</small>
            <strong>{station}</strong>
          </span>
          <b>
            <CloudSun className="h-3.5 w-3.5" />
            {category}
          </b>
        </div>
        <div className="sw-weather-tooltip-grid">
          <span>
            Wind
            <strong>
              {point.metar.wind_direction !== null
                ? `${point.metar.wind_direction} deg / ${point.metar.wind_speed ?? 0} kt`
                : "Calm"}
            </strong>
          </span>
          <span>
            Temp
            <strong>
              {point.metar.temperature !== null ? `${point.metar.temperature} C` : "--"}
            </strong>
          </span>
          <span>
            Visibility
            <strong>
              {point.metar.visibility !== null ? `${point.metar.visibility} sm` : "--"}
            </strong>
          </span>
          <span>
            Ceiling
            <strong>{point.metar.ceiling !== null ? `${point.metar.ceiling} ft` : "--"}</strong>
          </span>
        </div>
        <em>{point.metar.raw || "No raw METAR available"}</em>
      </div>
    );
  }

  if (object.objectType === "satellite") {
    const point = object as DeckSatellitePoint;
    return (
      <>
        <strong>{point.satellite.name}</strong>
        <span>{point.satellite.groupLabel}</span>
        <span>
          {point.satellite.altitudeKm !== null
            ? `${Math.round(point.satellite.altitudeKm)} km`
            : "Altitude --"}
        </span>
      </>
    );
  }

  if (object.objectType === "prediction") {
    const path = object as DeckPredictionPath;
    return (
      <>
        <strong>Predicted path</strong>
        <span>{path.flightId.toUpperCase()}</span>
        <span>{Math.round(path.confidence * 100)}% confidence</span>
      </>
    );
  }

  if (object.objectType === "track") {
    const path = object as DeckTrackPath;
    return (
      <>
        <strong>Historical track</strong>
        <span>{path.points.length.toLocaleString()} points</span>
        <span>{path.source}</span>
      </>
    );
  }

  const route = object as DeckRoutePath;
  return (
    <>
      <strong>{route.label || "Route"}</strong>
      <span>{route.path.length.toLocaleString()} vertices</span>
    </>
  );
}

function Tooltip({ tooltip }: { tooltip: SkywatchTooltip | null }) {
  if (!tooltip) return null;
  const isWeather = "objectType" in tooltip.object && tooltip.object.objectType === "weather";
  return (
    <div
      className={`sw-deck-tooltip${isWeather ? " sw-deck-tooltip-weather" : ""}`}
      style={{
        transform: `translate(${tooltip.x + 12}px, ${tooltip.y + 12}px)`,
      }}
    >
      <TooltipContent object={tooltip.object} />
    </div>
  );
}

function LayerButton({
  active,
  title,
  loading = false,
  icon: Icon,
  onClick,
}: {
  active: boolean;
  title: string;
  loading?: boolean;
  icon: typeof Plane;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      title={title}
      className={`grid h-9 w-9 place-items-center rounded-lg border transition-colors ${
        active
          ? "border-emerald-400/35 bg-emerald-400/15 text-emerald-300"
          : "border-white/10 bg-slate-950/70 text-slate-400 hover:bg-white/10 hover:text-white"
      }`}
      onClick={onClick}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
    </button>
  );
}

function MapToolbar({
  visibility,
  weatherLoading,
  restrictionLoading,
  onToggle,
  visible,
}: {
  visibility: DeckLayerVisibility;
  weatherLoading: boolean;
  restrictionLoading: boolean;
  onToggle: (key: LayerToggleKey) => void;
  visible: boolean;
}) {
  return (
    <div
      className={`sw-map-toolbar absolute top-[218px] z-[1000] grid gap-1.5 rounded-xl border border-white/10 bg-slate-950/80 p-1.5 shadow-2xl backdrop-blur-xl transition-all duration-300 ease-in-out ${
        visible
          ? "left-3 opacity-100 scale-100 pointer-events-auto"
          : "left-3 opacity-0 scale-90 pointer-events-none -translate-x-12"
      }`}
    >
      <LayerButton
        active={visibility.flights}
        icon={Plane}
        title="Toggle flights"
        onClick={() => onToggle("flights")}
      />
      <LayerButton
        active={visibility.predictions}
        icon={Navigation2}
        title="Toggle predicted paths"
        onClick={() => onToggle("predictions")}
      />
      <LayerButton
        active={visibility.tracks}
        icon={Route}
        title="Toggle selected track"
        onClick={() => onToggle("tracks")}
      />
      <LayerButton
        active={visibility.airports}
        icon={MapPin}
        title="Toggle airports"
        onClick={() => onToggle("airports")}
      />
      <LayerButton
        active={visibility.labels}
        icon={Tags}
        title="Toggle labels"
        onClick={() => onToggle("labels")}
      />
      <LayerButton
        active={visibility.weather}
        icon={CloudSun}
        loading={weatherLoading}
        title="Toggle weather"
        onClick={() => onToggle("weather")}
      />
      <LayerButton
        active={visibility.restrictions}
        icon={ShieldAlert}
        loading={restrictionLoading}
        title="Toggle restrictions"
        onClick={() => onToggle("restrictions")}
      />
      <LayerButton
        active={visibility.satellites}
        icon={Satellite}
        title="Toggle satellites"
        onClick={() => onToggle("satellites")}
      />
    </div>
  );
}

function LoadingStatus({
  weatherLoading,
  restrictionLoading,
}: {
  weatherLoading: boolean;
  restrictionLoading: boolean;
}) {
  if (!weatherLoading && !restrictionLoading) return null;

  return (
    <div className="absolute right-4 top-4 z-[1000] inline-flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950/80 px-3 py-2 text-xs font-medium text-slate-200 shadow-2xl backdrop-blur-xl">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-300" />
      <span>
        {weatherLoading && restrictionLoading
          ? "Updating weather and restrictions..."
          : weatherLoading
            ? "Loading weather..."
            : "Loading restrictions..."}
      </span>
    </div>
  );
}

function WebglUnavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-slate-950 text-slate-200">
      <div className="mx-4 flex max-w-md flex-col items-center gap-3 rounded-xl border border-white/10 bg-slate-900/80 px-5 py-5 text-center shadow-2xl backdrop-blur-xl">
        <Radar className="h-8 w-8 text-amber-300" />
        <div className="space-y-1">
          <strong className="block text-sm font-semibold">Live map paused</strong>
          <span className="block text-xs leading-5 text-slate-400">{message}</span>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-200 transition-colors hover:bg-emerald-400/20"
          onClick={onRetry}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry map
        </button>
      </div>
    </div>
  );
}

function MapView({
  flights,
  anomalyMap,
  selectedId,
  onSelect,
  focus,
  airports,
  enrichmentRoute,
  selectedFlight = null,
  selectedFlightTrack = null,
  isolateSelected = false,
  selectedPathVisible = true,
  satellites,
  theme,
  isPanelOpen = false,
}: MapViewProps) {
  const mapRef = useRef<MapRef | null>(null);
  const contextLossCleanupRef = useRef<(() => void) | null>(null);
  const [webglStatus, setWebglStatus] = useState<WebglStatus>(() => createWebglStatus());
  const [visibility, setVisibility] = useState<DeckLayerVisibility>(DEFAULT_LAYER_VISIBILITY);
  const [tooltip, setTooltip] = useState<SkywatchTooltip | null>(null);
  const [weather, setWeather] = useState<WeatherPayload["weather"]>({});
  const [restrictions, setRestrictions] = useState<RestrictionFeature[]>([]);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [restrictionLoading, setRestrictionLoading] = useState(false);
  const [weatherRefreshKey, setWeatherRefreshKey] = useState(0);
  const [viewportBounds, setViewportBounds] = useState<ViewportBounds | null>(null);

  const mapStyle = useMemo(() => createCartoRasterStyle(theme), [theme]);
  const selectedTrackSegments = useMemo(
    () => buildSelectedTrackSegments(selectedFlight, selectedFlightTrack),
    [selectedFlight, selectedFlightTrack],
  );
  const mapFlights = useMemo(
    () => (isolateSelected && selectedFlight ? [selectedFlight] : flights),
    [flights, isolateSelected, selectedFlight],
  );
  const visibleMapFlights = useMemo(() => {
    if (isolateSelected || !viewportBounds) return mapFlights;
    return mapFlights.filter(
      (flight) =>
        flight.icao24 === selectedId ||
        anomalyMap.has(flight.icao24) ||
        flightInViewport(flight, viewportBounds),
    );
  }, [anomalyMap, isolateSelected, mapFlights, selectedId, viewportBounds]);
  const routeOrigin = useMemo(
    () => routeAirportPosition(enrichmentRoute?.origin ?? null),
    [enrichmentRoute],
  );
  const routeDestination = useMemo(
    () => routeAirportPosition(enrichmentRoute?.destination ?? null),
    [enrichmentRoute],
  );
  const routeOriginLabel = useMemo(
    () => flightRouteAirportCode(enrichmentRoute?.origin ?? null),
    [enrichmentRoute],
  );
  const routeDestinationLabel = useMemo(
    () => flightRouteAirportCode(enrichmentRoute?.destination ?? null),
    [enrichmentRoute],
  );
  const routeLikelyIncorrect = useMemo(
    () => routeLooksIncorrect(selectedFlight, enrichmentRoute, routeOrigin, routeDestination),
    [selectedFlight, enrichmentRoute, routeOrigin, routeDestination],
  );
  const routeIsUsable = Boolean(
    selectedPathVisible && routeOrigin && routeDestination && !routeLikelyIncorrect,
  );
  const selectedTrackSegmentsForMap = useMemo(
    () => (selectedPathVisible && !routeLikelyIncorrect ? selectedTrackSegments : []),
    [routeLikelyIncorrect, selectedPathVisible, selectedTrackSegments],
  );
  const routeAirports = useMemo(
    () => (routeIsUsable ? routeAirportsFor(airports, enrichmentRoute, selectedFlightTrack) : []),
    [airports, enrichmentRoute, routeIsUsable, selectedFlightTrack],
  );

  const toggleLayer = useCallback((key: LayerToggleKey) => {
    setVisibility((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const updateViewportBounds = useCallback(() => {
    setViewportBounds(readViewportBounds(mapRef));
  }, []);

  useEffect(() => {
    if (!focus) return;
    mapRef.current?.flyTo({
      center: [focus.lng, focus.lat],
      zoom: focus.zoom ?? 7,
      duration: 900,
      essential: true,
    });
  }, [focus]);

  useEffect(() => {
    if (!selectedId || selectedTrackSegments.length === 0) return;
    fitTrackBounds(mapRef, selectedTrackSegments);
  }, [selectedId, selectedTrackSegments]);

  useEffect(() => {
    if (!visibility.weather) {
      setWeatherLoading(false);
      setWeather({});
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      const candidates = visibleWeatherAirports(mapRef, airports);
      const codes = candidates
        .map(airportWeatherCode)
        .filter((code): code is string => Boolean(code));

      if (codes.length === 0) {
        setWeather({});
        setWeatherLoading(false);
        return;
      }

      setWeatherLoading(true);
      void fetchBackendJson<WeatherPayload>(`/api/v1/weather/metar/?airports=${codes.join(",")}`)
        .then((payload) => {
          if (!cancelled) setWeather(payload.weather ?? {});
        })
        .catch(() => {
          if (!cancelled) setWeather({});
        })
        .finally(() => {
          if (!cancelled) setWeatherLoading(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [airports, visibility.weather, weatherRefreshKey]);

  useEffect(() => {
    if (!visibility.restrictions) {
      setRestrictionLoading(false);
      setRestrictions([]);
      return;
    }

    let cancelled = false;
    let interval: number | null = null;

    const loadRestrictions = () => {
      setRestrictionLoading(true);
      void fetchBackendJson<TfrPayload>("/api/v1/airspace/restrictions/")
        .then((payload) => {
          if (cancelled) return;
          setRestrictions(
            (payload.features ?? [])
              .map(normalizeRestrictionFeature)
              .filter((feature): feature is RestrictionFeature => feature !== null),
          );
        })
        .catch(() => {
          if (!cancelled) setRestrictions([]);
        })
        .finally(() => {
          if (!cancelled) setRestrictionLoading(false);
        });
    };

    loadRestrictions();
    interval = window.setInterval(loadRestrictions, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [visibility.restrictions]);

  useEffect(() => {
    const setZoom = (event: Event) => {
      const zoom = (event as CustomEvent<number>).detail;
      if (typeof zoom === "number" && Number.isFinite(zoom)) {
        mapRef.current?.flyTo({ zoom, duration: 350, essential: true });
      }
    };
    const focusLayers = () => {
      document.querySelector<HTMLButtonElement>(".sw-map-toolbar button")?.focus();
    };
    const togglePredictions = () => toggleLayer("predictions");
    const toggleWeather = () => toggleLayer("weather");
    const toggleRestrictions = () => toggleLayer("restrictions");
    const toggleSatellites = () => toggleLayer("satellites");
    const toggleAirports = () => toggleLayer("airports");

    window.addEventListener("skywatch:set-map-zoom", setZoom);
    window.addEventListener("skywatch:toggle-map-layers", focusLayers);
    window.addEventListener("skywatch:toggle-predictions", togglePredictions);
    window.addEventListener("skywatch:toggle-weather", toggleWeather);
    window.addEventListener("skywatch:toggle-tfr", toggleRestrictions);
    window.addEventListener("skywatch:toggle-satellites", toggleSatellites);
    window.addEventListener("skywatch:toggle-airports", toggleAirports);

    return () => {
      window.removeEventListener("skywatch:set-map-zoom", setZoom);
      window.removeEventListener("skywatch:toggle-map-layers", focusLayers);
      window.removeEventListener("skywatch:toggle-predictions", togglePredictions);
      window.removeEventListener("skywatch:toggle-weather", toggleWeather);
      window.removeEventListener("skywatch:toggle-tfr", toggleRestrictions);
      window.removeEventListener("skywatch:toggle-satellites", toggleSatellites);
      window.removeEventListener("skywatch:toggle-airports", toggleAirports);
    };
  }, [toggleLayer]);

  const layerInput = useMemo<LayerBuildInput>(
    () => ({
      flights: visibleMapFlights,
      refreshKey: 0,
      anomalyMap,
      selectedId,
      airports: isolateSelected ? [] : airports,
      routeAirports,
      weather: isolateSelected ? {} : (weather ?? {}),
      restrictions: isolateSelected ? [] : restrictions,
      selectedTrackSegments: selectedTrackSegmentsForMap,
      routeOrigin: routeIsUsable ? routeOrigin : null,
      routeDestination: routeIsUsable ? routeDestination : null,
      routeOriginLabel: routeIsUsable ? routeOriginLabel : null,
      routeDestinationLabel: routeIsUsable ? routeDestinationLabel : null,
      hasValidRoute: routeIsUsable,
      satellites: isolateSelected ? [] : satellites,
      visibility: {
        ...visibility,
        airports: isolateSelected ? false : visibility.airports,
        labels: isolateSelected ? false : visibility.labels,
        weather: isolateSelected ? false : visibility.weather,
        satellites: isolateSelected ? false : visibility.satellites,
        restrictions: isolateSelected ? false : visibility.restrictions,
      },
    }),
    [
      visibleMapFlights,
      anomalyMap,
      selectedId,
      airports,
      isolateSelected,
      routeAirports,
      weather,
      restrictions,
      selectedTrackSegmentsForMap,
      routeOrigin,
      routeDestination,
      routeOriginLabel,
      routeDestinationLabel,
      routeIsUsable,
      satellites,
      visibility,
    ],
  );

  const deckData = useMemo(() => prepareSkywatchDeckData(layerInput), [layerInput]);
  const deckLayers = useMemo(() => createSkywatchDeckLayers(deckData), [deckData]);

  const handleHover = useCallback((info: PickingInfo<SkywatchPickableObject>) => {
    if (!info.object || !info.layer) {
      setTooltip((current) => (current ? null : current));
      return;
    }

    const nextTooltip: SkywatchTooltip = {
      x: info.x,
      y: info.y,
      object: info.object,
      layerId: info.layer.id,
    };

    setTooltip((current) => {
      if (
        current &&
        current.object === nextTooltip.object &&
        current.layerId === nextTooltip.layerId &&
        Math.abs(current.x - nextTooltip.x) < TOOLTIP_MOVE_EPSILON_PX &&
        Math.abs(current.y - nextTooltip.y) < TOOLTIP_MOVE_EPSILON_PX
      ) {
        return current;
      }
      return nextTooltip;
    });
  }, []);

  const handleClick = useCallback(
    (info: PickingInfo<SkywatchPickableObject>) => {
      const object = info.object;
      if (!object) {
        setTooltip(null);
        onSelect(null);
        return false;
      }

      if (info.layer) {
        setTooltip({
          x: info.x,
          y: info.y,
          object,
          layerId: info.layer.id,
        });
      }

      const flightId = pickedFlightId(object);
      if (flightId) {
        onSelect(flightId);
      }

      return true;
    },
    [onSelect],
  );

  const handleMoveEnd = useCallback(() => {
    updateViewportBounds();
    if (visibility.weather) setWeatherRefreshKey((value) => value + 1);
  }, [updateViewportBounds, visibility.weather]);

  const retryWebgl = useCallback(() => {
    setWebglStatus(createWebglStatus());
  }, []);

  const handleMapError = useCallback((event: unknown) => {
    const message = getErrorMessage(event);
    if (isWebglFailure(message)) {
      setWebglStatus({
        ok: false,
        message:
          message ||
          "MapLibre could not initialize WebGL. Reload this tab or open a new one, then retry the map.",
      });
      return;
    }

    console.error("[Map] runtime error", event);
  }, []);

  const handleMapLoad = useCallback(() => {
    updateViewportBounds();
    const canvas = mapRef.current?.getMap().getCanvas();
    if (!canvas) return;

    contextLossCleanupRef.current?.();
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      setWebglStatus({
        ok: false,
        message:
          "The browser lost the map WebGL context. Reload this tab or open a new one, then retry the map.",
      });
    };

    canvas.addEventListener("webglcontextlost", handleContextLost, { once: true });
    contextLossCleanupRef.current = () => {
      canvas.removeEventListener("webglcontextlost", handleContextLost);
    };
  }, [updateViewportBounds]);

  useEffect(() => {
    return () => {
      contextLossCleanupRef.current?.();
      contextLossCleanupRef.current = null;
    };
  }, []);

  if (!webglStatus.ok) {
    return (
      <WebglUnavailable
        message={webglStatus.message ?? "WebGL is unavailable."}
        onRetry={retryWebgl}
      />
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <Map
        ref={mapRef}
        mapLib={maplibregl}
        initialViewState={INITIAL_VIEW_STATE}
        mapStyle={mapStyle}
        minZoom={MAP_LIMITS.minZoom}
        maxZoom={MAP_LIMITS.maxZoom}
        maxPitch={MAP_LIMITS.maxPitch}
        renderWorldCopies
        attributionControl={{ compact: true }}
        cooperativeGestures={false}
        onError={handleMapError}
        onLoad={handleMapLoad}
        onMoveEnd={handleMoveEnd}
        style={{ height: "100%", width: "100%" }}
      >
        <DeckOverlay
          layers={deckLayers}
          interleaved={true}
          pickingRadius={12}
          onHover={handleHover}
          onClick={handleClick}
          getCursor={({ isDragging, isHovering }) =>
            isDragging ? "grabbing" : isHovering ? "pointer" : "grab"
          }
        />
        <NavigationControl position="top-left" visualizePitch />
        <FullscreenControl position="top-left" />
        <ScaleControl position="bottom-left" />
      </Map>

      <Tooltip tooltip={tooltip} />
      <LoadingStatus weatherLoading={weatherLoading} restrictionLoading={restrictionLoading} />
      <MapToolbar
        visibility={visibility}
        weatherLoading={weatherLoading}
        restrictionLoading={restrictionLoading}
        onToggle={toggleLayer}
        visible={!(selectedId && isPanelOpen)}
      />
    </div>
  );
}

export default memo(MapView);
