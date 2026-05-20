import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FlightLayover,
  FlightTrackData,
  FlightTrackIntelligence,
  FlightTrackPoint,
  FlightTrackSegment,
} from "@/lib/flightTrack";
import {
  analyzeFlightTrack,
  calculateSegmentDistanceKm,
  detectFlightLayovers,
  flightTrackPointTimeMs,
  sanitizeTrackSegments,
} from "@/lib/flightTrack";
import { normalizeIcao24 } from "@/lib/api-safety";

const TRACK_CACHE_TTL_MS = 90_000;
const TRACK_FETCH_TIMEOUT_MS = 15_000;
const MAX_TRACK_CACHE_SIZE = 500;
const clientCache = new Map<string, FlightTrackData>();

const configuredApiBase = (
  import.meta.env.VITE_SKYWATCH_API_BASE ||
  import.meta.env.VITE_SKYWATCH_API_URL ||
  import.meta.env.VITE_API_URL ||
  ""
).replace(/\/+$/, "");

interface BackendRoutePoint {
  lat?: number | null;
  lon?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  alt?: number | null;
  altitude?: number | null;
  speed?: number | null;
  heading?: number | null;
  true_track?: number | null;
  time?: string | null;
  onGround?: boolean;
  on_ground?: boolean;
  dataSource?: string | null;
  data_source?: string | null;
}

interface BackendRoute {
  session_id?: string;
  points?: BackendRoutePoint[];
  started_at?: string | null;
  ended_at?: string | null;
  point_count?: number;
  total_distance_km?: number | null;
  source?: string;
}

interface BackendRouteResponse {
  icao24: string;
  routes?: BackendRoute[];
  point_count?: number;
  total_distance_km?: number | null;
  layovers?: FlightLayover[];
  intelligence?: FlightTrackIntelligence;
}

function getBackendTrackUrls(icao24: string): string[] {
  const routePath = `/flights/${icao24.toLowerCase()}/route/?hours=12`;
  if (!configuredApiBase) return [];

  let base: string;
  if (/\/api\/v1\/?$/.test(configuredApiBase)) {
    base = configuredApiBase;
  } else if (/\/api\/v1\/flights\/?$/.test(configuredApiBase)) {
    base = configuredApiBase.replace(/\/flights\/?$/, "");
  } else {
    base = `${configuredApiBase}/api/v1`;
  }

  return [`${base}${routePath}`];
}

function getCachedTrack(cacheKey: string): FlightTrackData | null {
  const cached = clientCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > TRACK_CACHE_TTL_MS) {
    clientCache.delete(cacheKey);
    return null;
  }
  return cached;
}

function putCachedTrack(cacheKey: string, track: FlightTrackData): void {
  if (clientCache.size >= MAX_TRACK_CACHE_SIZE) {
    const firstKey = clientCache.keys().next().value;
    if (firstKey) clientCache.delete(firstKey);
  }
  clientCache.set(cacheKey, track);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function normalizePoint(point: BackendRoutePoint): FlightTrackPoint | null {
  const lat = point.lat ?? point.latitude;
  const lon = point.lon ?? point.longitude;
  if (typeof lat !== "number" || typeof lon !== "number") return null;

  return {
    lat,
    lon,
    alt: point.alt ?? point.altitude ?? null,
    speed: point.speed ?? null,
    heading: point.heading ?? point.true_track ?? null,
    time: point.time ?? new Date().toISOString(),
    onGround: point.onGround ?? point.on_ground ?? false,
    dataSource: point.dataSource ?? point.data_source ?? null,
  };
}

function normalizeBackendTrack(icao24: string, payload: BackendRouteResponse): FlightTrackData {
  const segments = sanitizeTrackSegments(
    (payload.routes ?? []).map((route, index): FlightTrackSegment => {
      const points = (route.points ?? [])
        .map(normalizePoint)
        .filter((point): point is FlightTrackPoint => point !== null)
        .sort((a, b) => flightTrackPointTimeMs(a) - flightTrackPointTimeMs(b));

      return {
        id: route.session_id || `route-${index}`,
        source: route.source || "states",
        startedAt: route.started_at ?? points[0]?.time ?? null,
        endedAt: route.ended_at ?? points[points.length - 1]?.time ?? null,
        distanceKm:
          route.total_distance_km ??
          (points.length > 1 ? calculateSegmentDistanceKm(points) : null),
        points,
      };
    }),
  );

  const totalDistanceKm =
    payload.total_distance_km ??
    segments.reduce((total, segment) => total + (segment.distanceKm ?? 0), 0);
  const hasDistance = segments.some((segment) => segment.distanceKm !== null);
  const layovers = payload.layovers?.length ? payload.layovers : detectFlightLayovers(segments);
  const computedIntelligence = analyzeFlightTrack(segments, hasDistance ? totalDistanceKm : null);
  const intelligence = payload.intelligence
    ? {
        ...computedIntelligence,
        ...payload.intelligence,
        phaseBreakdown: payload.intelligence.phaseBreakdown ?? computedIntelligence.phaseBreakdown,
        currentPhase: payload.intelligence.currentPhase ?? computedIntelligence.currentPhase,
      }
    : computedIntelligence;

  return {
    icao24,
    source: "backend",
    fetchedAt: Date.now(),
    pointCount:
      payload.point_count ?? segments.reduce((total, segment) => total + segment.points.length, 0),
    totalDistanceKm: hasDistance ? totalDistanceKm : null,
    segments,
    layovers,
    intelligence,
  };
}

async function fetchBackendTrack(
  icao24: string,
  signal: AbortSignal,
): Promise<FlightTrackData | null> {
  const urls = getBackendTrackUrls(icao24);

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
      if (!res.ok) continue;

      const payload = (await res.json()) as BackendRouteResponse;
      const track = normalizeBackendTrack(icao24, payload);
      if (track.pointCount >= 2) return track;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
    }
  }

  return null;
}

