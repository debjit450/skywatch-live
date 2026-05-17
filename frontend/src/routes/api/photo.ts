import { createFileRoute } from "@tanstack/react-router";

const DEFAULT_ALLOWED_IMAGE_HOSTS = ["adsbdb.com", "photos.adsbdb.com", "airport-data.com"];
const MAX_IMAGE_BYTES = Number(process.env.MAX_AIRCRAFT_IMAGE_BYTES || 5_000_000);
const IMAGE_FETCH_TIMEOUT_MS = 5_000;

function getAllowedImageHosts(): string[] {
  return (process.env.ALLOWED_AIRCRAFT_IMAGE_HOSTS || DEFAULT_ALLOWED_IMAGE_HOSTS.join(","))
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return getAllowedImageHosts().some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function parseTargetUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    if (!isAllowedImageHost(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    return arrayBuffer.byteLength <= maxBytes ? new Uint8Array(arrayBuffer) : null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export const Route = createFileRoute("/api/photo")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const targetUrl = url.searchParams.get("url");

        if (!targetUrl) {
          return new Response("Missing url parameter", { status: 400 });
        }

        const parsedTargetUrl = parseTargetUrl(targetUrl);
        if (!parsedTargetUrl) {
          return new Response("Image host is not allowed", { status: 400 });
        }

        try {
          const response = await fetch(parsedTargetUrl.toString(), {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              Accept: "image/avif,image/webp,image/apng,image/jpeg,image/png,image/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
            },
            signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
          });

          if (!response.ok) {
            return new Response("Failed to fetch image", { status: response.status });
          }

          const contentType = response.headers.get("Content-Type") || "image/jpeg";
          if (!contentType.toLowerCase().startsWith("image/")) {
            return new Response("Unsupported media type", { status: 415 });
          }
          if (contentType.toLowerCase().startsWith("image/svg")) {
            return new Response("Unsupported media type", { status: 415 });
          }

          const contentLength = Number(response.headers.get("Content-Length") || 0);
          if (contentLength > MAX_IMAGE_BYTES) {
            return new Response("Image too large", { status: 413 });
          }

          const body = await readLimitedBody(response, MAX_IMAGE_BYTES);
          if (!body) {
            return new Response("Image too large", { status: 413 });
          }

          const responseBody = body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer;

          return new Response(responseBody, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "public, max-age=86400",
            },
          });
        } catch {
          return new Response("Error fetching image", { status: 500 });
        }
      },
    },
  },
});
