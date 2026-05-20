import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
  ZoomControl,
} from "react-leaflet";
import L from "leaflet";
import { CloudSun, Navigation2, Pause, Play, Satellite, ShieldAlert, Sun, Cloud, CloudLightning, Wind, Eye, Thermometer, Compass, Hash, Loader2, Plane } from "lucide-react";
import type { Flight } from "@/lib/opensky";
import type { AnomalousFlight } from "@/lib/anomaly";
import type { FlightRouteInfo } from "@/lib/enrichment-types";
import type { FlightTrackData, FlightTrackPoint, FlightLayover } from "@/lib/flightTrack";
import { predictFlightState, type PredictedFlightState } from "@/lib/prediction";
import { getAirportCode, getAirportTypeLabel, type Airport } from "@/lib/airports";
import { getSourceColor } from "@/lib/data-sources";
import { calculateGreatCirclePoints } from "@/lib/geo";
import { classifyFlight, getClassInfo } from "@/lib/aircraft-class";
import { satelliteColor, type SatelliteObject } from "@/lib/satellites";
import { gcBearing, gcDistanceKm } from "@/lib/format";
import { fetchBackendJson } from "@/lib/backend-api";


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
  satellites: SatelliteObject[];
  theme: "dark" | "light";
}

type RenderKind = "normal" | "anomaly" | "ground" | "selected";
type PositionedFlight = Flight & { latitude: number; longitude: number };
interface RenderedFlight {
  flight: Flight;
  predicted: PredictedFlightState & { latitude: number; longitude: number };
  kind: RenderKind;
  point: L.Point;
  originPoint: L.Point | null;
}
interface FlightCluster {
  point: L.Point;
  latlng: L.LatLngExpression;
  flights: Flight[];
}
interface TrackRenderSegment {
  id: string;
  points: FlightTrackPoint[];
  positions: Array<[number, number]>;
}
interface RenderLayover extends FlightLayover {
  label: string;
  airportName?: string | null;
  distanceToAirportKm?: number | null;
}

interface WeatherMetar {
  station: string;
  raw: string;
  wind_direction: number | null;
  wind_speed: number | null;
  visibility: number | null;
  ceiling: number | null;
  temperature: number | null;
  flight_category: "VFR" | "MVFR" | "IFR" | "LIFR" | string;
}

interface TfrFeature {
  type: "Feature";
  geometry?: { type: string; coordinates: number[][][] | number[][][][] };
  properties?: Record<string, unknown>;
}

interface WeatherPayload {
  weather?: Record<string, WeatherMetar>;
}

interface TfrPayload {
  features?: TfrFeature[];
}

interface PlaybackPayload {
  positions?: PlaybackPosition[];
}

interface PlaybackPosition {
  timestamp: string;
  latitude: number;
  longitude: number;
  altitude: number | null;
  velocity: number | null;
  heading: number | null;
}

const KIND_PRIORITY: Record<RenderKind, number> = {
  ground: 0,
  normal: 1,
  anomaly: 3,
  selected: 4,
};
const HELICOPTER_PRIORITY = 2;
const FLIGHT_DRAW_BUCKETS = 5;
const FLIGHT_PREDICTION_REDRAW_MS = 1_500;
const FLIGHT_INTERACTION_REDRAW_MS = 120;
const AIRPORT_INDEX_CELL_DEGREES = 5;
const TRACK_CONNECT_MAX_GAP_MS = 25 * 60 * 1000;
const TRACK_CONNECT_MAX_DISTANCE_KM = 800;
const ROUTE_ENDPOINT_MATCH_KM = 45;
const TRACK_MARKER_PANE = "selectedTrackPane";

interface AirportIndex {
  cells: Map<string, Airport[]>;
  lowZoomAirports: Airport[];
}

