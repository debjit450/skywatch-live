import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const csvPath = resolve(__dirname, "../src/lib/data/airports.csv");
const outPath = resolve(__dirname, "../src/lib/data/airport-db.ts");

const csv = readFileSync(csvPath, "utf-8");

function parseCsvRows(input) {
  const rows = [];
  let row = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        value += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(value);
      value = "";
    } else if (ch === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (ch !== "\r") {
      value += ch;
    }
  }
  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

const rows = parseCsvRows(csv);
const header = rows.shift();
const idx = new Map(header.map((name, i) => [name.trim(), i]));

function col(row, key) {
  const i = idx.get(key);
  return i === undefined ? "" : (row[i] ?? "").trim();
}

const merged = new Map();

for (const row of rows) {
  const ident = col(row, "ident");
  const icao = col(row, "icao_code");
  const iata = col(row, "iata_code");
  const name = col(row, "name");
  const city = col(row, "municipality");
  const country = col(row, "iso_country");
  const latStr = col(row, "latitude_deg");
  const lonStr = col(row, "longitude_deg");
  const elevStr = col(row, "elevation_ft");

  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);
  if (!isFinite(lat) || !isFinite(lon)) continue;
  if (!ident) continue;

  const hasIcao = icao && icao.length >= 3;
  const identLooksIcao = /^[A-Z]{4}$/.test(ident.toUpperCase()) && ident.length === 4;

  if (!hasIcao && !identLooksIcao && !iata) continue;

  const elev = parseInt(elevStr, 10);
  const entry = {
    name,
    iata,
    icao: icao || ident,
    city,
    country,
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    elev: isFinite(elev) ? elev : 0,
  };

  if (hasIcao) {
    const key = icao.toUpperCase();
    if (!merged.has(key)) merged.set(key, entry);
  }

  if (identLooksIcao) {
    const key = ident.toUpperCase();
    if (!merged.has(key)) merged.set(key, entry);
  }

  if (iata) {
    const key = iata.toUpperCase();
    if (!merged.has(key)) merged.set(key, entry);
  }
}

const escaped = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

let ts = `import type { RouteAirport } from "@/lib/enrichment-types";

interface CompactEntry {
  n: string;
  ia: string;
  ic: string;
  m: string;
  co: string;
  la: number;
  lo: number;
  el: number;
}

const _d: [string, CompactEntry][] = [\n`;

for (const [key, e] of merged) {
  ts += `["${key}",{n:"${escaped(e.name)}",ia:"${escaped(e.iata)}",ic:"${escaped(e.icao)}",m:"${escaped(e.city)}",co:"${escaped(e.country)}",la:${e.lat},lo:${e.lon},el:${e.elev}}],\n`;
}

ts += `];

const _m = new Map<string, CompactEntry>(_d);

export function lookupAirportByIcao(icao: string): RouteAirport | null {
  if (!icao) return null;
  const code = icao.toUpperCase().trim();
  const a = _m.get(code);
  if (!a) return null;
  return {
    name: a.n,
    iataCode: a.ia,
    icaoCode: a.ic,
    municipality: a.m,
    countryName: a.co,
    countryIso: a.co,
    latitude: a.la,
    longitude: a.lo,
    elevation: a.el,
  };
}

export const airportDbSize = _m.size;
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, ts, "utf-8");

console.log(`Generated ${outPath} with ${merged.size} lookup entries`);
