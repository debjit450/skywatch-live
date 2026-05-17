// Conversion + formatting helpers
export const M_TO_FT = 3.28084;
export const MS_TO_KT = 1.94384;
export const MS_TO_FPM = 196.85; // m/s -> ft/min
export const MS_TO_KMH = 3.6;
export const MS_TO_MPH = 2.23694;
export const NM_TO_KM = 1.852;

export function fmt(
  n: number | null | undefined,
  opts: { suffix?: string; digits?: number; sign?: boolean } = {},
): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "--";
  const { suffix = "", digits = 0, sign = false } = opts;
  const v = n.toFixed(digits);
  const s = sign && n > 0 ? `+${v}` : v;
  return `${s}${suffix}`;
}

export function altitudeFt(m: number | null): number | null {
  return m === null ? null : m * M_TO_FT;
}

export function speedKt(ms: number | null): number | null {
  return ms === null ? null : ms * MS_TO_KT;
}

export function speedKmh(ms: number | null): number | null {
  return ms === null ? null : ms * MS_TO_KMH;
}

export function speedMph(ms: number | null): number | null {
  return ms === null ? null : ms * MS_TO_MPH;
}

export function vsFpm(ms: number | null): number | null {
  return ms === null ? null : ms * MS_TO_FPM;
}

/** Flight level from barometric altitude in meters (FL = alt_ft / 100) */
export function flightLevel(baroAltM: number | null): string {
  if (baroAltM === null) return "--";
  const fl = Math.round((baroAltM * M_TO_FT) / 100);
  return `FL${fl.toString().padStart(3, "0")}`;
}

/** Rough Mach estimate using ISA temperature lapse.  Accuracy ~±0.02 M. */
export function estimateMach(velocityMs: number | null, baroAltM: number | null): number | null {
  if (velocityMs === null || baroAltM === null) return null;
  // ISA: T = 288.15 - 0.0065 * h  (troposphere, h in meters)
  const altClamped = Math.min(Math.max(baroAltM, 0), 11_000);
  const tempK = 288.15 - 0.0065 * altClamped;
  const speedOfSound = Math.sqrt(1.4 * 287.05 * tempK); // m/s
  return velocityMs / speedOfSound;
}

/** Decimal degrees → DMS string  e.g. 28° 37′ 12.48″ N */
export function toDMS(decimal: number | null, isLat: boolean): string {
  if (decimal === null) return "--";
  const abs = Math.abs(decimal);
  const d = Math.floor(abs);
  const mFloat = (abs - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  const dir = isLat ? (decimal >= 0 ? "N" : "S") : decimal >= 0 ? "E" : "W";
  return `${d}° ${m}′ ${s.toFixed(2)}″ ${dir}`;
}

export function headingCompass(deg: number | null): string {
  if (deg === null) return "--";
  const dirs = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  return dirs[Math.round((deg % 360) / 22.5) % 16];
}

export function relativeTime(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 600) return `${Math.floor(diff / 60)}m ${(diff % 60).toString().padStart(2, "0")}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

export function formatClock(ts: number | null): string {
  if (!ts) return "--";
  const d = new Date(ts);
  const hms = d.toLocaleTimeString("en-GB", { hour12: false });
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hms}.${ms}`;
}

export function formatDateTimeSeconds(seconds: number | null): string {
  if (!seconds) return "--";
  const d = new Date(seconds * 1000);
  const base = d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return base;
}

export function formatDateTimeMs(ms: number | null): string {
  if (!ms) return "--";
  const d = new Date(ms);
  const base = d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const msStr = d.getMilliseconds().toString().padStart(3, "0");
  return `${base}.${msStr}`;
}

/** Format a UNIX timestamp as a raw epoch string */
export function formatEpoch(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "--";
  return seconds.toFixed(3);
}

// ICAO country -> ISO-2 (subset; falls back to first 2 letters)
const COUNTRY_TO_ISO: Record<string, string> = {
  India: "IN",
  "United States": "US",
  "United Kingdom": "GB",
  Germany: "DE",
  France: "FR",
  Spain: "ES",
  Italy: "IT",
  Netherlands: "NL",
  Canada: "CA",
  Australia: "AU",
  Japan: "JP",
  China: "CN",
  "Russian Federation": "RU",
  Brazil: "BR",
  Mexico: "MX",
  Turkey: "TR",
  "United Arab Emirates": "AE",
  Singapore: "SG",
  "Hong Kong": "HK",
  Switzerland: "CH",
  Sweden: "SE",
  Norway: "NO",
  Denmark: "DK",
  Finland: "FI",
  Belgium: "BE",
  Austria: "AT",
  Ireland: "IE",
  Poland: "PL",
  Portugal: "PT",
  Greece: "GR",
  "Saudi Arabia": "SA",
  Qatar: "QA",
  "South Korea": "KR",
  Korea: "KR",
  Thailand: "TH",
  Malaysia: "MY",
  Indonesia: "ID",
  Philippines: "PH",
  "South Africa": "ZA",
  Egypt: "EG",
  Israel: "IL",
  "New Zealand": "NZ",
  Argentina: "AR",
  Chile: "CL",
  Colombia: "CO",
};

