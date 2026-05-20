const configuredApiBase = (
  import.meta.env.VITE_SKYWATCH_API_BASE ||
  import.meta.env.VITE_SKYWATCH_API_URL ||
  import.meta.env.VITE_API_URL ||
  ""
).replace(/\/+$/, "");

const LOCAL_DJANGO_API_ROOT = "http://127.0.0.1:8000";

function configuredUrl(path: string): string {
  if (/\/api\/v1\/?$/.test(configuredApiBase)) {
    return `${configuredApiBase}${path.replace(/^\/api\/v1/, "")}`;
  }
  return `${configuredApiBase}${path}`;
}

export function backendApiCandidates(path: string): string[] {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (configuredApiBase) return [configuredUrl(normalizedPath)];
  return [normalizedPath, `${LOCAL_DJANGO_API_ROOT}${normalizedPath}`];
}

export async function fetchBackendJson<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let lastError: Error | null = null;

  for (const url of backendApiCandidates(path)) {
    try {
      const response = await fetch(url, {
        credentials: "include",
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.headers || {}),
        },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error: unknown }).error)
            : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Backend API unavailable");
    }
  }

  throw lastError ?? new Error("Backend API unavailable");
}

export async function fetchBackendResponse(path: string, init: RequestInit = {}): Promise<Response> {
  let lastError: Error | null = null;

  for (const url of backendApiCandidates(path)) {
    try {
      const response = await fetch(url, {
        credentials: "include",
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.headers || {}),
        },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message =
          payload && typeof payload === "object" && "error" in payload
            ? String((payload as { error: unknown }).error)
            : `HTTP ${response.status}`;
        throw new Error(message);
      }
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Backend API unavailable");
    }
  }

  throw lastError ?? new Error("Backend API unavailable");
}
