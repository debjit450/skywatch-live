import { useEffect, useRef, useCallback, useReducer } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Flight } from "@/lib/opensky";
import {
  flagFlights,
  type AnomalousFlight,
  type Anomaly,
  type AnomalyType,
  type Severity,
} from "@/lib/anomaly";
import { isFiniteCoordinate, normalizeIcao24 } from "@/lib/api-safety";
import { inferDataSource } from "@/lib/data-sources";
import { ANOMALY_TYPE_LABELS } from "@/lib/flightFilters";

export type Status = "idle" | "loading" | "live" | "reconnecting" | "error";

const POLL_MS = 30_000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_POSITION_AGE_SECONDS = 180;
const MAX_HISTORY = 5_000;
const MAX_SEEN_ANOMALIES = 10_000;
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const MAX_WS_RECONNECT_ATTEMPTS = 10;

const configuredApiBase = (
  import.meta.env.VITE_SKYWATCH_API_BASE ||
  import.meta.env.VITE_SKYWATCH_API_URL ||
  import.meta.env.VITE_API_URL ||
  ""
).replace(/\/+$/, "");

const configuredWsUrl = import.meta.env.VITE_SKYWATCH_WS_URL || "";
const configuredDemoMode = import.meta.env.VITE_SKYWATCH_DEMO_MODE === "true";

export interface SourceHealth {
  status?: string;
  enabled?: boolean;
  confidence_score?: number;
  last_success_at?: string | null;
  last_error_at?: string | null;
  last_error?: string;
  consecutive_failures?: number;
  rate_limited_until?: string | null;
  circuit_open_until?: string | null;
  latency_ms?: number;
  aircraft_count?: number;
  normalized_count?: number;
  rejected_count?: number;
  updated_at?: string | null;
}

interface FlightsResponse {
  time: number;
  flights: Flight[];
  states?: Flight[];
  authenticated?: boolean;
  error?: string;
  source?: string;
  max_age_seconds?: number;
  stale_count?: number;
  source_counts?: Record<string, number>;
  source_health?: Record<string, SourceHealth>;
  source_conflict_count?: number;
  degraded?: boolean;
}

interface FlightUpdatePayload {
  time?: number;
  flights?: Flight[];
  states?: Flight[];
  authenticated?: boolean;
  source?: string;
  source_counts?: Record<string, number>;
  source_health?: Record<string, SourceHealth>;
  source_conflict_count?: number;
  degraded?: boolean;
  sequence?: number;
}

interface BackendAnomaly {
  id: number;
  icao24: string;
  callsign: string;
  origin_country: string;
  anomaly_type: string;
  severity: string;
  confidence_score: number;
  ml_score: number | null;
  details: {
    squawk?: string | null;
    [key: string]: unknown;
  } | null;
  explanation?: Anomaly["explanation"];
  source?: string;
  detected_at: string;
  resolved_at: string | null;
  is_active: boolean;
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  velocity: number | null;
}

const VALID_SEVERITIES = new Set<Severity>(["low", "medium", "high", "critical"]);
const VALID_ANOMALY_TYPES = new Set<AnomalyType>(Object.keys(ANOMALY_TYPE_LABELS) as AnomalyType[]);

function normalizeBackendAnomalyType(value: string): AnomalyType {
  return VALID_ANOMALY_TYPES.has(value as AnomalyType) ? (value as AnomalyType) : "ml_anomaly";
}

function normalizeBackendSeverity(value: string): Severity {
  return VALID_SEVERITIES.has(value as Severity) ? (value as Severity) : "medium";
}

interface AnomalyAlertPayload {
  flight?: Flight;
  anomalies?: Anomaly[] | BackendAnomaly[];
}

interface WebSocketMessage {
  type?: string;
  data?: FlightUpdatePayload | AnomalyAlertPayload;
}

type AnomalyHistoryEntry = {
  time: number;
  altitude: number | null;
  speed: number | null;
  heading: number | null;
};

interface FlightsState {
  flights: Flight[];
  currentAnomalies: AnomalousFlight[];
  anomalies: AnomalousFlight[];
  anomalyHistory: Record<string, AnomalyHistoryEntry[]>;
  lastUpdated: number | null;
  feedSource: string | null;
  sourceCounts: Record<string, number>;
  sourceHealth: Record<string, SourceHealth>;
  sourceConflictCount: number;
  degraded: boolean;
  staleCount: number;
  maxAgeSeconds: number | null;
  status: Status;
  isFetching: boolean;
  errorMessage: string | null;
  authenticated: boolean | null;
  reconnectAttempt: number;
  connectionLost: boolean;
  lastSequence: number | null;
}