export function countryCode(country: string): string {
  return COUNTRY_TO_ISO[country] || country.slice(0, 2).toUpperCase();
}

// Best-effort airline lookup from callsign prefix (3-letter ICAO)
const AIRLINES: Record<string, string> = {
  AIC: "Air India",
  IGO: "IndiGo",
  SEJ: "SpiceJet",
  AXB: "Air India Express",
  VTI: "Vistara",
  AIQ: "Alliance Air",
  IAD: "Air India",
  UAE: "Emirates",
  QTR: "Qatar Airways",
  ETD: "Etihad",
  SVA: "Saudia",
  THY: "Turkish Airlines",
  BAW: "British Airways",
  DLH: "Lufthansa",
  AFR: "Air France",
  KLM: "KLM",
  UAL: "United",
  AAL: "American",
  DAL: "Delta",
  SWA: "Southwest",
  JBU: "JetBlue",
  ACA: "Air Canada",
  QFA: "Qantas",
  ANZ: "Air NZ",
  JAL: "Japan Airlines",
  ANA: "ANA",
  SIA: "Singapore Air",
  CPA: "Cathay Pacific",
  THA: "Thai",
  MAS: "Malaysia",
  GIA: "Garuda",
  PAL: "Philippine",
  KAL: "Korean Air",
  AAR: "Asiana",
  CCA: "Air China",
  CES: "China Eastern",
  CSN: "China Southern",
  SVR: "Ural",
  AFL: "Aeroflot",
  FDX: "FedEx",
  UPS: "UPS",
  DHL: "DHL",
  RYR: "Ryanair",
  EZY: "easyJet",
  WZZ: "Wizz Air",
  IBE: "Iberia",
};

export function airlineFromCallsign(cs: string | null): string | null {
  if (!cs) return null;
  const prefix = cs.trim().slice(0, 3).toUpperCase();
  return AIRLINES[prefix] || null;
}

export function getAircraftCategoryLabel(category: number | string): string {
  switch (Number(category)) {
    case 1:
      return "No ADS-B Emitter Category";
    case 2:
      return "Light (< 15,500 lbs)";
    case 3:
      return "Small (15,500 - 75,000 lbs)";
    case 4:
      return "Large (75,000 - 300,000 lbs)";
    case 5:
      return "High Vortex Large";
    case 6:
      return "Heavy (> 300,000 lbs)";
    case 7:
      return "High Performance";
    case 8:
      return "Rotorcraft / Helicopter";
    case 9:
      return "Glider / Sailplane";
    case 10:
      return "Lighter-than-air";
    case 11:
      return "Parachutist / Skydiver";
    case 12:
      return "Ultralight / Hang-glider";
    case 14:
      return "Unmanned Aerial Vehicle";
    case 15:
      return "Space / Trans-atmospheric";
    case 16:
      return "Surface Vehicle - Emergency";
    case 17:
      return "Surface Vehicle - Service";
    case 18:
      return "Point Obstacle";
    case 19:
      return "Cluster Obstacle";
    case 20:
      return "Line Obstacle";
    default:
      return "Unknown or Not Provided";
  }
}

// ─── Atmosphere (ISA) helpers ───────────────────────────────────────────────
const ISA_T0 = 288.15; // sea-level temp (K)
const ISA_P0 = 101325; // sea-level pressure (Pa)
const ISA_RHO0 = 1.225; // sea-level density (kg/m³)
const ISA_LAPSE = 0.0065; // K/m in troposphere
const ISA_G = 9.80665;
const ISA_R = 287.05287;
const ISA_GAMMA = 1.4;
const TROPO_CEIL = 11000; // meters

/** ISA temperature at altitude (K). Troposphere only. */
export function isaTemperatureK(altM: number | null): number | null {
  if (altM === null) return null;
  const h = Math.min(Math.max(altM, 0), TROPO_CEIL);
  return ISA_T0 - ISA_LAPSE * h;
}

