export interface FlightTrackPoint {
  lat: number;
  lon: number;
  alt: number | null;
  speed: number | null;
  heading: number | null;
  time: string;
  onGround?: boolean;
  dataSource?: string | null;
}

export interface FlightTrackSegment {
  id: string;
  source: string;
  startedAt: string | null;
  endedAt: string | null;
  distanceKm: number | null;
  points: FlightTrackPoint[];
}

export interface FlightLayover {
  startTime: string;
  endTime: string;
  durationMinutes: number;
  lat: number;
  lon: number;
  arrivalLat?: number;
  arrivalLon?: number;
  departureLat?: number;
  departureLon?: number;
  airportCode?: string | null;
  airportName?: string | null;
  airportIcao?: string | null;
  airportIata?: string | null;
  distanceKm?: number | null;
  confidence?: "high" | "medium" | "low";
  source?: "segment_gap" | "ground_cluster" | "reported";
}

export type FlightPhaseName =
  | "ground"
  | "takeoff"
  | "climb"
  | "cruise"
  | "descent"
  | "approach"
  | "unknown";

export interface FlightTrackBounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface FlightTrackGap {
  startTime: string;
  endTime: string;
  durationMinutes: number;
  distanceKm: number | null;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
}

export interface FlightTrackPhase {
  phase: FlightPhaseName;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  distanceKm: number;
  pointCount: number;
  avgAltitudeM: number | null;
  avgSpeedMs: number | null;
}

export interface FlightTrackQuality {
  score: number;
  label: "excellent" | "good" | "limited" | "poor";
  reasons: string[];
}

export interface FlightTrackIntelligence {
  startedAt: string | null;
  endedAt: string | null;
  durationMinutes: number | null;
  airborneMinutes: number | null;
  distanceKm: number | null;
  straightLineKm: number | null;
  trackEfficiency: number | null;
  pointDensityPerHour: number | null;
  maxAltitudeM: number | null;
  minAltitudeM: number | null;
  avgAltitudeM: number | null;
  maxSpeedMs: number | null;
  avgSpeedMs: number | null;
  maxVerticalRateMs: number | null;
  minVerticalRateMs: number | null;
  segmentCount: number;
  pointCount: number;
  gapCount: number;
  gaps: FlightTrackGap[];
  phaseBreakdown: FlightTrackPhase[];
  currentPhase: FlightPhaseName;
  bounds: FlightTrackBounds | null;
  quality: FlightTrackQuality;
}

export interface FlightTrackData {
  icao24: string;
  source: "backend" | "opensky";
  fetchedAt: number;
  pointCount: number;
  totalDistanceKm: number | null;
  segments: FlightTrackSegment[];
  layovers: FlightLayover[];
  intelligence?: FlightTrackIntelligence;
}

const EARTH_RADIUS_KM = 6371;
const MAX_REASONABLE_SEGMENT_KM = 950;
const GAP_MINUTES = 45;

export function flightTrackPointTimeMs(point: FlightTrackPoint): number {
  const ms = Date.parse(point.time);
  return Number.isFinite(ms) ? ms : 0;
}

export function flightTrackDistanceKm(
  a: Pick<FlightTrackPoint, "lat" | "lon">,
  b: Pick<FlightTrackPoint, "lat" | "lon">,
): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function isValidTrackPoint(point: FlightTrackPoint): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lon >= -180 &&
    point.lon <= 180 &&
    flightTrackPointTimeMs(point) > 0
  );
}

export function flattenTrackPoints(segments: FlightTrackSegment[]): FlightTrackPoint[] {
  return segments
    .flatMap((segment) => segment.points)
    .filter(isValidTrackPoint)
    .sort((a, b) => flightTrackPointTimeMs(a) - flightTrackPointTimeMs(b));
}

export function calculateSegmentDistanceKm(points: FlightTrackPoint[]): number {
  let distanceKm = 0;
  let previous: FlightTrackPoint | null = null;

  for (const point of points.filter(isValidTrackPoint)) {
    if (previous) {
      const segmentKm = flightTrackDistanceKm(previous, point);
      const timeGapMinutes =
        Math.abs(flightTrackPointTimeMs(point) - flightTrackPointTimeMs(previous)) / 60_000;
      if (segmentKm <= MAX_REASONABLE_SEGMENT_KM || timeGapMinutes <= 20) {
        distanceKm += segmentKm;
      }
    }
    previous = point;
  }

  return distanceKm;
}

