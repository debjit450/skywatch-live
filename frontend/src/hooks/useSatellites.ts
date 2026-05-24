import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeSatelliteCatalog, type SatelliteCatalog } from "@/lib/satellites";

export type SatelliteStatus = "idle" | "loading" | "ready" | "error";

const POLL_MS = 60_000;
const FETCH_TIMEOUT_MS = 14_000;

const configuredApiBase = (
  import.meta.env.VITE_SKYWATCH_API_BASE ||
  import.meta.env.VITE_SKYWATCH_API_URL ||
  import.meta.env.VITE_API_URL ||
  ""
).replace(/\/+$/, "");
const configuredDemoMode = import.meta.env.VITE_SKYWATCH_DEMO_MODE === "true";

function getSatelliteUrls(): string[] {
  if (configuredDemoMode) return ["/api/satellites?demo=1"];
  const fallback = "/api/satellites";
  if (!configuredApiBase) return [fallback];

  let backendUrl: string;
  if (/\/satellites\/?$/.test(configuredApiBase)) {
    backendUrl = `${configuredApiBase}/`;
  } else if (/\/api\/v1\/?$/.test(configuredApiBase)) {
    backendUrl = `${configuredApiBase}/satellites/`;
  } else {
    backendUrl = `${configuredApiBase}/api/v1/satellites/`;
  }

  return [fallback, backendUrl];
}

async function fetchJsonWithTimeout(url: string, signal: AbortSignal) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `Satellite feed returned ${response.status}`);
    }
    return payload;
  } finally {
    window.clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}

export function useSatellites() {
  const [catalog, setCatalog] = useState<SatelliteCatalog>(() =>
    normalizeSatelliteCatalog({ satellites: [], groups: [] }),
  );
  const [status, setStatus] = useState<SatelliteStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const inFlightRef = useRef(false);

  const fetchOnce = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const controller = new AbortController();
    setStatus((current) => (current === "ready" ? current : "loading"));

    try {
      let normalized: SatelliteCatalog | null = null;
      let lastError: Error | null = null;
      const urls = getSatelliteUrls();

      for (let index = 0; index < urls.length; index += 1) {
        const url = urls[index];
        try {
          const payload = await fetchJsonWithTimeout(url, controller.signal);
          const candidate = normalizeSatelliteCatalog(payload);
          if (candidate.satellites.length === 0 && index < urls.length - 1) {
            lastError = new Error(candidate.error ?? "Satellite feed returned no usable objects");
            continue;
          }
          normalized = candidate;
          break;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          lastError = error instanceof Error ? error : new Error("Satellite feed unavailable");
        }
      }

      if (!normalized) throw lastError ?? new Error("Satellite feed unavailable");

      setCatalog(normalized);
      setLastUpdated((normalized.time || Math.floor(Date.now() / 1000)) * 1000);
      setErrorMessage(normalized.error ?? null);
      setStatus("ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Satellite feed unavailable";
      setErrorMessage(controller.signal.aborted ? "Satellite feed timed out" : message);
      setStatus("error");
    } finally {
      controller.abort();
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchOnce();
    const id = window.setInterval(fetchOnce, POLL_MS);
    return () => window.clearInterval(id);
  }, [fetchOnce]);

  return {
    ...catalog,
    status,
    errorMessage,
    lastUpdated,
    refresh: fetchOnce,
  };
}