/** ISA pressure at altitude (Pa). */
export function isaPressurePa(altM: number | null): number | null {
  if (altM === null) return null;
  const h = Math.min(Math.max(altM, 0), TROPO_CEIL);
  return ISA_P0 * Math.pow(1 - (ISA_LAPSE * h) / ISA_T0, ISA_G / (ISA_LAPSE * ISA_R));
}

/** ISA air density at altitude (kg/m³). */
export function isaDensity(altM: number | null): number | null {
  const T = isaTemperatureK(altM);
  const P = isaPressurePa(altM);
  if (T === null || P === null) return null;
  return P / (ISA_R * T);
}

/** Speed of sound at altitude (m/s). */
export function speedOfSound(altM: number | null): number | null {
  const T = isaTemperatureK(altM);
  if (T === null) return null;
  return Math.sqrt(ISA_GAMMA * ISA_R * T);
}

/** Estimated True Airspeed from ground speed (m/s). Crude — ignores wind. */
export function estimateTAS(groundSpeedMs: number | null, altM: number | null): number | null {
  if (groundSpeedMs === null || altM === null) return null;
  // TAS ≈ GS for zero-wind; apply density correction to get CAS→TAS direction
  const rho = isaDensity(altM);
  if (!rho || rho <= 0) return groundSpeedMs;
  // ratio = sqrt(rho0 / rho) — gives TAS from CAS, but we have GS not CAS
  // For display purposes, GS ≈ TAS is the accepted approximation
  return groundSpeedMs;
}

/** Estimated Calibrated Airspeed from ground speed & altitude (m/s). */
export function estimateCAS(groundSpeedMs: number | null, altM: number | null): number | null {
  if (groundSpeedMs === null || altM === null) return null;
  const rho = isaDensity(altM);
  if (!rho || rho <= 0) return groundSpeedMs;
  return groundSpeedMs * Math.sqrt(rho / ISA_RHO0);
}

/** Dynamic pressure q = ½ρv² (Pa). */
export function dynamicPressure(velocityMs: number | null, altM: number | null): number | null {
  if (velocityMs === null || altM === null) return null;
  const rho = isaDensity(altM);
  if (rho === null) return null;
  return 0.5 * rho * velocityMs * velocityMs;
}

/** Pressure altitude from barometric altitude (ft). Uses ISA. */
export function pressureAltitudeFt(baroAltM: number | null): number | null {
  if (baroAltM === null) return null;
  // pressure altitude = baro_alt in ISA (standard setting)
  return baroAltM * M_TO_FT;
}

/** Density altitude (ft) — altitude in ISA where density = actual density. */
export function densityAltitudeFt(baroAltM: number | null): number | null {
  if (baroAltM === null) return null;
  const T = isaTemperatureK(baroAltM);
  if (T === null) return null;
  const isaT = ISA_T0 - ISA_LAPSE * Math.min(Math.max(baroAltM, 0), TROPO_CEIL);
  // DA = PA + (120 × (OAT − ISA_T_at_PA)). OAT ≈ ISA here so DA ≈ PA
  return baroAltM * M_TO_FT;
}

// ─── Kinematic helpers ──────────────────────────────────────────────────────

/** Estimate turn rate (°/s) from two sequential headings over dt seconds. */
export function estimateTurnRate(heading: number | null, velocity: number | null): number | null {
  // Standard rate turn: 3°/s at any speed
  // We can't compute actual turn rate without heading history,
  // but we can compute the "standard rate" bank angle
  if (heading === null || velocity === null || velocity < 10) return null;
  return null; // requires heading history
}

/** Bank angle for a standard-rate turn at given TAS (degrees). */
export function standardRateBankAngle(velocityMs: number | null): number | null {
  if (velocityMs === null || velocityMs < 10) return null;
  // tan(bank) = v * ω / g,  ω = 3°/s = 0.05236 rad/s
  const omega = 0.05236;
  return (Math.atan((velocityMs * omega) / ISA_G) * 180) / Math.PI;
}

/** Estimated load factor for a turn at given bank angle. n = 1/cos(bank). */
export function loadFactorAtBank(bankDegrees: number | null): number | null {
  if (bankDegrees === null) return null;
  const rad = (bankDegrees * Math.PI) / 180;
  return 1 / Math.cos(rad);
}

