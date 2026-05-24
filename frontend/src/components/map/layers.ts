import type { Color, Layer } from "@deck.gl/core";
import { GeoJsonLayer, IconLayer, PathLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { AnomalousFlight } from "@/lib/anomaly";
import type { Airport } from "@/lib/airports";
import { getAirportCode } from "@/lib/airports";
import { classifyFlight, getClassInfo } from "@/lib/aircraft-class";
import { calculateGreatCirclePoints } from "@/lib/geo";
import type { FlightTrackPoint } from "@/lib/flightTrack";
import type { Flight } from "@/lib/opensky";
import { predictFlightState } from "@/lib/prediction";
import { satelliteColor } from "@/lib/satellites";
import { hexToDeckColor, MAP_COLORS, SKYWATCH_LAYER_IDS, weatherColor } from "./layerConfig";
import {
  MARKER_DECK_ICONS,
  MARKER_ICON_HEADING_OFFSET,
  markerIconForAircraftClass,
  type SkywatchMarkerIconName,
} from "./markerIcons";
import type {
  DeckAirportPoint,
  DeckFlightPoint,
  DeckHeadingPath,
  DeckPredictionPath,
  DeckRoutePath,
  DeckSatellitePoint,
  DeckTrackPath,
  DeckWeatherPoint,
  LayerBuildInput,
  LngLatPosition,
  PreparedSkywatchDeckData,
  RestrictionFeature,
  RestrictionFeatureCollection,
  SelectedTrackSegment,
  WeatherMetar,
} from "./types";

const EARTH_RADIUS_M = 6_371_000;
const MAX_PREDICTION_PATHS = 300;
const MAX_AIRPORT_LABELS = 500;
const FLIGHT_POINT_CACHE_LIMIT = 30_000;

const ROUTE_POINT_COUNT = 96;
const flightPointCache = new Map<string, DeckFlightPoint>();

function limitedCacheSet<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= FLIGHT_POINT_CACHE_LIMIT) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, value);
  return value;
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

