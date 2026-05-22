import type { DeckFlightPoint, RestrictionFeature, WeatherMetar } from "./types";

export const EXAMPLE_FLIGHT_SOURCE = {
  icao24: "a1b2c3",
  callsign: "SWA123",
  origin_country: "United States",
  time_position: 1779343200,
  last_contact: 1779343212,
  longitude: -97.0403,
  latitude: 32.8998,
  baro_altitude: 10363,
  on_ground: false,
  velocity: 232,
  true_track: 271,
  vertical_rate: 0,
  sensors: null,
  geo_altitude: 10424,
  squawk: "1200",
  spi: false,
  position_source: 0,
  category: 5,
  data_source: "adsb",
  predicted_path: [
    { lat: 32.8998, lon: -97.0403, alt: 10363, timestamp: "2026-05-21T12:00:00Z" },
    {
      lat: 32.9562,
      lon: -98.4051,
      alt: 10363,
      timestamp: "2026-05-21T12:05:00Z",
      confidence: 0.74,
    },
  ],
};

export const EXAMPLE_DECK_FLIGHT_POINT: Pick<
  DeckFlightPoint,
  "objectType" | "id" | "position" | "label" | "heading"
> = {
  objectType: "flight",
  id: "a1b2c3",
  position: [-97.0403, 32.8998],
  label: "SWA123",
  heading: 271,
};

export const EXAMPLE_METAR: WeatherMetar = {
  station: "KDFW",
  raw: "KDFW 211153Z 17012KT 10SM FEW030 24/18 A2992",
  wind_direction: 170,
  wind_speed: 12,
  visibility: 10,
  ceiling: null,
  temperature: 24,
  flight_category: "VFR",
};

export const EXAMPLE_RESTRICTION: RestrictionFeature = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-97.35, 32.72],
        [-96.75, 32.72],
        [-96.75, 33.12],
        [-97.35, 33.12],
        [-97.35, 32.72],
      ],
    ],
  },
  properties: {
    id: "TFR-DEMO-001",
    name: "Temporary flight restriction",
    riskLevel: "High Risk",
    altitudeLimits: "SFC-FL180",
    source: "FAA",
  },
};
