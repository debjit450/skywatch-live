import type { Flight } from "./opensky";

export type Severity = "low" | "medium" | "high" | "critical";
export type AnomalyType =
  | "ghost"
  | "squawk_7500"
  | "squawk_7600"
  | "squawk_7700"
  | "low_fast"
  | "rapid_descent"
  | "signal_lost"
  | "ml_anomaly"
  | "speed_anomaly"
  | "altitude_anomaly"
  | "heading_anomaly"
  | "position_anomaly"
  | "circling"
  | "trajectory_deviation"
  | "geofence"
  | "proximity"
  | "altitude_bust"
  | "speed_envelope"
  | "behavioral";

export interface Anomaly {
  type: AnomalyType;
  label: string;
  severity: Severity;
}

export interface AnomalousFlight extends Flight {
  anomalies: Anomaly[];
  detectedAt: number;
}

interface RobustStats {
  median: number;
  mad: number;
  count: number;
}

interface DetectionContext {
  now: number;
  speedStats: Map<string, RobustStats>;
  verticalStats: Map<string, RobustStats>;
  signalAgeStats: RobustStats | null;
}

const MIN_PEER_GROUP_SIZE = 24;
const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function robustStats(values: number[]): RobustStats | null {
  const finite = values.filter(Number.isFinite);
  if (finite.length < MIN_PEER_GROUP_SIZE) return null;
  const center = median(finite);
  const mad = median(finite.map((value) => Math.abs(value - center)));
  return { median: center, mad, count: finite.length };
}

function robustZ(value: number | null | undefined, stats: RobustStats | null): number {
  if (!isFiniteNumber(value) || !stats) return 0;
  const scale = Math.max(stats.mad * 1.4826, 1);
  return Math.abs((value - stats.median) / scale);
}

function altitudeBand(flight: Flight): string {
  const altitude = flight.baro_altitude ?? flight.geo_altitude;
  if (!isFiniteNumber(altitude)) return "unknown";
  if (altitude < 600) return "surface";
  if (altitude < 3_000) return "terminal";
  if (altitude < 8_000) return "low";
  if (altitude < 12_500) return "cruise";
  return "high";
}

function peerKey(flight: Flight): string {
  const categoryBucket = flight.category > 0 ? Math.floor(flight.category / 2) : 0;
  return `${altitudeBand(flight)}:${categoryBucket}`;
}

function buildStatsByKey(
  flights: Flight[],
  getValue: (flight: Flight) => number | null | undefined,
): Map<string, RobustStats> {
  const buckets = new Map<string, number[]>();
  const fallback = new Map<string, number[]>();

  for (const flight of flights) {
    if (flight.on_ground) continue;
    const value = getValue(flight);
    if (!isFiniteNumber(value)) continue;

    const key = peerKey(flight);
    const band = altitudeBand(flight);
    const keyed = buckets.get(key) ?? [];
    const banded = fallback.get(band) ?? [];
    keyed.push(value);
    banded.push(value);
    buckets.set(key, keyed);
    fallback.set(band, banded);
  }

  const result = new Map<string, RobustStats>();
  const fallbackStats = new Map<string, RobustStats>();
  for (const [band, values] of fallback) {
    const stats = robustStats(values);
    if (stats) fallbackStats.set(band, stats);
  }
  for (const [key, values] of buckets) {
    const stats = robustStats(values);
    if (stats) result.set(key, stats);
  }

  for (const flight of flights) {
    const key = peerKey(flight);
    if (result.has(key)) continue;
    const stats = fallbackStats.get(altitudeBand(flight));
    if (stats) result.set(key, stats);
  }

  return result;
}

function buildDetectionContext(
  flights: Flight[],
  now: number = Date.now() / 1000,
): DetectionContext {
  return {
    now,
    speedStats: buildStatsByKey(flights, (flight) => flight.velocity),
    verticalStats: buildStatsByKey(flights, (flight) =>
      isFiniteNumber(flight.vertical_rate) ? Math.abs(flight.vertical_rate) : null,
    ),
    signalAgeStats: robustStats(
      flights
        .filter((flight) => !flight.on_ground)
        .map((flight) => Math.max(0, now - flight.last_contact)),
    ),
  };
}

function severityForSignalAge(ageSeconds: number): Severity {
  if (ageSeconds > 900) return "medium";
  return "low";
}

