import { useEffect, useRef, useState, useCallback } from "react";
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
}

interface FlightUpdatePayload {
  time?: number;
  flights?: Flight[];
  states?: Flight[];
  authenticated?: boolean;
  source?: string;
  source_counts?: Record<string, number>;
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

function getFlightsRestUrls(): string[] {
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

function normalizeFlights(flights: Flight[] | undefined): Flight[] {
  if (!Array.isArray(flights)) return [];

  const nowSeconds = Date.now() / 1000;
  return flights
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
    .map((flight) => ({
      ...flight,
      icao24: normalizeIcao24(flight.icao24) ?? flight.icao24.toLowerCase(),
      callsign: flight.callsign ? flight.callsign.trim() || null : null,
      origin_country: flight.origin_country || "",
      time_position: flight.time_position ?? null,
      last_contact: flight.last_contact ?? Date.now() / 1000,
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
      predicted_path: Array.isArray(flight.predicted_path) ? flight.predicted_path : [],
      prediction_confidence:
        typeof flight.prediction_confidence === "number" ? flight.prediction_confidence : 0,
    }));
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
  const [flights, setFlights] = useState<Flight[]>([]);
  const [currentAnomalies, setCurrentAnomalies] = useState<AnomalousFlight[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalousFlight[]>([]);
  const [anomalyHistory, setAnomalyHistory] = useState<
    Record<
      string,
      Array<{
        time: number;
        altitude: number | null;
        speed: number | null;
        heading: number | null;
      }>
    >
  >({});
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [feedSource, setFeedSource] = useState<string | null>(null);
  const [sourceCounts, setSourceCounts] = useState<Record<string, number>>({});
  const [staleCount, setStaleCount] = useState(0);
  const [maxAgeSeconds, setMaxAgeSeconds] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [isFetching, setIsFetching] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [connectionLost, setConnectionLost] = useState(false);
  const seenRef = useRef<Map<string, number>>(new Map());
  const firstSeenRef = useRef<Map<string, FirstSeenPosition>>(new Map());
  const inFlightRef = useRef(false);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const lastUpdatedRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const flightsRef = useRef<Flight[]>([]);
  useEffect(() => {
    flightsRef.current = flights;
  }, [flights]);

  const rememberAnomalies = useCallback((flagged: AnomalousFlight[]) => {
    const now = Date.now();
    pruneSeen(seenRef.current, now);

    const fresh: AnomalousFlight[] = [];
    for (const anomaly of flagged) {
      const key = anomalyKey(anomaly);
      if (!seenRef.current.has(key)) fresh.push(anomaly);
      seenRef.current.set(key, now);
    }

    if (fresh.length > 0) {
      setAnomalies((prev) => [...fresh, ...prev].slice(0, MAX_HISTORY));
    }
  }, []);

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
      } = {},
    ) => {
      const normalized = normalizeFlights(nextFlights);
      const updatedAt =
        typeof metadata.time === "number" && metadata.time > 0 ? metadata.time * 1000 : Date.now();
      const previousUpdatedAt = lastUpdatedRef.current;

      if (previousUpdatedAt !== null && updatedAt + 1_000 < previousUpdatedAt) {
        return;
      }

      setFlights(normalized);
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
      setCurrentAnomalies(flagged);
      rememberAnomalies(flagged);

      setAnomalyHistory((prev) => {
        const next = { ...prev };
        const tMs = updatedAt;
        const t = Math.floor(tMs / 1000);
        for (const f of flagged) {
          if (!next[f.icao24]) next[f.icao24] = [];
          const last = next[f.icao24][next[f.icao24].length - 1];
          // Store the actual snapshot time (seconds), not a generalized bucket.
          // Only dedupe if the last entry has the exact same second AND the values are unchanged.
          const sameSecond = !!last && last.time === t;
          const sameValues =
            !!last &&
            last.altitude === (f.baro_altitude ?? f.geo_altitude ?? null) &&
            last.speed === (f.velocity ?? null) &&
            last.heading === (f.true_track ?? null);

          if (!sameSecond || !sameValues) {
            next[f.icao24] = [
              ...next[f.icao24],
              {
                time: t,
                altitude: f.baro_altitude ?? f.geo_altitude ?? null,
                speed: f.velocity ?? null,
                heading: f.true_track ?? null,
              },
            ];

            if (next[f.icao24].length > 200) {
              next[f.icao24] = next[f.icao24].slice(-200);
            }
          }
        }
        return next;
      });

      lastUpdatedRef.current = updatedAt;
      setLastUpdated(updatedAt);

      if (typeof metadata.authenticated === "boolean") {
        setAuthenticated(metadata.authenticated);
      }
      setFeedSource(metadata.source ?? null);
      if (metadata.sourceCounts && Object.keys(metadata.sourceCounts).length > 0) {
        setSourceCounts(metadata.sourceCounts);
      }
      setStaleCount(metadata.staleCount ?? 0);
      setMaxAgeSeconds(
        typeof metadata.maxAgeSeconds === "number" && Number.isFinite(metadata.maxAgeSeconds)
          ? metadata.maxAgeSeconds
          : null,
      );
      setErrorMessage(null);
      setStatus("live");
    },
    [queryClient, rememberAnomalies],
  );

