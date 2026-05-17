import type { Flight } from "./opensky";

const EARTH_RADIUS_M = 6_371_000;
const M_TO_NM = 1 / 1852;

export const POSITION_SOURCE_LABELS = ["ADS-B", "ASTERIX", "MLAT", "FLARM"];

export type PredictionConfidence = "high" | "medium" | "low" | "stale";

export interface PredictedFlightState {
  latitude: number | null;
  longitude: number | null;
  baroAltitude: number | null;
  geoAltitude: number | null;
  elapsedSeconds: number;
  projectedSeconds: number;
  isPredicted: boolean;
  confidence: PredictionConfidence;
  confidenceScore: number;
  uncertaintyNm: number | null;
  sourceLabel: string;
}

interface SourceModel {
  score: number;
  baseUncertaintyMeters: number;
  maxProjectionSeconds: number;
  processNoisePerSecond: number;
}

const SOURCE_MODELS: SourceModel[] = [
  { score: 0.97, baseUncertaintyMeters: 45, maxProjectionSeconds: 95, processNoisePerSecond: 4.2 },
  { score: 0.86, baseUncertaintyMeters: 180, maxProjectionSeconds: 70, processNoisePerSecond: 6.5 },
  {
    score: 0.72,
    baseUncertaintyMeters: 520,
    maxProjectionSeconds: 42,
    processNoisePerSecond: 10.5,
  },
  { score: 0.78, baseUncertaintyMeters: 260, maxProjectionSeconds: 55, processNoisePerSecond: 8.5 },
];

