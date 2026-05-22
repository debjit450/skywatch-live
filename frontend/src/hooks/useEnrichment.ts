import { useCallback, useEffect, useRef, useState } from "react";
import type { EnrichmentData } from "@/lib/enrichment-types";

const clientCache = new Map<string, EnrichmentData>();

function cacheCoordinatePart(lat: number | null, lon: number | null): string {
  if (lat === null || lon === null) return "no-position";
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

function enrichmentCacheKey(
  icao24: string,
  callsign: string,
  lat: number | null,
  lon: number | null,
  registration: string | null,
): string {
  return [
    icao24.toLowerCase(),
    (callsign || "").toUpperCase(),
    cacheCoordinatePart(lat, lon),
    registration?.toUpperCase() ?? "",
  ].join("|");
}

export function useEnrichment(
  icao24: string | null,
  callsign: string | null,
  isAnomaly: boolean = false,
  firstSeenLat: number | null = null,
  firstSeenLon: number | null = null,
  registration: string | null = null,
) {
  const [data, setData] = useState<EnrichmentData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetch_ = useCallback(
    async (
      ic: string,
      cs: string,
      anom: boolean,
      lat: number | null,
      lon: number | null,
      reg: string | null,
    ) => {
      const cacheKey = enrichmentCacheKey(ic, cs, lat, lon, reg);
      const cached = !anom && clientCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
        setData(cached);
        setLoading(false);
        setError(null);
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams({ icao24: ic });
        if (cs) params.set("callsign", cs);
        if (anom) params.set("isAnomaly", "true");
        if (lat !== null && lon !== null) {
          params.set("firstSeenLat", lat.toString());
          params.set("firstSeenLon", lon.toString());
        }
        if (reg) params.set("registration", reg);

        const res = await fetch(`/api/enrichment?${params}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const enrichment = (await res.json()) as EnrichmentData;
        if (!anom) clientCache.set(cacheKey, enrichment);
        setData(enrichment);
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Enrichment unavailable");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!icao24) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    fetch_(icao24, callsign || "", isAnomaly, firstSeenLat, firstSeenLon, registration);
    return () => abortRef.current?.abort();
  }, [icao24, callsign, isAnomaly, firstSeenLat, firstSeenLon, registration, fetch_]);

  return { data, loading, error };
}
