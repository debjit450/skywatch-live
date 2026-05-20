export interface SatelliteObject {
  id: string;
  name: string;
  group: string;
  groupLabel: string;
  latitude: number;
  longitude: number;
  altitudeKm: number | null;
  velocityKms: number | null;
  inclinationDeg: number | null;
  periodMinutes: number | null;
  epochAgeHours: number | null;
  orbitQuality: "fresh" | "nominal" | "degraded" | "stale" | "unknown";
  source: string;
  propagator: string;
  tleEpoch: string | null;
}

export interface SatelliteGroupSummary {
  key: string;
  name: string;
  celestrakGroup?: string;
  count: number;
  color: string;
}

export interface SatelliteCatalog {
  time: number;
  generatedAt: string | null;
  source: string;
  status: string;
  propagator: string | null;
  satellites: SatelliteObject[];
  count: number;
  sourceCounts: Record<string, number>;
  groups: SatelliteGroupSummary[];
  error?: string;
}

export const SATELLITE_GROUP_COLORS: Record<string, string> = {
  stations: "#22c55e",
  visual: "#facc15",
  weather: "#38bdf8",
  earth_resources: "#4ade80",
  navigation: "#a78bfa",
  galileo: "#c084fc",
  beidou: "#fb7185",
  starlink: "#94a3b8",
  oneweb: "#60a5fa",
};

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteCoordinate(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  const latitude = finiteNumber(lat);
  const longitude = finiteNumber(lon);
  if (
    latitude === null ||
    longitude === null ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }
  return { lat: latitude, lon: longitude };
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeOrbitQuality(value: unknown): SatelliteObject["orbitQuality"] {
  if (
    value === "fresh" ||
    value === "nominal" ||
    value === "degraded" ||
    value === "stale" ||
    value === "unknown"
  ) {
    return value;
  }
  return "unknown";
}

export function satelliteColor(group: string): string {
  return SATELLITE_GROUP_COLORS[group] ?? "#e2e8f0";
}

export function normalizeSatelliteCatalog(payload: unknown): SatelliteCatalog {
  const record = isRecord(payload) ? payload : {};
  const rawSatellites = Array.isArray(record.satellites) ? record.satellites.filter(isRecord) : [];
  const satellites: SatelliteObject[] = rawSatellites
    .map((item): SatelliteObject | null => {
      const coord = finiteCoordinate(item.latitude, item.longitude);
      if (!coord) return null;

      const group = stringValue(item.group, "unknown");
      return {
        id: stringValue(item.id, `${group}-${coord.lat}-${coord.lon}`),
        name: stringValue(item.name, "UNKNOWN SAT"),
        group,
        groupLabel: stringValue(item.group_label ?? item.groupLabel, group.replace(/_/g, " ")),
        latitude: coord.lat,
        longitude: coord.lon,
        altitudeKm: finiteNumber(item.altitude_km ?? item.altitudeKm),
        velocityKms: finiteNumber(item.velocity_kms ?? item.velocityKms),
        inclinationDeg: finiteNumber(item.inclination_deg ?? item.inclinationDeg),
        periodMinutes: finiteNumber(item.period_minutes ?? item.periodMinutes),
        epochAgeHours: finiteNumber(item.epoch_age_hours ?? item.epochAgeHours),
        orbitQuality: normalizeOrbitQuality(item.orbit_quality ?? item.orbitQuality),
        source: stringValue(item.source, "celestrak"),
        propagator: stringValue(item.propagator, "sgp4"),
        tleEpoch: stringValue(item.tle_epoch ?? item.tleEpoch, "") || null,
      };
    })
    .filter((item: SatelliteObject | null): item is SatelliteObject => item !== null);

  const rawGroups = Array.isArray(record.groups) ? record.groups.filter(isRecord) : [];
  const groups = rawGroups
    .map((item): SatelliteGroupSummary | null => {
      const key = stringValue(item.key);
      if (!key) return null;
      return {
        key,
        name: stringValue(item.name, key.replace(/_/g, " ")),
        celestrakGroup: stringValue(item.celestrak_group ?? item.celestrakGroup, ""),
        count: finiteNumber(item.count) ?? 0,
        color: stringValue(item.color, satelliteColor(key)),
      };
    })
    .filter((item: SatelliteGroupSummary | null): item is SatelliteGroupSummary => item !== null);

  return {
    time: finiteNumber(record.time) ?? Math.floor(Date.now() / 1000),
    generatedAt: stringValue(record.generated_at ?? record.generatedAt, "") || null,
    source: stringValue(record.source, "celestrak"),
    status: stringValue(record.status, satellites.length > 0 ? "ok" : "empty"),
    propagator: stringValue(record.propagator, "") || null,
    satellites,
    count: finiteNumber(record.count) ?? satellites.length,
    sourceCounts:
      record.source_counts && typeof record.source_counts === "object"
        ? (record.source_counts as Record<string, number>)
        : {},
    groups,
    error: stringValue(record.error, "") || undefined,
  };
}