type FlightsAction =
  | { type: "fetch_started"; hasSnapshot: boolean }
  | { type: "fetch_finished" }
  | { type: "fetch_failed"; message: string }
  | {
      type: "snapshot_applied";
      flights: Flight[];
      currentAnomalies: AnomalousFlight[];
      freshAnomalies: AnomalousFlight[];
      updatedAt: number;
      metadata: {
        authenticated?: boolean;
        source?: string;
        staleCount?: number;
        maxAgeSeconds?: number;
        sourceCounts?: Record<string, number>;
        sourceHealth?: Record<string, SourceHealth>;
        sourceConflictCount?: number;
        degraded?: boolean;
        sequence?: number;
      };
    }
  | { type: "ws_open"; hasSnapshot: boolean }
  | { type: "ws_initial_error"; message: string }
  | { type: "ws_reconnecting"; attempt: number; hasSnapshot: boolean }
  | { type: "ws_lost"; hasSnapshot: boolean }
  | { type: "flight_patch"; flight: Flight }
  | {
      type: "anomaly_alerts_merged";
      anomalies: AnomalousFlight[];
      freshAnomalies: AnomalousFlight[];
    };

const INITIAL_FLIGHTS_STATE: FlightsState = {
  flights: [],
  currentAnomalies: [],
  anomalies: [],
  anomalyHistory: {},
  lastUpdated: null,
  feedSource: null,
  sourceCounts: {},
  sourceHealth: {},
  sourceConflictCount: 0,
  degraded: false,
  staleCount: 0,
  maxAgeSeconds: null,
  status: "idle",
  isFetching: false,
  errorMessage: null,
  authenticated: null,
  reconnectAttempt: 0,
  connectionLost: false,
  lastSequence: null,
};

function getFlightsRestUrls(): string[] {
  if (configuredDemoMode) return ["/api/flights?demo=1"];
  if (!configuredApiBase) return ["/api/flights"];

  let backendUrl: string;
  if (/\/flights\/?$/.test(configuredApiBase)) {
    backendUrl = `${configuredApiBase}/`;
  } else if (/\/api\/v1\/?$/.test(configuredApiBase)) {
    backendUrl = `${configuredApiBase}/flights/`;
  } else {
    backendUrl = `${configuredApiBase}/api/v1/flights/`;
  }

  return ["/api/flights", backendUrl];
}

function isLastCandidate(index: number, urls: string[]): boolean {
  return index === urls.length - 1;
}

function getAnomaliesRestUrls(): string[] {
  if (!configuredApiBase) return [];

  let backendUrl: string;
  if (/\/flights\/?$/.test(configuredApiBase)) {
    backendUrl = configuredApiBase.replace(/\/flights\/?$/, "/anomalies/");
  } else if (/\/api\/v1\/?$/.test(configuredApiBase)) {
    backendUrl = `${configuredApiBase}/anomalies/`;
  } else {
    backendUrl = `${configuredApiBase}/api/v1/anomalies/`;
  }

  return [backendUrl];
}

function getFlightsWsUrl(): string | null {
  if (configuredWsUrl) return configuredWsUrl;
  if (!configuredApiBase || typeof window === "undefined") return null;

  const backendRoot = configuredApiBase.replace(/\/api\/v1(?:\/flights)?\/?$/, "");
  try {
    const url = new URL(backendRoot, window.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws/flights/";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchFlightsCandidate(url: string, signal: AbortSignal): Promise<FlightsResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const abort = () => controller.abort();

  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const payload = (await res.json().catch(() => ({}))) as FlightsResponse;
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    return payload;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

async function fetchBackendAnomaliesCandidate(
  url: string,
  signal: AbortSignal,
): Promise<BackendAnomaly[] | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const abort = () => controller.abort();

  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", abort, { once: true });
  }

  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || !payload || !Array.isArray(payload.anomalies)) return null;
    return payload.anomalies as BackendAnomaly[];
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

function hasFlightRows(payload: FlightsResponse): boolean {
  const rows = payload.flights ?? payload.states;
  return Array.isArray(rows) && rows.length > 0;
}

function samePredictedPath(a: Flight["predicted_path"], b: Flight["predicted_path"]): boolean {
  if (a === b) return true;
  const left = Array.isArray(a) ? a : [];
  const right = Array.isArray(b) ? b : [];
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (
      l.lat !== r.lat ||
      l.lon !== r.lon ||
      l.alt !== r.alt ||
      l.timestamp !== r.timestamp ||
      l.minutes_ahead !== r.minutes_ahead ||
      l.confidence !== r.confidence
    ) {
      return false;
    }
  }
  return true;
}

