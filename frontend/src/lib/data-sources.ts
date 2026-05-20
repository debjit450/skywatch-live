/**
 * Data source registry for flight tracking.
 *
 * Each source type has a display name, color, icon key, description,
 * and quality metadata. Used throughout the UI for source badges,
 * map coloring, and dashboard breakdowns.
 */

export interface DataSourceInfo {
  key: string;
  name: string;
  shortName: string;
  type: string;
  description: string;
  color: string;
  bgColor: string;
  borderColor: string;
  icon: string;
  quality: "high" | "medium" | "low";
  latency: string;
}

export const DATA_SOURCES: Record<string, DataSourceInfo> = {
  opensky: {
    key: "opensky",
    name: "OpenSky Network",
    shortName: "OpenSky",
    type: "ADS-B Ground",
    description: "Crowdsourced ADS-B ground receiver network with 50,000+ receivers",
    color: "#38bdf8",
    bgColor: "rgba(56, 189, 248, 0.12)",
    borderColor: "rgba(56, 189, 248, 0.25)",
    icon: "radio",
    quality: "high",
    latency: "~5s",
  },
  adsb_one: {
    key: "adsb_one",
    name: "ADSB-One",
    shortName: "ADSB-One",
    type: "ADS-B Ground",
    description: "Global ADS-B exchange aggregator",
    color: "#22d3ee",
    bgColor: "rgba(34, 211, 238, 0.12)",
    borderColor: "rgba(34, 211, 238, 0.25)",
    icon: "antenna",
    quality: "high",
    latency: "~3s",
  },
  airplanes_live: {
    key: "airplanes_live",
    name: "Airplanes.live",
    shortName: "AirLive",
    type: "ADS-B Ground",
    description: "ADS-B Exchange community feed aggregator",
    color: "#a78bfa",
    bgColor: "rgba(167, 139, 250, 0.12)",
    borderColor: "rgba(167, 139, 250, 0.25)",
    icon: "tower",
    quality: "high",
    latency: "~3s",
  },
  adsb_lol: {
    key: "adsb_lol",
    name: "ADSB.lol",
    shortName: "ADSB.lol",
    type: "ADS-B Ground",
    description: "Open ADS-B public network with regional point query coverage",
    color: "#06b6d4",
    bgColor: "rgba(6, 182, 212, 0.12)",
    borderColor: "rgba(6, 182, 212, 0.25)",
    icon: "radio",
    quality: "high",
    latency: "~5s",
  },
  ogn: {
    key: "ogn",
    name: "Open Glider Network",
    shortName: "OGN",
    type: "FLARM",
    description: "FLARM/OGN network for gliders and small aircraft (20–100 km range)",
    color: "#4ade80",
    bgColor: "rgba(74, 222, 128, 0.12)",
    borderColor: "rgba(74, 222, 128, 0.25)",
    icon: "wind",
    quality: "medium",
    latency: "~10s",
  },
  faa_radar: {
    key: "faa_radar",
    name: "FAA / Military Radar",
    shortName: "FAA Radar",
    type: "Radar",
    description: "US/Canada radar data from FAA SWIM and military feeds",
    color: "#f97316",
    bgColor: "rgba(249, 115, 22, 0.12)",
    borderColor: "rgba(249, 115, 22, 0.25)",
    icon: "shield",
    quality: "high",
    latency: "~15s",
  },
  uat: {
    key: "uat",
    name: "UAT (978 MHz)",
    shortName: "UAT",
    type: "UAT",
    description: "US general aviation below FL180 using 978 MHz transponders",
    color: "#facc15",
    bgColor: "rgba(250, 204, 21, 0.12)",
    borderColor: "rgba(250, 204, 21, 0.25)",
    icon: "plane",
    quality: "medium",
    latency: "~5s",
  },
  satellite: {
    key: "satellite",
    name: "Satellite ADS-B",
    shortName: "Satellite",
    type: "Satellite",
    description: "Space-based ADS-B receivers for oceanic and remote coverage",
    color: "#f472b6",
    bgColor: "rgba(244, 114, 182, 0.12)",
    borderColor: "rgba(244, 114, 182, 0.25)",
    icon: "satellite",
    quality: "medium",
    latency: "~30s",
  },
  mlat: {
    key: "mlat",
    name: "MLAT (Multilateration)",
    shortName: "MLAT",
    type: "MLAT",
    description: "Time Difference of Arrival calculation from 4+ ground receivers",
    color: "#c084fc",
    bgColor: "rgba(192, 132, 252, 0.12)",
    borderColor: "rgba(192, 132, 252, 0.25)",
    icon: "crosshair",
    quality: "low",
    latency: "~10s",
  },
};

const UNKNOWN_SOURCE: DataSourceInfo = {
  key: "unknown",
  name: "Unknown Source",
  shortName: "Unknown",
  type: "Unknown",
  description: "Data source not identified",
  color: "#94a3b8",
  bgColor: "rgba(148, 163, 184, 0.12)",
  borderColor: "rgba(148, 163, 184, 0.25)",
  icon: "help",
  quality: "low",
  latency: "N/A",
};

/**
 * Get display info for a data source key.
 * Falls back gracefully for unknown sources.
 */
export function getDataSourceInfo(sourceKey: string | null | undefined): DataSourceInfo {
  if (!sourceKey) return UNKNOWN_SOURCE;
  return DATA_SOURCES[sourceKey] ?? UNKNOWN_SOURCE;
}

/**
 * Infer the data source key from position_source if data_source is missing or unknown.
 */
export function inferDataSource(
  dataSource: string | null | undefined,
  positionSource: number | null | undefined,
): string {
  if (dataSource && dataSource !== "unknown" && DATA_SOURCES[dataSource]) {
    return dataSource;
  }

  // Infer from position_source field
  switch (positionSource) {
    case 0:
    case 1:
      return "opensky"; // ADS-B
    case 2:
      return "mlat"; // MLAT
    case 3:
      return "ogn"; // FLARM
    case 4:
      return "faa_radar"; // Radar
    case 5:
      return "uat"; // UAT
    case 6:
      return "satellite"; // Satellite
    default:
      return "unknown";
  }
}

/**
 * Get the source color for a flight based on its data_source and position_source.
 * Falls back to position_source-based inference if data_source is missing.
 */
export function getSourceColor(
  dataSource: string | null | undefined,
  positionSource: number | null | undefined,
): string {
  if (dataSource && DATA_SOURCES[dataSource]) {
    return DATA_SOURCES[dataSource].color;
  }

  // Infer from position_source field
  switch (positionSource) {
    case 0:
      return DATA_SOURCES.opensky.color; // ADS-B
    case 1:
      return DATA_SOURCES.opensky.color; // ADS-B (asterix)
    case 2:
      return DATA_SOURCES.mlat.color; // MLAT
    case 3:
      return DATA_SOURCES.ogn.color; // FLARM
    case 4:
      return DATA_SOURCES.faa_radar.color; // Radar
    case 5:
      return DATA_SOURCES.uat.color; // UAT
    case 6:
      return DATA_SOURCES.satellite.color; // Satellite
    default:
      return UNKNOWN_SOURCE.color;
  }
}

/**
 * Get the source label from position_source integer.
 */
export function positionSourceLabel(positionSource: number | null | undefined): string {
  switch (positionSource) {
    case 0:
      return "ADS-B";
    case 1:
      return "ADS-B (ASTERIX)";
    case 2:
      return "MLAT";
    case 3:
      return "FLARM/OGN";
    case 4:
      return "Radar";
    case 5:
      return "UAT";
    case 6:
      return "Satellite";
    default:
      return "Unknown";
  }
}