function normalizeLongitude(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function destinationPosition(
  latitude: number,
  longitude: number,
  bearingDegrees: number,
  distanceMeters: number,
): LngLatPosition {
  const bearing = (bearingDegrees * Math.PI) / 180;
  const lat1 = (latitude * Math.PI) / 180;
  const lon1 = (longitude * Math.PI) / 180;
  const angularDistance = distanceMeters / EARTH_RADIUS_M;
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

  return [normalizeLongitude((lon2 * 180) / Math.PI), (lat2 * 180) / Math.PI];
}

function latLngPathToLngLatPath(path: Array<[number, number]>): LngLatPosition[] {
  return path.map(([lat, lon]) => [lon, lat]);
}

function isFiniteLngLatPosition(
  position: LngLatPosition | null | undefined,
): position is LngLatPosition {
  return isFiniteCoordinate(position?.[1], position?.[0]);
}

function greatCircleLngLatPath(
  start: LngLatPosition,
  end: LngLatPosition,
  pointCount = ROUTE_POINT_COUNT,
): LngLatPosition[] {
  return latLngPathToLngLatPath(
    calculateGreatCirclePoints([start[1], start[0]], [end[1], end[0]], pointCount),
  );
}

function sameLngLatPosition(a: LngLatPosition, b: LngLatPosition): boolean {
  return Math.abs(a[0] - b[0]) < 0.00001 && Math.abs(a[1] - b[1]) < 0.00001;
}

function appendLngLatPath(target: LngLatPosition[], segment: LngLatPosition[]) {
  for (const point of segment) {
    if (!isFiniteLngLatPosition(point)) continue;
    const last = target[target.length - 1];
    if (!last || !sameLngLatPosition(last, point)) {
      target.push(point);
    }
  }
}

function combinedSelectedTrackPath(segments: SelectedTrackSegment[]): LngLatPosition[] {
  const path: LngLatPosition[] = [];
  for (const segment of segments) {
    appendLngLatPath(path, segment.path);
  }
  return path;
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function lngLatDistanceKm(a: LngLatPosition, b: LngLatPosition): number {
  const lat1 = degreesToRadians(a[1]);
  const lat2 = degreesToRadians(b[1]);
  const deltaLat = degreesToRadians(b[1] - a[1]);
  const deltaLon = degreesToRadians(b[0] - a[0]);
  const h =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return (EARTH_RADIUS_M / 1000) * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lngLatBearingDegrees(a: LngLatPosition, b: LngLatPosition): number {
  const lat1 = degreesToRadians(a[1]);
  const lat2 = degreesToRadians(b[1]);
  const deltaLon = degreesToRadians(b[0] - a[0]);
  const y = Math.sin(deltaLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon);
  return normalizeLongitude((Math.atan2(y, x) * 180) / Math.PI);
}

function lngLatCrossTrackKm(start: LngLatPosition, end: LngLatPosition, point: LngLatPosition) {
  const distance13 = lngLatDistanceKm(start, point) / (EARTH_RADIUS_M / 1000);
  const bearing13 = degreesToRadians(lngLatBearingDegrees(start, point));
  const bearing12 = degreesToRadians(lngLatBearingDegrees(start, end));
  return (
    Math.asin(Math.sin(distance13) * Math.sin(bearing13 - bearing12)) * (EARTH_RADIUS_M / 1000)
  );
}

function trackPathFitsRoute(
  start: LngLatPosition,
  end: LngLatPosition,
  trackPath: LngLatPosition[],
): boolean {
  const routeDistanceKm = lngLatDistanceKm(start, end);
  if (routeDistanceKm < 10 || trackPath.length < 2) return false;

  const maxCrossTrackKm = Math.max(80, Math.min(500, routeDistanceKm * 0.4));
  const maxJumpKm = Math.max(160, Math.min(700, routeDistanceKm * 0.45));

  let previous: LngLatPosition | null = null;
  for (const point of trackPath) {
    if (Math.abs(lngLatCrossTrackKm(start, end, point)) > maxCrossTrackKm) {
      return false;
    }
    if (previous && lngLatDistanceKm(previous, point) > maxJumpKm) {
      return false;
    }
    previous = point;
  }

  return true;
}

function flightLabel(flight: Flight): string {
  return flight.callsign?.trim() || flight.icao24.toUpperCase();
}

function isHelicopter(flight: Flight): boolean {
  return flight.category === 8;
}

function aircraftColor(
  flight: Flight,
  anomaly: AnomalousFlight | null,
  selected: boolean,
  classColor: string,
): Color {
  if (selected) return MAP_COLORS.selected;
  if (anomaly) return MAP_COLORS.anomaly;
  if (flight.on_ground) return MAP_COLORS.ground;
  return hexToDeckColor(classColor, 225);
}

function flightRadiusPixels(
  flight: Flight,
  anomaly: AnomalousFlight | null,
  selected: boolean,
): number {
  if (selected) return 9;
  if (anomaly) return 7;
  if (isHelicopter(flight)) return 6;
  if (flight.on_ground) return 3.2;
  return 5;
}

function flightIconSizePixels(
  flight: Flight,
  anomaly: AnomalousFlight | null,
  selected: boolean,
): number {
  if (selected) return 34;
  if (anomaly) return 30;
  if (isHelicopter(flight)) return 27;
  if (flight.on_ground) return 18;
  return 24;
}

function flightPriority(
  flight: Flight,
  anomaly: AnomalousFlight | null,
  selected: boolean,
): number {
  if (selected) return 10_000;
  if (anomaly) return 9_000;
  if (isHelicopter(flight)) return 8_000;
  const altitude = flight.baro_altitude ?? flight.geo_altitude ?? 0;
  const speed = flight.velocity ?? 0;
  return (flight.on_ground ? 0 : 900) + altitude * 0.03 + speed * 2;
}

// Position transitions removed: they caused the visual icon and pick target
// to animate independently, making clicks land on the wrong aircraft.

function flightPointCacheKey(
  flight: Flight,
  anomaly: AnomalousFlight | null,
  selected: boolean,
): string {
  return [
    flight.icao24,
    flight.time_position ?? "",
    flight.last_contact,
    flight.longitude ?? "",
    flight.latitude ?? "",
    flight.baro_altitude ?? "",
    flight.geo_altitude ?? "",
    flight.velocity ?? "",
    flight.true_track ?? "",
    flight.on_ground ? 1 : 0,
    flight.category ?? 0,
    flight.data_source ?? "",
    flight.prediction_confidence ?? "",
    selected ? 1 : 0,
    anomaly?.anomalies.map((item) => item.type).join(",") ?? "",
  ].join("|");
}

export function buildFlightPoints(
  flights: Flight[],
  anomalyMap: Map<string, AnomalousFlight>,
  selectedId: string | null,
): DeckFlightPoint[] {
  return flights
    .map((flight): DeckFlightPoint | null => {
      const selected = selectedId === flight.icao24;
      const anomaly = anomalyMap.get(flight.icao24) ?? null;
      const cacheKey = flightPointCacheKey(flight, anomaly, selected);
      const cached = flightPointCache.get(cacheKey);
      if (cached) return cached;

      const predicted = predictFlightState(flight);
      if (!isFiniteCoordinate(predicted.latitude, predicted.longitude)) return null;

      const aircraftClass = classifyFlight(flight);
      const classInfo = getClassInfo(aircraftClass);
      const fillColor = aircraftColor(flight, anomaly, selected, classInfo.color);
      const sourcePosition = isFiniteCoordinate(flight.latitude, flight.longitude)
        ? ([flight.longitude as number, flight.latitude as number] satisfies LngLatPosition)
        : null;

      return limitedCacheSet(flightPointCache, cacheKey, {
        objectType: "flight",
        id: flight.icao24,
        position: [predicted.longitude as number, predicted.latitude as number],
        sourcePosition,
        flight,
        anomaly,
        selected,
        onGround: flight.on_ground,
        heading: flight.true_track,
        altitudeMeters: predicted.baroAltitude ?? predicted.geoAltitude,
        speedMetersPerSecond: flight.velocity,
        callsign: flight.callsign?.trim() || "",
        label: flightLabel(flight),
        iconName: markerIconForAircraftClass(aircraftClass),
        iconSizePixels: flightIconSizePixels(flight, anomaly, selected),
        fillColor,
        lineColor: selected ? MAP_COLORS.selectedStroke : MAP_COLORS.black,
        radiusPixels: flightRadiusPixels(flight, anomaly, selected),
        priority: flightPriority(flight, anomaly, selected),
        predicted: predicted.isPredicted,
        confidence: predicted.confidence,
      });
    })
    .filter((point): point is DeckFlightPoint => point !== null)
    .sort((a, b) => a.priority - b.priority);
}

export function buildHeadingPaths(points: DeckFlightPoint[]): DeckHeadingPath[] {
  return points
    .map((point): DeckHeadingPath | null => {
      if (point.onGround || point.heading === null || point.speedMetersPerSecond === null) {
        return null;
      }

      const [longitude, latitude] = point.position;
      const distanceMeters = Math.max(7_500, Math.min(24_000, point.speedMetersPerSecond * 55));
      const end = destinationPosition(latitude, longitude, point.heading, distanceMeters);

      return {
        objectType: "flight-heading",
        id: `${point.id}-heading`,
        flightId: point.id,
        path: [point.position, end],
        color: point.fillColor,
        widthPixels: point.selected ? 2.4 : 1.5,
      };
    })
    .filter((path): path is DeckHeadingPath => path !== null);
}

function predictionPathForFlight(flight: Flight): DeckPredictionPath | null {
  const reported = flight.predicted_path ?? [];
  const reportedPath = reported
    .filter((point) => isFiniteCoordinate(point.lat, point.lon))
    .map((point) => [point.lon, point.lat] as LngLatPosition);

  if (reportedPath.length >= 2) {
    return {
      objectType: "prediction",
      id: `${flight.icao24}-prediction`,
      flightId: flight.icao24,
      path: reportedPath,
      color: MAP_COLORS.prediction,
      confidence: flight.prediction_confidence ?? reported[reported.length - 1]?.confidence ?? 0.5,
    };
  }

  if (
    flight.on_ground ||
    !isFiniteCoordinate(flight.latitude, flight.longitude) ||
    flight.velocity === null ||
    flight.true_track === null ||
    flight.velocity < 8
  ) {
    return null;
  }

  const seconds = [0, 90, 180, 300];
  return {
    objectType: "prediction",
    id: `${flight.icao24}-prediction`,
    flightId: flight.icao24,
    path: seconds.map((step) =>
      step === 0
        ? ([flight.longitude as number, flight.latitude as number] satisfies LngLatPosition)
        : destinationPosition(
            flight.latitude as number,
            flight.longitude as number,
            flight.true_track as number,
            (flight.velocity as number) * step,
          ),
    ),
    color: MAP_COLORS.prediction,
    confidence: 0.38,
  };
}

function prioritizedPredictionFlights(
  flights: Flight[],
  anomalyMap: Map<string, AnomalousFlight>,
  selectedId: string | null,
): Flight[] {
  return [...flights]
    .sort((a, b) => {
      const aScore =
        (a.icao24 === selectedId ? 10_000 : 0) +
        (anomalyMap.has(a.icao24) ? 5_000 : 0) +
        (a.predicted_path?.length ? 1_000 : 0) +
        (a.velocity ?? 0);
      const bScore =
        (b.icao24 === selectedId ? 10_000 : 0) +
        (anomalyMap.has(b.icao24) ? 5_000 : 0) +
        (b.predicted_path?.length ? 1_000 : 0) +
        (b.velocity ?? 0);
      return bScore - aScore;
    })
    .slice(0, MAX_PREDICTION_PATHS);
}

export function buildPredictionPaths(
  flights: Flight[],
  anomalyMap: Map<string, AnomalousFlight>,
  selectedId: string | null,
): DeckPredictionPath[] {
  return prioritizedPredictionFlights(flights, anomalyMap, selectedId)
    .map(predictionPathForFlight)
    .filter((path): path is DeckPredictionPath => path !== null);
}

export function buildTrackPaths(segments: SelectedTrackSegment[]): DeckTrackPath[] {
  return segments.map(
    (segment): DeckTrackPath => ({
      objectType: "track",
      id: segment.id,
      source: segment.source,
      path: segment.path,
      points: segment.points,
      color: MAP_COLORS.trackCore,
      widthPixels: 3,
    }),
  );
}

function routePath(
  id: string,
  label: string,
  start: LngLatPosition | null,
  end: LngLatPosition | null,
  color: Color,
  actualTrackPath: LngLatPosition[] = [],
  dashed = false,
): DeckRoutePath | null {
  if (!start || !end) return null;
  const path: LngLatPosition[] = [];
  const trackPath = actualTrackPath.filter(isFiniteLngLatPosition);

  if (trackPathFitsRoute(start, end, trackPath)) {
    appendLngLatPath(
      path,
      greatCircleLngLatPath(start, trackPath[0], Math.floor(ROUTE_POINT_COUNT / 2)),
    );
    appendLngLatPath(path, trackPath);
    appendLngLatPath(
      path,
      greatCircleLngLatPath(
        trackPath[trackPath.length - 1],
        end,
        Math.floor(ROUTE_POINT_COUNT / 2),
      ),
    );
  } else {
    appendLngLatPath(path, greatCircleLngLatPath(start, end));
  }

  if (path.length < 2) return null;

  return {
    objectType: "route",
    id,
    label,
    path,
    color,
    dashed,
  };
}

export function buildRoutePaths(input: LayerBuildInput): DeckRoutePath[] {
  if (!input.visibility.route || !input.hasValidRoute) return [];
  const actualTrackPath = combinedSelectedTrackPath(input.selectedTrackSegments);
  return [
    routePath(
      "route-origin-destination",
      [input.routeOriginLabel, input.routeDestinationLabel].filter(Boolean).join(" -> ") ||
        "actual route",
      input.routeOrigin,
      input.routeDestination,
      MAP_COLORS.route,
      actualTrackPath,
      actualTrackPath.length < 2,
    ),
  ].filter((path): path is DeckRoutePath => path !== null);
}

function isImportantAirport(airport: Airport): boolean {
  return (
    airport.scheduledService ||
    airport.type === "large_airport" ||
    airport.type === "medium_airport"
  );
}

function airportPriority(airport: Airport, routeNode: boolean): number {
  if (routeNode) return 10_000;
  if (airport.type === "large_airport") return 900;
  if (airport.type === "medium_airport") return 700;
  if (airport.scheduledService) return 500;
  if (airport.type === "heliport") return 200;
  return 100;
}

function airportColor(airport: Airport, routeNode: boolean): Color {
  if (routeNode) return MAP_COLORS.airportRoute;
  if (airport.type === "large_airport") return MAP_COLORS.airportLarge;
  if (airport.type === "medium_airport") return MAP_COLORS.airportMedium;
  if (airport.type === "heliport") return MAP_COLORS.airportHeliport;
  return MAP_COLORS.airportSmall;
}

function airportIconName(airport: Airport) {
  return airport.type === "heliport" ? "helipad" : "airport";
}

function airportIconSizePixels(airport: Airport, routeNode: boolean): number {
  if (routeNode) return 24;
  if (airport.type === "large_airport") return 20;
  if (airport.type === "medium_airport") return 17;
  if (airport.type === "heliport") return 16;
  return 14;
}

export function buildAirportPoints(
  airports: Airport[],
  routeAirports: Airport[],
): DeckAirportPoint[] {
  const routeIds = new Set(routeAirports.map((airport) => airport.ident));
  const searchAirports = airports.length > 0 ? airports : routeAirports;
  return searchAirports
    .filter((airport) => routeIds.has(airport.ident) || isImportantAirport(airport))
    .filter((airport) => isFiniteCoordinate(airport.lat, airport.lon))
    .map((airport): DeckAirportPoint => {
      const routeNode = routeIds.has(airport.ident);
      return {
        objectType: "airport",
        id: airport.ident,
        position: [airport.lon, airport.lat],
        airport,
        label: getAirportCode(airport),
        iconName: airportIconName(airport),
        iconSizePixels: airportIconSizePixels(airport, routeNode),
        fillColor: airportColor(airport, routeNode),
        lineColor: routeNode ? MAP_COLORS.white : MAP_COLORS.black,
        radiusPixels: routeNode ? 7 : airport.type === "large_airport" ? 5 : 3.5,
        routeNode,
      };
    })
    .sort(
      (a, b) => airportPriority(a.airport, a.routeNode) - airportPriority(b.airport, b.routeNode),
    );
}

function airportCodeCandidates(airport: Airport): string[] {
  return [airport.icao, airport.gpsCode, airport.ident, airport.iata].filter(Boolean);
}

export function buildWeatherPoints(
  airports: Airport[],
  weather: Record<string, WeatherMetar>,
): DeckWeatherPoint[] {
  if (Object.keys(weather).length === 0) return [];

  return airports
    .map((airport): DeckWeatherPoint | null => {
      const code = airportCodeCandidates(airport).find((candidate) => weather[candidate]);
      if (!code) return null;
      const metar = weather[code];

      let iconName: SkywatchMarkerIconName = "weatherUnknown";
      const cat = (metar.flight_category || "").toUpperCase();
      if (cat === "VFR") iconName = "weatherVfr";
      else if (cat === "MVFR") iconName = "weatherMvfr";
      else if (cat === "IFR") iconName = "weatherIfr";
      else if (cat === "LIFR") iconName = "weatherLifr";

      return {
        objectType: "weather",
        id: `weather-${code}`,
        position: [airport.lon, airport.lat],
        airport,
        metar,
        label: metar.flight_category || "WX",
        fillColor: weatherColor(metar.flight_category),
        iconName,
      };
    })
    .filter((point): point is DeckWeatherPoint => point !== null);
}

export function buildSatellitePoints(
  satellites: LayerBuildInput["satellites"],
): DeckSatellitePoint[] {
  return satellites
    .filter((satellite) => isFiniteCoordinate(satellite.latitude, satellite.longitude))
    .map(
      (satellite): DeckSatellitePoint => ({
        objectType: "satellite",
        id: satellite.id,
        position: [satellite.longitude, satellite.latitude],
        satellite,
        fillColor: hexToDeckColor(satelliteColor(satellite.group), 185),
      }),
    );
}

function satelliteIconSizePixels(point: DeckSatellitePoint): number {
  if (point.satellite.group === "stations") return 22;
  if (point.satellite.group === "starlink" || point.satellite.group === "oneweb") return 15;
  return 18;
}

function restrictionIsCritical(feature: RestrictionFeature): boolean {
  const props = feature.properties ?? {};
  const text = Object.values(props).join(" ").toLowerCase();
  return [
    "critical",
    "no-fly",
    "no fly",
    "closed",
    "closure",
    "prohibited",
    "conflict",
    "missile",
    "war",
  ].some((term) => text.includes(term));
}

function restrictionCollection(features: RestrictionFeature[]): RestrictionFeatureCollection {
  return {
    type: "FeatureCollection",
    features,
  };
}

export function prepareSkywatchDeckData(input: LayerBuildInput): PreparedSkywatchDeckData {
  const flightPoints = input.visibility.flights
    ? buildFlightPoints(input.flights, input.anomalyMap, input.selectedId)
    : [];
  const headingPaths = input.visibility.flights ? buildHeadingPaths(flightPoints) : [];
  const predictionPaths = input.visibility.predictions
    ? buildPredictionPaths(input.flights, input.anomalyMap, input.selectedId)
    : [];
  const routePaths = buildRoutePaths(input);
  const trackPaths =
    input.visibility.tracks && routePaths.length === 0
      ? buildTrackPaths(input.selectedTrackSegments)
      : [];
  const airportPoints = input.visibility.airports
    ? buildAirportPoints(input.airports, input.routeAirports)
    : input.hasValidRoute
      ? buildAirportPoints([], input.routeAirports)
      : [];
  const weatherPoints = input.visibility.weather
    ? buildWeatherPoints(input.airports, input.weather)
    : [];
  const satellitePoints = input.visibility.satellites ? buildSatellitePoints(input.satellites) : [];
  const highlightedFlightPoints = flightPoints.filter((point) => point.selected || point.anomaly);
  const airportLabelPoints = airportPoints
    .filter((point) => point.routeNode || point.airport.type === "large_airport")
    .slice(-MAX_AIRPORT_LABELS);
  const flightLabelPoints = flightPoints.filter(
    (point) => point.selected || point.anomaly || isHelicopter(point.flight),
  );

  return {
    visibility: input.visibility,
    hasValidRoute: input.hasValidRoute,
    selectedId: input.selectedId,
    routeAirports: input.routeAirports,
    flightPoints,
    headingPaths,
    predictionPaths,
    routePaths,
    trackPaths,
    airportPoints,
    weatherPoints,
    satellitePoints,
    highlightedFlightPoints,
    airportLabelPoints,
    flightLabelPoints,
    restrictions: input.restrictions,
  };
}

export function createSkywatchDeckLayers(input: PreparedSkywatchDeckData): Layer[] {
  const {
    visibility,
    hasValidRoute,
    selectedId,
    routeAirports,
    flightPoints,
    headingPaths,
    predictionPaths,
    routePaths,
    trackPaths,
    airportPoints,
    weatherPoints,
    satellitePoints,
    highlightedFlightPoints,
    airportLabelPoints,
    flightLabelPoints,
    restrictions,
  } = input;
  const layers: Layer[] = [];

  if (visibility.restrictions && restrictions.length > 0) {
    layers.push(
      new GeoJsonLayer<Record<string, unknown>>({
        id: SKYWATCH_LAYER_IDS.restrictions,
        data: restrictionCollection(restrictions),
        pickable: true,
        stroked: true,
        filled: true,
        getFillColor: (feature: RestrictionFeature) =>
          restrictionIsCritical(feature) ? MAP_COLORS.restrictionCritical : MAP_COLORS.restriction,
        getLineColor: (feature: RestrictionFeature) =>
          restrictionIsCritical(feature) ? MAP_COLORS.restrictionCritical : MAP_COLORS.anomaly,
        getLineWidth: 2,
        lineWidthUnits: "pixels",
      }),
    );
  }

  if (routePaths.length > 0) {
    layers.push(
      new PathLayer<DeckRoutePath>({
        id: `${SKYWATCH_LAYER_IDS.route}-halo`,
        data: routePaths,
        pickable: false,
        getPath: (item) => item.path,
        getColor: MAP_COLORS.routeHalo,
        getWidth: 7,
        widthUnits: "pixels",
      }),
      new PathLayer<DeckRoutePath>({
        id: SKYWATCH_LAYER_IDS.route,
        data: routePaths,
        pickable: true,
        getPath: (item) => item.path,
        getColor: (item) => item.color,
        getWidth: 3,
        widthUnits: "pixels",
      }),
    );
  }

  if (predictionPaths.length > 0) {
    layers.push(
      new PathLayer<DeckPredictionPath>({
        id: SKYWATCH_LAYER_IDS.predictions,
        data: predictionPaths,
        pickable: true,
        getPath: (item) => item.path,
        getColor: (item) => [
          item.color[0],
          item.color[1],
          item.color[2],
          70 + item.confidence * 140,
        ],
        getWidth: 1.6,
        widthUnits: "pixels",
      }),
    );
  }

  if (trackPaths.length > 0) {
    layers.push(
      new PathLayer<DeckTrackPath>({
        id: `${SKYWATCH_LAYER_IDS.selectedTrack}-halo`,
        data: trackPaths,
        pickable: false,
        getPath: (item) => item.path,
        getColor: MAP_COLORS.trackHalo,
        getWidth: 7,
        widthUnits: "pixels",
      }),
      new PathLayer<DeckTrackPath>({
        id: SKYWATCH_LAYER_IDS.selectedTrack,
        data: trackPaths,
        pickable: true,
        getPath: (item) => item.path,
        getColor: (item) => item.color,
        getWidth: (item) => item.widthPixels,
        widthUnits: "pixels",
      }),
    );
  }

  if (airportPoints.length > 0) {
    const routeAirportPoints = airportPoints.filter((point) => point.routeNode);
    if (routeAirportPoints.length > 0) {
      layers.push(
        new ScatterplotLayer<DeckAirportPoint>({
          id: `${SKYWATCH_LAYER_IDS.airports}-route-halo`,
          data: routeAirportPoints,
          pickable: false,
          radiusUnits: "pixels",
          lineWidthUnits: "pixels",
          stroked: true,
          filled: false,
          getPosition: (item) => item.position,
          getRadius: (item) => item.iconSizePixels * 0.7,
          getLineColor: MAP_COLORS.white,
          getLineWidth: 2,
        }),
      );
    }

    layers.push(
      new IconLayer<DeckAirportPoint>({
        id: SKYWATCH_LAYER_IDS.airports,
        data: airportPoints,
        pickable: true,
        autoHighlight: true,
        billboard: true,
        sizeUnits: "pixels",
        getPosition: (item) => item.position,
        getIcon: (item) => MARKER_DECK_ICONS[item.iconName],
        getSize: (item) => item.iconSizePixels,
        getColor: (item) => item.fillColor,
        updateTriggers: {
          getColor: [routeAirports.length],
          getSize: [routeAirports.length],
        },
      }),
    );
  }

  if (satellitePoints.length > 0) {
    layers.push(
      new IconLayer<DeckSatellitePoint>({
        id: SKYWATCH_LAYER_IDS.satellites,
        data: satellitePoints,
        pickable: true,
        autoHighlight: true,
        billboard: true,
        sizeUnits: "pixels",
        getPosition: (item) => item.position,
        getIcon: () => MARKER_DECK_ICONS.satellite,
        getSize: satelliteIconSizePixels,
        getColor: (item) => item.fillColor,
      }),
    );
  }

  if (headingPaths.length > 0) {
    layers.push(
      new PathLayer<DeckHeadingPath>({
        id: SKYWATCH_LAYER_IDS.flightHeadings,
        data: headingPaths,
        pickable: false,
        getPath: (item) => item.path,
        getColor: (item) => item.color,
        getWidth: (item) => item.widthPixels,
        widthUnits: "pixels",
      }),
    );
  }

  if (flightPoints.length > 0) {
    if (highlightedFlightPoints.length > 0) {
      layers.push(
        new ScatterplotLayer<DeckFlightPoint>({
          id: `${SKYWATCH_LAYER_IDS.flights}-highlight-rings`,
          data: highlightedFlightPoints,
          pickable: false,
          radiusUnits: "pixels",
          lineWidthUnits: "pixels",
          stroked: true,
          filled: false,
          getPosition: (item) => item.position,
          getRadius: (item) => item.iconSizePixels * 0.56,
          getLineColor: (item) => (item.selected ? MAP_COLORS.selectedStroke : MAP_COLORS.anomaly),
          getLineWidth: (item) => (item.selected ? 2.4 : 1.8),
        }),
      );
    }

    layers.push(
      new IconLayer<DeckFlightPoint>({
        id: SKYWATCH_LAYER_IDS.flights,
        data: flightPoints,
        pickable: true,
        autoHighlight: true,
        billboard: true,
        sizeUnits: "pixels",
        getPosition: (item) => item.position,
        getIcon: (item) => MARKER_DECK_ICONS[item.iconName],
        getSize: (item) => item.iconSizePixels,
        getColor: (item) => item.fillColor,
        getAngle: (item) => -(item.heading ?? 0) + MARKER_ICON_HEADING_OFFSET[item.iconName],
        updateTriggers: {
          getColor: [selectedId],
          getSize: [selectedId],
          getIcon: [selectedId],
        },
      }),
    );
  }

  if (weatherPoints.length > 0) {
    layers.push(
      new IconLayer<DeckWeatherPoint>({
        id: SKYWATCH_LAYER_IDS.weather,
        data: weatherPoints,
        pickable: true,
        autoHighlight: true,
        billboard: true,
        sizeUnits: "pixels",
        getPosition: (item) => item.position,
        getIcon: (item) => MARKER_DECK_ICONS[item.iconName || "weatherUnknown"],
        getSize: 28,
        getColor: [255, 255, 255, 255],
      }),
    );
  }

  const showAirportLabels = visibility.labels || hasValidRoute;
  const activeAirportLabelPoints = visibility.labels
    ? airportLabelPoints
    : airportLabelPoints.filter((point) => point.routeNode);

  if (showAirportLabels && activeAirportLabelPoints.length > 0) {
    layers.push(
      new TextLayer<DeckAirportPoint>({
        id: SKYWATCH_LAYER_IDS.airportLabels,
        data: activeAirportLabelPoints,
        pickable: false,
        getPosition: (item) => item.position,
        getText: (item) => item.label,
        getSize: (item) => (item.routeNode ? 12 : 10),
        getColor: MAP_COLORS.white,
        getPixelOffset: [0, 13],
        background: true,
        getBackgroundColor: MAP_COLORS.black,
        fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
        fontWeight: 700,
        sizeUnits: "pixels",
      }),
    );
  }

  if (visibility.labels && flightLabelPoints.length > 0) {
    layers.push(
      new TextLayer<DeckFlightPoint>({
        id: SKYWATCH_LAYER_IDS.flightLabels,
        data: flightLabelPoints,
        pickable: false,
        getPosition: (item) => item.position,
        getText: (item) => item.label,
        getSize: (item) => (item.selected ? 12 : 10),
        getColor: (item) => item.fillColor,
        getPixelOffset: [14, -10],
        background: true,
        getBackgroundColor: MAP_COLORS.black,
        fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace",
        fontWeight: 700,
        sizeUnits: "pixels",
      }),
    );
  }

  return layers;
}