function normalizeLongitude(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function boundsContainLatLng(bounds: L.LatLngBounds, lat: number, lon: number): boolean {
  if (lat < bounds.getSouth() || lat > bounds.getNorth()) return false;

  const west = bounds.getWest();
  const east = bounds.getEast();
  if (east - west >= 360) return true;

  const normalizedLon = normalizeLongitude(lon);
  const normalizedWest = normalizeLongitude(west);
  const normalizedEast = normalizeLongitude(east);

  if (normalizedWest <= normalizedEast) {
    return normalizedLon >= normalizedWest && normalizedLon <= normalizedEast;
  }

  return normalizedLon >= normalizedWest || normalizedLon <= normalizedEast;
}

function airportCellKey(latIndex: number, lonIndex: number): string {
  return `${latIndex}:${lonIndex}`;
}

function getAirportCellIndexes(airport: Airport): [number, number] {
  return [
    Math.floor((airport.lat + 90) / AIRPORT_INDEX_CELL_DEGREES),
    Math.floor((normalizeLongitude(airport.lon) + 180) / AIRPORT_INDEX_CELL_DEGREES),
  ];
}

function isImportantAirport(airport: Airport): boolean {
  return (
    airport.scheduledService ||
    airport.type === "large_airport" ||
    airport.type === "medium_airport"
  );
}

function shouldRenderAirport(airport: Airport, zoom: number): boolean {
  if (zoom < 3) return airport.type === "large_airport";
  if (zoom < 4) return airport.type === "large_airport" || airport.type === "medium_airport";
  if (zoom < 5) return isImportantAirport(airport);
  if (zoom < 7) return airport.type !== "closed_airport" && isImportantAirport(airport);
  if (zoom < 9) return airport.type !== "closed_airport";
  return true;
}

function buildAirportIndex(airports: Airport[]): AirportIndex {
  const cells = new Map<string, Airport[]>();
  const lowZoomAirports: Airport[] = [];

  for (const airport of airports) {
    if (isImportantAirport(airport)) lowZoomAirports.push(airport);

    const [latIndex, lonIndex] = getAirportCellIndexes(airport);
    const key = airportCellKey(latIndex, lonIndex);
    const bucket = cells.get(key);
    if (bucket) bucket.push(airport);
    else cells.set(key, [airport]);
  }

  lowZoomAirports.sort((a, b) => AIRPORT_PRIORITY[a.type] - AIRPORT_PRIORITY[b.type]);
  return { cells, lowZoomAirports };
}

function getLonCellRanges(bounds: L.LatLngBounds): Array<[number, number]> {
  const west = bounds.getWest();
  const east = bounds.getEast();
  if (east - west >= 360) {
    return [[0, Math.floor(360 / AIRPORT_INDEX_CELL_DEGREES)]];
  }

  const normalizedWest = normalizeLongitude(west);
  const normalizedEast = normalizeLongitude(east);
  const toIndex = (lon: number) =>
    Math.floor((normalizeLongitude(lon) + 180) / AIRPORT_INDEX_CELL_DEGREES);

  if (normalizedWest <= normalizedEast) {
    return [[toIndex(normalizedWest), toIndex(normalizedEast)]];
  }

  return [
    [toIndex(normalizedWest), Math.floor(360 / AIRPORT_INDEX_CELL_DEGREES)],
    [0, toIndex(normalizedEast)],
  ];
}

function getAirportCandidates(
  index: AirportIndex,
  bounds: L.LatLngBounds,
  zoom: number,
): Airport[] {
  if (zoom < 5) {
    return index.lowZoomAirports.filter((airport) =>
      boundsContainLatLng(bounds, airport.lat, airport.lon),
    );
  }

  const southIndex = Math.max(
    0,
    Math.floor((Math.max(-90, bounds.getSouth()) + 90) / AIRPORT_INDEX_CELL_DEGREES),
  );
  const northIndex = Math.min(
    Math.floor(180 / AIRPORT_INDEX_CELL_DEGREES),
    Math.floor((Math.min(90, bounds.getNorth()) + 90) / AIRPORT_INDEX_CELL_DEGREES),
  );
  const lonRanges = getLonCellRanges(bounds);
  const candidates: Airport[] = [];

  for (let latIndex = southIndex; latIndex <= northIndex; latIndex += 1) {
    for (const [lonStart, lonEnd] of lonRanges) {
      for (let lonIndex = lonStart; lonIndex <= lonEnd; lonIndex += 1) {
        const bucket = index.cells.get(airportCellKey(latIndex, lonIndex));
        if (bucket) candidates.push(...bucket);
      }
    }
  }

  return candidates.filter(
    (airport) =>
      shouldRenderAirport(airport, zoom) && boundsContainLatLng(bounds, airport.lat, airport.lon),
  );
}

function hasPosition(flight: Flight): flight is PositionedFlight {
  return flight.latitude !== null && flight.longitude !== null;
}

function hasPredictedPosition(
  predicted: PredictedFlightState,
): predicted is PredictedFlightState & { latitude: number; longitude: number } {
  return predicted.latitude !== null && predicted.longitude !== null;
}

function trackPointTimeMs(point: FlightTrackPoint): number {
  const ms = Date.parse(point.time);
  return Number.isFinite(ms) ? ms : 0;
}

function trackDistanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function findNearestAirportToPoint(
  airports: Airport[],
  lat: number,
  lon: number,
  maxDistanceKm = 100,
): { airport: Airport; distanceKm: number } | null {
  let best: { airport: Airport; distanceKm: number } | null = null;
  for (const airport of airports) {
    if (airport.type === "closed_airport") continue;
    const distanceKm = trackDistanceKm({ lat, lon }, { lat: airport.lat, lon: airport.lon });
    if (distanceKm > maxDistanceKm) continue;
    if (!best || distanceKm < best.distanceKm) best = { airport, distanceKm };
  }
  return best;
}

function livePointFromFlight(flight: Flight | null | undefined): FlightTrackPoint | null {
  if (!flight) return null;
  const predicted = predictFlightState(flight);
  if (!hasPredictedPosition(predicted)) return null;
  if (!Number.isFinite(predicted.latitude) || !Number.isFinite(predicted.longitude)) return null;

  return {
    lat: predicted.latitude,
    lon: predicted.longitude,
    alt: predicted.baroAltitude ?? predicted.geoAltitude ?? null,
    speed: flight.velocity ?? null,
    heading: flight.true_track ?? null,
    time: new Date(
      ((flight.time_position ?? flight.last_contact) || Date.now() / 1000) * 1000,
    ).toISOString(),
    onGround: flight.on_ground,
  };
}

function livePointFromPredictedFlight(
  flight: Flight | null | undefined,
  predicted: PredictedFlightState,
): FlightTrackPoint | null {
  if (!flight || !hasPredictedPosition(predicted)) return null;
  if (!Number.isFinite(predicted.latitude) || !Number.isFinite(predicted.longitude)) return null;

  return {
    lat: predicted.latitude,
    lon: predicted.longitude,
    alt: predicted.baroAltitude ?? predicted.geoAltitude ?? null,
    speed: flight.velocity ?? null,
    heading: flight.true_track ?? null,
    time: new Date(Date.now()).toISOString(),
    onGround: flight.on_ground,
  };
}

function canConnectTrackPoints(a: FlightTrackPoint, b: FlightTrackPoint): boolean {
  const gapMs = Math.abs(trackPointTimeMs(b) - trackPointTimeMs(a));
  return (
    gapMs <= TRACK_CONNECT_MAX_GAP_MS && trackDistanceKm(a, b) <= TRACK_CONNECT_MAX_DISTANCE_KM
  );
}

function positionsAreNear(
  a: [number, number] | null,
  b: [number, number] | null,
  maxDistanceKm = ROUTE_ENDPOINT_MATCH_KM,
): boolean {
  if (!a || !b) return false;
  return trackDistanceKm({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) <= maxDistanceKm;
}

function isHelicopter(flight: Flight): boolean {
  return flight.category === 8;
}

function isPriorityFlight(flight: Flight, kind: RenderKind): boolean {
  return kind === "selected" || kind === "anomaly" || isHelicopter(flight);
}

function flightBucketPriority(flight: Flight, kind: RenderKind): number {
  if (kind === "selected" || kind === "anomaly") return KIND_PRIORITY[kind];
  if (isHelicopter(flight)) return HELICOPTER_PRIORITY;
  return KIND_PRIORITY[kind];
}

function flightDeclutterCellSize(zoom: number): number {
  if (zoom < 2.5) return 46;
  if (zoom < 3.5) return 38;
  if (zoom < 4.5) return 30;
  if (zoom < 5.5) return 22;
  return 0;
}

function flightRenderScore(flight: Flight, kind: RenderKind): number {
  if (kind === "selected") return 10_000;
  if (kind === "anomaly") return 9_000;
  if (isHelicopter(flight)) return 8_000;

  const altitude = flight.baro_altitude ?? flight.geo_altitude ?? 0;
  const speed = flight.velocity ?? 0;
  const airborneScore = flight.on_ground ? 0 : 900;
  return airborneScore + altitude * 0.03 + speed * 2;
}

function getKind(
  flight: Flight,
  anomalyMap: Map<string, AnomalousFlight>,
  selectedId: string | null,
): RenderKind {
  if (selectedId === flight.icao24) return "selected";
  if (anomalyMap.has(flight.icao24)) return "anomaly";
  if (flight.on_ground) return "ground";
  return "normal";
}

const MAP_COLORS = {
  activeAircraft: "#00e5ff",
  selectedAircraft: "#3b82f6", // tailwind blue-500
  anomalyAircraft: "#f59e0b", // tailwind amber-500
  groundAircraft: "#52525b", // tailwind zinc-600
  helicopterAircraft: "#06b6d4", // tailwind cyan-500
  selectedRing: "rgba(59, 130, 246, 0.82)", // blue-500
  anomalyRing: "rgba(245, 158, 11, 0.62)", // amber-500
  trackHalo: "rgba(9, 9, 11, 0.78)", // zinc-950
  trackGlow: "#60a5fa", // blue-400
  trackCore: "#3b82f6", // blue-500
  trackCurrent: "#60a5fa",
  routeDash: "rgba(161, 161, 170, 0.58)", // zinc-400
  routeEndpoint: "#facc15", // yellow-400
  airportLarge: "rgba(168, 130, 200, 0.7)",
  airportMedium: "rgba(130, 150, 200, 0.6)",
  airportSmall: "rgba(140, 140, 140, 0.45)",
  airportHeliport: "rgba(200, 100, 100, 0.5)",
  airportSeaplane: "rgba(80, 180, 160, 0.5)",
  airportClosed: "rgba(80, 90, 100, 0.25)",
  airportOther: "rgba(160, 160, 160, 0.35)",
} as const;

function aircraftColor(flight: Flight, kind: RenderKind): string {
  if (kind === "selected") return MAP_COLORS.selectedAircraft;
  if (kind === "anomaly") return MAP_COLORS.anomalyAircraft;
  const cls = classifyFlight(flight);
  const info = getClassInfo(cls);
  return info.color;
}

function routeAirportCode(airport: FlightRouteInfo["origin"]): string | null {
  if (!airport) return null;
  return airport.iataCode || airport.icaoCode || null;
}

const aircraftPath = new Path2D(
  "M0 -14 L2.4 -8.5 L2.2 -3.6 L10.8 1.6 L10.8 4.8 L2 3.2 L1.8 8.2 L5.1 11.2 L5.1 13.2 L0 11.4 L-5.1 13.2 L-5.1 11.2 L-1.8 8.2 L-2 3.2 L-10.8 4.8 L-10.8 1.6 L-2.2 -3.6 L-2.4 -8.5 Z",
);

const helicopterPath = new Path2D(
  "M60.64 28.1a1.24 1.24 0 0 0-1.27-1.22l-14.89-.33c.61-.91 1.51-2.05 2.78-3.57 6.16-7.36 4.19-9.8 4.19-9.8s-2.28-2-9.91 3.84c-1.31 1-2.34 1.76-3.19 2.31l.3-14.09a1.19 1.19 0 1 0-2.38 0l-.34 15.33c-2 .44-3-1.25-7.33-3.31 0 0-2.34.91-2.86 2.77a39.41 39.41 0 0 1 3.39 6.24l-14.5-.31a1.2 1.2 0 1 0-.05 2.39l14.6.31a1.28 1.28 0 0 0 .35.59l-9.69 12.36-4.57-3.24.54-1.25S12 39.7 11.5 41.34l-.14 2 1.37-.48.41-1.31L16 45.91s-.79.9-.24 1.47 1.55-.1 1.55-.1l4.35 3.1-1.32.35-.54 1.35h2c1.65-.39 4.4-4.13 4.4-4.13l-1.28.49-3-4.71 12.81-9.15a1.31 1.31 0 0 0 1 .45l-.32 15a1.19 1.19 0 1 0 2.38 0l.21-14.8a42.17 42.17 0 0 1 5.67 3.47c1.88-.44 2.87-2.75 2.87-2.75-1.71-4.1-3.24-5.34-3.09-7l15.87.34a1.25 1.25 0 0 0 1.32-1.19Z",
);

const satellitePath = new Path2D(
  "M-8 -1 L-8 1 L-3 1 L-3 3 L-1 3 L-1 8 L1 8 L1 3 L3 3 L3 1 L8 1 L8 -1 L3 -1 L3 -3 L1 -3 L1 -8 L-1 -8 L-1 -3 L-3 -3 L-3 -1 Z",
);

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string | null | undefined,
  x: number,
  y: number,
  color: string,
) {
  const safeText = text || "Unknown";
  ctx.save();
  ctx.font = "600 10px Inter, ui-sans-serif, system-ui, sans-serif";
  const width = Math.ceil(ctx.measureText(safeText).width) + 12;
  ctx.fillStyle = "rgba(9, 9, 11, 0.9)"; // zinc-950
  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 1;
  ctx.fillRect(x + 9, y - 18, width, 18);
  ctx.strokeRect(x + 9, y - 18, width, 18);
  ctx.fillStyle = color;
  ctx.fillText(safeText, x + 15, y - 5);
  ctx.restore();
}

function drawAircraft(
  ctx: CanvasRenderingContext2D,
  flight: Flight,
  predicted: PredictedFlightState,
  kind: RenderKind,
  point: L.Point,
  zoom: number,
) {
  const color = aircraftColor(flight, kind);
  const stale = predicted.confidence === "stale";
  const lowConfidence = predicted.confidence === "low";
  const alpha =
    stale && kind !== "selected" ? 0.36 : lowConfidence && kind !== "selected" ? 0.58 : 1;
  const heading = ((flight.true_track ?? 0) * Math.PI) / 180;
  const helicopter = isHelicopter(flight);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(point.x, point.y);

  if (kind === "selected") {
    ctx.strokeStyle = "rgba(248, 250, 252, 0.4)";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(0, 0, 24, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = MAP_COLORS.selectedRing;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, 0, 15, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === "anomaly") {
    ctx.strokeStyle = MAP_COLORS.anomalyRing;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(0, 0, 12, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (helicopter && kind !== "selected" && kind !== "anomaly") {
    ctx.strokeStyle = "rgba(6, 182, 212, 0.48)"; // cyan-500
    ctx.lineWidth = zoom < 4 ? 1.4 : 1.1;
    ctx.beginPath();
    ctx.arc(0, 0, zoom < 4 ? 15 : 12, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (kind === "ground" && !helicopter) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, zoom < 5 ? 2.5 : 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  const heliSize = kind === "selected" ? 14 : kind === "anomaly" ? 12 : zoom < 4 ? 10.5 : 8.5;
  ctx.rotate(heading);
  const cls = classifyFlight(flight);
  const clsInfo = getClassInfo(cls);
  ctx.shadowColor = kind === "anomaly" ? "rgba(245, 158, 11, 0.48)" : clsInfo.glowColor;
  ctx.shadowBlur = kind === "selected" || kind === "anomaly" || helicopter ? 6 : 3;
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(9, 9, 11, 0.82)"; // zinc-950
  ctx.lineWidth = 1;

  if (helicopter) {
    ctx.save();
    ctx.rotate(-Math.PI / 2);
    const iconScale = heliSize / 33;
    ctx.scale(iconScale, iconScale);
    ctx.translate(-36, -28);
    ctx.fill(helicopterPath);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.8 / iconScale;
    ctx.strokeStyle = "rgba(250, 250, 250, 0.92)"; // zinc-50
    ctx.stroke(helicopterPath);
    ctx.restore();
  } else if (kind === "selected") {
    ctx.fill(aircraftPath);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "rgba(250, 250, 250, 0.92)";
    ctx.stroke(aircraftPath);
  } else {
    const iconScale = kind === "anomaly" ? 0.62 : 0.5;
    ctx.save();
    ctx.scale(iconScale, iconScale);
    ctx.fill(aircraftPath);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.2 / iconScale;
    ctx.stroke(aircraftPath);
    ctx.restore();
  }
  ctx.restore();

  if (kind === "selected" || helicopter || (kind === "anomaly" && zoom >= 4.5)) {
    drawLabel(ctx, flight.callsign?.trim() || flight.icao24.toUpperCase(), point.x, point.y, color);
  }
}

function drawPredictionTrack(ctx: CanvasRenderingContext2D, item: RenderedFlight, zoom: number) {
  if (
    !item.originPoint ||
    !item.predicted.isPredicted ||
    item.originPoint.distanceTo(item.point) < 3
  )
    return;
  if (zoom < 5 && !isPriorityFlight(item.flight, item.kind)) return;

  const color = aircraftColor(item.flight, item.kind);
  ctx.save();
  ctx.globalAlpha = item.kind === "selected" ? 0.72 : 0.32;
  ctx.strokeStyle = color;
  ctx.lineWidth = item.kind === "selected" ? 1.4 : 1;
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.moveTo(item.originPoint.x, item.originPoint.y);
  ctx.lineTo(item.point.x, item.point.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = item.kind === "selected" ? 0.8 : 0.22;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(item.originPoint.x, item.originPoint.y, item.kind === "selected" ? 3 : 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawCluster(ctx: CanvasRenderingContext2D, cluster: FlightCluster) {
  const count = cluster.flights.length;
  const color = count > 50 ? "#f43f5e" : count >= 10 ? "#f59e0b" : "#10b981"; // rose, amber, emerald
  ctx.save();
  ctx.translate(cluster.point.x, cluster.point.y);
  ctx.fillStyle = "rgba(9, 9, 11, 0.9)"; // zinc-950
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, count > 50 ? 22 : count >= 10 ? 18 : 15, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#f8fafc"; // slate-50
  ctx.font = "800 11px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(count.toString(), 0, 0);
  ctx.restore();
}

interface FlightCanvasLayerProps {
  flights: Flight[];
  anomalyMap: Map<string, AnomalousFlight>;
  selectedId: string | null;
  onSelect: (icao24: string | null) => void;
  showClustering: boolean;
}

function FlightCanvasLayer({ flights, anomalyMap, selectedId, onSelect, showClustering }: FlightCanvasLayerProps) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const lastDrawAtRef = useRef(0);
  const throttleTimerRef = useRef<number | null>(null);
  const clustersRef = useRef<FlightCluster[]>([]);
  const propsRef = useRef({ flights, anomalyMap, selectedId, showClustering });
  propsRef.current = { flights, anomalyMap, selectedId, showClustering };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const size = map.getSize();
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (canvas.width !== size.x * ratio || canvas.height !== size.y * ratio) {
      canvas.width = size.x * ratio;
      canvas.height = size.y * ratio;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }

    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    if (size.x < 1 || size.y < 1) return;

    const {
      flights: currentFlights,
      anomalyMap: currentAnomalyMap,
      selectedId: currentSelectedId,
      showClustering: currentShowClustering,
    } = propsRef.current;
    const bounds = map.getBounds().pad(0.08);
    const prefilterBounds = map.getBounds().pad(0.22);
    const zoom = map.getZoom();
    const nowSeconds = Date.now() / 1000;
    const drawBuckets: RenderedFlight[][] = Array.from({ length: FLIGHT_DRAW_BUCKETS }, () => []);
    const declutterCellSize = flightDeclutterCellSize(zoom);
    const sampledFlights = new Map<string, RenderedFlight>();
    const clusterCells = new Map<string, RenderedFlight[]>();

    for (const flight of currentFlights) {
      const isSelected = currentSelectedId === flight.icao24;
      if (
        !isSelected &&
        hasPosition(flight) &&
        !boundsContainLatLng(prefilterBounds, flight.latitude, flight.longitude)
      ) {
        continue;
      }

      const predicted = predictFlightState(flight, nowSeconds);
      if (
        !hasPredictedPosition(predicted) ||
        !Number.isFinite(predicted.latitude) ||
        !Number.isFinite(predicted.longitude) ||
        !boundsContainLatLng(bounds, predicted.latitude, predicted.longitude)
      ) {
        continue;
      }

      const kind = getKind(flight, currentAnomalyMap, currentSelectedId);
      const originPoint = hasPosition(flight)
        ? map.latLngToContainerPoint([flight.latitude, flight.longitude])
        : null;
      const point = map.latLngToContainerPoint([predicted.latitude, predicted.longitude]);
      const renderedFlight: RenderedFlight = {
        flight,
        predicted,
        kind,
        point,
        originPoint,
      };

      if (currentShowClustering && zoom <= 10 && kind !== "selected" && kind !== "anomaly") {
        const key = `${Math.floor(point.x / 40)}:${Math.floor(point.y / 40)}`;
        const bucket = clusterCells.get(key) ?? [];
        bucket.push(renderedFlight);
        clusterCells.set(key, bucket);
        continue;
      }

      if (declutterCellSize > 0 && !isPriorityFlight(flight, kind)) {
        if (kind === "ground" && zoom < 4.5) continue;

        const cellKey = `${Math.floor(point.x / declutterCellSize)}:${Math.floor(
          point.y / declutterCellSize,
        )}`;
        const existing = sampledFlights.get(cellKey);
        if (
          !existing ||
          flightRenderScore(renderedFlight.flight, renderedFlight.kind) >
          flightRenderScore(existing.flight, existing.kind)
        ) {
          sampledFlights.set(cellKey, renderedFlight);
        }
        continue;
      }

      drawBuckets[flightBucketPriority(flight, kind)].push(renderedFlight);
    }

    for (const item of sampledFlights.values()) {
      drawBuckets[flightBucketPriority(item.flight, item.kind)].push(item);
    }

    const clusters: FlightCluster[] = [];
    for (const bucket of clusterCells.values()) {
      if (bucket.length < 2) {
        const item = bucket[0];
        if (item) drawBuckets[flightBucketPriority(item.flight, item.kind)].push(item);
        continue;
      }
      const x = bucket.reduce((sum, item) => sum + item.point.x, 0) / bucket.length;
      const y = bucket.reduce((sum, item) => sum + item.point.y, 0) / bucket.length;
      clusters.push({
        point: L.point(x, y),
        latlng: map.containerPointToLatLng([x, y]),
        flights: bucket.map((item) => item.flight),
      });
    }
    clustersRef.current = clusters;

    for (const bucket of drawBuckets) {
      for (const item of bucket) drawPredictionTrack(ctx, item, zoom);
    }

    for (const bucket of drawBuckets) {
      for (const item of bucket) {
        drawAircraft(ctx, item.flight, item.predicted, item.kind, item.point, zoom);
      }
    }

    for (const cluster of clusters) drawCluster(ctx, cluster);
  }, [map]);

  const scheduleDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      lastDrawAtRef.current = performance.now();
      draw();
    });
  }, [draw]);

  const scheduleInteractionDraw = useCallback(() => {
    const elapsed = performance.now() - lastDrawAtRef.current;
    if (elapsed >= FLIGHT_INTERACTION_REDRAW_MS) {
      scheduleDraw();
      return;
    }

    if (throttleTimerRef.current !== null) return;
    throttleTimerRef.current = window.setTimeout(() => {
      throttleTimerRef.current = null;
      scheduleDraw();
    }, FLIGHT_INTERACTION_REDRAW_MS - elapsed);
  }, [scheduleDraw]);

  const findNearestFlight = useCallback(
    (containerPoint: L.Point): Flight | null => {
      const {
        flights: currentFlights,
        anomalyMap: currentAnomalyMap,
        selectedId: currentSelectedId,
      } = propsRef.current;
      const bounds = map.getBounds().pad(0.04);
      const nowSeconds = Date.now() / 1000;
      let best: { flight: Flight; distance: number } | null = null;

      for (const flight of currentFlights) {
        const predicted = predictFlightState(flight, nowSeconds);
        if (
          !hasPredictedPosition(predicted) ||
          !boundsContainLatLng(bounds, predicted.latitude, predicted.longitude)
        ) {
          continue;
        }

        const kind = getKind(flight, currentAnomalyMap, currentSelectedId);
        const radius =
          kind === "selected" || kind === "anomaly"
            ? 18
            : isHelicopter(flight)
              ? 18
              : flight.on_ground
                ? 10
                : 13;
        const point = map.latLngToContainerPoint([predicted.latitude, predicted.longitude]);
        const distance = point.distanceTo(containerPoint);
        if (distance <= radius && (!best || distance < best.distance)) {
          best = { flight, distance };
        }
      }

      return best?.flight ?? null;
    },
    [map],
  );

  useEffect(() => {
    const canvas = L.DomUtil.create(
      "canvas",
      "leaflet-zoom-animated", // Only leaflet native classes
    ) as HTMLCanvasElement;
    canvasRef.current = canvas;
    map.getPanes().overlayPane.appendChild(canvas);

    const handlers = {
      move: scheduleInteractionDraw,
      zoom: scheduleInteractionDraw,
      resize: scheduleDraw,
      moveend: scheduleDraw,
      zoomend: scheduleDraw,
    };
    map.on(handlers);
    scheduleDraw();

    intervalRef.current = window.setInterval(() => {
      if (document.visibilityState !== "hidden") {
        scheduleDraw();
      }
    }, FLIGHT_PREDICTION_REDRAW_MS);

    return () => {
      map.off(handlers);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (throttleTimerRef.current !== null) {
        window.clearTimeout(throttleTimerRef.current);
        throttleTimerRef.current = null;
      }
      canvas.remove();
      canvasRef.current = null;
    };
  }, [map, scheduleDraw, scheduleInteractionDraw]);

  useEffect(() => {
    scheduleDraw();
  }, [flights, anomalyMap, selectedId, showClustering, scheduleDraw]);

  useEffect(() => {
    const handleClick = (event: L.LeafletMouseEvent) => {
      const cluster = clustersRef.current.find(
        (item) => item.point.distanceTo(event.containerPoint) <= 24,
      );
      if (cluster) {
        map.setView(cluster.latlng, Math.min(11, map.getZoom() + 2), { animate: true });
        return;
      }
      const flight = findNearestFlight(event.containerPoint);
      onSelect(flight ? flight.icao24 : null);
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
  }, [findNearestFlight, map, onSelect]);

  return null;
}

function FlyTo({ focus }: { focus: MapViewProps["focus"] }) {
  const map = useMap();
  const lastId = useRef<string | null>(null);

  useEffect(() => {
    if (focus && focus.id !== lastId.current) {
      lastId.current = focus.id;
      map.flyTo([focus.lat, focus.lng], focus.zoom ?? Math.max(map.getZoom(), 6), {
        duration: 0.9,
      });
    }
  }, [focus, map]);

  return null;
}

const SATELLITE_PANE = "satelliteCanvasPane";
const SATELLITE_PRIORITY: Record<string, number> = {
  starlink: 0,
  oneweb: 0,
  earth_resources: 1,
  weather: 2,
  navigation: 2,
  galileo: 2,
  beidou: 2,
  visual: 3,
  stations: 4,
};

function satelliteFootprintRadiusPx(
  map: L.Map,
  satellite: SatelliteObject,
  point: L.Point,
  zoom: number,
): number {
  const altitudeKm = satellite.altitudeKm;
  if (!altitudeKm || altitudeKm <= 0 || zoom < 3) return 0;

  const earthRadiusKm = 6371;
  const centralAngle = Math.acos(earthRadiusKm / (earthRadiusKm + altitudeKm));
  const groundRadiusKm = earthRadiusKm * centralAngle;
  const latDelta = Math.min(70, groundRadiusKm / 111.32);
  const edgeLat = Math.max(-85, Math.min(85, satellite.latitude + latDelta));
  const edgePoint = map.latLngToContainerPoint([edgeLat, satellite.longitude]);
  return Math.max(0, Math.min(point.distanceTo(edgePoint), zoom >= 5 ? 180 : 92));
}

function SatelliteCanvasLayer({ satellites }: { satellites: SatelliteObject[] }) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const propsRef = useRef({ satellites });
  propsRef.current = { satellites };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const size = map.getSize();
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (canvas.width !== size.x * ratio || canvas.height !== size.y * ratio) {
      canvas.width = size.x * ratio;
      canvas.height = size.y * ratio;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }

    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    const bounds = map.getBounds().pad(0.08);
    const zoom = map.getZoom();
    const declutterCell = zoom < 3 ? 42 : zoom < 4 ? 30 : 0;
    const sampled = new Map<string, SatelliteObject>();
    const visible: SatelliteObject[] = [];

    for (const satellite of propsRef.current.satellites) {
      if (!boundsContainLatLng(bounds, satellite.latitude, satellite.longitude)) continue;

      if (declutterCell > 0) {
        const point = map.latLngToContainerPoint([satellite.latitude, satellite.longitude]);
        const key = `${Math.floor(point.x / declutterCell)}:${Math.floor(point.y / declutterCell)}`;
        const existing = sampled.get(key);
        const score = SATELLITE_PRIORITY[satellite.group] ?? 1;
        const existingScore = existing ? (SATELLITE_PRIORITY[existing.group] ?? 1) : -1;
        if (!existing || score > existingScore) sampled.set(key, satellite);
        continue;
      }

      visible.push(satellite);
    }

    visible.push(...sampled.values());
    visible.sort((a, b) => (SATELLITE_PRIORITY[a.group] ?? 1) - (SATELLITE_PRIORITY[b.group] ?? 1));

    let labels = 0;
    for (const satellite of visible) {
      const point = map.latLngToContainerPoint([satellite.latitude, satellite.longitude]);
      const color = satelliteColor(satellite.group);
      const priority = SATELLITE_PRIORITY[satellite.group] ?? 1;
      const radius = satellite.group === "stations" ? 3.2 : priority >= 3 ? 2.4 : 1.8;
      const footprint = satelliteFootprintRadiusPx(map, satellite, point, zoom);

      ctx.save();
      if (footprint > 8 && priority >= 2) {
        ctx.globalAlpha = satellite.group === "stations" ? 0.08 : 0.04;
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.8;
        ctx.setLineDash([5, 7]);
        ctx.beginPath();
        ctx.arc(point.x, point.y, footprint, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.globalAlpha = satellite.orbitQuality === "stale" ? 0.18 : 0.38;
      ctx.translate(point.x, point.y);

      // Draw satellite icon
      const iconScale = radius / 4;
      ctx.save();
      ctx.scale(iconScale, iconScale);
      ctx.shadowColor = color;
      ctx.shadowBlur = (priority >= 3 ? 4 : 2) / iconScale;
      ctx.fillStyle = color;
      ctx.fill(satellitePath);
      ctx.strokeStyle = "rgba(9, 9, 11, 0.82)"; // zinc-950
      ctx.lineWidth = 1.5 / iconScale;
      ctx.stroke(satellitePath);
      ctx.restore();

      ctx.restore();

      const shouldLabel =
        zoom >= 5.5 &&
        labels < 40 &&
        (priority >= 4 || (zoom >= 7 && satellite.group !== "starlink"));
      if (shouldLabel) {
        labels += 1;
        drawLabel(ctx, satellite.name, point.x, point.y, color);
      }
    }
  }, [map]);

  const scheduleDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    const pane = map.getPane(SATELLITE_PANE) ?? map.createPane(SATELLITE_PANE);
    pane.style.zIndex = "620";
    pane.style.pointerEvents = "none";

    const canvas = L.DomUtil.create(
      "canvas",
      "leaflet-zoom-animated",
    ) as HTMLCanvasElement;
    canvasRef.current = canvas;
    pane.appendChild(canvas);

    const handlers = {
      resize: scheduleDraw,
      move: scheduleDraw,
      zoom: scheduleDraw,
      moveend: scheduleDraw,
      zoomend: scheduleDraw,
    };
    map.on(handlers);
    scheduleDraw();

    return () => {
      map.off(handlers);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      canvas.remove();
      canvasRef.current = null;
    };
  }, [map, scheduleDraw]);

  useEffect(() => {
    scheduleDraw();
  }, [satellites, scheduleDraw]);

  return null;
}

