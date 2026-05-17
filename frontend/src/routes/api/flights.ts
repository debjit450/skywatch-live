import { createFileRoute } from "@tanstack/react-router";
import { parseFlights, type OpenSkyResponse } from "@/lib/opensky";
import { fetchWithTimeout, jsonResponse } from "@/lib/api-safety";

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all?extended=1";

let cachedToken: { token: string; expiresAt: number } | null = null;

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
  if (!res.ok) {
    console.error("OpenSky token request failed", res.status);
    return null;
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

export const Route = createFileRoute("/api/flights")({
  server: {
    handlers: {
      GET: async () => {
        try {
          const token = await getAccessToken();
          const headers: Record<string, string> = { Accept: "application/json" };
          if (token) headers.Authorization = `Bearer ${token}`;

          const res = await fetchWithTimeout(STATES_URL, { headers }, 12_000);
          if (!res.ok) {
            return jsonResponse(
              {
                error: `OpenSky returned ${res.status}`,
                flights: [],
                time: 0,
              },
              { status: 502 },
            );
          }
          const data = (await res.json()) as OpenSkyResponse;
          const flights = parseFlights(data.states);
          return jsonResponse(
            { time: data.time, flights, authenticated: !!token },
            {
              status: 200,
              headers: {
                "Cache-Control": "no-store",
              },
            },
          );
        } catch (err) {
          console.error("Flight proxy failed", err);
          return jsonResponse(
            {
              error: "Flight feed unavailable",
              flights: [],
              time: 0,
            },
            { status: 502 },
          );
        }
      },
    },
  },
});