async function fetchOpenSkyTrack(
  icao24: string,
  signal: AbortSignal,
): Promise<FlightTrackData | null> {
  const params = new URLSearchParams({ icao24: icao24.toLowerCase() });
  const res = await fetch(`/api/flight-track?${params}`, { signal });
  if (!res.ok) return null;

  const track = (await res.json()) as FlightTrackData;
  if (track.pointCount < 2) return null;

  const segments = sanitizeTrackSegments(track.segments ?? []);
  const computedDistanceKm = segments.reduce(
    (total, segment) => total + (segment.distanceKm ?? 0),
    0,
  );
  const totalDistanceKm =
    track.totalDistanceKm ?? (computedDistanceKm > 0 ? computedDistanceKm : null);

  return {
    ...track,
    segments,
    totalDistanceKm,
    layovers: track.layovers?.length ? track.layovers : detectFlightLayovers(segments),
    intelligence: track.intelligence ?? analyzeFlightTrack(segments, totalDistanceKm),
  };
}

export function useFlightTrack(icao24: string | null, enabled = true) {
  const [data, setData] = useState<FlightTrackData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const fetchTrack = useCallback(async (id: string, forceRefresh = false) => {
    const cacheKey = normalizeIcao24(id);
    if (!cacheKey) {
      setData(null);
      setLoading(false);
      setError("Invalid aircraft identifier");
      return;
    }

    const cached = forceRefresh ? null : getCachedTrack(cacheKey);
    if (cached) {
      setData(cached);
      setLoading(false);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const timeout = window.setTimeout(() => controller.abort(), TRACK_FETCH_TIMEOUT_MS);

    setLoading(true);
    setError(null);

    try {
      const track =
        (await fetchBackendTrack(cacheKey, controller.signal)) ??
        (await fetchOpenSkyTrack(cacheKey, controller.signal));

      if (track) {
        putCachedTrack(cacheKey, track);
        if (requestId === requestIdRef.current) setData(track);
      } else {
        if (requestId === requestIdRef.current) setData(null);
      }
    } catch (err) {
      if (isAbortError(err)) return;
      if (requestId === requestIdRef.current) {
        setData(null);
        setError(err instanceof Error ? err.message : "Flight track unavailable");
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!icao24 || !enabled) {
      requestIdRef.current += 1;
      abortRef.current?.abort();
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    void fetchTrack(icao24);
    return () => {
      requestIdRef.current += 1;
      abortRef.current?.abort();
    };
  }, [enabled, fetchTrack, icao24]);

  return {
    data,
    loading,
    error,
    refresh: () => (icao24 ? fetchTrack(icao24, true) : undefined),
  };
}