function TrackCanvasLayer({
  selectedId,
  selectedFlight,
  segments,
  routeOriginPos,
  routeDestPos,
  routeOriginLabel,
  routeDestLabel,
  hasValidRoute,
  selectedTrackEnd,
}: {
  selectedId: string | null;
  selectedFlight: Flight | null | undefined;
  segments: TrackRenderSegment[];
  routeOriginPos: [number, number] | null;
  routeDestPos: [number, number] | null;
  routeOriginLabel: string | null;
  routeDestLabel: string | null;
  hasValidRoute: boolean;
  selectedTrackEnd: [number, number] | null;
}) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);

  const propsRef = useRef({
    segments,
    routeOriginPos,
    routeDestPos,
    routeOriginLabel,
    routeDestLabel,
    hasValidRoute,
    selectedTrackEnd,
    selectedId,
    selectedFlight,
  });
  propsRef.current = {
    segments,
    routeOriginPos,
    routeDestPos,
    routeOriginLabel,
    routeDestLabel,
    hasValidRoute,
    selectedTrackEnd,
    selectedId,
    selectedFlight,
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const size = map.getSize();
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (canvas.width !== size.x * ratio || canvas.height !== size.y * ratio) {
      canvas.width = size.x * ratio;
      canvas.height = size.y * ratio;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }

    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    if (size.x < 1 || size.y < 1) return;

    const {
      segments: currentSegments,
      routeOriginPos: orig,
      routeDestPos: dest,
      routeOriginLabel: origLabel,
      routeDestLabel: destLabel,
      hasValidRoute: valid,
      selectedTrackEnd: end,
      selectedId: currentId,
      selectedFlight: currentFlight,
    } = propsRef.current;

    if (!currentId) return;

    const zoom = map.getZoom();
    const trackWidth = zoom >= 7 ? 4.2 : zoom >= 5 ? 3.6 : 3;

    const drawRouteArc = (
      p1: [number, number] | null,
      p2: [number, number] | null,
      alpha: number,
      dashed = true,
      color: string = MAP_COLORS.routeDash,
      width = 2,
    ) => {
      if (!p1 || !p2) return;
      const pts = calculateGreatCirclePoints(p1, p2, zoom >= 5 ? 96 : 56);
      if (pts.length < 2) return;

      ctx.save();
      ctx.beginPath();
      let previous = map.latLngToContainerPoint(pts[0]);
      ctx.moveTo(previous.x, previous.y);
      for (let i = 1; i < pts.length; i++) {
        const p = map.latLngToContainerPoint(pts[i]);
        if (Math.abs(p.x - previous.x) > size.x * 1.5) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
        previous = p;
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha * 0.08;
      ctx.lineWidth = width + 8;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      previous = map.latLngToContainerPoint(pts[0]);
      ctx.moveTo(previous.x, previous.y);
      for (let i = 1; i < pts.length; i++) {
        const p = map.latLngToContainerPoint(pts[i]);
        if (Math.abs(p.x - previous.x) > size.x * 1.5) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
        previous = p;
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.lineCap = "round";
      if (dashed) ctx.setLineDash([10, 10]);
      ctx.stroke();
      ctx.restore();
    };

    const drawTrackPath = (points: FlightTrackPoint[], width: number, color: string, alpha = 1) => {
      if (points.length < 2) return;
      ctx.save();
      ctx.beginPath();
      let previous = map.latLngToContainerPoint([points[0].lat, points[0].lon]);
      ctx.moveTo(previous.x, previous.y);
      for (let i = 1; i < points.length; i++) {
        const p = map.latLngToContainerPoint([points[i].lat, points[i].lon]);
        if (Math.abs(p.x - previous.x) > size.x * 1.5) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
        previous = p;
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.globalAlpha = alpha;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.restore();
    };

    const pointFromPosition = (
      pos: [number, number],
      template?: FlightTrackPoint | null,
    ): FlightTrackPoint => ({
      lat: pos[0],
      lon: pos[1],
      alt: template?.alt ?? null,
      speed: template?.speed ?? null,
      heading: template?.heading ?? null,
      time: template?.time ?? new Date().toISOString(),
      onGround: template?.onGround ?? false,
      dataSource: template?.dataSource ?? "route",
    });

    const predictedLivePoint = currentFlight
      ? livePointFromPredictedFlight(
        currentFlight,
        predictFlightState(currentFlight, Date.now() / 1000),
      )
      : null;
    const dynamicEnd: [number, number] | null = predictedLivePoint
      ? [predictedLivePoint.lat, predictedLivePoint.lon]
      : end;

    if (valid && orig && dest) {
      if (currentSegments.length > 0 && dynamicEnd && !positionsAreNear(dynamicEnd, dest)) {
        drawRouteArc(dynamicEnd, dest, 0.48, true, MAP_COLORS.routeDash, 2.4);
      } else {
        drawRouteArc(orig, dest, 0.34, true, MAP_COLORS.routeDash, 2.2);
      }
    }

    const visualTrackPoints = currentSegments.flatMap((segment) => segment.points);

    if (!valid) {
      return;
    }

    if (valid && orig) {
      const firstPoint = visualTrackPoints[0] ?? predictedLivePoint ?? null;
      if (firstPoint) {
        visualTrackPoints.unshift(pointFromPosition(orig, firstPoint));
      }
    }

    const lastPoint = visualTrackPoints[visualTrackPoints.length - 1] ?? null;
    if (predictedLivePoint) {
      if (!lastPoint || trackDistanceKm(lastPoint, predictedLivePoint) >= 0.02) {
        visualTrackPoints.push(predictedLivePoint);
      }
    }

    if (visualTrackPoints.length >= 2) {
      drawTrackPath(visualTrackPoints, trackWidth + 4.8, MAP_COLORS.trackHalo, 0.62);
      drawTrackPath(visualTrackPoints, trackWidth, MAP_COLORS.trackCore, 0.96);
    }

    const drawMarker = (
      pos: [number, number],
      color: string,
      fill: string,
      radius: number,
      label?: string | null,
    ) => {
      const p = map.latLngToContainerPoint(pos);
      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
      ctx.shadowBlur = 6;
      ctx.fillStyle = fill;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      if (label && zoom >= 4) drawLabel(ctx, label, p.x, p.y, color);
    };

    if (valid && orig) {
      drawMarker(orig, "#facc15", "rgba(9, 9, 11, 0.9)", 4, origLabel);
    }
    if (valid && dest) {
      drawMarker(dest, "#facc15", "rgba(9, 9, 11, 0.9)", 4, destLabel);
    }
  }, [map]);

  const scheduleDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      draw();
    });
  }, [draw]);

  useEffect(() => {
    const pane = map.getPane(TRACK_MARKER_PANE) ?? map.createPane(TRACK_MARKER_PANE);
    pane.style.zIndex = "760";
    pane.style.pointerEvents = "none";

    const canvas = L.DomUtil.create(
      "canvas",
      "leaflet-zoom-animated",
    ) as HTMLCanvasElement;
    canvasRef.current = canvas;
    pane.appendChild(canvas);

    const intervalId = window.setInterval(scheduleDraw, FLIGHT_PREDICTION_REDRAW_MS);
    const handlers = {
      resize: scheduleDraw,
      move: scheduleDraw,
      zoom: scheduleDraw,
    };
    map.on(handlers);
    scheduleDraw();

    return () => {
      map.off(handlers);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      window.clearInterval(intervalId);
      canvas.remove();
      canvasRef.current = null;
    };
  }, [map, scheduleDraw]);

  useEffect(() => {
    scheduleDraw();
  }, [
    segments,
    routeOriginPos,
    routeDestPos,
    routeOriginLabel,
    routeDestLabel,
    hasValidRoute,
    selectedTrackEnd,
    selectedId,
    selectedFlight,
    scheduleDraw,
  ]);

  return null;
}

