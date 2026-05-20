import { createFileRoute } from "@tanstack/react-router";
import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
} from "satellite.js";
import { fetchWithTimeout, jsonResponse } from "@/lib/api-safety";

const CELESTRAK_GP_URL = "https://celestrak.org/NORAD/elements/gp.php";
const CACHE_TTL_MS = 15 * 60 * 1000;
const SOURCE_TIMEOUT_MS = 3_000;
const CATALOG_TIMEOUT_MS = 10_000;
const LIVE_SOURCE_BACKOFF_MS = 120_000;

const SATELLITE_GROUPS = [
  { key: "stations", group: "stations", label: "Space stations", limit: 24, color: "#22c55e" },
  { key: "visual", group: "visual", label: "Bright visual", limit: 90, color: "#facc15" },
  { key: "weather", group: "weather", label: "Weather", limit: 120, color: "#38bdf8" },
  {
    key: "earth_resources",
    group: "resource",
    label: "Earth observation",
    limit: 140,
    color: "#4ade80",
  },
  { key: "navigation", group: "gps-ops", label: "GPS", limit: 48, color: "#a78bfa" },
  { key: "galileo", group: "galileo", label: "Galileo", limit: 48, color: "#c084fc" },
  { key: "beidou", group: "beidou", label: "BeiDou", limit: 64, color: "#fb7185" },
  { key: "starlink", group: "starlink", label: "Starlink", limit: 180, color: "#94a3b8" },
  { key: "oneweb", group: "oneweb", label: "OneWeb", limit: 90, color: "#60a5fa" },
] as const;

type SatelliteGroup = (typeof SATELLITE_GROUPS)[number];

interface TleRecord {
  satnum: string;
  name: string;
  line1: string;
  line2: string;
}

const groupByKey = new Map<string, SatelliteGroup>();
for (const group of SATELLITE_GROUPS) {
  groupByKey.set(group.key, group);
  groupByKey.set(group.group, group);
}

const tleCache = new Map<string, { insertedAt: number; records: TleRecord[] }>();
let liveSourceBackoffUntil = 0;

const FALLBACK_TLE_GROUPS: Record<string, TleRecord[]> = {
  stations: [
    {
      satnum: "25544",
      name: "ISS (ZARYA)",
      line1: "1 25544U 98067A   21275.51041667  .00002182  00000-0  50365-4 0  9993",
      line2: "2 25544  51.6445  21.2947 0003456  88.8090  44.7201 15.48915324306411",
    },
    {
      satnum: "48274",
      name: "CSS (TIANHE)",
      line1: "1 48274U 21035A   21275.47692130  .00016717  00000-0  18979-3 0  9996",
      line2: "2 48274  41.4697 116.4504 0005304  39.2292 320.8911 15.62092622 24453",
    },
  ],
  visual: [
    {
      satnum: "20580",
      name: "HST",
      line1: "1 20580U 90037B   21275.59097222  .00000500  00000-0  19827-4 0  9994",
      line2: "2 20580  28.4699 264.6238 0002852  74.1049 286.0268 15.09299830477275",
    },
    {
      satnum: "25338",
      name: "NOAA 15",
      line1: "1 25338U 98030A   21275.48198843  .00000055  00000-0  53184-4 0  9992",
      line2: "2 25338  98.7092 302.0538 0011228 187.9963 172.1062 14.25996389214174",
    },
  ],
  weather: [
    {
      satnum: "33591",
      name: "NOAA 19",
      line1: "1 33591U 09005A   21275.48563382  .00000058  00000-0  59431-4 0  9990",
      line2: "2 33591  99.1945 304.9613 0014080 235.5730 124.4096 14.12516450652914",
    },
    {
      satnum: "28654",
      name: "NOAA 18",
      line1: "1 28654U 05018A   21275.51296467  .00000074  00000-0  66778-4 0  9997",
      line2: "2 28654  99.0334 316.0682 0013908 122.0142 238.2381 14.12506171844621",
    },
  ],
  resource: [
    {
      satnum: "39084",
      name: "LANDSAT 8",
      line1: "1 39084U 13008A   21275.49420139  .00000295  00000-0  71548-4 0  9998",
      line2: "2 39084  98.2204 347.7113 0001276  89.7485 270.3862 14.57110888459628",
    },
    {
      satnum: "25994",
      name: "TERRA",
      line1: "1 25994U 99068A   21275.52394444  .00000115  00000-0  32214-4 0  9997",
      line2: "2 25994  98.2068 350.2217 0001285  91.0026 269.1325 14.57111758158542",
    },
  ],
  "gps-ops": [
    {
      satnum: "24876",
      name: "GPS BIIR-2",
      line1: "1 24876U 97035A   21275.14512416  .00000040  00000-0  00000-0 0  9995",
      line2: "2 24876  55.5537 205.5573 0147989  55.1852 306.1903  2.00563585177617",
    },
    {
      satnum: "32711",
      name: "GPS BIIRM-6",
      line1: "1 32711U 08012A   21275.23152778 -.00000028  00000-0  00000-0 0  9991",
      line2: "2 32711  54.9446  86.3822 0086408  49.6258 311.1534  2.00563448 99321",
    },
  ],
};

