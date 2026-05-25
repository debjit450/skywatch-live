import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, "..");
const clientDir = path.join(appDir, "dist", "client");
const serverEntryUrl = pathToFileURL(path.join(appDir, "dist", "server", "server.js")).href;
const { default: app } = await import(serverEntryUrl);

const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp",
};

function staticPathFor(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  if (pathname.endsWith("/")) return null;
  const candidate = path.resolve(clientDir, `.${pathname}`);
  const clientRoot = `${clientDir}${path.sep}`;
  return candidate.startsWith(clientRoot) ? candidate : null;
}

async function maybeServeStatic(req, res, url) {
  const filePath = staticPathFor(url);
  if (!filePath) return false;

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;

    const ext = path.extname(filePath).toLowerCase();
    res.statusCode = 200;
    res.setHeader("content-type", MIME_TYPES[ext] || "application/octet-stream");
    res.setHeader(
      "cache-control",
      url.pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=86400",
    );
    createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function fetchRequestFromIncoming(req, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const init = {
    method: req.method,
    headers,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }

  return new Request(url, init);
}

async function sendFetchResponse(fetchResponse, res, method) {
  res.statusCode = fetchResponse.status;
  res.statusMessage = fetchResponse.statusText;
  fetchResponse.headers.forEach((value, key) => res.setHeader(key, value));

  if (method === "HEAD" || !fetchResponse.body) {
    res.end();
    return;
  }

  Readable.fromWeb(fetchResponse.body).pipe(res);
}

createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

  if (await maybeServeStatic(req, res, url)) return;

  try {
    const fetchRequest = fetchRequestFromIncoming(req, url);
    const fetchResponse = await app.fetch(fetchRequest, process.env, {});
    await sendFetchResponse(fetchResponse, res, req.method);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Internal Server Error");
  }
}).listen(port, host, () => {
  console.log(`SkyWatch frontend listening on http://${host}:${port}`);
});