function TrackAutoFit({
  selectedId,
  segments,
}: {
  selectedId: string | null;
  segments: TrackRenderSegment[];
}) {
  const map = useMap();
  const fittedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedId || fittedIdRef.current === selectedId) return;

    const allPositions = segments.flatMap((segment) => segment.positions);
    if (allPositions.length < 2) return;

    fittedIdRef.current = selectedId;
    map.fitBounds(L.latLngBounds(allPositions), {
      animate: true,
      duration: 0.75,
      maxZoom: 7,
      paddingTopLeft: [90, 100],
      paddingBottomRight: [420, 120],
    });
  }, [map, segments, selectedId]);

  useEffect(() => {
    if (!selectedId) fittedIdRef.current = null;
  }, [selectedId]);

  return null;
}

const AIRPORT_PRIORITY: Record<Airport["type"], number> = {
  large_airport: 6,
  medium_airport: 5,
  small_airport: 4,
  seaplane_base: 3,
  heliport: 2,
  balloonport: 1,
  closed_airport: 0,
};

function airportKey(airport: Airport): string {
  return airport.id?.toString() || airport.ident;
}

function airportColor(airport: Airport): string {
  if (airport.type === "closed_airport") return MAP_COLORS.airportClosed;
  if (airport.type === "large_airport") return MAP_COLORS.airportLarge;
  if (airport.type === "medium_airport") return MAP_COLORS.airportMedium;
  if (airport.type === "small_airport") return MAP_COLORS.airportSmall;
  if (airport.type === "heliport") return MAP_COLORS.airportHeliport;
  if (airport.type === "seaplane_base") return MAP_COLORS.airportSeaplane;
  return MAP_COLORS.airportOther;
}

function airportRadius(airport: Airport, zoom: number): number {
  const base = zoom < 4 ? 6.5 : zoom < 6 ? 7.5 : zoom < 8 ? 8.5 : zoom < 10 ? 10.0 : 11.5;
  if (airport.type === "large_airport") return base + 3.0;
  if (airport.type === "medium_airport") return base + 1.5;
  if (airport.scheduledService) return base + 0.5;
  if (airport.type === "closed_airport") return Math.max(3, base - 2.5);
  return base - 0.5; // small_airport, etc.
}

function shouldLabelAirport(airport: Airport, zoom: number): boolean {
  if (zoom >= 10) return airport.type !== "closed_airport" && airport.scheduledService;
  if (zoom >= 9)
    return (
      airport.scheduledService ||
      airport.type === "large_airport" ||
      airport.type === "medium_airport"
    );
  if (zoom >= 7) return airport.type === "large_airport" || airport.type === "medium_airport";
  return airport.type === "large_airport";
}