function parseTlePayload(payload: string): TleRecord[] {
  const lines = payload
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const records: TleRecord[] = [];

  for (let index = 0; index + 2 < lines.length; ) {
    const name = lines[index];
    const line1 = lines[index + 1];
    const line2 = lines[index + 2];
    if (!line1?.startsWith("1 ") || !line2?.startsWith("2 ")) {
      index += 1;
      continue;
    }
    records.push({ satnum: line1.slice(2, 7).trim(), name, line1, line2 });
    index += 3;
  }

  return records;
}

async function fetchTleGroup(group: string, timeoutMs = SOURCE_TIMEOUT_MS): Promise<TleRecord[]> {
  const cached = tleCache.get(group);
  if (cached && Date.now() - cached.insertedAt < CACHE_TTL_MS) return cached.records;

  const url = new URL(CELESTRAK_GP_URL);
  url.searchParams.set("GROUP", group);
  url.searchParams.set("FORMAT", "tle");

  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          Accept: "text/plain",
          "User-Agent": "skywatch-live/1.0",
        },
      },
      Math.max(500, Math.min(SOURCE_TIMEOUT_MS, timeoutMs)),
    );
    if (!response.ok) throw new Error(`CelesTrak returned ${response.status}`);
    const records = parseTlePayload(await response.text());
    tleCache.set(group, { insertedAt: Date.now(), records });
    return records;
  } catch (error) {
    if (cached) return cached.records;
    throw error;
  }
}

function fallbackTleGroup(group: string): TleRecord[] {
  return (FALLBACK_TLE_GROUPS[group] ?? []).map((record) => ({ ...record }));
}