const UNKNOWN_SOURCE_MODEL: SourceModel = {
  score: 0.58,
  baseUncertaintyMeters: 1_200,
  maxProjectionSeconds: 28,
  processNoisePerSecond: 15,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeLongitude(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sourceModel(positionSource: number): SourceModel {
  return SOURCE_MODELS[positionSource] ?? UNKNOWN_SOURCE_MODEL;
}

function destinationPoint(
  latitude: number,
  longitude: number,
  bearingDegrees: number,
  distanceMeters: number,
): { latitude: number; longitude: number } {
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

  return {
    latitude: (lat2 * 180) / Math.PI,
    longitude: normalizeLongitude((lon2 * 180) / Math.PI),
  };
}

function confidenceBand(score: number, elapsedSeconds: number): PredictionConfidence {
  if (elapsedSeconds > 240 || score < 0.22) return "stale";
  if (score >= 0.78) return "high";
  if (score >= 0.52) return "medium";
  return "low";
}

function hasMotionVector(flight: Flight): boolean {
  return (
    !flight.on_ground &&
    isFiniteNumber(flight.latitude) &&
    isFiniteNumber(flight.longitude) &&
    isFiniteNumber(flight.velocity) &&
    isFiniteNumber(flight.true_track) &&
    flight.velocity > 8
  );
}

function verticalRateForProjection(
  verticalRate: number | null,
  altitude: number | null,
): number | null {
  if (!isFiniteNumber(verticalRate)) return null;
  const absoluteRate = Math.abs(verticalRate);
  if (absoluteRate > 75) return null;
  if (altitude !== null && altitude < 120 && verticalRate < -3) return Math.max(verticalRate, -3);
  return verticalRate;
}

function adaptiveProjectionSeconds(
  flight: Flight,
  elapsedSeconds: number,
  requestedMaxProjectionSeconds: number,
): number {
  if (!hasMotionVector(flight)) return 0;

  const model = sourceModel(flight.position_source);
  const signalAge = Math.max(0, elapsedSeconds);
  const speed = flight.velocity ?? 0;
  const sourceLimit = model.maxProjectionSeconds;
  const speedLimit = speed > 260 ? 45 : speed > 220 ? 60 : sourceLimit;
  const staleLimit = signalAge > 180 ? 0 : signalAge > 120 ? 18 : signalAge > 75 ? 35 : sourceLimit;
  const capped = Math.min(requestedMaxProjectionSeconds, sourceLimit, speedLimit, staleLimit);
  return Math.max(0, Math.min(elapsedSeconds, capped));
}

function motionPenalty(flight: Flight): number {
  if (flight.on_ground) return 0;
  if (!hasMotionVector(flight)) return 0.26;

  let penalty = 0;
  const speed = flight.velocity ?? 0;
  const verticalRate = Math.abs(flight.vertical_rate ?? 0);
  if (speed > 285) penalty += 0.08;
  if (verticalRate > 25) penalty += 0.08;
  if (verticalRate > 45) penalty += 0.12;
  if (flight.spi) penalty += 0.06;
  return penalty;
}

function estimateUncertaintyMeters(
  flight: Flight,
  projectedSeconds: number,
  staleSeconds: number,
  confidenceScore: number,
): number {
  const model = sourceModel(flight.position_source);
  const velocity = flight.velocity ?? 0;
  const verticalRate = Math.abs(flight.vertical_rate ?? 0);
  const maneuverNoise = verticalRate > 20 ? 1.35 : verticalRate > 10 ? 1.15 : 1;
  const speedNoise = 1 + clamp(velocity / 260, 0, 1.2) * 0.32;
  const confidenceNoise = 1 + (1 - confidenceScore) * 1.8;

  return (
    model.baseUncertaintyMeters +
    projectedSeconds * model.processNoisePerSecond * speedNoise * maneuverNoise +
    staleSeconds * (model.processNoisePerSecond * 3.2 + velocity * 0.09) * confidenceNoise
  );
}

export function predictFlightState(
  flight: Flight,
  nowSeconds: number = Date.now() / 1000,
  maxProjectionSeconds = 120,
): PredictedFlightState {
  const sourceLabel = POSITION_SOURCE_LABELS[flight.position_source] || "Unknown";
  const model = sourceModel(flight.position_source);
  const baseTime = flight.time_position ?? flight.last_contact;
  const elapsedSeconds = Math.max(0, nowSeconds - baseTime);
  const projectedSeconds = adaptiveProjectionSeconds(flight, elapsedSeconds, maxProjectionSeconds);

  const projectedPosition =
    projectedSeconds > 0 &&
    isFiniteNumber(flight.latitude) &&
    isFiniteNumber(flight.longitude) &&
    isFiniteNumber(flight.true_track) &&
    isFiniteNumber(flight.velocity)
      ? destinationPoint(
          flight.latitude,
          flight.longitude,
          flight.true_track,
          flight.velocity * projectedSeconds,
        )
      : { latitude: flight.latitude, longitude: flight.longitude };

  const verticalRate = verticalRateForProjection(
    flight.vertical_rate,
    flight.baro_altitude ?? flight.geo_altitude,
  );
  const verticalProjectionSeconds =
    verticalRate === null ? 0 : projectedSeconds * clamp(1 - elapsedSeconds / 240, 0.25, 1);
  const baroAltitude =
    flight.baro_altitude !== null && verticalRate !== null
      ? Math.max(0, flight.baro_altitude + verticalRate * verticalProjectionSeconds)
      : flight.baro_altitude;
  const geoAltitude =
    flight.geo_altitude !== null && verticalRate !== null
      ? Math.max(0, flight.geo_altitude + verticalRate * verticalProjectionSeconds)
      : flight.geo_altitude;

  const staleSeconds = Math.max(0, elapsedSeconds - projectedSeconds);
  const agePenalty = Math.min(0.82, elapsedSeconds / 260);
  const stalePenalty = staleSeconds > 0 ? Math.min(0.25, staleSeconds / 420) : 0;
  const confidenceScore = clamp(
    model.score - agePenalty - stalePenalty - motionPenalty(flight),
    0.05,
    0.99,
  );
  const uncertaintyNm =
    flight.latitude === null || flight.longitude === null
      ? null
      : estimateUncertaintyMeters(flight, projectedSeconds, staleSeconds, confidenceScore) *
        M_TO_NM;

  return {
    latitude: projectedPosition.latitude,
    longitude: projectedPosition.longitude,
    baroAltitude,
    geoAltitude,
    elapsedSeconds,
    projectedSeconds,
    isPredicted: projectedSeconds > 1,
    confidence: confidenceBand(confidenceScore, elapsedSeconds),
    confidenceScore,
    uncertaintyNm,
    sourceLabel,
  };
}