export function detectAnomalies(
  flight: Flight,
  now: number = Date.now() / 1000,
  context?: DetectionContext,
): Anomaly[] {
  const ctx = context ?? buildDetectionContext([flight], now);
  const out: Anomaly[] = [];
  const signalAge = Math.max(0, now - flight.last_contact);
  const positionAge = flight.time_position ? Math.max(0, now - flight.time_position) : signalAge;
  const altitude = flight.baro_altitude ?? flight.geo_altitude;
  const velocity = flight.velocity ?? 0;
  const verticalRate = flight.vertical_rate ?? 0;
  const speedZ = robustZ(flight.velocity, ctx.speedStats.get(peerKey(flight)) ?? null);
  const verticalZ = robustZ(Math.abs(verticalRate), ctx.verticalStats.get(peerKey(flight)) ?? null);
  const signalZ = robustZ(signalAge, ctx.signalAgeStats);
  const airborne = !flight.on_ground;

  if (
    !flight.callsign?.trim() &&
    airborne &&
    signalAge > 300 &&
    (signalZ > 3.5 || signalAge > 600)
  ) {
    out.push({ type: "ghost", label: "Unidentified Stale Track", severity: "low" });
  }

  if (flight.squawk === "7500") {
    out.push({ type: "squawk_7500", label: "Hijack (7500)", severity: "high" });
  } else if (flight.squawk === "7600") {
    out.push({ type: "squawk_7600", label: "Radio Failure (7600)", severity: "high" });
  } else if (flight.squawk === "7700") {
    out.push({ type: "squawk_7700", label: "Emergency (7700)", severity: "high" });
  }

  const veryLowFast =
    airborne &&
    isFiniteNumber(altitude) &&
    altitude > 0 &&
    altitude < 220 &&
    velocity > 235 &&
    (speedZ > 2.5 || velocity > 285);
  const lowFastOutlier =
    airborne &&
    isFiniteNumber(altitude) &&
    altitude > 0 &&
    altitude < 500 &&
    velocity > 265 &&
    speedZ > 4;

  if (veryLowFast || lowFastOutlier) {
    out.push({ type: "low_fast", label: "Low Fast Outlier", severity: "high" });
  }

  const descentRate = -verticalRate;
  const isEmergencyDescent =
    airborne &&
    isFiniteNumber(altitude) &&
    altitude > 900 &&
    velocity > 45 &&
    (descentRate > 35 || (descentRate > 24 && verticalZ > 3.2));

  if (isEmergencyDescent) {
    out.push({
      type: "rapid_descent",
      label: descentRate > 35 ? "Emergency Descent" : "Rapid Descent Outlier",
      severity: descentRate > 35 ? "high" : "medium",
    });
  }

  const hasEmergencySquawk = !!flight.squawk && EMERGENCY_SQUAWKS.has(flight.squawk);
  const staleTrack =
    airborne &&
    signalAge > 300 &&
    positionAge > 240 &&
    !hasEmergencySquawk &&
    (signalAge > 600 || signalZ > 3);

  if (staleTrack) {
    out.push({
      type: "signal_lost",
      label: "Stale Signal Outlier",
      severity: severityForSignalAge(signalAge),
    });
  }

  if (
    isFiniteNumber(flight.ml_anomaly_score) &&
    flight.ml_anomaly_score < -0.55 &&
    out.length === 0
  ) {
    out.push({
      type: "ml_anomaly",
      label: "ML-Detected Anomaly",
      severity: flight.ml_anomaly_score < -0.7 ? "high" : "medium",
    });
  }

  return out;
}

export function flagFlights(flights: Flight[]): AnomalousFlight[] {
  const now = Date.now() / 1000;
  const detectedAt = Date.now();
  const context = buildDetectionContext(flights, now);
  const result: AnomalousFlight[] = [];
  for (const f of flights) {
    const a = detectAnomalies(f, now, context);
    if (a.length > 0) result.push({ ...f, anomalies: a, detectedAt });
  }
  return result;
}

export function severityRank(s: Severity): number {
  if (s === "critical") return 4;
  return s === "high" ? 3 : s === "medium" ? 2 : 1;
}
export function topSeverity(anomalies: Anomaly[]): Severity {
  return anomalies.reduce<Severity>(
    (acc, a) => (severityRank(a.severity) > severityRank(acc) ? a.severity : acc),
    "low",
  );
}
