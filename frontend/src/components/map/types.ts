import type { Color } from "@deck.gl/core";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { AnomalousFlight } from "@/lib/anomaly";
import type { Airport } from "@/lib/airports";
import type { FlightTrackPoint } from "@/lib/flightTrack";
import type { Flight } from "@/lib/opensky";
import type { SatelliteObject } from "@/lib/satellites";
import type { SkywatchMarkerIconName } from "./markerIcons";

export type LngLatPosition = [longitude: number, latitude: number];
export type LatLngPosition = [latitude: number, longitude: number];

export type SkywatchDeckLayerId =
  | "flights"
  | "flightHeadings"
  | "flightLabels"
  | "predictions"
  | "selectedTrack"
  | "route"
  | "airports"
  | "airportLabels"
  | "weather"
  | "satellites"
  | "restrictions";

export interface DeckLayerVisibility {
  flights: boolean;
  predictions: boolean;
  tracks: boolean;
  route: boolean;
  airports: boolean;
  labels: boolean;
  weather: boolean;
  satellites: boolean;
  restrictions: boolean;
}

export interface DeckFlightPoint {
  objectType: "flight";
  id: string;
  position: LngLatPosition;
  sourcePosition: LngLatPosition | null;
  flight: Flight;
  anomaly: AnomalousFlight | null;
  selected: boolean;
  onGround: boolean;
  heading: number | null;
  altitudeMeters: number | null;
  speedMetersPerSecond: number | null;
  callsign: string;
  label: string;
  iconName: SkywatchMarkerIconName;
  iconSizePixels: number;
  fillColor: Color;
  lineColor: Color;
  radiusPixels: number;
  priority: number;
  predicted: boolean;
  confidence: string;
}

export interface DeckHeadingPath {
  objectType: "flight-heading";
  id: string;
  flightId: string;
  path: LngLatPosition[];
  color: Color;
  widthPixels: number;
}

export interface DeckPredictionPath {
  objectType: "prediction";
  id: string;
  flightId: string;
  path: LngLatPosition[];
  color: Color;
  confidence: number;
}

export interface DeckTrackPath {
  objectType: "track";
  id: string;
  source: string;
  path: LngLatPosition[];
  points: FlightTrackPoint[];
  color: Color;
  widthPixels: number;
}

export interface DeckRoutePath {
  objectType: "route";
  id: string;
  label: string;
  path: LngLatPosition[];
  color: Color;
  dashed?: boolean;
}

export interface DeckAirportPoint {
  objectType: "airport";
  id: string;
  position: LngLatPosition;
  airport: Airport;
  label: string;
  iconName: SkywatchMarkerIconName;
  iconSizePixels: number;
  fillColor: Color;
  lineColor: Color;
  radiusPixels: number;
  routeNode: boolean;
}

export interface DeckWeatherPoint {
  objectType: "weather";
  id: string;
  position: LngLatPosition;
  airport: Airport;
  metar: WeatherMetar;
  label: string;
  fillColor: Color;
  iconName: SkywatchMarkerIconName;
}

export interface DeckSatellitePoint {
  objectType: "satellite";
  id: string;
  position: LngLatPosition;
  satellite: SatelliteObject;
  fillColor: Color;
}

export interface WeatherMetar {
  station: string;
  raw: string;
  wind_direction: number | null;
  wind_speed: number | null;
  visibility: number | null;
  ceiling: number | null;
  temperature: number | null;
  flight_category: "VFR" | "MVFR" | "IFR" | "LIFR" | string;
}

export interface WeatherPayload {
  weather?: Record<string, WeatherMetar>;
}

export type RestrictionFeature = Feature<Geometry, Record<string, unknown>>;
export type RestrictionFeatureCollection = FeatureCollection<Geometry, Record<string, unknown>>;

export interface TfrPayload {
  features?: RestrictionFeature[];
}

export type SkywatchPickableObject =
  | DeckFlightPoint
  | DeckAirportPoint
  | DeckWeatherPoint
  | DeckSatellitePoint
  | DeckPredictionPath
  | DeckTrackPath
  | DeckRoutePath
  | RestrictionFeature;

export interface SkywatchTooltip {
  x: number;
  y: number;
  object: SkywatchPickableObject;
  layerId: string;
}

export interface SelectedTrackSegment {
  id: string;
  source: string;
  points: FlightTrackPoint[];
  path: LngLatPosition[];
}

export interface LayerBuildInput {
  flights: Flight[];
  refreshKey: number;
  anomalyMap: Map<string, AnomalousFlight>;
  selectedId: string | null;
  airports: Airport[];
  routeAirports: Airport[];
  weather: Record<string, WeatherMetar>;
  restrictions: RestrictionFeature[];
  selectedTrackSegments: SelectedTrackSegment[];
  routeOrigin: LngLatPosition | null;
  routeDestination: LngLatPosition | null;
  routeOriginLabel: string | null;
  routeDestinationLabel: string | null;
  hasValidRoute: boolean;
  satellites: SatelliteObject[];
  visibility: DeckLayerVisibility;
}

export interface PreparedSkywatchDeckData {
  visibility: DeckLayerVisibility;
  hasValidRoute: boolean;
  selectedId: string | null;
  routeAirports: Airport[];
  flightPoints: DeckFlightPoint[];
  headingPaths: DeckHeadingPath[];
  predictionPaths: DeckPredictionPath[];
  routePaths: DeckRoutePath[];
  trackPaths: DeckTrackPath[];
  airportPoints: DeckAirportPoint[];
  weatherPoints: DeckWeatherPoint[];
  satellitePoints: DeckSatellitePoint[];
  highlightedFlightPoints: DeckFlightPoint[];
  airportLabelPoints: DeckAirportPoint[];
  flightLabelPoints: DeckFlightPoint[];
  restrictions: RestrictionFeature[];
}
