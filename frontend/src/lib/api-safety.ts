const ICAO24_PATTERN = /^[a-f0-9]{6}$/;
const CALLSIGN_PATTERN = /^[A-Z0-9]{1,10}$/;
const REGISTRATION_PATTERN = /^[A-Z0-9-]{1,12}$/;

export function normalizeIcao24(value: string | null | undefined): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return ICAO24_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeCallsign(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const normalized = raw.toUpperCase().replace(/\s+/g, "");
  return CALLSIGN_PATTERN.test(normalized) ? normalized : null;
}

export function normalizeRegistration(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const normalized = raw.toUpperCase();
  return REGISTRATION_PATTERN.test(normalized) ? normalized : null;
}

export function parseOptionalCoordinate(
  value: string | null | undefined,
  min: number,
  max: number,
): { value: number | null; valid: boolean } {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null, valid: true };

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? { value: parsed, valid: true }
    : { value: null, valid: false };
}

export function isFiniteCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 8_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const upstreamSignal = init.signal;

  const abort = () => controller.abort();
  if (upstreamSignal?.aborted) {
    controller.abort();
  } else {
    upstreamSignal?.addEventListener("abort", abort, { once: true });
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    upstreamSignal?.removeEventListener("abort", abort);
  }
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}