function drawAirport(
  ctx: CanvasRenderingContext2D,
  airport: Airport,
  point: L.Point,
  zoom: number,
  selected: boolean,
  isRouteNode: boolean = false,
) {
  const important =
    airport.scheduledService ||
    airport.type === "large_airport" ||
    airport.type === "medium_airport" ||
    isRouteNode;

  if (!important && zoom < 5) return;

  ctx.save();
  ctx.globalAlpha = selected
    ? 0.98
    : isRouteNode
      ? 0.9
      : airport.type === "closed_airport"
        ? 0.28
        : important
          ? 0.72
          : 0.58;

  const color = isRouteNode ? MAP_COLORS.routeEndpoint : airportColor(airport);
  const radius = airportRadius(airport, zoom);
  const size = selected ? radius + 3 : isRouteNode ? radius + 1.5 : radius;

  ctx.translate(point.x, point.y);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // 1. Draw outer selection ring / glow
  if (selected || isRouteNode) {
    ctx.beginPath();
    ctx.arc(0, 0, size + 4.5, 0, Math.PI * 2);
    ctx.strokeStyle = selected ? MAP_COLORS.selectedAircraft : MAP_COLORS.routeEndpoint;
    ctx.lineWidth = selected ? 2.0 : 1.5;
    ctx.globalAlpha = selected ? 0.75 : 0.55;
    ctx.stroke();

    // Add subtle outer glow shadow for selected nodes
    if (selected) {
      ctx.shadowColor = MAP_COLORS.selectedAircraft;
      ctx.shadowBlur = 8;
    }

    ctx.globalAlpha = selected ? 0.98 : 0.9;
  }

  // 2. Draw base circle
  ctx.beginPath();
  ctx.arc(0, 0, size, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "rgba(9, 9, 11, 0.85)";
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Reset shadow for inner icons
  ctx.shadowBlur = 0;

  // 3. Draw white icon on top of the circle
  if (airport.type === "closed_airport") {
    // Draw white 'X'
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = size >= 8 ? 2.0 : 1.4;
    ctx.beginPath();
    const offset = size * 0.42;
    ctx.moveTo(-offset, -offset);
    ctx.lineTo(offset, offset);
    ctx.moveTo(offset, -offset);
    ctx.lineTo(-offset, offset);
    ctx.stroke();
  } else if (airport.type === "heliport") {
    // Draw white 'H'
    ctx.fillStyle = "#ffffff";
    const fontSize = Math.max(7, Math.round(size * 1.1));
    ctx.font = `800 ${fontSize}px Inter, system-ui, -apple-system, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("H", 0, 0);
  } else {
    // Draw airplane silhouette
    ctx.save();
    ctx.fillStyle = "#ffffff";
    // Rotate 45 degrees for northeast direction (airport symbol standard)
    ctx.rotate(45 * Math.PI / 180);

    // Plane path scale based on size
    const s = size * 0.55;
    ctx.beginPath();
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.15, -s * 0.7);
    ctx.lineTo(s * 0.15, -s * 0.2);
    // Wings
    ctx.lineTo(s * 0.85, s * 0.15);
    ctx.lineTo(s * 0.85, s * 0.35);
    ctx.lineTo(s * 0.15, s * 0.15);
    // Tail fuselage
    ctx.lineTo(s * 0.15, s * 0.65);
    // Tail wing
    ctx.lineTo(s * 0.45, s * 0.85);
    ctx.lineTo(s * 0.45, s * 0.95);
    ctx.lineTo(0, s * 0.8);
    ctx.lineTo(-s * 0.45, s * 0.95);
    ctx.lineTo(-s * 0.45, s * 0.85);
    ctx.lineTo(-s * 0.15, s * 0.65);
    // Left wing
    ctx.lineTo(-s * 0.15, s * 0.15);
    ctx.lineTo(-s * 0.85, s * 0.35);
    ctx.lineTo(-s * 0.85, s * 0.15);
    ctx.lineTo(-s * 0.15, -s * 0.2);
    ctx.lineTo(-s * 0.15, -s * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.restore();
}

function AirportCanvasLayer({
  airports,
  selectedAirport,
  onSelectAirport,
  routeAirports = [],
}: {
  airports: Airport[];
  selectedAirport: Airport | null;
  onSelectAirport: (airport: Airport | null) => void;
  routeAirports?: Airport[];
}) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const airportIndex = useMemo(() => buildAirportIndex(airports), [airports]);
  const propsRef = useRef({ airportIndex, selectedAirport, routeAirports });
  propsRef.current = { airportIndex, selectedAirport, routeAirports };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const size = map.getSize();
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (canvas.width !== size.x * ratio || canvas.height !== size.y * ratio) {
      canvas.width = size.x * ratio;
      canvas.height = size.y * ratio;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
    }

    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    if (size.x < 1 || size.y < 1) return;

    const bounds = map.getBounds().pad(0.08);
    const zoom = map.getZoom();
    const selectedKey = propsRef.current.selectedAirport
      ? airportKey(propsRef.current.selectedAirport)
      : null;
    const visibleAirports = getAirportCandidates(propsRef.current.airportIndex, bounds, zoom);
    if (zoom >= 5) {
      visibleAirports.sort((a, b) => AIRPORT_PRIORITY[a.type] - AIRPORT_PRIORITY[b.type]);
    }

    let labelsDrawn = 0;
    const labelLimit = zoom >= 9 ? 180 : zoom >= 7 ? 90 : zoom >= 4 ? 44 : 10;

    const routeAirportKeys = new Set(propsRef.current.routeAirports.map(airportKey));
    const visibleKeys = new Set(visibleAirports.map(airportKey));
    for (const ra of propsRef.current.routeAirports) {
      if (!visibleKeys.has(airportKey(ra))) {
        visibleAirports.push(ra);
      }
    }

    for (const airport of visibleAirports) {
      const point = map.latLngToContainerPoint([airport.lat, airport.lon]);
      const selected = selectedKey === airportKey(airport);
      const isRouteNode = routeAirportKeys.has(airportKey(airport));
      drawAirport(ctx, airport, point, zoom, selected, isRouteNode);

      if (
        (selected || isRouteNode || shouldLabelAirport(airport, zoom)) &&
        labelsDrawn < labelLimit
      ) {
        labelsDrawn += 1;
        drawLabel(
          ctx,
          getAirportCode(airport),
          point.x,
          point.y,
          selected
            ? MAP_COLORS.selectedAircraft
            : isRouteNode
              ? MAP_COLORS.routeEndpoint
              : airportColor(airport),
        );
      }
    }
  }, [map]);

  const scheduleDraw = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      draw();
    });
  }, [draw]);

  const findNearestAirport = useCallback(
    (containerPoint: L.Point): Airport | null => {
      const bounds = map.getBounds().pad(0.04);
      const zoom = map.getZoom();
      let best: { airport: Airport; score: number } | null = null;

      for (const airport of getAirportCandidates(propsRef.current.airportIndex, bounds, zoom)) {
        const point = map.latLngToContainerPoint([airport.lat, airport.lon]);
        const distance = point.distanceTo(containerPoint);
        const hitRadius = Math.max(airportRadius(airport, zoom) + 5, zoom < 5 ? 6 : 9);
        if (distance > hitRadius) continue;

        const score =
          AIRPORT_PRIORITY[airport.type] * 10 + (airport.scheduledService ? 4 : 0) - distance;
        if (!best || score > best.score) best = { airport, score };
      }

      return best?.airport ?? null;
    },
    [map],
  );

  useEffect(() => {
    const airportPane = map.getPane("airportCanvasPane") ?? map.createPane("airportCanvasPane");
    airportPane.style.zIndex = "390";
    airportPane.style.pointerEvents = "none";

    const canvas = L.DomUtil.create(
      "canvas",
      "leaflet-zoom-animated",
    ) as HTMLCanvasElement;
    canvasRef.current = canvas;
    airportPane.appendChild(canvas);

    const handlers = {
      resize: scheduleDraw,
      moveend: scheduleDraw,
      zoomend: scheduleDraw,
    };
    map.on(handlers);
    scheduleDraw();

    return () => {
      map.off(handlers);
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      canvas.remove();
      canvasRef.current = null;
    };
  }, [map, scheduleDraw]);

  useEffect(() => {
    scheduleDraw();
  }, [airportIndex, selectedAirport, routeAirports, scheduleDraw]);

  useEffect(() => {
    const handleClick = (event: L.LeafletMouseEvent) => {
      onSelectAirport(findNearestAirport(event.containerPoint));
    };

    map.on("click", handleClick);
    return () => {
      map.off("click", handleClick);
    };
  }, [findNearestAirport, map, onSelectAirport]);

  return null;
}

function MapToolbar({
  predictions,
  weather,
  tfr,
  satellites,
  clustering,
  airports,
  weatherLoading,
  tfrLoading,
  onTogglePredictions,
  onToggleWeather,
  onToggleTfr,
  onToggleSatellites,
  onToggleClustering,
  onToggleAirports,
}: {
  predictions: boolean;
  weather: boolean;
  tfr: boolean;
  satellites: boolean;
  clustering: boolean;
  airports: boolean;
  weatherLoading?: boolean;
  tfrLoading?: boolean;
  onTogglePredictions: () => void;
  onToggleWeather: () => void;
  onToggleTfr: () => void;
  onToggleSatellites: () => void;
  onToggleClustering: () => void;
  onToggleAirports: () => void;
}) {
  return (
    <div className="sw-map-toolbar absolute top-[165px] left-3 z-[1000] flex flex-col gap-1.5 bg-zinc-950/80 backdrop-blur-xl border border-white/10 p-1.5 rounded-xl shadow-xl">
      <button
        type="button"
        className={`p-2 rounded-lg transition-colors ${predictions ? "bg-blue-500/20 text-blue-400" : "text-zinc-400 hover:text-white hover:bg-white/10"}`}
        onClick={onTogglePredictions}
        title="Toggle predicted paths"
      >
        <Navigation2 className="w-4 h-4" />
      </button>
      <button
        type="button"
        className={`p-2 rounded-lg transition-colors ${weather ? "bg-blue-500/20 text-blue-400" : "text-zinc-400 hover:text-white hover:bg-white/10"}`}
        onClick={onToggleWeather}
        title="Toggle weather layer"
      >
        {weatherLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
        ) : (
          <CloudSun className="w-4 h-4" />
        )}
      </button>
      <button
        type="button"
        className={`p-2 rounded-lg transition-colors ${tfr ? "bg-blue-500/20 text-blue-400" : "text-zinc-400 hover:text-white hover:bg-white/10"}`}
        onClick={onToggleTfr}
        title="Toggle TFR layer"
      >
        {tfrLoading ? (
          <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
        ) : (
          <ShieldAlert className="w-4 h-4" />
        )}
      </button>
      <button
        type="button"
        className={`p-2 rounded-lg transition-colors ${satellites ? "bg-blue-500/20 text-blue-400" : "text-zinc-400 hover:text-white hover:bg-white/10"}`}
        onClick={onToggleSatellites}
        title="Toggle satellite layer"
      >
        <Satellite className="w-4 h-4" />
      </button>
      <button
        type="button"
        className={`p-2 rounded-lg transition-colors ${airports ? "bg-blue-500/20 text-blue-400" : "text-zinc-400 hover:text-white hover:bg-white/10"}`}
        onClick={onToggleAirports}
        title="Toggle airport layer"
      >
        <Plane className="w-4 h-4" />
      </button>
      <button
        type="button"
        className={`p-2 rounded-lg transition-colors ${clustering ? "bg-blue-500/20 text-blue-400" : "text-zinc-400 hover:text-white hover:bg-white/10"}`}
        onClick={onToggleClustering}
        title="Toggle clustering"
      >
        <Hash className="w-4 h-4" />
      </button>
    </div>
  );
}

function MapKeyboardBridge({
  onTogglePredictions,
  onToggleWeather,
  onToggleTfr,
  onToggleSatellites,
  onToggleClustering,
  onToggleAirports,
}: {
  onTogglePredictions: () => void;
  onToggleWeather: () => void;
  onToggleTfr: () => void;
  onToggleSatellites: () => void;
  onToggleClustering: () => void;
  onToggleAirports: () => void;
}) {
  const map = useMap();
  useEffect(() => {
    const setZoom = (event: Event) => {
      const zoom = (event as CustomEvent<number>).detail;
      if (typeof zoom === "number") map.setZoom(zoom);
    };
    const togglePredictions = () => onTogglePredictions();
    const toggleWeather = () => onToggleWeather();
    const toggleTfr = () => onToggleTfr();
    const toggleSatellites = () => onToggleSatellites();
    const toggleClustering = () => onToggleClustering();
    const toggleAirports = () => onToggleAirports();
    const focusLayers = () => {
      document.querySelector<HTMLButtonElement>(".sw-map-toolbar button")?.focus();
    };
    window.addEventListener("skywatch:set-map-zoom", setZoom);
    window.addEventListener("skywatch:toggle-predictions", togglePredictions);
    window.addEventListener("skywatch:toggle-weather", toggleWeather);
    window.addEventListener("skywatch:toggle-tfr", toggleTfr);
    window.addEventListener("skywatch:toggle-satellites", toggleSatellites);
    window.addEventListener("skywatch:toggle-clustering", toggleClustering);
    window.addEventListener("skywatch:toggle-airports", toggleAirports);
    window.addEventListener("skywatch:toggle-map-layers", focusLayers);
    return () => {
      window.removeEventListener("skywatch:set-map-zoom", setZoom);
      window.removeEventListener("skywatch:toggle-predictions", togglePredictions);
      window.removeEventListener("skywatch:toggle-weather", toggleWeather);
      window.removeEventListener("skywatch:toggle-tfr", toggleTfr);
      window.removeEventListener("skywatch:toggle-satellites", toggleSatellites);
      window.removeEventListener("skywatch:toggle-clustering", toggleClustering);
      window.removeEventListener("skywatch:toggle-airports", toggleAirports);
      window.removeEventListener("skywatch:toggle-map-layers", focusLayers);
    };
  }, [map, onTogglePredictions, onToggleSatellites, onToggleTfr, onToggleWeather, onToggleClustering, onToggleAirports]);
  return null;
}

const PREDICTION_EARTH_RADIUS_M = 6_371_000;

function projectedPosition(
  latitude: number,
  longitude: number,
  bearingDegrees: number,
  distanceMeters: number,
): [number, number] {
  const bearing = (bearingDegrees * Math.PI) / 180;
  const lat1 = (latitude * Math.PI) / 180;
  const lon1 = (longitude * Math.PI) / 180;
  const angularDistance = distanceMeters / PREDICTION_EARTH_RADIUS_M;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
    Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
    );

  return [
    (lat2 * 180) / Math.PI,
    normalizeLongitude((lon2 * 180) / Math.PI),
  ];
}

function predictionPathForFlight(flight: Flight): { positions: [number, number][]; confidence: number } {
  const path = flight.predicted_path ?? [];
  const positions = path
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
    .map((point) => [point.lat, point.lon] as [number, number]);
  if (positions.length >= 2) {
    return {
      positions,
      confidence: flight.prediction_confidence ?? path[path.length - 1]?.confidence ?? 0.5,
    };
  }

  if (
    flight.on_ground ||
    flight.latitude === null ||
    flight.longitude === null ||
    flight.velocity === null ||
    flight.true_track === null ||
    flight.velocity < 8
  ) {
    return { positions: [], confidence: 0 };
  }

  const seconds = [0, 90, 180, 300];
  return {
    positions: seconds.map((step) =>
      step === 0
        ? [flight.latitude as number, flight.longitude as number]
        : projectedPosition(
          flight.latitude as number,
          flight.longitude as number,
          flight.true_track as number,
          (flight.velocity as number) * step,
        ),
    ),
    confidence: 0.38,
  };
}

function PredictedPathLayer({ flights, enabled }: { flights: Flight[]; enabled: boolean }) {
  if (!enabled) return null;
  return (
    <>
      {flights.slice(0, 180).map((flight) => {
        const { positions, confidence } = predictionPathForFlight(flight);
        if (positions.length < 2) return null;
        return (
          <Polyline
            key={`prediction-${flight.icao24}`}
            positions={positions}
            pathOptions={{
              color: "#f59e0b",
              opacity: Math.max(0.18, Math.min(0.82, confidence)),
              dashArray: "6 8",
              weight: selectedWeight(flight),
            }}
          />
        );
      })}
    </>
  );
}

function selectedWeight(flight: Flight): number {
  return flight.prediction_confidence && flight.prediction_confidence > 0.8 ? 2.4 : 1.6;
}

function weatherColor(category: string): string {
  if (category === "MVFR") return "#3b82f6";
  if (category === "IFR") return "#ef4444";
  if (category === "LIFR") return "#d946ef";
  return "#22c55e";
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

function getWeatherCategorySvg(category: string): string {
  const cat = (category || "").toUpperCase();
  if (cat === "VFR") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5 filter drop-shadow-[0_0_1px_rgba(16,185,129,0.5)]"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
  }
  if (cat === "MVFR") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5 filter drop-shadow-[0_0_1px_rgba(59,130,246,0.5)]"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.9 10.1A4 4 0 0 0 12 6"/><path d="M18.5 19a3.5 3.5 0 0 0 0-7c-.12 0-.23 0-.35.02a6 6 0 0 0-11.65 0 4.6 4.6 0 0 0-.25-.02A4.5 4.5 0 0 0 1.75 16.5 4.5 4.5 0 0 0 6.25 21h10.75a3.5 3.5 0 0 0 1.5-3Z"/></svg>`;
  }
  if (cat === "IFR") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5 filter drop-shadow-[0_0_1px_rgba(239,68,68,0.5)]"><path d="M17.5 19a3.5 3.5 0 0 0 .5-6.975 6 6 0 0 0-11.95 0A4.6 4.6 0 0 0 2 15.75 4.75 4.75 0 0 0 6.75 20.5h10.75a3.5 3.5 0 0 0 0-7Z"/></svg>`;
  }
  if (cat === "LIFR") {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#d946ef" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5 filter drop-shadow-[0_0_1px_rgba(217,70,239,0.5)]"><path d="M17.5 19a3.5 3.5 0 0 0 .5-6.975 6 6 0 0 0-11.95 0A4.6 4.6 0 0 0 2 15.75 4.75 4.75 0 0 0 6.75 20.5h10.75a3.5 3.5 0 0 0 0-7Z"/><path d="m13 16-3 4h3l-1 4 4-5h-3l1-3Z"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#71717a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-3.5 h-3.5"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.9 10.1A4 4 0 0 0 12 6"/><path d="M18.5 19a3.5 3.5 0 0 0 0-7c-.12 0-.23 0-.35.02a6 6 0 0 0-11.65 0 4.6 4.6 0 0 0-.25-.02A4.5 4.5 0 0 0 1.75 16.5 4.5 4.5 0 0 0 6.25 21h10.75a3.5 3.5 0 0 0 1.5-3Z"/></svg>`;
}

function WeatherLayer({
  airports,
  enabled,
  setLoading,
}: {
  airports: Airport[];
  enabled: boolean;
  setLoading: (loading: boolean) => void;
}) {
  const map = useMap();
  const [weather, setWeather] = useState<Record<string, WeatherMetar>>({});
  const airportIndex = useMemo(() => buildAirportIndex(airports), [airports]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let timer: number | null = null;
    let cancelled = false;

    const load = () => {
      setLoading(true);
      const visible = getAirportCandidates(airportIndex, map.getBounds().pad(0.1), map.getZoom())
        .filter((airport) => airport.type === "large_airport" || airport.type === "medium_airport")
        .slice(0, 50);
      const codes = visible
        .map((airport) => airport.icao || airport.gpsCode || airport.ident)
        .filter((c): c is string => Boolean(c) && /^[A-Z]{4}$/.test(c));
      if (codes.length === 0) {
        setLoading(false);
        return;
      }
      void fetchBackendJson<WeatherPayload>(`/api/v1/weather/metar/?airports=${codes.join(",")}`)
        .then((data) => {
          if (!cancelled) setWeather(data.weather || {});
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    // Load instantly when layer is first enabled
    load();

    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(load, 500);
    };
    map.on("moveend zoomend", schedule);
    return () => {
      cancelled = true;
      map.off("moveend zoomend", schedule);
      if (timer !== null) window.clearTimeout(timer);
      setLoading(false);
    };
  }, [airportIndex, enabled, map, setLoading]);

  if (!enabled) return null;
  return (
    <>
      {airports.map((airport) => {
        const code = airport.icao || airport.gpsCode || airport.ident;
        const item = code ? weather[code] : undefined;
        if (!item) return null;
        const catConfig = getWeatherCategoryConfig(item.flight_category);
        const catSvg = getWeatherCategorySvg(item.flight_category);

        const icon = L.divIcon({
          className: "bg-transparent border-0",
          html: `<div class="flex items-center justify-center w-6 h-6 rounded-full bg-zinc-950/80 border border-white/10 hover:scale-110 hover:bg-zinc-900 transition-all duration-150 shadow-sm cursor-pointer">${catSvg}</div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
          popupAnchor: [0, -12],
        });

        return (
          <Marker
            key={`weather-${code}`}
            position={[airport.lat, airport.lon]}
            icon={icon}
          >
            <Popup className="bg-transparent border-0 shadow-none m-0 p-0">
              <div className="flex flex-col min-w-[280px] max-w-[340px] text-zinc-200 bg-zinc-950/95 backdrop-blur-md border border-white/10 p-4 rounded-2xl shadow-2xl font-sans text-xs select-none">
                <div className="flex flex-col gap-1 border-b border-white/5 pb-3 mb-3">
                  <div className="flex justify-between items-center">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <strong className="text-base font-bold text-white tracking-tight leading-none font-mono">
                        {code}
                      </strong>
                      <span className="text-[10px] text-zinc-400 font-medium truncate">
                        {airport.city ? `${airport.city}, ${airport.countryCode}` : airport.country}
                      </span>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${catConfig.colorClass}`}
                    >
                      <catConfig.icon className="w-3.5 h-3.5 flex-shrink-0" />
                      {catConfig.label}
                    </span>
                  </div>
                  <span className="text-[10px] text-zinc-500 truncate leading-none">
                    {airport.name}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2.5 mb-3">
                  {/* Wind Card */}
                  <div className="bg-white/[0.02] border border-white/5 rounded-xl p-2.5 flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 flex-shrink-0">
                      <Wind className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="block text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Wind</span>
                      <strong className="block text-xs text-zinc-200 truncate mt-0.5 font-mono">
                        {item.wind_direction !== null ? (
                          <span className="inline-flex items-center gap-1">
                            <Navigation2
                              className="w-2.5 h-2.5 text-blue-400 fill-current"
                              style={{ transform: `rotate(${item.wind_direction}deg)` }}
                            />
                            {item.wind_direction}° / {item.wind_speed ?? 0} kt
                          </span>
                        ) : "Calm"}
                      </strong>
                    </div>
                  </div>

                  {/* Temperature Card */}
                  <div className="bg-white/[0.02] border border-white/5 rounded-xl p-2.5 flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-400 flex-shrink-0">
                      <Thermometer className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="block text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Temp</span>
                      <strong className="block text-xs text-zinc-200 mt-0.5 font-mono">
                        {item.temperature !== null ? `${item.temperature} °C` : "--"}
                      </strong>
                    </div>
                  </div>

                  {/* Visibility Card */}
                  <div className="bg-white/[0.02] border border-white/5 rounded-xl p-2.5 flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 flex-shrink-0">
                      <Eye className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="block text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Visibility</span>
                      <strong className="block text-xs text-zinc-200 mt-0.5 font-mono">
                        {item.visibility !== null ? `${item.visibility} sm` : "--"}
                      </strong>
                    </div>
                  </div>

                  {/* Ceiling Card */}
                  <div className="bg-white/[0.02] border border-white/5 rounded-xl p-2.5 flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg bg-purple-500/10 flex items-center justify-center text-purple-400 flex-shrink-0">
                      <Cloud className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className="block text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Ceiling</span>
                      <strong className="block text-xs text-zinc-200 mt-0.5 font-mono">
                        {item.ceiling !== null ? `${item.ceiling.toLocaleString()} ft` : "Clear"}
                      </strong>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5 border-t border-white/5 pt-3">
                  <span className="text-[9px] font-semibold uppercase tracking-widest text-zinc-500">Raw METAR</span>
                  <p className="text-[10px] font-mono text-zinc-400 bg-white/5 p-2 rounded-lg leading-relaxed break-words border border-white/5 select-text">
                    {item.raw}
                  </p>
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

function TfrLayer({
  enabled,
  setLoading,
}: {
  enabled: boolean;
  setLoading: (loading: boolean) => void;
}) {
  const [features, setFeatures] = useState<TfrFeature[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let refreshTimer: number | null = null;

    const load = () => {
      setLoading(true);
      void fetchBackendJson<TfrPayload>("/api/v1/airspace/restrictions/")
        .then((payload) => {
          if (cancelled) return;
          setFeatures((payload.features || []).filter((feature) => feature.geometry?.coordinates));
        })
        .catch(() => {
          if (!cancelled) setFeatures([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    load();
    refreshTimer = window.setInterval(load, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearInterval(refreshTimer);
      setLoading(false);
    };
  }, [enabled, setLoading]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);

  if (!enabled) return null;
  return (
    <>
      {features.flatMap((feature, index) =>
        featurePolygons(feature).map((ring, ringIndex) => {
          const display = restrictionDisplay(feature, nowMs);
          return (
            <Polygon
              key={`restriction-${display.id}-${index}-${ringIndex}`}
              positions={ring.map((point) => [point[1], point[0]] as [number, number])}
              pathOptions={{
                color: display.color,
                fillColor: display.color,
                fillOpacity: display.isCritical ? 0.22 : 0.16,
                dashArray: display.isCritical ? undefined : "6 6",
                weight: display.isFresh ? 3 : 2,
                className: display.isFresh ? "sw-restriction-fresh" : undefined,
              }}
            >
              <Tooltip sticky className="bg-zinc-950/95 border border-white/10 text-zinc-200 rounded-xl p-3 shadow-2xl font-sans text-xs">
                <div className="flex flex-col min-w-[220px] max-w-[300px]">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-1.5 min-w-0 font-bold">
                      <span className={`w-2 h-2 rounded-full ${display.isCritical ? "bg-rose-500" : "bg-amber-500"}`}></span>
                      <span className={`${display.isCritical ? "text-rose-400" : "text-amber-400"} truncate`}>
                        {display.riskLabel.toUpperCase()}
                      </span>
                    </div>
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${display.sourceType === "backup"
                        ? "border-zinc-500/40 bg-zinc-500/10 text-zinc-300"
                        : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                      }`}>
                      {display.sourceType === "backup" ? "Backup" : "Live"}
                    </span>
                  </div>
                  <div className="font-semibold text-white text-sm mb-1 leading-snug">{display.name}</div>
                  <div className="text-[10px] text-zinc-400 mb-2 font-mono leading-relaxed">
                    LIMITS: {display.altitudeLimits} | AUTH: {display.authority}
                  </div>
                  {display.expiresIn ? (
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-sky-300">
                      {display.expiresIn}
                    </div>
                  ) : null}
                  <div className="text-[11px] text-zinc-300 leading-relaxed border-t border-white/10 pt-2 mt-1">
                    {display.reason}
                  </div>
                  <div className="mt-2 text-[9px] uppercase tracking-wider text-zinc-500">
                    {display.source}
                  </div>
                </div>
              </Tooltip>
            </Polygon>
          );
        }),
      )}
    </>
  );
}

function featurePolygons(feature: TfrFeature): number[][][] {
  const coords = feature.geometry?.coordinates;
  if (!coords) return [];
  if (feature.geometry?.type === "MultiPolygon") {
    return (coords as number[][][][])
      .map((polygon) => polygon[0])
      .filter((ring): ring is number[][] => Array.isArray(ring) && ring.length > 2);
  }
  return [(coords as number[][][])[0]].filter((ring): ring is number[][] => Array.isArray(ring) && ring.length > 2);
}

function restrictionDisplay(feature: TfrFeature, nowMs: number) {
  const props = feature.properties || {};
  const sourceType = String(propValue(props, ["source_type", "sourceType"], "live")).toLowerCase() === "backup" ? "backup" : "live";
  const riskLabel = String(propValue(props, ["riskLevel", "risk_level", "severity"], "High Risk (Advisory)"));
  const reason = compactText(String(propValue(props, ["reason", "qualifier", "REASON", "NOTAM_TXT", "hazard", "type"], "airspace restriction")), 180);
  const name = compactText(String(propValue(props, ["name", "title", "NOTAM", "notamNumber", "restriction_kind", "type"], "Airspace restriction")), 90);
  const altitudeLimits = compactText(String(propValue(props, ["altitudeLimits", "altitude_limits", "altitude"], altitudeText(props))), 60);
  const authority = compactText(String(propValue(props, ["authority", "source"], "Government feed")), 80);
  const source = compactText(String(propValue(props, ["source"], sourceType === "backup" ? "SkyWatch backup" : "Live government feed")), 90);
  const isCritical = isCriticalRestriction(riskLabel, reason, name);
  const issuedAt = parseTimestamp(propValue(props, ["issued_at", "issuedAt", "issueTime", "startTime", "validFrom"], ""));
  const expiresAt = parseTimestamp(propValue(props, ["expires_at", "expiresAt", "expireTime", "endTime", "validTo"], ""));
  const expiresIn = formatExpiry(expiresAt, nowMs);
  const isFresh = Boolean(issuedAt && nowMs - issuedAt.getTime() >= 0 && nowMs - issuedAt.getTime() <= 2 * 60 * 60 * 1000);

  return {
    id: String(propValue(props, ["id", "notamNumber", "NOTAM"], "unknown")),
    name,
    reason,
    riskLabel,
    altitudeLimits,
    authority,
    source,
    sourceType,
    expiresIn,
    isFresh,
    isCritical,
    color: isCritical ? "#ef4444" : "#f59e0b",
  };
}

function propValue(props: Record<string, unknown>, keys: string[], fallback: unknown): unknown {
  for (const key of keys) {
    if (key in props && props[key] !== null && props[key] !== undefined && props[key] !== "") {
      return props[key];
    }
    const match = Object.keys(props).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (match && props[match] !== null && props[match] !== undefined && props[match] !== "") {
      return props[match];
    }
  }
  return fallback;
}

function altitudeText(props: Record<string, unknown>): string {
  const base = propValue(props, ["base", "altitudeLow1", "ALT_LMT_LO"], "SFC");
  const top = propValue(props, ["top", "altitudeHi1", "ALT_LMT_HI"], "UNL");
  return `${base}-${top}`;
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}

function isCriticalRestriction(...values: string[]): boolean {
  const text = values.join(" ").toLowerCase();
  return ["critical", "no-fly", "no fly", "closed", "closure", "prohibited", "conflict", "missile", "war"].some((term) => text.includes(term));
}

function parseTimestamp(value: unknown): Date | null {
  if (!value) return null;
  if (typeof value === "number") {
    return new Date(value > 10_000_000_000 ? value : value * 1000);
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatExpiry(expiresAt: Date | null, nowMs: number): string | null {
  if (!expiresAt) return null;
  const diffMs = expiresAt.getTime() - nowMs;
  if (diffMs <= 0) return "Expired";
  const totalMinutes = Math.ceil(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `Expires in ${days}d ${hours}h`;
  if (hours > 0) return `Expires in ${hours}h ${minutes}m`;
  return `Expires in ${minutes}m`;
}

function PlaybackLayer({ selectedId, enabled, trackData }: { selectedId: string | null; enabled: boolean; trackData: FlightTrackData | null }) {
  const [positions, setPositions] = useState<PlaybackPosition[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    if (!enabled || !selectedId || !trackData) {
      setPositions([]);
      setIndex(0);
      setPlaying(false);
      return;
    }
    const allPoints: PlaybackPosition[] = [];
    for (const segment of trackData.segments) {
      for (const point of segment.points) {
        if (Number.isFinite(point.lat) && Number.isFinite(point.lon)) {
          allPoints.push({
            timestamp: point.time,
            latitude: point.lat,
            longitude: point.lon,
            altitude: point.alt,
            velocity: point.speed,
            heading: point.heading,
          });
        }
      }
    }
    allPoints.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    setPositions(allPoints);
    setIndex(0);
  }, [enabled, selectedId, trackData]);

  useEffect(() => {
    if (!playing || positions.length < 2) return;
    const timer = window.setInterval(
      () => {
        setIndex((value) => Math.min(value + 1, positions.length - 1));
      },
      Math.max(100, 1000 / speed),
    );
    return () => window.clearInterval(timer);
  }, [playing, positions.length, speed]);

  const controlsRef = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      L.DomEvent.disableClickPropagation(node);
      L.DomEvent.disableScrollPropagation(node);
    }
  }, []);

  if (!enabled || positions.length === 0) return null;
  const current = positions[Math.min(index, positions.length - 1)];
  const elapsed = positions[0]
    ? Date.parse(current.timestamp) - Date.parse(positions[0].timestamp)
    : 0;

  return (
    <>
      <CircleMarker
        center={[current.latitude, current.longitude]}
        radius={8}
        pathOptions={{ color: "#f59e0b", fillColor: "#f59e0b", fillOpacity: 0.9 }}
      />
      <div ref={controlsRef} className="absolute bottom-8 left-1/2 -translate-x-1/2 z-[1000] flex items-center gap-4 bg-zinc-950/90 backdrop-blur-xl border border-white/10 px-5 py-3 rounded-full shadow-2xl">
        <button
          type="button"
          onClick={() => setPlaying((value) => !value)}
          className="flex items-center justify-center w-8 h-8 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
        >
          {playing ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
        </button>
        <select
          value={speed}
          onChange={(event) => setSpeed(Number(event.target.value))}
          className="bg-transparent text-xs font-semibold text-zinc-300 outline-none cursor-pointer appearance-none px-1"
        >
          {[1, 5, 30].map((value) => (
            <option key={value} value={value} className="bg-zinc-900">
              {value}x
            </option>
          ))}
        </select>
        <input
          type="range"
          min={0}
          max={positions.length - 1}
          value={index}
          onChange={(event) => setIndex(Number(event.target.value))}
          className="w-48 accent-blue-500 cursor-pointer"
        />
        <span className="text-xs font-mono font-medium text-zinc-400 min-w-[60px] text-right">
          {Math.max(0, Math.round(elapsed / 60000)).toLocaleString()} min
        </span>
      </div>
    </>
  );
}

function MapResizeObserver() {
  const map = useMap();
  useEffect(() => {
    const container = map.getContainer();
    if (!container) return;

    const observer = new ResizeObserver(() => {
      map.invalidateSize();
    });
    observer.observe(container);

    return () => {
      observer.unobserve(container);
      observer.disconnect();
    };
  }, [map]);

  return null;
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
  satellites,
  theme,
}: MapViewProps) {
  const [selectedAirport, setSelectedAirport] = useState<Airport | null>(null);
  const [showPredictions, setShowPredictions] = useState(false);
  const [showWeather, setShowWeather] = useState(false);
  const [showTfr, setShowTfr] = useState(false);
  const [showSatellites, setShowSatellites] = useState(true);
  const [showAirports, setShowAirports] = useState(true);
  const [showPlayback, setShowPlayback] = useState(false);
  const [showClustering, setShowClustering] = useState(true);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [tfrLoading, setTfrLoading] = useState(false);

  const selectedTrackSegments = useMemo(() => {
    const rawSegments: TrackRenderSegment[] = selectedFlightTrack
      ? selectedFlightTrack.segments
        .map((segment): TrackRenderSegment => {
          const points = segment.points.filter(
            (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon),
          );
          return {
            id: segment.id,
            points,
            positions: points.map((point) => [point.lat, point.lon] as [number, number]),
          };
        })
        .filter((segment) => segment.positions.length > 0)
      : [];

    const livePoint = livePointFromFlight(selectedFlight);
    if (livePoint && rawSegments.length > 0) {
      const lastSegment = rawSegments[rawSegments.length - 1];
      const lastPoint = lastSegment.points[lastSegment.points.length - 1];
      if (lastPoint) {
        const alreadyCurrent = trackDistanceKm(lastPoint, livePoint) < 0.02;
        if (!alreadyCurrent) {
          lastSegment.points = [...lastSegment.points, livePoint];
          lastSegment.positions = [
            ...lastSegment.positions,
            [livePoint.lat, livePoint.lon] as [number, number],
          ];
        }
      }
    }

    if (livePoint && rawSegments.length === 0) {
      rawSegments.push({
        id: "selected-live-point",
        points: [livePoint],
        positions: [[livePoint.lat, livePoint.lon]],
      });
    }

    return rawSegments.filter((segment) => segment.positions.length > 1);
  }, [selectedFlight, selectedFlightTrack]);

  const selectedTrackEnd = useMemo(() => {
    const segments = selectedTrackSegments.filter((segment) => segment.points.length > 0);
    const lastSegment = segments[segments.length - 1];
    const point = lastSegment?.points[lastSegment.points.length - 1];
    return point ? ([point.lat, point.lon] as [number, number]) : null;
  }, [selectedTrackSegments]);

  const routeOriginPos = useMemo((): [number, number] | null => {
    const orig = enrichmentRoute?.origin;
    if (!orig) return null;
    if (!Number.isFinite(orig.latitude) || !Number.isFinite(orig.longitude)) return null;
    if (orig.latitude === 0 && orig.longitude === 0) return null;
    return [orig.latitude, orig.longitude];
  }, [enrichmentRoute]);

  const routeDestPos = useMemo((): [number, number] | null => {
    const dest = enrichmentRoute?.destination;
    if (!dest) return null;
    if (!Number.isFinite(dest.latitude) || !Number.isFinite(dest.longitude)) return null;
    if (dest.latitude === 0 && dest.longitude === 0) return null;
    return [dest.latitude, dest.longitude];
  }, [enrichmentRoute]);

  const isRouteLikelyIncorrect = useMemo(() => {
    if (!enrichmentRoute || !selectedFlight || selectedFlight.latitude === null || selectedFlight.longitude === null) {
      return false;
    }

    const lat = Number(selectedFlight.latitude);
    const lon = Number(selectedFlight.longitude);
    const track = selectedFlight.true_track !== null ? Number(selectedFlight.true_track) : null;

    const orig = enrichmentRoute.origin;
    const dest = enrichmentRoute.destination;
    if (!orig || !dest) return false;

    const origLat = Number(orig.latitude);
    const origLon = Number(orig.longitude);
    const destLat = Number(dest.latitude);
    const destLon = Number(dest.longitude);

    // Calculate progress-like flown and remaining using direct distances
    const flown = gcDistanceKm(origLat, origLon, lat, lon);
    const total = gcDistanceKm(origLat, origLon, destLat, destLon);
    if (total <= 0) return false;
    const remaining = gcDistanceKm(lat, lon, destLat, destLon);
    const pct = (flown / total) * 100;

    // Calculate shortest angle difference
    const angleDiff = (a: number, b: number) => {
      const d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    };

    // 1. Heading towards origin when close to origin (landing/approaching instead of departing)
    const distToOrigin = flown;
    if (distToOrigin < 150 && track !== null) {
      const brgOrig = gcBearing(lat, lon, origLat, origLon);
      const diffOrig = angleDiff(track, brgOrig);
      if (diffOrig < 80) {
        return true;
      }
    }

    // 2. Heading away from destination when far from destination
    if (remaining > 100 && track !== null) {
      const brgDest = gcBearing(lat, lon, destLat, destLon);
      const diffDest = angleDiff(track, brgDest);
      if (diffDest > 90) {
        return true;
      }
    }

    // 3. Physical flight phase mismatch check (e.g. descending rapidly at the very start of a long route)
    if (total > 300 && pct < 30) {
      const vSpeed = selectedFlight.vertical_rate !== null ? Number(selectedFlight.vertical_rate) * 196.85 : 0; // m/s -> fpm
      const alt = selectedFlight.baro_altitude !== null ? Number(selectedFlight.baro_altitude) * 3.28084 : 0; // m -> ft
      if (vSpeed < -800 && alt < 18000) {
        return true;
      }
    }

    // 4. Backend reported low confidence override
    if (enrichmentRoute.routeConfidence === "low") {
      return true;
    }

    return false;
  }, [enrichmentRoute, selectedFlight]);

  const hasValidRoute = !!(
    enrichmentRoute?.origin &&
    enrichmentRoute?.destination &&
    !isRouteLikelyIncorrect
  );

  const routeOriginLabel = useMemo(
    () => routeAirportCode(enrichmentRoute?.origin ?? null),
    [enrichmentRoute],
  );

  const routeDestLabel = useMemo(
    () => routeAirportCode(enrichmentRoute?.destination ?? null),
    [enrichmentRoute],
  );

  const renderLayovers = useMemo<RenderLayover[]>(() => {
    const layovers = selectedFlightTrack?.layovers ?? [];
    return layovers.map((layover, index) => {
      const nearest = findNearestAirportToPoint(airports, layover.lat, layover.lon, 140);
      const code = nearest ? getAirportCode(nearest.airport) : layover.airportCode;
      return {
        ...layover,
        label: code || `STOP ${index + 1}`,
        airportName: nearest?.airport.name ?? layover.airportName ?? null,
        airportCode: code ?? layover.airportCode ?? null,
        airportIcao: nearest?.airport.icao || layover.airportIcao || null,
        airportIata: nearest?.airport.iata || layover.airportIata || null,
        distanceToAirportKm: nearest?.distanceKm ?? null,
      };
    });
  }, [airports, selectedFlightTrack]);

  const routeAirports = useMemo(() => {
    if (!airports) return [];
    const originIcao = enrichmentRoute?.origin?.icaoCode;
    const destIcao = enrichmentRoute?.destination?.icaoCode;
    const originIata = enrichmentRoute?.origin?.iataCode;
    const destIata = enrichmentRoute?.destination?.iataCode;
    const matchesCode = (
      a: (typeof airports)[0],
      icao: string | undefined,
      iata: string | undefined,
    ) =>
      (icao && (a.icao === icao || a.ident === icao || a.gpsCode === icao)) ||
      (iata && a.iata === iata);
    return airports.filter(
      (a) =>
        matchesCode(a, originIcao, originIata) ||
        matchesCode(a, destIcao, destIata) ||
        renderLayovers.some(
          (layover) =>
            (layover.airportIcao &&
              (a.icao === layover.airportIcao || a.ident === layover.airportIcao)) ||
            (layover.airportIata && a.iata === layover.airportIata),
        ),
    );
  }, [enrichmentRoute, airports, renderLayovers]);
  const handleFlightSelect = useCallback(
    (icao24: string | null) => {
      if (icao24) setSelectedAirport(null);
      onSelect(icao24);
    },
    [onSelect],
  );
  const tileUrl =
    theme === "light"
      ? "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
      : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

  return (
    <div className="relative w-full h-full overflow-hidden">
      <MapContainer
        center={[20, 0]}
        zoom={2}
        minZoom={2}
        maxZoom={12}
        zoomSnap={0.25}
        zoomDelta={0.5}
        wheelPxPerZoomLevel={90}
        worldCopyJump
        zoomControl={false}
        preferCanvas
        style={{ height: "100%", width: "100%", zIndex: 0 }}
      >
        <MapResizeObserver />
        <TileLayer
          key={theme}
          url={tileUrl}
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a> &middot; <a href="https://opensky-network.org" target="_blank" rel="noreferrer">OpenSky Network</a> &middot; <a href="https://airplanes.live" target="_blank" rel="noreferrer">Airplanes.live</a> &middot; <a href="https://www.adsb.lol" target="_blank" rel="noreferrer">ADSB.lol</a> &middot; <a href="https://celestrak.org" target="_blank" rel="noreferrer">CelesTrak</a> &middot; <a href="https://glidernet.org" target="_blank" rel="noreferrer">OGN</a> &middot; <a href="https://ourairports.com" target="_blank" rel="noreferrer">OurAirports</a>'
          subdomains={["a", "b", "c", "d"]}
          detectRetina
          updateWhenIdle
          keepBuffer={4}
        />
        <ZoomControl position="topleft" />
        <MapKeyboardBridge
          onTogglePredictions={() => setShowPredictions((value) => !value)}
          onToggleWeather={() => setShowWeather((value) => !value)}
          onToggleTfr={() => setShowTfr((value) => !value)}
          onToggleSatellites={() => setShowSatellites((value) => !value)}
          onToggleClustering={() => setShowClustering((value) => !value)}
          onToggleAirports={() => setShowAirports((value) => !value)}
        />
        <FlyTo focus={focus} />
        <TrackAutoFit selectedId={selectedId} segments={selectedTrackSegments} />
        <PredictedPathLayer flights={flights} enabled={showPredictions} />
        <WeatherLayer airports={airports} enabled={showWeather} setLoading={setWeatherLoading} />
        <TfrLayer enabled={showTfr} setLoading={setTfrLoading} />
        <PlaybackLayer selectedId={selectedId} enabled={showPlayback} trackData={selectedFlightTrack} />
        {showSatellites && <SatelliteCanvasLayer satellites={satellites} />}
        <FlightCanvasLayer
          flights={flights}
          anomalyMap={anomalyMap}
          selectedId={selectedId}
          onSelect={handleFlightSelect}
          showClustering={showClustering}
        />
        {showAirports && (
          <AirportCanvasLayer
            airports={airports}
            selectedAirport={selectedAirport}
            onSelectAirport={setSelectedAirport}
            routeAirports={routeAirports}
          />
        )}

        {selectedAirport && (
          <Popup
            position={[selectedAirport.lat, selectedAirport.lon]}
            eventHandlers={{ remove: () => setSelectedAirport(null) }}
            className="bg-transparent border-0 shadow-none m-0 p-0"
          >
            <div className="flex flex-col min-w-[240px] text-zinc-200 bg-zinc-950 border border-white/10 p-4 rounded-xl shadow-2xl font-sans text-xs">
              <strong className="text-base text-white mb-0.5 tracking-tight">{selectedAirport.name}</strong>
              <span className="text-zinc-500 mb-4 leading-tight">
                {[selectedAirport.city, selectedAirport.region, selectedAirport.country]
                  .filter(Boolean)
                  .join(", ")}
              </span>
              <dl className="grid grid-cols-2 gap-y-3 gap-x-4 text-[10px] uppercase tracking-wider font-semibold text-zinc-500">
                <div>
                  <dt className="mb-1">Code</dt>
                  <dd className="text-zinc-200 normal-case tracking-normal">{getAirportCode(selectedAirport)}</dd>
                </div>
                <div>
                  <dt className="mb-1">Type</dt>
                  <dd className="text-zinc-200 normal-case tracking-normal truncate">{getAirportTypeLabel(selectedAirport.type)}</dd>
                </div>
                <div>
                  <dt className="mb-1">Country</dt>
                  <dd className="text-zinc-200 normal-case tracking-normal">{selectedAirport.countryCode || "--"}</dd>
                </div>
                <div>
                  <dt className="mb-1">Service</dt>
                  <dd className="text-zinc-200 normal-case tracking-normal">{selectedAirport.scheduledService ? "Scheduled" : "Unscheduled"}</dd>
                </div>
              </dl>
            </div>
          </Popup>
        )}

        <TrackCanvasLayer
          selectedId={selectedId}
          selectedFlight={selectedFlight}
          segments={selectedTrackSegments}
          routeOriginPos={routeOriginPos}
          routeDestPos={routeDestPos}
          routeOriginLabel={routeOriginLabel}
          routeDestLabel={routeDestLabel}
          hasValidRoute={hasValidRoute}
          selectedTrackEnd={selectedTrackEnd}
        />
      </MapContainer>

      {/* Floating Layer Status Indicator */}
      {(weatherLoading || tfrLoading) && (
        <div className="absolute top-4 right-4 z-[1000] flex items-center gap-2 px-3 py-2 bg-zinc-950/80 backdrop-blur-xl border border-white/10 text-xs font-medium text-zinc-200 rounded-xl shadow-2xl transition-all duration-300 animate-in fade-in slide-in-from-top-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
          <span>
            {weatherLoading && tfrLoading
              ? "Updating weather & restrictions..."
              : weatherLoading
                ? "Loading weather data..."
                : "Loading airspace restrictions..."}
          </span>
        </div>
      )}

      <MapToolbar
        predictions={showPredictions}
        weather={showWeather}
        tfr={showTfr}
        satellites={showSatellites}
        clustering={showClustering}
        airports={showAirports}
        weatherLoading={weatherLoading}
        tfrLoading={tfrLoading}
        onTogglePredictions={() => setShowPredictions((value) => !value)}
        onToggleWeather={() => setShowWeather((value) => !value)}
        onToggleTfr={() => setShowTfr((value) => !value)}
        onToggleSatellites={() => setShowSatellites((value) => !value)}
        onToggleClustering={() => setShowClustering((value) => !value)}
        onToggleAirports={() => setShowAirports((value) => !value)}
      />
    </div>
  );
}

export default memo(MapView);
