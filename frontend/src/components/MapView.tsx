import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  useMap,
  ZoomControl,
} from "react-leaflet";
import L from "leaflet";
import type { Flight } from "@/lib/opensky";
import type { AnomalousFlight } from "@/lib/anomaly";
import type { FlightRouteInfo } from "@/lib/enrichment-types";
import type { FlightTrackData, FlightTrackPoint, FlightLayover } from "@/lib/flightTrack";
import { predictFlightState, type PredictedFlightState } from "@/lib/prediction";
import { getAirportCode, getAirportTypeLabel, type Airport } from "@/lib/airports";
import { getSourceColor } from "@/lib/data-sources";
import { calculateGreatCirclePoints, getAltitudeColor } from "@/lib/geo";
import {
  classifyFlight,
  getClassInfo,
  getClassesForLegend,
  countByClass,
  type AircraftClass,
} from "@/lib/aircraft-class";

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

function canConnectTrackPoints(a: FlightTrackPoint, b: FlightTrackPoint): boolean {
  const gapMs = Math.abs(trackPointTimeMs(b) - trackPointTimeMs(a));
  return (
    gapMs <= TRACK_CONNECT_MAX_GAP_MS && trackDistanceKm(a, b) <= TRACK_CONNECT_MAX_DISTANCE_KM
  );
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
  selectedAircraft: "#00ff7a",
  anomalyAircraft: "#ffb020",
  groundAircraft: "#64748b",
  helicopterAircraft: "#22d3ee",
  selectedRing: "rgba(0, 255, 122, 0.82)",
  anomalyRing: "rgba(255, 176, 32, 0.62)",
  trackHalo: "#020617",
  trackGlow: "#facc15",
  trackCore: "#f97316",
  trackCurrent: "#22c55e",
  routeDash: "#f97316",
  routeEndpoint: "#facc15",
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
  // Use aircraft class-based coloring
  const cls = classifyFlight(flight);
  const info = getClassInfo(cls);
  return info.color;
}