function sameSensors(a: Flight["sensors"], b: Flight["sensors"]): boolean {
  if (a === b) return true;
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function sameFlightSnapshot(a: Flight, b: Flight): boolean {
  return (
    a.icao24 === b.icao24 &&
    a.callsign === b.callsign &&
    a.origin_country === b.origin_country &&
    a.time_position === b.time_position &&
    a.last_contact === b.last_contact &&
    a.longitude === b.longitude &&
    a.latitude === b.latitude &&
    a.baro_altitude === b.baro_altitude &&
    a.on_ground === b.on_ground &&
    a.velocity === b.velocity &&
    a.true_track === b.true_track &&
    a.vertical_rate === b.vertical_rate &&
    sameSensors(a.sensors, b.sensors) &&
    a.geo_altitude === b.geo_altitude &&
    a.squawk === b.squawk &&
    a.spi === b.spi &&
    a.position_source === b.position_source &&
    a.category === b.category &&
    a.data_source === b.data_source &&
    a.source_confidence === b.source_confidence &&
    JSON.stringify(a.source_provenance ?? []) === JSON.stringify(b.source_provenance ?? []) &&
    JSON.stringify(a.source_conflicts ?? []) === JSON.stringify(b.source_conflicts ?? []) &&
    a.ml_anomaly_score === b.ml_anomaly_score &&
    a.prediction_confidence === b.prediction_confidence &&
    samePredictedPath(a.predicted_path, b.predicted_path)
  );
}

function normalizeFlights(
  flights: Flight[] | undefined,
  previousById: Map<string, Flight> = new Map(),
  previousList: Flight[] = [],
): Flight[] {
  if (!Array.isArray(flights)) return [];

  const nowSeconds = Date.now() / 1000;
  const normalized = flights
    .filter((flight) => {
      if (!flight) return false;
      const icao24 = normalizeIcao24(flight.icao24);
      const lastContact =
        typeof flight.last_contact === "number" && Number.isFinite(flight.last_contact)
          ? flight.last_contact
          : null;
      const timePosition =
        typeof flight.time_position === "number" && Number.isFinite(flight.time_position)
          ? flight.time_position
          : lastContact;
      const fixAgeSeconds = timePosition ? nowSeconds - timePosition : Infinity;
      return (
        !!icao24 &&
        typeof flight.latitude === "number" &&
        typeof flight.longitude === "number" &&
        isFiniteCoordinate(flight.latitude, flight.longitude) &&
        lastContact !== null &&
        fixAgeSeconds >= -30 &&
        fixAgeSeconds <= MAX_POSITION_AGE_SECONDS
      );
    })
    .map((flight) => {
      const icao24 = normalizeIcao24(flight.icao24) ?? flight.icao24.toLowerCase();
      const candidate: Flight = {
        ...flight,
        icao24,
        callsign: flight.callsign ? flight.callsign.trim() || null : null,
        origin_country: flight.origin_country || "",
        time_position: flight.time_position ?? null,
        last_contact: flight.last_contact ?? nowSeconds,
        baro_altitude: flight.baro_altitude ?? null,
        velocity: flight.velocity ?? null,
        true_track: flight.true_track ?? null,
        vertical_rate: flight.vertical_rate ?? null,
        sensors: flight.sensors ?? null,
        geo_altitude: flight.geo_altitude ?? null,
        squawk: flight.squawk ?? null,
        spi: Boolean(flight.spi),
        position_source: flight.position_source ?? 0,
        category: flight.category ?? 0,
        data_source: inferDataSource(flight.data_source, flight.position_source),
        source_confidence:
          typeof flight.source_confidence === "number" ? flight.source_confidence : undefined,
        source_provenance: Array.isArray(flight.source_provenance)
          ? flight.source_provenance
          : undefined,
        source_conflicts: Array.isArray(flight.source_conflicts)
          ? flight.source_conflicts
          : undefined,
        predicted_path: Array.isArray(flight.predicted_path) ? flight.predicted_path : [],
        prediction_confidence:
          typeof flight.prediction_confidence === "number" ? flight.prediction_confidence : 0,
      };
      const previous = previousById.get(icao24);
      return previous && sameFlightSnapshot(previous, candidate) ? previous : candidate;
    });

  if (
    previousList.length === normalized.length &&
    normalized.every((flight, index) => flight === previousList[index])
  ) {
    return previousList;
  }

  return normalized;
}

function anomalyKey(flight: AnomalousFlight): string {
  const signature = flight.anomalies
    .map((anomaly) => anomaly.type)
    .sort()
    .join("|");
  return `${flight.icao24}:${signature}`;
}

function pruneSeen(seen: Map<string, number>, now: number) {
  for (const [key, timestamp] of seen) {
    if (now - timestamp > SEEN_TTL_MS) seen.delete(key);
  }

  if (seen.size <= MAX_SEEN_ANOMALIES) return;

  const overflow = seen.size - MAX_SEEN_ANOMALIES;
  const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, overflow);
  for (const [key] of oldest) seen.delete(key);
}

