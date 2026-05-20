import { createFileRoute } from "@tanstack/react-router";
import type {
  AdsbdbAircraftResponse,
  AdsbdbCallsignResponse,
  AircraftInfo,
  EnrichmentData,
  FlightRouteInfo,
  RouteAirport,
} from "@/lib/enrichment-types";
import { lookupAirportByIcao, lookupAirportByIata } from "@/lib/data/airport-db";
import { inferAirlineFromCallsign } from "@/lib/airline-lookup";
import {
  fetchWithTimeout,
  isFiniteCoordinate,
  jsonResponse,
  normalizeCallsign,
  normalizeIcao24,
  normalizeRegistration,
  parseOptionalCoordinate,
} from "@/lib/api-safety";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 2000;
const ORIGIN_DISTANCE_THRESHOLD_KM = 300;
const DESTINATION_DISTANCE_THRESHOLD_KM = 150;
const EARTH_RADIUS_KM = 6371;
const OPENSKY_TIMEOUT_MS = 5000;

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_OPEN_TIME_MS = 60_000;

interface CacheEntry {
  data: EnrichmentData;
  insertedAt: number;
}

const cache = new Map<string, CacheEntry>();

interface CircuitState {
  failures: number;
  lastFailure: number;
  openUntil: number;
}

const openskyCircuit: CircuitState = { failures: 0, lastFailure: 0, openUntil: 0 };
const adsbdbCircuit: CircuitState = { failures: 0, lastFailure: 0, openUntil: 0 };

function cacheKey(icao24: string, callsign: string): string {
  return `${icao24.toLowerCase()}|${callsign.toUpperCase()}`;
}

function getCached(key: string): EnrichmentData | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.insertedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function putCache(key: string, data: EnrichmentData): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { data, insertedAt: Date.now() });
}

