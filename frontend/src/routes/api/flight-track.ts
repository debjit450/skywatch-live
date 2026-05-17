import { createFileRoute } from "@tanstack/react-router";
import type { FlightTrackData, FlightTrackPoint, FlightTrackSegment } from "@/lib/flightTrack";
import {
  analyzeFlightTrack,
  calculateSegmentDistanceKm,
  detectFlightLayovers,
} from "@/lib/flightTrack";
import {
  fetchWithTimeout,
  isFiniteCoordinate,
  jsonResponse,
  normalizeIcao24,
} from "@/lib/api-safety";

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const TRACKS_URL = "https://opensky-network.org/api/tracks/all";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_TRACK_CACHE_SIZE = 500;

let cachedToken: { token: string; expiresAt: number } | null = null;
const trackCache = new Map<string, { data: FlightTrackData; insertedAt: number }>();

interface OpenSkyTrackResponse {
  icao24: string;
  startTime: number;
  endTime: number;
  callsign: string | null;
  path: Array<[number, number | null, number | null, number | null, number | null, boolean]>;
}

async function getAccessToken(): Promise<string | null> {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  if (cachedToken && cachedToken.expiresAt - 30_000 > Date.now()) {
    return cachedToken.token;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetchWithTimeout(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    8_000,
  );
  if (!res.ok) return null;

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

function normalizeTrack(icao24: string, payload: OpenSkyTrackResponse): FlightTrackData {
  const points: FlightTrackPoint[] = (payload.path ?? [])
    .map((point): FlightTrackPoint | null => {
      const [time, lat, lon, alt, heading, onGround] = point;
      if (
        !Number.isFinite(time) ||
        typeof lat !== "number" ||
        typeof lon !== "number" ||
        !isFiniteCoordinate(lat, lon)
      ) {
        return null;
      }
      return {
        lat,
        lon,
        alt,
        speed: null,
        heading,
        time: new Date(time * 1000).toISOString(),
        onGround,
      };
    })
    .filter((point): point is FlightTrackPoint => point !== null)
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  const segment: FlightTrackSegment = {
    id: `opensky-${payload.startTime || 0}`,
    source: "opensky-live-track",
    startedAt: payload.startTime
      ? new Date(payload.startTime * 1000).toISOString()
      : (points[0]?.time ?? null),
    endedAt: payload.endTime
      ? new Date(payload.endTime * 1000).toISOString()
      : (points[points.length - 1]?.time ?? null),
    distanceKm: points.length > 1 ? calculateSegmentDistanceKm(points) : null,
    points,
  };
  const segments = points.length > 0 ? [segment] : [];
  const totalDistanceKm = segment.distanceKm && segment.distanceKm > 0 ? segment.distanceKm : null;

  return {
    icao24,
    source: "opensky",
    fetchedAt: Date.now(),
    pointCount: points.length,
    totalDistanceKm,
    segments,
    layovers: detectFlightLayovers(segments),
    intelligence: analyzeFlightTrack(segments, totalDistanceKm),
  };
}

function putTrackCache(icao24: string, data: FlightTrackData): void {
  if (trackCache.size >= MAX_TRACK_CACHE_SIZE) {
    const firstKey = trackCache.keys().next().value;
    if (firstKey) trackCache.delete(firstKey);
  }
  trackCache.set(icao24, { data, insertedAt: Date.now() });
}

export const Route = createFileRoute("/api/flight-track")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const icao24 = normalizeIcao24(url.searchParams.get("icao24"));
        if (!icao24) {
          return jsonResponse({ error: "Valid icao24 parameter required" }, { status: 400 });
        }

        const cached = trackCache.get(icao24);
        if (cached && Date.now() - cached.insertedAt < CACHE_TTL_MS) {
          return jsonResponse(cached.data, {
            status: 200,
            headers: {
              "Cache-Control": "private, max-age=300",
            },
          });
        }
        if (cached) {
          trackCache.delete(icao24);
        }

        try {
          const token = await getAccessToken();
          const headers: Record<string, string> = { Accept: "application/json" };
          if (token) headers.Authorization = `Bearer ${token}`;

          const trackUrl = new URL(TRACKS_URL);
          trackUrl.searchParams.set("icao24", icao24);
          trackUrl.searchParams.set("time", "0");

          const res = await fetchWithTimeout(trackUrl, { headers }, 10_000);
          if (res.status === 404) {
            return jsonResponse(
              {
                icao24,
                source: "opensky",
                fetchedAt: Date.now(),
                pointCount: 0,
                totalDistanceKm: null,
                segments: [],
                layovers: [],
              } satisfies FlightTrackData,
              { status: 200 },
            );
          }

          if (!res.ok) {
            return jsonResponse({ error: `OpenSky returned ${res.status}` }, { status: 502 });
          }

          const payload = (await res.json()) as OpenSkyTrackResponse;
          const data = normalizeTrack(icao24, payload);
          putTrackCache(icao24, data);

          return jsonResponse(data, {
            status: 200,
            headers: {
              "Cache-Control": "private, max-age=300",
            },
          });
        } catch (err) {
          console.error("Track proxy failed", err);
          return jsonResponse({ error: "Track unavailable" }, { status: 502 });
        }
      },
    },
  },
});