function collectFreshAnomalies(
  seen: Map<string, number>,
  flagged: AnomalousFlight[],
): AnomalousFlight[] {
  const now = Date.now();
  pruneSeen(seen, now);

  const fresh: AnomalousFlight[] = [];
  for (const anomaly of flagged) {
    const key = anomalyKey(anomaly);
    if (!seen.has(key)) fresh.push(anomaly);
    seen.set(key, now);
  }
  return fresh;
}

function prependAnomalies(current: AnomalousFlight[], fresh: AnomalousFlight[]): AnomalousFlight[] {
  return fresh.length > 0 ? [...fresh, ...current].slice(0, MAX_HISTORY) : current;
}

function updateAnomalyHistory(
  current: Record<string, AnomalyHistoryEntry[]>,
  flagged: AnomalousFlight[],
  updatedAt: number,
): Record<string, AnomalyHistoryEntry[]> {
  if (flagged.length === 0) return current;

  let changed = false;
  const next = { ...current };
  const timestamp = Math.floor(updatedAt / 1000);

  for (const flight of flagged) {
    const entries = next[flight.icao24] ?? [];
    const last = entries[entries.length - 1];
    const altitude = flight.baro_altitude ?? flight.geo_altitude ?? null;
    const speed = flight.velocity ?? null;
    const heading = flight.true_track ?? null;
    const sameSecond = !!last && last.time === timestamp;
    const sameValues =
      !!last && last.altitude === altitude && last.speed === speed && last.heading === heading;

    if (sameSecond && sameValues) continue;

    next[flight.icao24] = [...entries, { time: timestamp, altitude, speed, heading }].slice(-200);
    changed = true;
  }

  return changed ? next : current;
}

function mergeCurrentAnomalies(
  current: AnomalousFlight[],
  incoming: AnomalousFlight[],
): AnomalousFlight[] {
  if (incoming.length === 0) return current;

  const next = [...current];
  for (const anomaly of incoming) {
    const index = next.findIndex((item) => item.icao24 === anomaly.icao24);
    if (index >= 0) {
      const existing = next[index];
      const mergedAnomalies = [...existing.anomalies];
      for (const item of anomaly.anomalies) {
        if (!mergedAnomalies.some((existingItem) => existingItem.type === item.type)) {
          mergedAnomalies.push(item);
        }
      }
      next[index] = {
        ...existing,
        ...anomaly,
        anomalies: mergedAnomalies,
        detectedAt: Math.max(existing.detectedAt, anomaly.detectedAt),
      };
    } else {
      next.unshift(anomaly);
    }
  }
  return next;
}