function distanceBetweenCoordinates(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function withCircuitBreaker(circuit: CircuitState): "ok" | "open" {
  const now = Date.now();
  if (now < circuit.openUntil) {
    return "open";
  }
  if (circuit.openUntil > 0) {
    circuit.openUntil = 0;
    circuit.failures = 0;
  }
  return "ok";
}

function recordSuccess(circuit: CircuitState): void {
  circuit.failures = 0;
  circuit.lastFailure = 0;
  circuit.openUntil = 0;
}

function recordFailure(circuit: CircuitState): void {
  const now = Date.now();
  circuit.failures += 1;
  circuit.lastFailure = now;
  if (circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openUntil = now + CIRCUIT_OPEN_TIME_MS;
  }
}

const ADSBDB_BASE = "https://api.adsbdb.com/v0";

async function fetchAircraftInfo(icao24: string): Promise<AircraftInfo | null> {
  if (withCircuitBreaker(adsbdbCircuit) === "open") {
    return null;
  }
  try {
    const res = await fetchWithTimeout(
      `${ADSBDB_BASE}/aircraft/${icao24.toUpperCase()}`,
      {
        headers: { Accept: "application/json" },
      },
      8_000,
    );
    if (!res.ok) {
      recordFailure(adsbdbCircuit);
      return null;
    }
    const json = (await res.json()) as AdsbdbAircraftResponse;
    const ac = json?.response?.aircraft;
    if (!ac) {
      recordSuccess(adsbdbCircuit);
      return null;
    }
    recordSuccess(adsbdbCircuit);
    return {
      manufacturer: ac.manufacturer || null,
      type: ac.type || null,
      icaoType: ac.icao_type || null,
      registration: ac.registration || null,
      registeredOwner: ac.registered_owner || null,
      ownerCountry: ac.registered_owner_country_name || null,
      ownerCountryIso: ac.registered_owner_country_iso_name || null,
      operatorFlagCode: ac.registered_owner_operator_flag_code || null,
      photoUrl: ac.url_photo || null,
      photoThumbUrl: ac.url_photo_thumbnail || null,
    };
  } catch {
    recordFailure(adsbdbCircuit);
    return null;
  }
}

function resolveAirportByIcao(icao: string): RouteAirport | null {
  if (!icao) return null;
  return lookupAirportByIcao(icao);
}

function resolveAirportByIata(iata: string): RouteAirport | null {
  if (!iata) return null;
  return lookupAirportByIata(iata);
}

interface OpenSkyFlightEntry {
  icao24: string;
  firstSeen: number;
  estDepartureAirport: string | null;
  lastSeen: number;
  estArrivalAirport: string | null;
  callsign: string | null;
  estDepartureAirportHorizDistance: number;
  estDepartureAirportVertDistance: number;
  estArrivalAirportHorizDistance: number;
  estArrivalAirportVertDistance: number;
  departureAirportCandidatesCount: number;
  arrivalAirportCandidatesCount: number;
}

async function fetchOpenSkyRoute(
  icao24: string,
  currentLat: number | null,
  currentLon: number | null,
): Promise<{ departureIcao: string; arrivalIcao: string } | null> {
  if (withCircuitBreaker(openskyCircuit) === "open") {
    return null;
  }
  try {
    const now = Math.floor(Date.now() / 1000);
    const begin = now - 3600;
    const routeUrl = new URL("https://opensky-network.org/api/flights/aircraft");
    routeUrl.searchParams.set("icao24", icao24.toLowerCase());
    routeUrl.searchParams.set("begin", String(begin));
    routeUrl.searchParams.set("end", String(now));
    const res = await fetchWithTimeout(
      routeUrl,
      {
        headers: { Accept: "application/json" },
      },
      OPENSKY_TIMEOUT_MS,
    );
    if (!res.ok) {
      recordFailure(openskyCircuit);
      return null;
    }
    const entries = (await res.json()) as OpenSkyFlightEntry[];
    if (!Array.isArray(entries) || entries.length === 0) {
      recordSuccess(openskyCircuit);
      return null;
    }
    recordSuccess(openskyCircuit);

    let bestMatch: OpenSkyFlightEntry | null = null;
    let minTimeDiff = Infinity;

    for (const entry of entries) {
      const timeDiff = now - entry.lastSeen;
      if (timeDiff < minTimeDiff && entry.estDepartureAirport) {
        bestMatch = entry;
        minTimeDiff = timeDiff;
      }
    }

    if (!bestMatch) {
      return null;
    }

    const dep = bestMatch.estDepartureAirport;
    const arr = bestMatch.estArrivalAirport;
    if (!dep && !arr) return null;
    return {
      departureIcao: dep || "",
      arrivalIcao: arr || "",
    };
  } catch {
    recordFailure(openskyCircuit);
    return null;
  }
}

async function fetchAdsbdbRoute(
  callsign: string,
  currentLat: number | null,
  currentLon: number | null,
): Promise<FlightRouteInfo | null> {
  if (withCircuitBreaker(adsbdbCircuit) === "open") {
    return null;
  }
  try {
    const cs = callsign.trim().toUpperCase();
    if (!cs) return null;
    const res = await fetchWithTimeout(
      `${ADSBDB_BASE}/callsign/${encodeURIComponent(cs)}`,
      {
        headers: { Accept: "application/json" },
      },
      8_000,
    );
    if (!res.ok) {
      recordFailure(adsbdbCircuit);
      return null;
    }
    const json = (await res.json()) as AdsbdbCallsignResponse;
    const fr = json?.response?.flightroute;
    if (!fr) {
      recordSuccess(adsbdbCircuit);
      return null;
    }

    const origin = fr.origin
      ? {
          name: fr.origin.name,
          iataCode: fr.origin.iata_code,
          icaoCode: fr.origin.icao_code,
          municipality: fr.origin.municipality,
          countryName: fr.origin.country_name,
          countryIso: fr.origin.country_iso_name,
          latitude: fr.origin.latitude,
          longitude: fr.origin.longitude,
          elevation: fr.origin.elevation,
        }
      : null;

    const destination = fr.destination
      ? {
          name: fr.destination.name,
          iataCode: fr.destination.iata_code,
          icaoCode: fr.destination.icao_code,
          municipality: fr.destination.municipality,
          countryName: fr.destination.country_name,
          countryIso: fr.destination.country_iso_name,
          latitude: fr.destination.latitude,
          longitude: fr.destination.longitude,
          elevation: fr.destination.elevation,
        }
      : null;

    let routeConfidence: "high" | "low" = "high";
    let routeWarning: string | null = null;

    if (currentLat !== null && currentLon !== null) {
      if (origin && isFiniteCoordinate(origin.latitude, origin.longitude)) {
        const distToOrigin = distanceBetweenCoordinates(
          currentLat,
          currentLon,
          origin.latitude,
          origin.longitude,
        );
        if (destination && isFiniteCoordinate(destination.latitude, destination.longitude)) {
          const routeLength = distanceBetweenCoordinates(
            origin.latitude,
            origin.longitude,
            destination.latitude,
            destination.longitude,
          );
          // Only flag low confidence if aircraft is far from origin AND far from route corridor
          if (distToOrigin > routeLength * 1.5) {
            routeConfidence = "low";
            routeWarning = "Aircraft position far from route";
          }
        } else if (distToOrigin > ORIGIN_DISTANCE_THRESHOLD_KM) {
          // No destination to validate against — use simple threshold
          routeConfidence = "low";
          routeWarning = "Aircraft position far from origin airport";
        }
      }

      if (
        destination &&
        isFiniteCoordinate(destination.latitude, destination.longitude) &&
        routeConfidence === "high"
      ) {
        const distToDest = distanceBetweenCoordinates(
          currentLat,
          currentLon,
          destination.latitude,
          destination.longitude,
        );
        if (distToDest < 50) {
          routeConfidence = "high";
        }
      }
    }

    const routeData: FlightRouteInfo = {
      callsign: fr.callsign || null,
      callsignIata: fr.callsign_iata || null,
      airline: fr.airline
        ? {
            name: fr.airline.name,
            icao: fr.airline.icao,
            iata: fr.airline.iata,
            country: fr.airline.country,
            countryIso: fr.airline.country_iso || "",
            callsign: fr.airline.callsign || "",
          }
        : null,
      origin,
      destination,
      routeConfidence,
      routeWarning,
      routeSource: "adsbdb",
    };

    recordSuccess(adsbdbCircuit);
    return routeData;
  } catch {
    recordFailure(adsbdbCircuit);
    return null;
  }
}

async function fetchAircraftByRegistration(registration: string): Promise<AircraftInfo | null> {
  if (withCircuitBreaker(adsbdbCircuit) === "open") {
    return null;
  }
  try {
    const reg = registration.trim().toUpperCase();
    if (!reg) return null;
    const res = await fetchWithTimeout(
      `${ADSBDB_BASE}/aircraft/${encodeURIComponent(reg)}`,
      {
        headers: { Accept: "application/json" },
      },
      8_000,
    );
    if (!res.ok) {
      recordFailure(adsbdbCircuit);
      return null;
    }
    const json = (await res.json()) as AdsbdbAircraftResponse;
    const ac = json?.response?.aircraft;
    if (!ac) {
      recordSuccess(adsbdbCircuit);
      return null;
    }
    recordSuccess(adsbdbCircuit);
    return {
      manufacturer: ac.manufacturer || null,
      type: ac.type || null,
      icaoType: ac.icao_type || null,
      registration: ac.registration || null,
      registeredOwner: ac.registered_owner || null,
      ownerCountry: ac.registered_owner_country_name || null,
      ownerCountryIso: ac.registered_owner_country_iso_name || null,
      operatorFlagCode: ac.registered_owner_operator_flag_code || null,
      photoUrl: ac.url_photo || null,
      photoThumbUrl: ac.url_photo_thumbnail || null,
    };
  } catch {
    recordFailure(adsbdbCircuit);
    return null;
  }
}

async function resolveRoute(
  icao24: string,
  callsign: string,
  currentLat: number | null,
  currentLon: number | null,
): Promise<FlightRouteInfo | null> {
  if (currentLat === null || currentLon === null) {
    return null;
  }

  let adsbdbResult: FlightRouteInfo | null = null;
  let oskyResult: { departureIcao: string; arrivalIcao: string } | null = null;

  if (callsign) {
    adsbdbResult = await fetchAdsbdbRoute(callsign, currentLat, currentLon);
  }

  oskyResult = await fetchOpenSkyRoute(icao24, currentLat, currentLon);

  let bestRoute: FlightRouteInfo | null = null;
  let bestScore = -1;

  if (adsbdbResult) {
    const score = calculateRouteScore(adsbdbResult, currentLat, currentLon);
    if (score > bestScore) {
      bestScore = score;
      bestRoute = adsbdbResult;
    }
  }

  if (oskyResult && (oskyResult.departureIcao || oskyResult.arrivalIcao)) {
    const origin = resolveAirportByIcao(oskyResult.departureIcao);
    const destination = resolveAirportByIcao(oskyResult.arrivalIcao);

    if (origin || destination) {
      const inferredAirline = inferAirlineFromCallsign(callsign);
      const oskyRoute: FlightRouteInfo = {
        callsign: callsign || null,
        callsignIata: null,
        airline: inferredAirline
          ? {
              name: inferredAirline.name,
              icao: inferredAirline.icao,
              iata: inferredAirline.iata,
              country: inferredAirline.country,
              countryIso: "",
              callsign: "",
            }
          : null,
        origin,
        destination,
        routeConfidence: "high",
        routeWarning: null,
        routeSource: "opensky",
      };

      const score = calculateRouteScore(oskyRoute, currentLat, currentLon);
      if (score > bestScore) {
        bestScore = score;
        bestRoute = oskyRoute;
      }
    }
  }

  if (bestRoute && bestScore < 0.3) {
    return null;
  }

  if (bestRoute) {
    const { confidence, warning } = getRouteConfidence(bestRoute, currentLat, currentLon);
    bestRoute.routeConfidence = confidence;
    bestRoute.routeWarning = warning;
  }

  return bestRoute;
}

function calculateRouteScore(
  route: FlightRouteInfo,
  currentLat: number,
  currentLon: number,
): number {
  if (!route.origin || !route.destination) {
    return 0;
  }

  const { latitude: originLat, longitude: originLon } = route.origin;
  const { latitude: destLat, longitude: destLon } = route.destination;

  if (!isFiniteCoordinate(originLat, originLon) || !isFiniteCoordinate(destLat, destLon)) {
    return 0;
  }

  const distToOrigin = distanceBetweenCoordinates(currentLat, currentLon, originLat, originLon);
  const distToDest = distanceBetweenCoordinates(currentLat, currentLon, destLat, destLon);
  const routeLength = distanceBetweenCoordinates(originLat, originLon, destLat, destLon);

  if (routeLength < 50) {
    return 0;
  }

  const totalDist = distToOrigin + distToDest;
  const deviation = Math.abs(totalDist - routeLength);
  const deviationRatio = deviation / routeLength;

  // Only reject when far from DESTINATION (not origin — flights past mid-route
  // will always be far from origin, which is expected and valid).
  if (distToDest > routeLength * 1.5) {
    return 0;
  }

  if (deviationRatio > 0.6) {
    return 0;
  }

  const score = Math.max(0, 1 - deviationRatio);
  return score;
}

function getRouteConfidence(
  route: FlightRouteInfo,
  currentLat: number,
  currentLon: number,
): { confidence: "high" | "low"; warning: string | null } {
  if (!route.origin || !route.destination) {
    return { confidence: "low", warning: "Incomplete route data" };
  }

  const { latitude: originLat, longitude: originLon } = route.origin;
  const { latitude: destLat, longitude: destLon } = route.destination;

  if (!isFiniteCoordinate(originLat, originLon) || !isFiniteCoordinate(destLat, destLon)) {
    return { confidence: "low", warning: "Missing airport coordinates" };
  }

  const distToOrigin = distanceBetweenCoordinates(currentLat, currentLon, originLat, originLon);
  const distToDest = distanceBetweenCoordinates(currentLat, currentLon, destLat, destLon);
  const routeLength = distanceBetweenCoordinates(originLat, originLon, destLat, destLon);

  if (distToOrigin < 50) {
    return { confidence: "high", warning: null };
  }

  if (distToDest < 50) {
    return { confidence: "high", warning: null };
  }

  const totalDist = distToOrigin + distToDest;
  const deviation = Math.abs(totalDist - routeLength);
  const deviationRatio = deviation / routeLength;

  if (deviationRatio < 0.15) {
    return { confidence: "high", warning: null };
  }

  if (deviationRatio < 0.3) {
    return { confidence: "low", warning: "Route data may be outdated" };
  }

  return { confidence: "low", warning: "Route data likely incorrect" };
}

export const Route = createFileRoute("/api/enrichment")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const icao24 = normalizeIcao24(url.searchParams.get("icao24"));
        const callsign = normalizeCallsign(url.searchParams.get("callsign"));
        const latitude = parseOptionalCoordinate(url.searchParams.get("firstSeenLat"), -90, 90);
        const longitude = parseOptionalCoordinate(url.searchParams.get("firstSeenLon"), -180, 180);
        const isAnomaly = url.searchParams.get("isAnomaly") === "true";
        const reg = normalizeRegistration(url.searchParams.get("registration"));

        if (!icao24) {
          return jsonResponse(
            { error: "Valid icao24 parameter required" },
            {
              status: 400,
            },
          );
        }

        if (callsign === null) {
          return jsonResponse({ error: "Invalid callsign parameter" }, { status: 400 });
        }

        if (reg === null) {
          return jsonResponse({ error: "Invalid registration parameter" }, { status: 400 });
        }

        if (!latitude.valid || !longitude.valid) {
          return jsonResponse({ error: "Invalid first-seen coordinates" }, { status: 400 });
        }

        const key = cacheKey(icao24, callsign);
        const cached = !isAnomaly && getCached(key);
        if (cached) {
          return jsonResponse(cached, {
            status: 200,
            headers: {
              "Cache-Control": "private, max-age=300",
            },
          });
        }

        let aircraft: AircraftInfo | null = null;
        let route: FlightRouteInfo | null = null;

        if (callsign && latitude.value !== null && longitude.value !== null) {
          const routeResult = await resolveRoute(icao24, callsign, latitude.value, longitude.value);
          if (routeResult) {
            route = routeResult;
          }
        }

        if (!route || !route.airline) {
          aircraft = await fetchAircraftInfo(icao24);
          if (!aircraft && reg) {
            aircraft = await fetchAircraftByRegistration(reg);
          }
        }

        const enrichment: EnrichmentData = {
          aircraft,
          route,
          fetchedAt: Date.now(),
        };

        if (!isAnomaly) putCache(key, enrichment);

        return jsonResponse(enrichment, {
          status: 200,
          headers: {
            "Cache-Control": "private, max-age=300",
          },
        });
      },
    },
  },
});
