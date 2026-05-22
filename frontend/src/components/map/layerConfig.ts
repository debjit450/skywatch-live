import type { Color } from "@deck.gl/core";
import type { StyleSpecification } from "maplibre-gl";
import type { DeckLayerVisibility, SkywatchDeckLayerId } from "./types";

export const INITIAL_VIEW_STATE = {
  longitude: 0,
  latitude: 20,
  zoom: 2,
  pitch: 0,
  bearing: 0,
} as const;

export const MAP_LIMITS = {
  minZoom: 2,
  maxZoom: 12,
  maxPitch: 65,
} as const;

export const DEFAULT_LAYER_VISIBILITY: DeckLayerVisibility = {
  flights: true,
  predictions: false,
  tracks: true,
  route: true,
  airports: true,
  labels: true,
  weather: false,
  satellites: true,
  restrictions: false,
};

export const SKYWATCH_LAYER_IDS = {
  flights: "skywatch-flights",
  flightHeadings: "skywatch-flight-headings",
  flightLabels: "skywatch-flight-labels",
  predictions: "skywatch-predictions",
  selectedTrack: "skywatch-selected-track",
  route: "skywatch-route",
  airports: "skywatch-airports",
  airportLabels: "skywatch-airport-labels",
  weather: "skywatch-weather",
  satellites: "skywatch-satellites",
  restrictions: "skywatch-restrictions",
} satisfies Record<SkywatchDeckLayerId, string>;

export const MAP_COLORS = {
  selected: [59, 130, 246, 240],
  selectedStroke: [241, 245, 249, 255],
  anomaly: [245, 158, 11, 235],
  ground: [100, 116, 139, 170],
  trackHalo: [2, 6, 23, 210],
  trackCore: [59, 130, 246, 235],
  route: [250, 204, 21, 205],
  routeHalo: [2, 6, 23, 215],
  routeMuted: [148, 163, 184, 145],
  airportLarge: [168, 85, 247, 190],
  airportMedium: [96, 165, 250, 175],
  airportSmall: [148, 163, 184, 135],
  airportHeliport: [251, 113, 133, 175],
  airportRoute: [250, 204, 21, 230],
  satellite: [226, 232, 240, 180],
  prediction: [245, 158, 11, 190],
  weatherVfr: [16, 185, 129, 220],
  weatherMvfr: [59, 130, 246, 220],
  weatherIfr: [239, 68, 68, 230],
  weatherLifr: [217, 70, 239, 230],
  restriction: [245, 158, 11, 95],
  restrictionCritical: [239, 68, 68, 105],
  white: [248, 250, 252, 255],
  black: [2, 6, 23, 235],
} satisfies Record<string, Color>;

export const MAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a> &middot; <a href="https://opensky-network.org" target="_blank" rel="noreferrer">OpenSky Network</a> &middot; <a href="https://airplanes.live" target="_blank" rel="noreferrer">Airplanes.live</a> &middot; <a href="https://www.adsb.lol" target="_blank" rel="noreferrer">ADSB.lol</a> &middot; <a href="https://celestrak.org" target="_blank" rel="noreferrer">CelesTrak</a> &middot; <a href="https://glidernet.org" target="_blank" rel="noreferrer">OGN</a> &middot; <a href="https://ourairports.com" target="_blank" rel="noreferrer">OurAirports</a>';

const CARTO_SUBDOMAINS = ["a", "b", "c", "d"] as const;

export function createCartoRasterStyle(theme: "dark" | "light"): StyleSpecification {
  const styleName = theme === "light" ? "light_all" : "dark_all";
  const backgroundColor = theme === "light" ? "#d8dee8" : "#030712";

  return {
    version: 8,
    sources: {
      carto: {
        type: "raster",
        tiles: CARTO_SUBDOMAINS.map(
          (subdomain) => `https://${subdomain}.basemaps.cartocdn.com/${styleName}/{z}/{x}/{y}.png`,
        ),
        tileSize: 256,
        attribution: MAP_ATTRIBUTION,
      },
    },
    layers: [
      {
        id: "skywatch-solid-background",
        type: "background",
        paint: {
          "background-color": backgroundColor,
        },
      },
      {
        id: "carto-basemap",
        type: "raster",
        source: "carto",
        minzoom: 0,
        maxzoom: 20,
      },
    ],
  };
}

export function hexToDeckColor(hex: string, alpha = 230): Color {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return [
    Number.isFinite(r) ? r : 148,
    Number.isFinite(g) ? g : 163,
    Number.isFinite(b) ? b : 184,
    alpha,
  ];
}

export function weatherColor(category: string): Color {
  const normalized = category.toUpperCase();
  if (normalized === "MVFR") return MAP_COLORS.weatherMvfr;
  if (normalized === "IFR") return MAP_COLORS.weatherIfr;
  if (normalized === "LIFR") return MAP_COLORS.weatherLifr;
  return MAP_COLORS.weatherVfr;
}