function flightsReducer(state: FlightsState, action: FlightsAction): FlightsState {
  switch (action.type) {
    case "fetch_started":
      return {
        ...state,
        isFetching: true,
        status: action.hasSnapshot
          ? state.status === "error"
            ? "reconnecting"
            : state.status
          : "loading",
      };
    case "fetch_finished":
      return state.isFetching ? { ...state, isFetching: false } : state;
    case "fetch_failed":
      return {
        ...state,
        isFetching: false,
        errorMessage: action.message,
        status: state.lastUpdated || state.status === "live" ? "reconnecting" : "error",
      };
    case "snapshot_applied": {
      const hasSourceCounts =
        action.metadata.sourceCounts && Object.keys(action.metadata.sourceCounts).length > 0;
      return {
        ...state,
        flights: action.flights,
        currentAnomalies: action.currentAnomalies,
        anomalies: prependAnomalies(state.anomalies, action.freshAnomalies),
        anomalyHistory: updateAnomalyHistory(
          state.anomalyHistory,
          action.currentAnomalies,
          action.updatedAt,
        ),
        lastUpdated: action.updatedAt,
        authenticated:
          typeof action.metadata.authenticated === "boolean"
            ? action.metadata.authenticated
            : state.authenticated,
        feedSource: action.metadata.source ?? null,
        sourceCounts: hasSourceCounts
          ? (action.metadata.sourceCounts as Record<string, number>)
          : state.sourceCounts,
        sourceHealth: action.metadata.sourceHealth ?? state.sourceHealth,
        sourceConflictCount: action.metadata.sourceConflictCount ?? state.sourceConflictCount,
        degraded: action.metadata.degraded ?? false,
        staleCount: action.metadata.staleCount ?? 0,
        maxAgeSeconds:
          typeof action.metadata.maxAgeSeconds === "number" &&
          Number.isFinite(action.metadata.maxAgeSeconds)
            ? action.metadata.maxAgeSeconds
            : null,
        errorMessage: null,
        status: "live",
        connectionLost: false,
        lastSequence: action.metadata.sequence ?? state.lastSequence,
      };
    }
    case "ws_open":
      return {
        ...state,
        reconnectAttempt: 0,
        connectionLost: false,
        errorMessage: null,
        status: action.hasSnapshot ? "live" : "loading",
      };
    case "ws_initial_error":
      return state.lastUpdated ? state : { ...state, errorMessage: action.message };
    case "ws_reconnecting":
      return {
        ...state,
        reconnectAttempt: action.attempt,
        status: action.hasSnapshot ? "live" : "error",
      };
    case "ws_lost":
      return {
        ...state,
        connectionLost: true,
        status: action.hasSnapshot ? "live" : "error",
        errorMessage: action.hasSnapshot ? null : "Connection lost",
      };
    case "flight_patch": {
      const index = state.flights.findIndex((flight) => flight.icao24 === action.flight.icao24);
      if (index < 0) return state;
      const nextFlights = [...state.flights];
      nextFlights[index] = { ...nextFlights[index], ...action.flight };
      return { ...state, flights: nextFlights };
    }
    case "anomaly_alerts_merged":
      return {
        ...state,
        currentAnomalies: mergeCurrentAnomalies(state.currentAnomalies, action.anomalies),
        anomalies: prependAnomalies(state.anomalies, action.freshAnomalies),
      };
    default:
      return state;
  }
}

function isAnomalyAlertPayload(
  data: FlightUpdatePayload | AnomalyAlertPayload | undefined,
): data is AnomalyAlertPayload {
  return Boolean(data && typeof data === "object" && ("flight" in data || "anomalies" in data));
}

function isFlightUpdatePayload(
  data: FlightUpdatePayload | AnomalyAlertPayload | undefined,
): data is FlightUpdatePayload {
  return Boolean(
    data &&
    typeof data === "object" &&
    ("flights" in data || "states" in data || "time" in data || "authenticated" in data),
  );
}

export interface FirstSeenPosition {
  lat: number;
  lon: number;
  missCount: number;
}

const FIRST_SEEN_MISS_LIMIT = 20;

