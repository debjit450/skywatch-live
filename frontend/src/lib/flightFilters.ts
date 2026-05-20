import type { AnomalousFlight, Severity } from "@/lib/anomaly";
import { topSeverity } from "@/lib/anomaly";
import { airlineFromCallsign, altitudeFt, countryCode, speedKt, vsFpm } from "@/lib/format";
import type { Flight } from "@/lib/opensky";
import { classifyFlight } from "@/lib/aircraft-class";

export type FlightFilterMode = "all" | "airborne" | "ground" | "anomaly" | "emergency" | "stale";
export type AltitudeBand = "all" | "surface" | "terminal" | "low" | "cruise" | "high";
export type SpeedBand = "all" | "slow" | "standard" | "fast" | "very_fast";
export type VerticalBand = "all" | "climbing" | "level" | "descending";
export type SeverityFilter = "all" | Severity;

export interface FlightFilters {
  query: string;
  mode: FlightFilterMode;
  aircraftClass: string;
  country: string;
  altitudeBand: AltitudeBand;
  speedBand: SpeedBand;
  verticalBand: VerticalBand;
  severity: SeverityFilter;
  anomalyType: string;
  minAltitudeFt: string;
  maxAltitudeFt: string;
  minSpeedKt: string;
  maxSpeedKt: string;
}

export interface FlightFilterResult {
  flights: Flight[];
  total: number;
  matched: number;
  activeFilterCount: number;
  activeFilterLabels: string[];
}

type QueryField = "icao" | "callsign" | "country" | "airline" | "squawk" | "category";
type NumericField = "altitude" | "flight_level" | "speed" | "vertical";
type NumericOperator = ">" | ">=" | "<" | "<=" | "=";

interface QueryConstraint {
  field: QueryField;
  value: string;
}

interface NumericConstraint {
  field: NumericField;
  operator: NumericOperator;
  value: number;
}

interface ParsedQuery {
  raw: string;
  terms: string[];
  fields: QueryConstraint[];
  numeric: NumericConstraint[];
}

interface RankedFlight {
  flight: Flight;
  score: number;
  index: number;
}

export const DEFAULT_FLIGHT_FILTERS: FlightFilters = {
  query: "",
  mode: "all",
  aircraftClass: "all",
  country: "all",
  altitudeBand: "all",
  speedBand: "all",
  verticalBand: "all",
  severity: "all",
  anomalyType: "all",
  minAltitudeFt: "",
  maxAltitudeFt: "",
  minSpeedKt: "",
  maxSpeedKt: "",
};

export const ANOMALY_TYPE_LABELS: Record<string, string> = {
  ghost: "Ghost Flight",
  squawk_7500: "Hijack (7500)",
  squawk_7600: "Radio Failure (7600)",
  squawk_7700: "Emergency (7700)",
  low_fast: "Low & Fast Outlier",
  rapid_descent: "Rapid Descent",
  signal_lost: "Signal Lost Outlier",
  ml_anomaly: "ML-Detected Anomaly",
  speed_anomaly: "Unusual Speed",
  altitude_anomaly: "Unusual Altitude",
  heading_anomaly: "Unusual Heading",
  position_anomaly: "Position Jump",
  circling: "Circling / Loitering",
  trajectory_deviation: "Trajectory Deviation",
  geofence: "Restricted Airspace",
  proximity: "Proximity Alert",
  altitude_bust: "Altitude Bust",
  speed_envelope: "Speed Envelope Violation",
  behavioral: "Behavioral Deviation",
  custom_rule: "Custom Alert Rule",
};

export const FLIGHT_FILTER_MODES: Array<{ value: FlightFilterMode; label: string }> = [
  { value: "all", label: "All" },
  { value: "airborne", label: "Airborne" },
  { value: "ground", label: "Ground" },
  { value: "anomaly", label: "Anomaly" },
  { value: "emergency", label: "Emergency" },
  { value: "stale", label: "Stale" },
];

export const ALTITUDE_BANDS: Array<{ value: AltitudeBand; label: string }> = [
  { value: "all", label: "Any altitude" },
  { value: "surface", label: "Surface" },
  { value: "terminal", label: "Terminal" },
  { value: "low", label: "Low" },
  { value: "cruise", label: "Cruise" },
  { value: "high", label: "High" },
];

export const SPEED_BANDS: Array<{ value: SpeedBand; label: string }> = [
  { value: "all", label: "Any speed" },
  { value: "slow", label: "Slow" },
  { value: "standard", label: "Standard" },
  { value: "fast", label: "Fast" },
  { value: "very_fast", label: "Very fast" },
];

export const VERTICAL_BANDS: Array<{ value: VerticalBand; label: string }> = [
  { value: "all", label: "Any vertical" },
  { value: "climbing", label: "Climbing" },
  { value: "level", label: "Level" },
  { value: "descending", label: "Descending" },
];