  const fetchOnce = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const controller = new AbortController();
    fetchAbortRef.current = controller;
    setIsFetching(true);
    setStatus((current) => {
      if (!lastUpdatedRef.current) return "loading";
      return current === "error" ? "reconnecting" : current;
    });

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
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Flight feed unavailable";
      setErrorMessage(controller.signal.aborted ? "Flight feed timed out" : message);
      setStatus((current) => {
        if (lastUpdatedRef.current || current === "live") return "reconnecting";
        return "error";
      });
    } finally {
      if (fetchAbortRef.current === controller) {
        fetchAbortRef.current = null;
      }
      inFlightRef.current = false;
      setIsFetching(false);
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
        setReconnectAttempt(0);
        setConnectionLost(false);
        setErrorMessage(null);
        setStatus(lastUpdatedRef.current ? "live" : "loading");
        ws.send(JSON.stringify({ type: "ping" }));
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;
          if (message.type === "flight_update") {
            const payload = isFlightUpdatePayload(message.data) ? message.data : {};
            applyFlightSnapshot(payload.flights ?? payload.states, {
              time: payload.time,
              authenticated: payload.authenticated,
              source: payload.source,
              sourceCounts: payload.source_counts,
            });
          } else if (message.type === "anomaly_alert") {
            try {
              const payload = isAnomalyAlertPayload(message.data) ? message.data : undefined;
              if (payload) {
                if (payload.flight) {
                  // Legacy/development frontend-flagged format
                  const updatedFlight = normalizeFlights([payload.flight])[0];
                  if (updatedFlight) {
                    setFlights((prev) => {
                      const idx = prev.findIndex((f) => f.icao24 === updatedFlight.icao24);
                      if (idx >= 0) {
                        const next = [...prev];
                        next[idx] = { ...next[idx], ...updatedFlight };
                        return next;
                      }
                      return prev;
                    });

                    if (payload.anomalies && Array.isArray(payload.anomalies)) {
                      const anomalousFlight: AnomalousFlight = {
                        ...updatedFlight,
                        anomalies: payload.anomalies as Anomaly[],
                        detectedAt: Date.now(),
                      };
                      setCurrentAnomalies((prev) => {
                        const filtered = prev.filter((a) => a.icao24 !== anomalousFlight.icao24);
                        return [anomalousFlight, ...filtered];
                      });
                      rememberAnomalies([anomalousFlight]);
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
                      if (ea.ml_score !== null) {
                        existingFlight.ml_anomaly_score = ea.ml_score;
                      }
                      mappedAnomalies.push({
                        ...existingFlight,
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
                    setCurrentAnomalies((prev) => {
                      const next = [...prev];
                      for (const ma of mappedAnomalies) {
                        const idx = next.findIndex((a) => a.icao24 === ma.icao24);
                        if (idx >= 0) {
                          const existing = next[idx];
                          const mergedAnom = [...existing.anomalies];
                          for (const newA of ma.anomalies) {
                            if (!mergedAnom.some((item) => item.type === newA.type)) {
                              mergedAnom.push(newA);
                            }
                          }
                          next[idx] = {
                            ...existing,
                            ...ma,
                            anomalies: mergedAnom,
                            detectedAt: Math.max(existing.detectedAt, ma.detectedAt),
                          };
                        } else {
                          next.unshift(ma);
                        }
                      }
                      return next;
                    });
                    rememberAnomalies(mappedAnomalies);
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
          setErrorMessage("Real-time flight stream unavailable");
        }
      };

      ws.onclose = () => {
        if (closed) return;
        if (reconnectAttempt >= MAX_WS_RECONNECT_ATTEMPTS) {
          setConnectionLost(true);
          if (lastUpdatedRef.current) {
            setStatus("live");
            setErrorMessage(null);
          } else {
            setStatus("error");
            setErrorMessage("Connection lost");
          }
          window.dispatchEvent(new CustomEvent("skywatch:ws-connection-lost"));
          return;
        }
        setStatus(lastUpdatedRef.current ? "live" : "error");
        setReconnectAttempt(reconnectAttempt + 1);
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
  }, [applyFlightSnapshot, rememberAnomalies]);

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
    staleCount,
    maxAgeSeconds,
    refresh: fetchOnce,
    firstSeenPositions: firstSeenRef.current,
    reconnectAttempt,
    connectionLost,
  };
}
