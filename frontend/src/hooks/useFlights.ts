import { useEffect, useRef, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Flight } from "@/lib/opensky";
import { flagFlights, type AnomalousFlight, type Anomaly } from "@/lib/anomaly";
import { isFiniteCoordinate, normalizeIcao24 } from "@/lib/api-safety";
import { inferDataSource } from "@/lib/data-sources";

export type Status = "idle" | "loading" | "live" | "reconnecting" | "error";

const POLL_MS = 30_000;
const FETCH_TIMEOUT_MS = 12_000;
const MAX_HISTORY = 5_000;
const MAX_SEEN_ANOMALIES = 10_000;
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;

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
}

interface FlightUpdatePayload {
  time?: number;
  flights?: Flight[];
  states?: Flight[];
  authenticated?: boolean;
}

interface AnomalyAlertPayload {
  flight?: Flight;
  anomalies?: Anomaly[];
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

  return [backendUrl, "/api/flights"];
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

function normalizeFlights(flights: Flight[] | undefined): Flight[] {
  if (!Array.isArray(flights)) return [];

  return flights
    .filter((flight) => {
      if (!flight) return false;
      const icao24 = normalizeIcao24(flight.icao24);
      return (
        !!icao24 &&
        typeof flight.latitude === "number" &&
        typeof flight.longitude === "number" &&
        isFiniteCoordinate(flight.latitude, flight.longitude)
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
  return Boolean(data && typeof data === "object" && "flight" in data);
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
  const [status, setStatus] = useState<Status>("idle");
  const [isFetching, setIsFetching] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const seenRef = useRef<Map<string, number>>(new Map());
  const firstSeenRef = useRef<Map<string, FirstSeenPosition>>(new Map());
  const inFlightRef = useRef(false);
  const fetchAbortRef = useRef<AbortController | null>(null);
  const lastUpdatedRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

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
      metadata: { time?: number; authenticated?: boolean } = {},
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

      const flagged = flagFlights(normalized);
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
    const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    setIsFetching(true);
    setStatus((current) => {
      if (!lastUpdatedRef.current) return "loading";
      return current === "error" ? "reconnecting" : current;
    });

    try {
      let data: FlightsResponse | null = null;
      let lastError: Error | null = null;

      for (const url of getFlightsRestUrls()) {
        try {
          const res = await fetch(url, {
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
          const payload = (await res.json().catch(() => ({}))) as FlightsResponse;
          if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
          data = payload;
          break;
        } catch (err) {
          if (controller.signal.aborted) throw err;
          lastError = err instanceof Error ? err : new Error("Flight feed unavailable");
        }
      }

      if (!data) throw lastError ?? new Error("Flight feed unavailable");

      applyFlightSnapshot(data.flights ?? data.states, {
        time: data.time,
        authenticated: data.authenticated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Flight feed unavailable";
      setErrorMessage(controller.signal.aborted ? "Flight feed timed out" : message);
      setStatus((current) => {
        if (lastUpdatedRef.current || current === "live") return "reconnecting";
        return "error";
      });
    } finally {
      window.clearTimeout(timeout);
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

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt = 0;
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
            });
          } else if (message.type === "anomaly_alert") {
            try {
              const payload = isAnomalyAlertPayload(message.data) ? message.data : undefined;
              if (payload?.flight) {
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
                      anomalies: payload.anomalies,
                      detectedAt: Date.now(),
                    };
                    setCurrentAnomalies((prev) => {
                      const filtered = prev.filter((a) => a.icao24 !== anomalousFlight.icao24);
                      return [anomalousFlight, ...filtered];
                    });
                    rememberAnomalies([anomalousFlight]);
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
        setErrorMessage("Real-time flight stream unavailable");
      };

      ws.onclose = () => {
        if (closed) return;
        setStatus(lastUpdatedRef.current ? "reconnecting" : "error");
        const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
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
    refresh: fetchOnce,
    firstSeenPositions: firstSeenRef.current,
  };
}