export function sanitizeTrackSegments(segments: FlightTrackSegment[]): FlightTrackSegment[] {
  return segments
    .map((segment, index): FlightTrackSegment => {
      const seen = new Set<string>();
      const points = segment.points
        .filter(isValidTrackPoint)
        .sort((a, b) => flightTrackPointTimeMs(a) - flightTrackPointTimeMs(b))
        .filter((point) => {
          const key = `${Math.round(flightTrackPointTimeMs(point) / 1000)}:${point.lat.toFixed(
            5,
          )}:${point.lon.toFixed(5)}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

      return {
        ...segment,
        id: segment.id || `track-${index}`,
        startedAt: segment.startedAt ?? points[0]?.time ?? null,
        endedAt: segment.endedAt ?? points[points.length - 1]?.time ?? null,
        distanceKm:
          segment.distanceKm ?? (points.length > 1 ? calculateSegmentDistanceKm(points) : null),
        points,
      };
    })
    .filter((segment) => segment.points.length > 0)
    .sort((a, b) => flightTrackPointTimeMs(a.points[0]) - flightTrackPointTimeMs(b.points[0]));
}

export function summarizeTrackBounds(points: FlightTrackPoint[]): FlightTrackBounds | null {
  const valid = points.filter(isValidTrackPoint);
  if (valid.length === 0) return null;

  return valid.reduce<FlightTrackBounds>(
    (bounds, point) => ({
      north: Math.max(bounds.north, point.lat),
      south: Math.min(bounds.south, point.lat),
      east: Math.max(bounds.east, point.lon),
      west: Math.min(bounds.west, point.lon),
    }),
    {
      north: valid[0].lat,
      south: valid[0].lat,
      east: valid[0].lon,
      west: valid[0].lon,
    },
  );
}

function numericValues(points: FlightTrackPoint[], key: "alt" | "speed"): number[] {
  return points
    .map((point) => point[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pointIsGround(point: FlightTrackPoint): boolean {
  const alt = point.alt;
  const speed = point.speed;
  return Boolean(point.onGround) || ((alt === null || alt < 160) && (speed === null || speed < 35));
}

function classifyPhase(
  point: FlightTrackPoint,
  previous: FlightTrackPoint | null,
): FlightPhaseName {
  if (pointIsGround(point)) return "ground";
  const alt = point.alt ?? 0;
  const speed = point.speed ?? 0;
  const dtSeconds = previous
    ? (flightTrackPointTimeMs(point) - flightTrackPointTimeMs(previous)) / 1000
    : 0;
  const verticalRate =
    previous && previous.alt !== null && point.alt !== null && dtSeconds > 5
      ? (point.alt - previous.alt) / dtSeconds
      : null;

  if (alt < 900 && speed > 55 && (!verticalRate || verticalRate > -1)) return "takeoff";
  if (verticalRate !== null && verticalRate > 2) return "climb";
  if (verticalRate !== null && verticalRate < -2) return alt < 1500 ? "approach" : "descent";
  if (alt > 6100) return "cruise";
  if (alt < 1500 && speed < 125) return "approach";
  return "cruise";
}

function buildPhaseBreakdown(points: FlightTrackPoint[]): FlightTrackPhase[] {
  if (points.length === 0) return [];

  const phases: FlightTrackPhase[] = [];
  let currentPhase = classifyPhase(points[0], null);
  let currentPoints: FlightTrackPoint[] = [points[0]];

  const flush = () => {
    if (currentPoints.length === 0) return;
    const startedAt = currentPoints[0].time;
    const endedAt = currentPoints[currentPoints.length - 1].time;
    const durationMinutes = Math.max(
      0,
      (flightTrackPointTimeMs(currentPoints[currentPoints.length - 1]) -
        flightTrackPointTimeMs(currentPoints[0])) /
        60_000,
    );
    phases.push({
      phase: currentPhase,
      startedAt,
      endedAt,
      durationMinutes,
      distanceKm: calculateSegmentDistanceKm(currentPoints),
      pointCount: currentPoints.length,
      avgAltitudeM: average(numericValues(currentPoints, "alt")),
      avgSpeedMs: average(numericValues(currentPoints, "speed")),
    });
  };

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const nextPhase = classifyPhase(point, previous);

    if (nextPhase !== currentPhase && currentPoints.length > 2) {
      flush();
      currentPhase = nextPhase;
      currentPoints = [previous, point];
    } else {
      currentPoints.push(point);
    }
  }

  flush();
  return phases;
}

function buildGaps(segments: FlightTrackSegment[]): FlightTrackGap[] {
  const gaps: FlightTrackGap[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const previous = segments[index - 1].points[segments[index - 1].points.length - 1];
    const next = segments[index].points[0];
    if (!previous || !next) continue;

    const durationMinutes =
      (flightTrackPointTimeMs(next) - flightTrackPointTimeMs(previous)) / 60_000;
    if (durationMinutes < GAP_MINUTES) continue;

    gaps.push({
      startTime: previous.time,
      endTime: next.time,
      durationMinutes,
      distanceKm: flightTrackDistanceKm(previous, next),
      startLat: previous.lat,
      startLon: previous.lon,
      endLat: next.lat,
      endLon: next.lon,
    });
  }
  return gaps;
}

function pushLayoverIfNew(layovers: FlightLayover[], layover: FlightLayover) {
  const start = Date.parse(layover.startTime);
  const end = Date.parse(layover.endTime);
  const duplicate = layovers.some((existing) => {
    const existingStart = Date.parse(existing.startTime);
    const existingEnd = Date.parse(existing.endTime);
    return Math.abs(existingStart - start) < 60_000 && Math.abs(existingEnd - end) < 60_000;
  });
  if (!duplicate) layovers.push(layover);
}

export function detectFlightLayovers(
  segments: FlightTrackSegment[],
  minDurationMinutes = GAP_MINUTES,
): FlightLayover[] {
  const layovers: FlightLayover[] = [];
  const ordered = sanitizeTrackSegments(segments);

  for (const gap of buildGaps(ordered)) {
    if (gap.durationMinutes < minDurationMinutes) continue;
    const distanceKm = gap.distanceKm ?? 0;
    pushLayoverIfNew(layovers, {
      startTime: gap.startTime,
      endTime: gap.endTime,
      durationMinutes: gap.durationMinutes,
      lat: distanceKm < 75 ? (gap.startLat + gap.endLat) / 2 : gap.startLat,
      lon: distanceKm < 75 ? (gap.startLon + gap.endLon) / 2 : gap.startLon,
      arrivalLat: gap.startLat,
      arrivalLon: gap.startLon,
      departureLat: gap.endLat,
      departureLon: gap.endLon,
      distanceKm,
      confidence: distanceKm < 25 ? "high" : distanceKm < 100 ? "medium" : "low",
      source: "segment_gap",
    });
  }

  for (const segment of ordered) {
    let cluster: FlightTrackPoint[] = [];
    const flush = () => {
      if (cluster.length < 2) {
        cluster = [];
        return;
      }

      const start = cluster[0];
      const end = cluster[cluster.length - 1];
      const durationMinutes =
        (flightTrackPointTimeMs(end) - flightTrackPointTimeMs(start)) / 60_000;
      const spreadKm = calculateSegmentDistanceKm(cluster);
      if (durationMinutes >= minDurationMinutes && spreadKm < 25) {
        const lat = average(cluster.map((point) => point.lat)) ?? start.lat;
        const lon = average(cluster.map((point) => point.lon)) ?? start.lon;
        pushLayoverIfNew(layovers, {
          startTime: start.time,
          endTime: end.time,
          durationMinutes,
          lat,
          lon,
          arrivalLat: start.lat,
          arrivalLon: start.lon,
          departureLat: end.lat,
          departureLon: end.lon,
          distanceKm: spreadKm,
          confidence: spreadKm < 8 ? "high" : "medium",
          source: "ground_cluster",
        });
      }
      cluster = [];
    };

    for (const point of segment.points) {
      if (pointIsGround(point)) {
        cluster.push(point);
      } else {
        flush();
      }
    }
    flush();
  }

  return layovers.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

function buildQuality(
  points: FlightTrackPoint[],
  gaps: FlightTrackGap[],
  durationMinutes: number | null,
): FlightTrackQuality {
  let score = 100;
  const reasons: string[] = [];

  if (points.length < 4) {
    score -= 40;
    reasons.push("very few track points");
  } else if (points.length < 12) {
    score -= 18;
    reasons.push("sparse track sample");
  }

  if (gaps.length > 0) {
    score -= Math.min(32, gaps.length * 10);
    reasons.push(`${gaps.length} signal gap${gaps.length === 1 ? "" : "s"}`);
  }

  const density =
    durationMinutes && durationMinutes > 0
      ? points.length / Math.max(durationMinutes / 60, 0.1)
      : null;
  if (density !== null && durationMinutes !== null && durationMinutes > 20 && density < 6) {
    score -= 15;
    reasons.push("low sample density");
  }

  const altitudeCoverage = numericValues(points, "alt").length / Math.max(points.length, 1);
  const speedCoverage = numericValues(points, "speed").length / Math.max(points.length, 1);
  if (altitudeCoverage < 0.5) {
    score -= 10;
    reasons.push("limited altitude data");
  }
  if (speedCoverage < 0.35) {
    score -= 8;
    reasons.push("limited speed data");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const label = score >= 85 ? "excellent" : score >= 68 ? "good" : score >= 42 ? "limited" : "poor";

  return {
    score,
    label,
    reasons: reasons.length > 0 ? reasons : ["continuous usable track"],
  };
}

export function analyzeFlightTrack(
  segments: FlightTrackSegment[],
  totalDistanceKmOverride: number | null = null,
): FlightTrackIntelligence {
  const cleanSegments = sanitizeTrackSegments(segments);
  const points = flattenTrackPoints(cleanSegments);
  const first = points[0] ?? null;
  const last = points[points.length - 1] ?? null;
  const startedAt = first?.time ?? null;
  const endedAt = last?.time ?? null;
  const durationMinutes =
    first && last
      ? Math.max(0, (flightTrackPointTimeMs(last) - flightTrackPointTimeMs(first)) / 60_000)
      : null;
  const airbornePoints = points.filter((point) => !pointIsGround(point));
  const altitudes = numericValues(points, "alt");
  const speeds = numericValues(points, "speed");
  const distanceKm =
    totalDistanceKmOverride ??
    cleanSegments.reduce((sum, segment) => sum + (segment.distanceKm ?? 0), 0);
  const computedDistance = distanceKm > 0 ? distanceKm : calculateSegmentDistanceKm(points);
  const straightLineKm = first && last ? flightTrackDistanceKm(first, last) : null;
  const gaps = buildGaps(cleanSegments);
  const verticalRates: number[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    if (previous.alt === null || point.alt === null) continue;
    const dtSeconds = (flightTrackPointTimeMs(point) - flightTrackPointTimeMs(previous)) / 1000;
    if (dtSeconds <= 5 || dtSeconds > 900) continue;
    verticalRates.push((point.alt - previous.alt) / dtSeconds);
  }

  const phaseBreakdown = buildPhaseBreakdown(points);
  const currentPhase = last ? classifyPhase(last, points[points.length - 2] ?? null) : "unknown";
  const pointDensityPerHour =
    durationMinutes && durationMinutes > 0 ? points.length / (durationMinutes / 60) : null;

  return {
    startedAt,
    endedAt,
    durationMinutes,
    airborneMinutes:
      durationMinutes === null
        ? null
        : (airbornePoints.length / Math.max(points.length, 1)) * durationMinutes,
    distanceKm: computedDistance > 0 ? computedDistance : null,
    straightLineKm,
    trackEfficiency:
      computedDistance > 0 && straightLineKm !== null && straightLineKm > 0
        ? straightLineKm / computedDistance
        : null,
    pointDensityPerHour,
    maxAltitudeM: altitudes.length > 0 ? Math.max(...altitudes) : null,
    minAltitudeM: altitudes.length > 0 ? Math.min(...altitudes) : null,
    avgAltitudeM: average(altitudes),
    maxSpeedMs: speeds.length > 0 ? Math.max(...speeds) : null,
    avgSpeedMs: average(speeds),
    maxVerticalRateMs: verticalRates.length > 0 ? Math.max(...verticalRates) : null,
    minVerticalRateMs: verticalRates.length > 0 ? Math.min(...verticalRates) : null,
    segmentCount: cleanSegments.length,
    pointCount: points.length,
    gapCount: gaps.length,
    gaps,
    phaseBreakdown,
    currentPhase,
    bounds: summarizeTrackBounds(points),
    quality: buildQuality(points, gaps, durationMinutes),
  };
}