function trackPointColor(point: FlightTrackPoint): string {
  if (point.alt !== null) return getAltitudeColor(point.alt);
  if (point.speed !== null) {
    if (point.speed < 60) return "#fbbf24";
    if (point.speed < 140) return "#84cc16";
    if (point.speed < 230) return "#22c55e";
    if (point.speed < 310) return "#06b6d4";
    return "#3b82f6";
  }
  return MAP_COLORS.trackCore;
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
  ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
  ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
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
    ctx.strokeStyle = "rgba(34, 211, 238, 0.48)";
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
  ctx.shadowColor = kind === "anomaly" ? "rgba(255, 176, 32, 0.48)" : clsInfo.glowColor;
  ctx.shadowBlur = kind === "selected" || kind === "anomaly" || helicopter ? 6 : 3;
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(2, 6, 23, 0.72)";
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
    ctx.strokeStyle = "rgba(240, 253, 244, 0.92)";
    ctx.stroke(helicopterPath);
    ctx.restore();
  } else if (kind === "selected") {
    ctx.fill(aircraftPath);
    ctx.shadowBlur = 0;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "rgba(240, 253, 244, 0.92)";
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

type FlightCanvasLayerProps = Pick<
  MapViewProps,
  "flights" | "anomalyMap" | "selectedId" | "onSelect"
>;

function FlightCanvasLayer({ flights, anomalyMap, selectedId, onSelect }: FlightCanvasLayerProps) {
  const map = useMap();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const lastDrawAtRef = useRef(0);
  const throttleTimerRef = useRef<number | null>(null);
  const propsRef = useRef({ flights, anomalyMap, selectedId });
  propsRef.current = { flights, anomalyMap, selectedId };

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
    } = propsRef.current;
    const bounds = map.getBounds().pad(0.08);
    const prefilterBounds = map.getBounds().pad(0.22);
    const zoom = map.getZoom();
    const nowSeconds = Date.now() / 1000;
    const drawBuckets: RenderedFlight[][] = Array.from({ length: FLIGHT_DRAW_BUCKETS }, () => []);
    const declutterCellSize = flightDeclutterCellSize(zoom);
    const sampledFlights = new Map<string, RenderedFlight>();

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

    for (const bucket of drawBuckets) {
      for (const item of bucket) drawPredictionTrack(ctx, item, zoom);
    }

    for (const bucket of drawBuckets) {
      for (const item of bucket) {
        drawAircraft(ctx, item.flight, item.predicted, item.kind, item.point, zoom);
      }
    }
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
      "sw-flight-canvas leaflet-zoom-animated",
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
  }, [flights, anomalyMap, selectedId, scheduleDraw]);

  useEffect(() => {
    const handleClick = (event: L.LeafletMouseEvent) => {
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

function TrackCanvasLayer({
  selectedId,
  segments,
  routeOriginPos,
  routeDestPos,
  routeOriginLabel,
  routeDestLabel,
  hasValidRoute,
  selectedTrackStart,
  selectedTrackEnd,
  layovers,
}: {
  selectedId: string | null;
  segments: TrackRenderSegment[];
  routeOriginPos: [number, number] | null;
  routeDestPos: [number, number] | null;
  routeOriginLabel: string | null;
  routeDestLabel: string | null;
  hasValidRoute: boolean;
  selectedTrackStart: [number, number] | null;
  selectedTrackEnd: [number, number] | null;
  layovers: RenderLayover[];
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
    selectedTrackStart,
    selectedTrackEnd,
    layovers,
    selectedId,
  });
  propsRef.current = {
    segments,
    routeOriginPos,
    routeDestPos,
    routeOriginLabel,
    routeDestLabel,
    hasValidRoute,
    selectedTrackStart,
    selectedTrackEnd,
    layovers,
    selectedId,
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
      selectedTrackStart: start,
      selectedTrackEnd: end,
      layovers: lays,
      selectedId: currentId,
    } = propsRef.current;

    if (!currentId) return;

    const zoom = map.getZoom();
    const trackWidth = zoom >= 7 ? 4.8 : zoom >= 5 ? 4.1 : 3.4;

    const drawRouteArc = (
      p1: [number, number] | null,
      p2: [number, number] | null,
      alpha: number,
      dashed = true,
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
      ctx.strokeStyle = MAP_COLORS.routeDash;
      ctx.globalAlpha = alpha * 0.16;
      ctx.lineWidth = 18;
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
      ctx.strokeStyle = MAP_COLORS.routeDash;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2.1;
      ctx.lineCap = "round";
      if (dashed) ctx.setLineDash([7, 6]);
      ctx.stroke();
      ctx.restore();
    };

    const drawTrackPath = (points: FlightTrackPoint[], width: number, color: string) => {
      if (points.length < 2) return;
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
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    };

    const drawDirectionArrow = (from: L.Point, to: L.Point, color: string, alpha: number) => {
      const distance = from.distanceTo(to);
      if (distance < 18) return;
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const sizePx = zoom >= 6 ? 7 : 5.5;
      ctx.save();
      ctx.translate(to.x, to.y);
      ctx.rotate(angle);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(2, 6, 23, 0.8)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sizePx, 0);
      ctx.lineTo(-sizePx * 0.6, -sizePx * 0.55);
      ctx.lineTo(-sizePx * 0.25, 0);
      ctx.lineTo(-sizePx * 0.6, sizePx * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };

    if (valid) {
      if (currentSegments.length === 0) {
        drawRouteArc(orig, dest, 0.48);
      } else {
        drawRouteArc(orig, start, 0.5);
        drawRouteArc(end, dest, 0.34);
      }
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const segment of currentSegments) {
      if (segment.points.length < 2) continue;
      ctx.globalAlpha = 0.55;
      drawTrackPath(segment.points, trackWidth + 5.2, MAP_COLORS.trackHalo);
    }

    ctx.globalAlpha = 0.95;
    for (const segment of currentSegments) {
      if (segment.points.length < 2) continue;
      let prevPt = segment.points[0];
      let prevP = map.latLngToContainerPoint([prevPt.lat, prevPt.lon]);
      let arrowAccumulator = 0;
      for (let i = 1; i < segment.points.length; i++) {
        const pt = segment.points[i];
        const p = map.latLngToContainerPoint([pt.lat, pt.lon]);
        if (Math.abs(p.x - prevP.x) <= size.x * 1.5) {
          ctx.beginPath();
          ctx.moveTo(prevP.x, prevP.y);
          ctx.lineTo(p.x, p.y);
          ctx.strokeStyle = trackPointColor(prevPt);
          ctx.lineWidth = trackWidth;
          ctx.lineCap = "round";
          ctx.stroke();

          arrowAccumulator += prevP.distanceTo(p);
          if (arrowAccumulator > (zoom >= 6 ? 150 : 230)) {
            drawDirectionArrow(prevP, p, trackPointColor(pt), zoom >= 6 ? 0.82 : 0.62);
            arrowAccumulator = 0;
          }
        }
        prevPt = pt;
        prevP = p;
      }
    }
    ctx.globalAlpha = 1;

    const drawMarker = (
      pos: [number, number],
      color: string,
      fill: string,
      radius: number,
      label?: string | null,
    ) => {
      const p = map.latLngToContainerPoint(pos);
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      if (label && zoom >= 4) drawLabel(ctx, label, p.x, p.y, color);
    };

    if (valid && orig) {
      drawMarker(orig, MAP_COLORS.routeEndpoint, MAP_COLORS.trackHalo, 4.8, origLabel);
    }
    if (valid && dest) {
      drawMarker(dest, MAP_COLORS.routeEndpoint, MAP_COLORS.routeDash, 4.8, destLabel);
    }

    if (lays) {
      for (const l of lays) {
        drawMarker([l.lat, l.lon], "#fbbf24", "#0f172a", 5.2, l.label);
      }
    }

    if (start) drawMarker(start, MAP_COLORS.trackCore, MAP_COLORS.trackHalo, 4.5, "START");
    if (end) drawMarker(end, MAP_COLORS.trackGlow, MAP_COLORS.trackCurrent, 5.8, "LIVE");
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
      "sw-track-canvas leaflet-zoom-animated",
    ) as HTMLCanvasElement;
    canvasRef.current = canvas;
    pane.appendChild(canvas);

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
    selectedTrackStart,
    selectedTrackEnd,
    layovers,
    selectedId,
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
  const base = zoom < 3 ? 1.4 : zoom < 5 ? 1.8 : zoom < 7 ? 2.2 : zoom < 9 ? 2.8 : 3.4;
  if (airport.type === "large_airport") return base + 1.8;
  if (airport.type === "medium_airport") return base + 1.2;
  if (airport.scheduledService) return base + 0.6;
  if (airport.type === "closed_airport") return Math.max(1, base - 0.6);
  return base;
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
    ? 0.92
    : isRouteNode
      ? 0.8
      : airport.type === "closed_airport"
        ? 0.12
        : important
          ? 0.4
          : 0.25;

  const color = isRouteNode ? MAP_COLORS.routeEndpoint : airportColor(airport);
  const radius = airportRadius(airport, zoom);
  const size = selected ? radius + 3 : isRouteNode ? radius + 2 : radius;

  ctx.translate(point.x, point.y);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Selection / route highlight ring
  if (selected || isRouteNode) {
    ctx.beginPath();
    ctx.arc(0, 0, size + 4, 0, Math.PI * 2);
    ctx.strokeStyle = selected ? MAP_COLORS.selectedAircraft : MAP_COLORS.routeEndpoint;
    ctx.lineWidth = selected ? 1.6 : 1.2;
    ctx.globalAlpha = selected ? 0.7 : 0.5;
    ctx.stroke();
    ctx.globalAlpha = selected ? 0.92 : 0.8;
  }

  if (airport.type === "heliport") {
    // Circled H — standard aviation heliport symbol
    const r = Math.max(4, size * 1.1);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 2.4;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 1.4 : 0.9;
    ctx.stroke();
    if (zoom >= 6) {
      const h = r * 0.52;
      ctx.beginPath();
      ctx.moveTo(-h, -h);
      ctx.lineTo(-h, h);
      ctx.moveTo(h, -h);
      ctx.lineTo(h, h);
      ctx.moveTo(-h, 0);
      ctx.lineTo(h, 0);
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 1.3 : 0.85;
      ctx.stroke();
    }
  } else if (airport.type === "seaplane_base") {
    // Anchor-like diamond with wave
    const d = Math.max(3.5, size * 1.0);
    ctx.beginPath();
    ctx.moveTo(0, -d);
    ctx.lineTo(d, 0);
    ctx.lineTo(0, d);
    ctx.lineTo(-d, 0);
    ctx.closePath();
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 2.2;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 1.3 : 0.8;
    ctx.stroke();
    if (zoom >= 7) {
      ctx.beginPath();
      const w = d * 0.8;
      ctx.moveTo(-w, d + 2.5);
      ctx.quadraticCurveTo(-w * 0.5, d + 1, 0, d + 2.5);
      ctx.quadraticCurveTo(w * 0.5, d + 4, w, d + 2.5);
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
  } else if (important) {
    // Runway crosshair — standard aviation airport symbol
    const runway = Math.max(4, size * 1.4);
    const cross = Math.max(2.5, size * 0.55);
    ctx.beginPath();
    ctx.moveTo(0, -runway);
    ctx.lineTo(0, runway);
    ctx.moveTo(-cross, 0);
    ctx.lineTo(cross, 0);
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = selected ? 3.2 : 2.4;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 1.4 : 0.9;
    ctx.stroke();
    // Center dot
    ctx.beginPath();
    ctx.arc(0, 0, selected ? 2 : 1.3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  } else {
    // Simple dot for small/other airports
    const r = Math.max(1.5, size * 0.65);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, r - 0.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
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
    airportPane.style.zIndex = "640";
    airportPane.style.pointerEvents = "none";

    const canvas = L.DomUtil.create(
      "canvas",
      "sw-airport-canvas leaflet-zoom-animated",
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

import MapLegend from "./MapLegend";

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
  theme,
}: MapViewProps) {
  const [selectedAirport, setSelectedAirport] = useState<Airport | null>(null);

  const selectedTrackSegments = useMemo(() => {
    const segments: TrackRenderSegment[] = selectedFlightTrack
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
    if (livePoint && segments.length > 0) {
      const lastSegment = segments[segments.length - 1];
      const lastPoint = lastSegment.points[lastSegment.points.length - 1];
      if (lastPoint && canConnectTrackPoints(lastPoint, livePoint)) {
        const alreadyCurrent =
          trackDistanceKm(lastPoint, livePoint) < 0.02 ||
          trackPointTimeMs(livePoint) <= trackPointTimeMs(lastPoint);
        if (!alreadyCurrent) {
          lastSegment.points = [...lastSegment.points, livePoint];
          lastSegment.positions = [
            ...lastSegment.positions,
            [livePoint.lat, livePoint.lon] as [number, number],
          ];
        }
      }
    }

    return segments.filter((segment) => segment.positions.length > 1);
  }, [selectedFlight, selectedFlightTrack]);

  const selectedTrackStart = useMemo(() => {
    const firstSegment = selectedTrackSegments.find((segment) => segment.points.length > 0);
    const point = firstSegment?.points[0];
    return point ? ([point.lat, point.lon] as [number, number]) : null;
  }, [selectedTrackSegments]);

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

  const routeOriginLabel = useMemo(
    () => routeAirportCode(enrichmentRoute?.origin ?? null),
    [enrichmentRoute],
  );

  const routeDestLabel = useMemo(
    () => routeAirportCode(enrichmentRoute?.destination ?? null),
    [enrichmentRoute],
  );

  const hasValidRoute = !!(
    enrichmentRoute?.origin &&
    enrichmentRoute?.destination &&
    !(enrichmentRoute.routeConfidence === "low" && enrichmentRoute.routeWarning)
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
    <MapContainer
      center={[20, 0]}
      zoom={2}
      minZoom={2}
      maxZoom={12}
      worldCopyJump
      zoomControl={false}
      preferCanvas
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer
        key={theme}
        url={tileUrl}
        attribution='&copy; OpenStreetMap &copy; CARTO &middot; OpenSky Network &middot; Airport data <a href="https://ourairports.com/data/" target="_blank" rel="noreferrer">OurAirports</a>'
        subdomains={["a", "b", "c", "d"]}
      />
      <ZoomControl position="topleft" />
      <FlyTo focus={focus} />
      <TrackAutoFit selectedId={selectedId} segments={selectedTrackSegments} />
      <FlightCanvasLayer
        flights={flights}
        anomalyMap={anomalyMap}
        selectedId={selectedId}
        onSelect={handleFlightSelect}
      />
      <AirportCanvasLayer
        airports={airports}
        selectedAirport={selectedAirport}
        onSelectAirport={setSelectedAirport}
        routeAirports={routeAirports}
      />

      {selectedAirport && (
        <Popup
          position={[selectedAirport.lat, selectedAirport.lon]}
          eventHandlers={{ remove: () => setSelectedAirport(null) }}
        >
          <div className="sw-airport-popup">
            <strong>{selectedAirport.name}</strong>
            <span>
              {[selectedAirport.city, selectedAirport.region, selectedAirport.country]
                .filter(Boolean)
                .join(", ")}
            </span>
            <dl>
              <div>
                <dt>Code</dt>
                <dd>{getAirportCode(selectedAirport)}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{getAirportTypeLabel(selectedAirport.type)}</dd>
              </div>
              <div>
                <dt>Country</dt>
                <dd>{selectedAirport.countryCode || "--"}</dd>
              </div>
              <div>
                <dt>Service</dt>
                <dd>{selectedAirport.scheduledService ? "Scheduled" : "Unscheduled"}</dd>
              </div>
            </dl>
          </div>
        </Popup>
      )}

      <TrackCanvasLayer
        selectedId={selectedId}
        segments={selectedTrackSegments}
        routeOriginPos={routeOriginPos}
        routeDestPos={routeDestPos}
        routeOriginLabel={routeOriginLabel}
        routeDestLabel={routeDestLabel}
        hasValidRoute={hasValidRoute}
        selectedTrackStart={selectedTrackStart}
        selectedTrackEnd={selectedTrackEnd}
        layovers={renderLayovers}
      />
      <MapLegend flights={flights} />
    </MapContainer>
  );
}

export default memo(MapView);