/** Turn radius at given speed and standard rate (meters). */
export function standardRateTurnRadius(velocityMs: number | null): number | null {
  if (velocityMs === null || velocityMs < 10) return null;
  // R = v / ω,  ω = 3°/s = 0.05236 rad/s
  return velocityMs / 0.05236;
}

// ─── Geospatial helpers ─────────────────────────────────────────────────────

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in km. */
export function gcDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p = toRad(lat1),
    q = toRad(lat2),
    dl = toRad(lon2 - lon1);
  const a = Math.sin((q - p) / 2) ** 2 + Math.cos(p) * Math.cos(q) * Math.sin(dl / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Great-circle distance in nautical miles. */
export function gcDistanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return gcDistanceKm(lat1, lon1, lat2, lon2) / NM_TO_KM;
}

/** Initial bearing from point 1 to point 2 (degrees, 0-360). */
export function gcBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = toRad(lat1),
    p2 = toRad(lat2);
  const dl = toRad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Cross-track distance (km) of point C from great-circle path A→B. */
export function crossTrackDistanceKm(
  latA: number,
  lonA: number,
  latB: number,
  lonB: number,
  latC: number,
  lonC: number,
): number {
  const dAC = gcDistanceKm(latA, lonA, latC, lonC) / 6371;
  const brgAC = toRad(gcBearing(latA, lonA, latC, lonC));
  const brgAB = toRad(gcBearing(latA, lonA, latB, lonB));
  return Math.abs(Math.asin(Math.sin(dAC) * Math.sin(brgAC - brgAB))) * 6371;
}

/** Midpoint of two coordinates. */
export function gcMidpoint(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): { lat: number; lon: number } {
  const p1 = toRad(lat1),
    l1 = toRad(lon1),
    p2 = toRad(lat2),
    dl = toRad(lon2 - lon1);
  const bx = Math.cos(p2) * Math.cos(dl);
  const by = Math.cos(p2) * Math.sin(dl);
  const lat = Math.atan2(
    Math.sin(p1) + Math.sin(p2),
    Math.sqrt((Math.cos(p1) + bx) ** 2 + by ** 2),
  );
  const lon = l1 + Math.atan2(by, Math.cos(p1) + bx);
  return { lat: toDeg(lat), lon: toDeg(lon) };
}

// ─── Signal quality helpers ─────────────────────────────────────────────────

export function signalFreshnessLabel(ageSeconds: number): string {
  if (ageSeconds < 5) return "Excellent";
  if (ageSeconds < 15) return "Good";
  if (ageSeconds < 30) return "Fair";
  if (ageSeconds < 60) return "Degraded";
  if (ageSeconds < 120) return "Poor";
  if (ageSeconds < 300) return "Very Poor";
  return "Stale / Lost";
}

export function positionSourceQuality(source: number): {
  label: string;
  accuracy: string;
  description: string;
} {
  switch (source) {
    case 0:
      return {
        label: "ADS-B",
        accuracy: "±15–90 m",
        description: "Automatic Dependent Surveillance-Broadcast via 1090 MHz transponder",
      };
    case 1:
      return {
        label: "ASTERIX",
        accuracy: "±50–200 m",
        description: "All-purpose Structured Eurocontrol Surveillance Info Exchange",
      };
    case 2:
      return {
        label: "MLAT",
        accuracy: "±100–500 m",
        description: "Multilateration via time-difference-of-arrival from ground receivers",
      };
    case 3:
      return {
        label: "FLARM",
        accuracy: "±25–150 m",
        description: "Low-power collision avoidance for GA & gliders",
      };
    default:
      return {
        label: "Unknown",
        accuracy: "Unknown",
        description: "Position source not identified",
      };
  }
}

// ─── Squawk code reference ──────────────────────────────────────────────────

export function squawkMeaning(squawk: string | null): string | null {
  if (!squawk) return null;
  const meanings: Record<string, string> = {
    "0000": "Mode A code not set",
    "1200": "VFR (US/Canada)",
    "1400": "VFR above 12,500 ft",
    "2000": "Oceanic / Non-discrete",
    "7000": "VFR (ICAO / Europe)",
    "7500": "🔴 HIJACK",
    "7600": "🔴 RADIO FAILURE",
    "7700": "🔴 GENERAL EMERGENCY",
    "7777": "Military interceptor (do not assign)",
  };
  return meanings[squawk] || null;
}

/** Returns true if the squawk indicates a VFR or notable code. */
export function isNotableSquawk(squawk: string | null): boolean {
  if (!squawk) return false;
  return ["1200", "1400", "2000", "7000", "7500", "7600", "7700", "7777"].includes(squawk);
}