function parseFloatSlice(value: string, start: number, end: number): number | null {
  const parsed = Number(value.slice(start, end).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function tleEpoch(line1: string): string | null {
  const year = Number(line1.slice(18, 20));
  const day = Number(line1.slice(20, 32));
  if (!Number.isFinite(year) || !Number.isFinite(day)) return null;
  const fullYear = year < 57 ? 2000 + year : 1900 + year;
  const epoch = new Date(Date.UTC(fullYear, 0, 1));
  epoch.setUTCSeconds((day - 1) * 86400);
  return epoch.toISOString();
}

function orbitQuality(epochIso: string | null): string {
  if (!epochIso) return "unknown";
  const ageHours = Math.abs(Date.now() - Date.parse(epochIso)) / 3_600_000;
  if (ageHours <= 24) return "fresh";
  if (ageHours <= 72) return "nominal";
  if (ageHours <= 168) return "degraded";
  return "stale";
}

function epochAgeHours(epochIso: string | null): number | null {
  if (!epochIso) return null;
  const age = Math.abs(Date.now() - Date.parse(epochIso)) / 3_600_000;
  return Number.isFinite(age) ? Math.round(age * 100) / 100 : null;
}

function propagateSatellite(
  record: TleRecord,
  group: SatelliteGroup,
  now: Date,
  source = "celestrak",
) {
  const satrec = twoline2satrec(record.line1, record.line2);
  const positionAndVelocity = propagate(satrec, now);
  if (!positionAndVelocity?.position || !positionAndVelocity.velocity) return null;
  const { position, velocity } = positionAndVelocity;

  const gmst = gstime(now);
  const geodetic = eciToGeodetic(position, gmst);
  const latitude = degreesLat(geodetic.latitude);
  const longitude = degreesLong(geodetic.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const velocityKms = Math.sqrt(velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2);
  const inclination = parseFloatSlice(record.line2, 8, 16);
  const meanMotion = parseFloatSlice(record.line2, 52, 63);
  const epochIso = tleEpoch(record.line1);

  return {
    id: record.satnum,
    name: record.name,
    group: group.key,
    group_label: group.label,
    latitude: Math.round(latitude * 100000) / 100000,
    longitude: Math.round(longitude * 100000) / 100000,
    altitude_km: Math.round(geodetic.height * 100) / 100,
    velocity_kms: Math.round(velocityKms * 10000) / 10000,
    inclination_deg: inclination !== null ? Math.round(inclination * 1000) / 1000 : null,
    period_minutes:
      meanMotion && meanMotion > 0 ? Math.round((1440 / meanMotion) * 100) / 100 : null,
    mean_motion_rev_day: meanMotion,
    tle_epoch: epochIso,
    epoch_age_hours: epochAgeHours(epochIso),
    orbit_quality: orbitQuality(epochIso),
    source,
    propagator: "sgp4",
  };
}

function selectedGroups(rawGroups: string | null): SatelliteGroup[] {
  const values = rawGroups
    ?.split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!values?.length) return [...SATELLITE_GROUPS];

  const selected: SatelliteGroup[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const group = groupByKey.get(value);
    if (group && !seen.has(group.key)) {
      selected.push(group);
      seen.add(group.key);
    }
  }
  return selected.length ? selected : [...SATELLITE_GROUPS];
}

function parseLimit(raw: string | null): number {
  if (!raw) return 650;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0) return 650;
  return Math.max(1, Math.min(Math.round(parsed), 1500));
}

export const Route = createFileRoute("/api/satellites")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const groups = selectedGroups(url.searchParams.get("groups"));
        const limit = parseLimit(url.searchParams.get("limit"));
        const now = new Date();
        const satellites = [];
        const sourceCounts: Record<string, number> = {};
        const groupSummaries = [];
        const errors: Record<string, string> = {};
        const seen = new Set<string>();
        const fallbackGroups = new Set<string>();
        const startedAt = Date.now();

        for (const group of groups) {
          if (satellites.length >= limit) break;

          let propagated = 0;
          const remainingMs = CATALOG_TIMEOUT_MS - (Date.now() - startedAt);
          let tles: TleRecord[] = [];
          let source = "celestrak";
          try {
            if (remainingMs <= 500) throw new Error("Satellite source request budget exceeded");
            if (Date.now() < liveSourceBackoffUntil) {
              throw new Error("CelesTrak live source in cooldown");
            }
            tles = await fetchTleGroup(group.group, remainingMs);
            if (tles.length === 0) throw new Error("CelesTrak returned no TLE records");
          } catch (error) {
            const fallback = fallbackTleGroup(group.group);
            const message = error instanceof Error ? error.message : "Source unavailable";
            if (fallback.length > 0) {
              tles = fallback;
              source = "celestrak_bootstrap";
              fallbackGroups.add(group.key);
              liveSourceBackoffUntil = Date.now() + LIVE_SOURCE_BACKOFF_MS;
              errors[group.key] = `${message}; using bundled bootstrap TLE seed`;
            } else {
              errors[group.key] = message;
            }
          }

          for (const record of tles) {
            if (!record.satnum || seen.has(record.satnum)) continue;
            const state = propagateSatellite(record, group, now, source);
            if (!state) continue;
            satellites.push(state);
            seen.add(record.satnum);
            propagated += 1;
            if (propagated >= group.limit || satellites.length >= limit) break;
          }

          sourceCounts[group.key] = propagated;
          groupSummaries.push({
            key: group.key,
            name: group.label,
            celestrak_group: group.group,
            count: propagated,
            color: group.color,
          });
        }

        return jsonResponse(
          {
            time: Math.floor(now.getTime() / 1000),
            generated_at: now.toISOString(),
            source: "celestrak",
            status: satellites.length > 0 ? "ok" : "empty",
            propagator: "sgp4",
            satellites,
            count: satellites.length,
            source_counts: sourceCounts,
            groups: groupSummaries,
            errors,
            coverage: {
              public_sources_only: true,
              source: "CelesTrak NORAD GP element sets",
              model: "SGP4 propagated TLE sub-satellite point",
              max_total: limit,
              fallback_groups: Array.from(fallbackGroups).sort(),
            },
          },
          {
            status: 200,
            headers: {
              "Cache-Control": "public, max-age=60",
            },
          },
        );
      },
    },
  },
});