export function useFlights() {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(flightsReducer, INITIAL_FLIGHTS_STATE);
  const {
    flights,
    currentAnomalies,
    anomalies,
    anomalyHistory,
    lastUpdated,
    feedSource,
    sourceCounts,
    sourceHealth,
    sourceConflictCount,
    degraded,
    staleCount,
    maxAgeSeconds,
    status,
    isFetching,
    errorMessage,
    authenticated,
    reconnectAttempt,
    connectionLost,
    lastSequence,
  } = state;
  const seenRef = useRef<Map<string, number>>(new Map());
  const firstSeenRef = useRef<Map<string, FirstSeenPosition>>(new Map());
  const inFlightRef = useRef(false);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const lastUpdatedRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const flightsRef = useRef<Flight[]>([]);
  const flightsByIdRef = useRef<Map<string, Flight>>(new Map());
  const lastSequenceRef = useRef<number | null>(null);
  useEffect(() => {
    flightsRef.current = flights;
    flightsByIdRef.current = new Map(flights.map((flight) => [flight.icao24, flight]));
  }, [flights]);
  useEffect(() => {
    lastSequenceRef.current = lastSequence;
  }, [lastSequence]);

  const applyFlightSnapshot = useCallback(
    (
      nextFlights: Flight[] | undefined,
      metadata: {
        time?: number;
        authenticated?: boolean;
        source?: string;
        staleCount?: number;
        maxAgeSeconds?: number;
        backendAnomalies?: BackendAnomaly[];
        sourceCounts?: Record<string, number>;
        sourceHealth?: Record<string, SourceHealth>;
        sourceConflictCount?: number;
        degraded?: boolean;
        sequence?: number;
      } = {},
    ) => {
      const normalized = normalizeFlights(nextFlights, flightsByIdRef.current, flightsRef.current);
      const updatedAt =
        typeof metadata.time === "number" && metadata.time > 0 ? metadata.time * 1000 : Date.now();
      const previousUpdatedAt = lastUpdatedRef.current;

      if (previousUpdatedAt !== null && updatedAt + 1_000 < previousUpdatedAt) {
        return;
      }

      queryClient.setQueryData(["flights"], {
        time: metadata.time ?? Math.floor(Date.now() / 1000),
        flights: normalized,
        authenticated: metadata.authenticated,
      });

      const currentIds = new Set<string>();
      for (const f of normalized) {
        if (f.latitude !== null && f.longitude !== null) {
          currentIds.add(f.icao24);
          if (!firstSeenRef.current.has(f.icao24)) {
            firstSeenRef.current.set(f.icao24, { lat: f.latitude, lon: f.longitude, missCount: 0 });
          } else {
            const entry = firstSeenRef.current.get(f.icao24)!;
            entry.missCount = 0;
          }
        }
      }
      for (const [id, entry] of firstSeenRef.current) {
        if (!currentIds.has(id)) {
          entry.missCount += 1;
          if (entry.missCount >= FIRST_SEEN_MISS_LIMIT) {
            firstSeenRef.current.delete(id);
          }
        }
      }

      const clientFlagged = flagFlights(normalized);
      const mergedAnomaliesMap = new Map<string, AnomalousFlight>();

      // 1. Add all client-side flagged anomalies first
      for (const f of clientFlagged) {
        mergedAnomaliesMap.set(f.icao24, f);
      }

      // 2. Add backend active anomalies (mapping them and merging if flight already exists)
      // Filter out anomalies older than 1 hour to prevent showing stale data
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      const bAnoms = (metadata.backendAnomalies || []).filter((ea) => {
        const detectedTime = new Date(ea.detected_at).getTime();
        return detectedTime > oneHourAgo;
      });

      for (const ea of bAnoms) {
        const label = ANOMALY_TYPE_LABELS[ea.anomaly_type] || ea.anomaly_type.replace(/_/g, " ");
        const anomalyItem: Anomaly = {
          id: ea.id,
          type: normalizeBackendAnomalyType(ea.anomaly_type),
          label,
          severity: normalizeBackendSeverity(ea.severity),
          source: ea.source,
          explanation: ea.explanation,
        };

        const existing = mergedAnomaliesMap.get(ea.icao24);
        if (existing) {
          if (!existing.anomalies.some((item) => item.type === anomalyItem.type)) {
            existing.anomalies.push(anomalyItem);
          }
          existing.detectedAt = Math.max(existing.detectedAt, new Date(ea.detected_at).getTime());
        } else {
          const liveFlight = normalized.find((f) => f.icao24 === ea.icao24);
          if (liveFlight) {
            mergedAnomaliesMap.set(ea.icao24, {
              ...liveFlight,
              anomalies: [anomalyItem],
              detectedAt: new Date(ea.detected_at).getTime(),
            });
          } else {
            const fallback: AnomalousFlight = {
              icao24: ea.icao24,
              callsign: ea.callsign || null,
              origin_country: ea.origin_country || "",
              time_position: new Date(ea.detected_at).getTime() / 1000,
              last_contact: new Date(ea.detected_at).getTime() / 1000,
              longitude: ea.longitude,
              latitude: ea.latitude,
              baro_altitude: ea.altitude,
              on_ground: false,
              velocity: ea.velocity,
              true_track: null,
              vertical_rate: null,
              sensors: null,
              geo_altitude: ea.altitude,
              squawk: ea.details?.squawk || null,
              spi: false,
              position_source: 0,
              category: 0,
              ml_anomaly_score: ea.ml_score,
              data_source: "backend",
              anomalies: [anomalyItem],
              detectedAt: new Date(ea.detected_at).getTime(),
            };
            mergedAnomaliesMap.set(ea.icao24, fallback);
          }
        }
      }

      const flagged = Array.from(mergedAnomaliesMap.values());
      const freshAnomalies = collectFreshAnomalies(seenRef.current, flagged);

      lastUpdatedRef.current = updatedAt;
      flightsRef.current = normalized;
      flightsByIdRef.current = new Map(normalized.map((flight) => [flight.icao24, flight]));
      dispatch({
        type: "snapshot_applied",
        flights: normalized,
        currentAnomalies: flagged,
        freshAnomalies,
        updatedAt,
        metadata,
      });
    },
    [queryClient],
  );

  const fetchOnce = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    dispatch({ type: "fetch_started", hasSnapshot: Boolean(lastUpdatedRef.current) });

    try {
      let data: FlightsResponse | null = null;
      let lastError: Error | null = null;
      let usedFlightsUrl: string | null = null;

      const flightUrls = getFlightsRestUrls();
      for (let index = 0; index < flightUrls.length; index += 1) {
        const url = flightUrls[index];
        try {
          const payload = await fetchFlightsCandidate(url, controller.signal);
          if (
            !hasFlightRows(payload) &&
            !isLastCandidate(index, flightUrls) &&
            ((payload.stale_count ?? 0) > 0 || payload.source === "cache")
          ) {
            throw new Error("Flight feed returned only stale positions");
          }
          data = payload;
          usedFlightsUrl = url;
          break;
        } catch (err) {
          if (controller.signal.aborted) throw err;
          lastError = err instanceof Error ? err : new Error("Flight feed unavailable");
        }
      }

      if (!data) throw lastError ?? new Error("Flight feed unavailable");

      let backendAnomalies: BackendAnomaly[] = [];
      if (usedFlightsUrl !== "/api/flights") {
        for (const url of getAnomaliesRestUrls()) {
          try {
            const anomalies = await fetchBackendAnomaliesCandidate(url, controller.signal);
            if (anomalies !== null) {
              backendAnomalies = anomalies;
              break;
            }
          } catch (err) {
            if (controller.signal.aborted) throw err;
            console.warn("Failed to fetch active anomalies", err);
          }
        }
      }

      applyFlightSnapshot(data.flights ?? data.states, {
        time: data.time,
        authenticated: data.authenticated,
        source: data.source,
        staleCount: data.stale_count,
        maxAgeSeconds: data.max_age_seconds,
        backendAnomalies,
        sourceCounts: data.source_counts,
        sourceHealth: data.source_health,
        sourceConflictCount: data.source_conflict_count,
        degraded: data.degraded,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Flight feed unavailable";
      dispatch({
        type: "fetch_failed",
        message: controller.signal.aborted ? "Flight feed timed out" : message,
      });
    } finally {
      if (fetchAbortRef.current === controller) {
        fetchAbortRef.current = null;
      }
      inFlightRef.current = false;
      dispatch({ type: "fetch_finished" });
    }
  }, [applyFlightSnapshot]);

  useEffect(() => {
    fetchOnce();
    const id = window.setInterval(fetchOnce, POLL_MS);
    return () => {
      window.clearInterval(id);
      fetchAbortRef.current?.abort();
    };
  }, [fetchOnce]);

  useEffect(() => {
    const wsUrl = getFlightsWsUrl();
    if (!wsUrl) return;

    let closed = false;
    let reconnectAttempt = 0;

    const connect = () => {
      if (closed) return;

      // Browser WebSocket handshakes automatically advertise per-message deflate
      // when the server supports it; no custom header is allowed from JS.
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt = 0;
        dispatch({ type: "ws_open", hasSnapshot: Boolean(lastUpdatedRef.current) });
        ws.send(JSON.stringify({ type: "ping" }));
        if (lastSequenceRef.current !== null) {
          ws.send(JSON.stringify({ type: "resume", last_sequence: lastSequenceRef.current }));
        }
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;
          if (message.type === "flight_update" || message.type === "initial_snapshot") {
            const payload = isFlightUpdatePayload(message.data) ? message.data : {};
            applyFlightSnapshot(payload.flights ?? payload.states, {
              time: payload.time,
              authenticated: payload.authenticated,
              source: payload.source,
              sourceCounts: payload.source_counts,
              sourceHealth: payload.source_health,
              sourceConflictCount: payload.source_conflict_count,
              degraded: payload.degraded,
              sequence: payload.sequence,
            });
          } else if (message.type === "anomaly_alert") {
            try {
              const payload = isAnomalyAlertPayload(message.data) ? message.data : undefined;
              if (payload) {
                if (payload.flight) {
                  // Legacy/development frontend-flagged format
                  const updatedFlight = normalizeFlights(
                    [payload.flight],
                    flightsByIdRef.current,
                    flightsRef.current,
                  )[0];
                  if (updatedFlight) {
                    dispatch({ type: "flight_patch", flight: updatedFlight });

                    if (payload.anomalies && Array.isArray(payload.anomalies)) {
                      const anomalousFlight: AnomalousFlight = {
                        ...updatedFlight,
                        anomalies: payload.anomalies as Anomaly[],
                        detectedAt: Date.now(),
                      };
                      dispatch({
                        type: "anomaly_alerts_merged",
                        anomalies: [anomalousFlight],
                        freshAnomalies: collectFreshAnomalies(seenRef.current, [anomalousFlight]),
                      });
                    }
                  }
                } else if (Array.isArray(payload.anomalies)) {
                  // Production backend-persisted database format
                  const incomingEvents = payload.anomalies as BackendAnomaly[];
                  const mappedAnomalies: AnomalousFlight[] = [];

                  for (const ea of incomingEvents) {
                    const existingFlight = flightsRef.current.find((f) => f.icao24 === ea.icao24);
                    const label =
                      ANOMALY_TYPE_LABELS[ea.anomaly_type] || ea.anomaly_type.replace(/_/g, " ");
                    const anomalyItem: Anomaly = {
                      id: ea.id,
                      type: normalizeBackendAnomalyType(ea.anomaly_type),
                      label,
                      severity: normalizeBackendSeverity(ea.severity),
                      source: ea.source,
                      explanation: ea.explanation,
                    };

                    if (existingFlight) {
                      const flightWithScore =
                        ea.ml_score !== null
                          ? { ...existingFlight, ml_anomaly_score: ea.ml_score }
                          : existingFlight;
                      mappedAnomalies.push({
                        ...flightWithScore,
                        anomalies: [anomalyItem],
                        detectedAt: new Date(ea.detected_at).getTime(),
                      });
                    } else {
                      const fallback: AnomalousFlight = {
                        icao24: ea.icao24,
                        callsign: ea.callsign || null,
                        origin_country: ea.origin_country || "",
                        time_position: new Date(ea.detected_at).getTime() / 1000,
                        last_contact: new Date(ea.detected_at).getTime() / 1000,
                        longitude: ea.longitude,
                        latitude: ea.latitude,
                        baro_altitude: ea.altitude,
                        on_ground: false,
                        velocity: ea.velocity,
                        true_track: null,
                        vertical_rate: null,
                        sensors: null,
                        geo_altitude: ea.altitude,
                        squawk: ea.details?.squawk || null,
                        spi: false,
                        position_source: 0,
                        category: 0,
                        ml_anomaly_score: ea.ml_score,
                        data_source: "backend",
                        anomalies: [anomalyItem],
                        detectedAt: new Date(ea.detected_at).getTime(),
                      };
                      mappedAnomalies.push(fallback);
                    }
                  }

                  if (mappedAnomalies.length > 0) {
                    dispatch({
                      type: "anomaly_alerts_merged",
                      anomalies: mappedAnomalies,
                      freshAnomalies: collectFreshAnomalies(seenRef.current, mappedAnomalies),
                    });
                  }
                }
              }
            } catch (err) {
              console.warn("Failed to handle anomaly alert WS message", err);
            }
          }
        } catch {
          console.warn("Ignored malformed flight WebSocket message");
        }
      };

      ws.onerror = () => {
        if (!lastUpdatedRef.current) {
          dispatch({
            type: "ws_initial_error",
            message: "Real-time flight stream unavailable",
          });
        }
      };

      ws.onclose = () => {
        if (closed) return;
        if (reconnectAttempt >= MAX_WS_RECONNECT_ATTEMPTS) {
          dispatch({ type: "ws_lost", hasSnapshot: Boolean(lastUpdatedRef.current) });
          window.dispatchEvent(new CustomEvent("skywatch:ws-connection-lost"));
          return;
        }
        dispatch({
          type: "ws_reconnecting",
          attempt: reconnectAttempt + 1,
          hasSnapshot: Boolean(lastUpdatedRef.current),
        });
        window.dispatchEvent(
          new CustomEvent("skywatch:ws-reconnecting", {
            detail: { attempt: reconnectAttempt + 1 },
          }),
        );
        const delay =
          RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
        reconnectAttempt += 1;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [applyFlightSnapshot]);

  return {
    flights,
    currentAnomalies,
    anomalies,
    anomalyHistory,
    lastUpdated,
    status,
    isFetching,
    isInitialLoading: status === "idle" || status === "loading",
    errorMessage,
    authenticated,
    feedSource,
    sourceCounts,
    sourceHealth,
    sourceConflictCount,
    degraded,
    staleCount,
    maxAgeSeconds,
    refresh: fetchOnce,
    firstSeenPositions: firstSeenRef.current,
    reconnectAttempt,
    connectionLost,
  };
}