export const SEVERITY_FILTERS: Array<{ value: SeverityFilter; label: string }> = [
  { value: "all", label: "Any severity" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);
const QUERY_TOKEN_PATTERN = /"([^"]+)"|[^\s]+/g;

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function parseLooseNumber(value: string): number | null {
  if (!value.trim()) return null;
  const normalized = value.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  for (const match of query.matchAll(QUERY_TOKEN_PATTERN)) {
    const token = (match[1] ?? match[0]).trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function parseNumericToken(token: string): NumericConstraint | null {
  const match = token.match(
    /^(alt|altitude|fl|level|speed|spd|kt|vs|vertical)(>=|<=|>|<|=)(-?\d+(?:\.\d+)?)$/i,
  );
  if (!match) return null;

  const [, rawField, operator, rawValue] = match;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return null;

  const field = normalize(rawField);
  if (field === "alt" || field === "altitude") {
    return { field: "altitude", operator: operator as NumericOperator, value };
  }
  if (field === "fl" || field === "level") {
    return { field: "flight_level", operator: operator as NumericOperator, value };
  }
  if (field === "speed" || field === "spd" || field === "kt") {
    return { field: "speed", operator: operator as NumericOperator, value };
  }
  return { field: "vertical", operator: operator as NumericOperator, value };
}

function parseFieldToken(token: string): QueryConstraint | null {
  const splitAt = token.indexOf(":");
  if (splitAt <= 0 || splitAt === token.length - 1) return null;

  const key = normalize(token.slice(0, splitAt));
  const value = token.slice(splitAt + 1).trim();
  if (!value) return null;

  if (key === "icao" || key === "icao24" || key === "hex" || key === "id") {
    return { field: "icao", value };
  }
  if (key === "cs" || key === "call" || key === "callsign" || key === "flight") {
    return { field: "callsign", value };
  }
  if (key === "country" || key === "origin") {
    return { field: "country", value };
  }
  if (key === "airline" || key === "operator") {
    return { field: "airline", value };
  }
  if (key === "sq" || key === "squawk") {
    return { field: "squawk", value };
  }
  if (key === "cat" || key === "category") {
    return { field: "category", value };
  }
  return null;
}

function parseQuery(query: string): ParsedQuery {
  const terms: string[] = [];
  const fields: QueryConstraint[] = [];
  const numeric: NumericConstraint[] = [];

  for (const token of tokenizeQuery(query)) {
    const numericConstraint = parseNumericToken(token);
    if (numericConstraint) {
      numeric.push(numericConstraint);
      continue;
    }

    const fieldConstraint = parseFieldToken(token);
    if (fieldConstraint) {
      fields.push(fieldConstraint);
      continue;
    }

    terms.push(token);
  }

  return { raw: query.trim(), terms, fields, numeric };
}

function compareNumber(value: number | null, operator: NumericOperator, target: number): boolean {
  if (value === null || !Number.isFinite(value)) return false;
  if (operator === ">") return value > target;
  if (operator === ">=") return value >= target;
  if (operator === "<") return value < target;
  if (operator === "<=") return value <= target;
  return Math.abs(value - target) < 0.0001;
}

function flightAltitudeFt(flight: Flight): number | null {
  return altitudeFt(flight.baro_altitude ?? flight.geo_altitude);
}

function flightSpeedKt(flight: Flight): number | null {
  return speedKt(flight.velocity);
}

function flightVerticalFpm(flight: Flight): number | null {
  return vsFpm(flight.vertical_rate);
}

function fieldValue(flight: Flight, field: QueryField): string {
  if (field === "icao") return flight.icao24;
  if (field === "callsign") return flight.callsign ?? "";
  if (field === "country") return `${flight.origin_country} ${countryCode(flight.origin_country)}`;
  if (field === "airline") return airlineFromCallsign(flight.callsign) ?? "";
  if (field === "squawk") return flight.squawk ?? "";
  return flight.category === 8 ? "8 rotorcraft helicopter" : String(flight.category ?? "");
}

function flightSearchText(flight: Flight, anomaly?: AnomalousFlight): string {
  return [
    flight.icao24,
    flight.callsign,
    flight.origin_country,
    countryCode(flight.origin_country),
    flight.squawk,
    flight.category ? `cat${flight.category}` : "",
    flight.category === 8 ? "helicopter rotorcraft heli" : "",
    airlineFromCallsign(flight.callsign),
    anomaly?.anomalies.map((item) => item.label).join(" "),
    anomaly ? "anomaly alert" : "",
    EMERGENCY_SQUAWKS.has(flight.squawk ?? "") ? "emergency distress" : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function matchesNumericQuery(flight: Flight, constraint: NumericConstraint): boolean {
  if (constraint.field === "altitude") {
    return compareNumber(flightAltitudeFt(flight), constraint.operator, constraint.value);
  }
  if (constraint.field === "flight_level") {
    const altitude = flightAltitudeFt(flight);
    return compareNumber(
      altitude === null ? null : altitude / 100,
      constraint.operator,
      constraint.value,
    );
  }
  if (constraint.field === "speed") {
    return compareNumber(flightSpeedKt(flight), constraint.operator, constraint.value);
  }
  return compareNumber(flightVerticalFpm(flight), constraint.operator, constraint.value);
}

function matchesParsedQuery(
  flight: Flight,
  anomaly: AnomalousFlight | undefined,
  parsed: ParsedQuery,
): boolean {
  if (!parsed.raw) return true;

  for (const constraint of parsed.fields) {
    if (!normalize(fieldValue(flight, constraint.field)).includes(normalize(constraint.value))) {
      return false;
    }
  }

  for (const constraint of parsed.numeric) {
    if (!matchesNumericQuery(flight, constraint)) return false;
  }

  if (parsed.terms.length === 0) return true;
  const haystack = flightSearchText(flight, anomaly);
  return parsed.terms.every((term) => haystack.includes(normalize(term)));
}

function queryScore(
  flight: Flight,
  anomaly: AnomalousFlight | undefined,
  parsed: ParsedQuery,
): number {
  if (!parsed.raw) return 0;

  let score = anomaly ? 25 : 0;
  const callsign = normalize(flight.callsign);
  const icao = normalize(flight.icao24);
  const country = normalize(flight.origin_country);
  const airline = normalize(airlineFromCallsign(flight.callsign));
  const squawk = normalize(flight.squawk);

  const bump = (text: string, term: string, exact: number, starts: number, contains: number) => {
    if (!text || !term) return 0;
    if (text === term) return exact;
    if (text.startsWith(term)) return starts;
    if (text.includes(term)) return contains;
    return 0;
  };

  for (const term of parsed.terms.map(normalize)) {
    score += bump(callsign, term, 900, 620, 340);
    score += bump(icao, term, 860, 600, 320);
    score += bump(squawk, term, 520, 360, 220);
    score += bump(airline, term, 340, 260, 140);
    score += bump(country, term, 220, 160, 80);
  }

  for (const constraint of parsed.fields) {
    const term = normalize(constraint.value);
    score += bump(normalize(fieldValue(flight, constraint.field)), term, 1000, 680, 380);
  }

  score += parsed.numeric.length * 60;
  if (EMERGENCY_SQUAWKS.has(flight.squawk ?? "")) score += 80;
  if (!flight.on_ground) score += 10;

  return score;
}

function signalAgeSeconds(flight: Flight): number {
  return Math.max(0, Date.now() / 1000 - flight.last_contact);
}

function modeMatches(flight: Flight, anomaly: AnomalousFlight | undefined, mode: FlightFilterMode) {
  if (mode === "all") return true;
  if (mode === "airborne") return !flight.on_ground;
  if (mode === "ground") return flight.on_ground;
  if (mode === "anomaly") return Boolean(anomaly);
  if (mode === "emergency") return EMERGENCY_SQUAWKS.has(flight.squawk ?? "");
  return signalAgeSeconds(flight) > 300;
}

function altitudeBandMatches(flight: Flight, band: AltitudeBand): boolean {
  if (band === "all") return true;
  const altitude = flightAltitudeFt(flight);
  if (altitude === null) return false;
  if (band === "surface") return altitude < 2_000;
  if (band === "terminal") return altitude >= 2_000 && altitude < 10_000;
  if (band === "low") return altitude >= 10_000 && altitude < 24_000;
  if (band === "cruise") return altitude >= 24_000 && altitude < 39_000;
  return altitude >= 39_000;
}

function speedBandMatches(flight: Flight, band: SpeedBand): boolean {
  if (band === "all") return true;
  const speed = flightSpeedKt(flight);
  if (speed === null) return false;
  if (band === "slow") return speed < 140;
  if (band === "standard") return speed >= 140 && speed < 360;
  if (band === "fast") return speed >= 360 && speed < 520;
  return speed >= 520;
}

function verticalBandMatches(flight: Flight, band: VerticalBand): boolean {
  if (band === "all") return true;
  const vertical = flightVerticalFpm(flight);
  if (vertical === null) return false;
  if (band === "climbing") return vertical > 500;
  if (band === "descending") return vertical < -500;
  return Math.abs(vertical) <= 500;
}

function severityMatches(anomaly: AnomalousFlight | undefined, severity: SeverityFilter): boolean {
  if (severity === "all") return true;
  if (!anomaly) return false;
  return topSeverity(anomaly.anomalies) === severity;
}

function rangeMatches(value: number | null, minRaw: string, maxRaw: string): boolean {
  const min = parseLooseNumber(minRaw);
  const max = parseLooseNumber(maxRaw);
  if (min === null && max === null) return true;
  if (value === null) return false;
  if (min !== null && value < min) return false;
  if (max !== null && value > max) return false;
  return true;
}

export function hasActiveFlightFilters(filters: FlightFilters): boolean {
  return describeFlightFilters(filters).length > 0;
}

export function describeFlightFilters(filters: FlightFilters): string[] {
  const labels: string[] = [];
  if (filters.query.trim()) labels.push(`Target: ${filters.query.trim()}`);
  if (filters.mode !== "all") {
    labels.push(
      FLIGHT_FILTER_MODES.find((item) => item.value === filters.mode)?.label ?? filters.mode,
    );
  }
  if (filters.aircraftClass !== "all") {
    labels.push(`Class: ${filters.aircraftClass}`);
  }
  if (filters.country !== "all") labels.push(`Country: ${filters.country}`);
  if (filters.altitudeBand !== "all") {
    labels.push(
      ALTITUDE_BANDS.find((item) => item.value === filters.altitudeBand)?.label ??
        filters.altitudeBand,
    );
  }
  if (filters.speedBand !== "all") {
    labels.push(
      SPEED_BANDS.find((item) => item.value === filters.speedBand)?.label ?? filters.speedBand,
    );
  }
  if (filters.verticalBand !== "all") {
    labels.push(
      VERTICAL_BANDS.find((item) => item.value === filters.verticalBand)?.label ??
        filters.verticalBand,
    );
  }
  if (filters.severity !== "all") labels.push(`Severity: ${filters.severity}`);
  if (filters.anomalyType && filters.anomalyType !== "all") {
    labels.push(`Anomaly: ${ANOMALY_TYPE_LABELS[filters.anomalyType] || filters.anomalyType}`);
  }
  if (filters.minAltitudeFt.trim()) labels.push(`Alt >= ${filters.minAltitudeFt.trim()} ft`);
  if (filters.maxAltitudeFt.trim()) labels.push(`Alt <= ${filters.maxAltitudeFt.trim()} ft`);
  if (filters.minSpeedKt.trim()) labels.push(`Speed >= ${filters.minSpeedKt.trim()} kt`);
  if (filters.maxSpeedKt.trim()) labels.push(`Speed <= ${filters.maxSpeedKt.trim()} kt`);
  return labels;
}

function anomalyTypeMatches(anomaly: AnomalousFlight | undefined, typeFilter: string): boolean {
  if (typeFilter === "all") return true;
  if (!anomaly) return false;
  return anomaly.anomalies.some((a) => a.type === typeFilter);
}

export function applyFlightFilters(
  flights: Flight[],
  anomalyMap: Map<string, AnomalousFlight>,
  filters: FlightFilters,
): FlightFilterResult {
  const parsed = parseQuery(filters.query);
  const ranked: RankedFlight[] = [];

  flights.forEach((flight, index) => {
    const anomaly = anomalyMap.get(flight.icao24);
    if (!modeMatches(flight, anomaly, filters.mode)) return;
    if (filters.aircraftClass !== "all" && classifyFlight(flight) !== filters.aircraftClass) return;
    if (filters.country !== "all" && flight.origin_country !== filters.country) return;
    if (!altitudeBandMatches(flight, filters.altitudeBand)) return;
    if (!speedBandMatches(flight, filters.speedBand)) return;
    if (!verticalBandMatches(flight, filters.verticalBand)) return;
    if (!severityMatches(anomaly, filters.severity)) return;
    if (
      filters.anomalyType &&
      filters.anomalyType !== "all" &&
      !anomalyTypeMatches(anomaly, filters.anomalyType)
    )
      return;
    if (!rangeMatches(flightAltitudeFt(flight), filters.minAltitudeFt, filters.maxAltitudeFt))
      return;
    if (!rangeMatches(flightSpeedKt(flight), filters.minSpeedKt, filters.maxSpeedKt)) return;
    if (!matchesParsedQuery(flight, anomaly, parsed)) return;

    ranked.push({
      flight,
      score: queryScore(flight, anomaly, parsed),
      index,
    });
  });

  if (parsed.raw) {
    ranked.sort(
      (a, b) =>
        b.score - a.score ||
        Number(a.flight.on_ground) - Number(b.flight.on_ground) ||
        a.index - b.index,
    );
  }

  const activeFilterLabels = describeFlightFilters(filters);
  return {
    flights: ranked.map((item) => item.flight),
    total: flights.length,
    matched: ranked.length,
    activeFilterCount: activeFilterLabels.length,
    activeFilterLabels,
  };
}
