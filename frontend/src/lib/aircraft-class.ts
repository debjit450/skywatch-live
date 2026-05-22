/**
 * Aircraft classification system for SkyWatch.
 *
 * Classifies aircraft into operational classes (civilian, military, cargo, etc.)
 * based on ICAO ADS-B category codes, callsign prefixes, and ICAO24 hex ranges.
 * Provides color palettes, icons, and labels for map rendering and legends.
 */

import type { Flight } from "./opensky";

// ─── Aircraft operational classes ─────────────────────────────────────────────

export type AircraftClass =
  | "commercial"
  | "cargo"
  | "military"
  | "general_aviation"
  | "helicopter"
  | "business_jet"
  | "glider"
  | "uav"
  | "lighter_than_air"
  | "ground_vehicle"
  | "unknown";

export interface AircraftClassInfo {
  key: AircraftClass;
  label: string;
  shortLabel: string;
  description: string;
  color: string;
  glowColor: string;
  bgColor: string;
  borderColor: string;
  iconType:
    | "plane"
    | "cargoPlane"
    | "businessJet"
    | "fighterJet"
    | "helicopter"
    | "glider"
    | "uav"
    | "balloon"
    | "vehicle";
  priority: number;
}

// ─── Color palette — carefully curated for dark map backgrounds ──────────────

export const AIRCRAFT_CLASSES: Record<AircraftClass, AircraftClassInfo> = {
  commercial: {
    key: "commercial",
    label: "Commercial Airline",
    shortLabel: "Commercial",
    description: "Scheduled commercial passenger & regional flights",
    color: "#38bdf8", // Sky blue
    glowColor: "rgba(56, 189, 248, 0.40)",
    bgColor: "rgba(56, 189, 248, 0.12)",
    borderColor: "rgba(56, 189, 248, 0.30)",
    iconType: "plane",
    priority: 5,
  },
  cargo: {
    key: "cargo",
    label: "Cargo / Freight",
    shortLabel: "Cargo",
    description: "Freight carriers — FedEx, UPS, DHL, cargo charters",
    color: "#f59e0b", // Amber
    glowColor: "rgba(245, 158, 11, 0.40)",
    bgColor: "rgba(245, 158, 11, 0.12)",
    borderColor: "rgba(245, 158, 11, 0.30)",
    iconType: "cargoPlane",
    priority: 4,
  },
  military: {
    key: "military",
    label: "Military",
    shortLabel: "Military",
    description: "Military aircraft — fighters, transports, tankers, surveillance",
    color: "#ef4444", // Red
    glowColor: "rgba(239, 68, 68, 0.45)",
    bgColor: "rgba(239, 68, 68, 0.12)",
    borderColor: "rgba(239, 68, 68, 0.30)",
    iconType: "fighterJet",
    priority: 8,
  },
  general_aviation: {
    key: "general_aviation",
    label: "General Aviation",
    shortLabel: "GA",
    description: "Private / general aviation — Cessna, Piper, small aircraft",
    color: "#4ade80", // Green
    glowColor: "rgba(74, 222, 128, 0.35)",
    bgColor: "rgba(74, 222, 128, 0.12)",
    borderColor: "rgba(74, 222, 128, 0.30)",
    iconType: "plane",
    priority: 2,
  },
  helicopter: {
    key: "helicopter",
    label: "Helicopter",
    shortLabel: "Heli",
    description: "Rotorcraft — police, EMS, news, VIP, military helos",
    color: "#22d3ee", // Cyan
    glowColor: "rgba(34, 211, 238, 0.45)",
    bgColor: "rgba(34, 211, 238, 0.12)",
    borderColor: "rgba(34, 211, 238, 0.30)",
    iconType: "helicopter",
    priority: 7,
  },
  business_jet: {
    key: "business_jet",
    label: "Business Jet",
    shortLabel: "BizJet",
    description: "Corporate / business jets — Gulfstream, Bombardier, Embraer",
    color: "#c084fc", // Purple
    glowColor: "rgba(192, 132, 252, 0.40)",
    bgColor: "rgba(192, 132, 252, 0.12)",
    borderColor: "rgba(192, 132, 252, 0.30)",
    iconType: "businessJet",
    priority: 3,
  },
  glider: {
    key: "glider",
    label: "Glider / Sailplane",
    shortLabel: "Glider",
    description: "Gliders, sailplanes, hang-gliders, paragliders",
    color: "#a3e635", // Lime
    glowColor: "rgba(163, 230, 53, 0.35)",
    bgColor: "rgba(163, 230, 53, 0.12)",
    borderColor: "rgba(163, 230, 53, 0.30)",
    iconType: "glider",
    priority: 1,
  },
  uav: {
    key: "uav",
    label: "UAV / Drone",
    shortLabel: "UAV",
    description: "Unmanned aerial vehicles — military drones, commercial drones",
    color: "#fb923c", // Orange
    glowColor: "rgba(251, 146, 60, 0.40)",
    bgColor: "rgba(251, 146, 60, 0.12)",
    borderColor: "rgba(251, 146, 60, 0.30)",
    iconType: "uav",
    priority: 6,
  },
  lighter_than_air: {
    key: "lighter_than_air",
    label: "Lighter-than-Air",
    shortLabel: "Balloon",
    description: "Balloons, airships, blimps",
    color: "#fbbf24", // Gold
    glowColor: "rgba(251, 191, 36, 0.35)",
    bgColor: "rgba(251, 191, 36, 0.12)",
    borderColor: "rgba(251, 191, 36, 0.30)",
    iconType: "balloon",
    priority: 0,
  },
  ground_vehicle: {
    key: "ground_vehicle",
    label: "Ground Vehicle",
    shortLabel: "Ground",
    description: "Airport ground vehicles — emergency, service",
    color: "#94a3b8", // Slate
    glowColor: "rgba(148, 163, 184, 0.25)",
    bgColor: "rgba(148, 163, 184, 0.10)",
    borderColor: "rgba(148, 163, 184, 0.20)",
    iconType: "vehicle",
    priority: 0,
  },
  unknown: {
    key: "unknown",
    label: "Unknown",
    shortLabel: "Unknown",
    description: "Unclassified aircraft — category not provided",
    color: "#64748b", // Gray
    glowColor: "rgba(100, 116, 139, 0.25)",
    bgColor: "rgba(100, 116, 139, 0.10)",
    borderColor: "rgba(100, 116, 139, 0.20)",
    iconType: "plane",
    priority: 0,
  },
};

// ─── Known military callsign prefixes ────────────────────────────────────────

const MILITARY_CALLSIGN_PREFIXES = new Set([
  "RCH",
  "REACH", // USAF AMC
  "CNV", // US Navy
  "RRR", // RAF
  "GAF", // German Air Force
  "FAF", // French Air Force
  "IAM", // Italian Air Force
  "BAF", // Belgian Air Force
  "NAF", // Netherlands Air Force
  "SUI", // Swiss Air Force
  "SVF", // Swedish Air Force
  "HUF", // Hungarian Air Force
  "PLF", // Polish Air Force
  "CFG", // Canadian Forces
  "ASY", // Australian Air Force
  "NZM", // NZ Air Force
  "IAF", // Israeli Air Force
  "DUKE", // USAF
  "KING", // USAF KC-135
  "TABOR", // USAF
  "CASA", // Spanish Air Force
  "MMF", // Malaysian Air Force
  "KAF", // Kuwaiti Air Force
  "QAF", // Qatari Air Force
  "UAF", // UAE Air Force
  "PAF", // Pakistan Air Force
  "BAD", // Bangladesh Air Force
  "TKF", // Turkish Air Force
  "FORTE", // USAF RQ-4 Global Hawk
  "JAKE", // USAF KC-46
]);

// ─── Known cargo operator callsign prefixes ──────────────────────────────────

const CARGO_CALLSIGN_PREFIXES = new Set([
  "FDX", // FedEx
  "UPS", // UPS
  "DHL", // DHL
  "GTI", // Atlas Air
  "ABW", // AirBridge Cargo
  "CLX", // Cargolux
  "MPH", // Martinair Cargo
  "ICL", // CAL Cargo
  "GEC", // Lufthansa Cargo
  "BOX", // Aerologic
  "CKS", // Kalitta Air
  "KFS", // Kalitta Charters
  "SQC", // Singapore Airlines Cargo
  "CAO", // Air China Cargo
  "SHQ", // Shanghai Airlines Cargo
  "KAL", // Korean Air (partial cargo ops)
  "NCA", // Nippon Cargo Airlines
  "TPA", // TAMPA Cargo
  "MAS", // MASkargo
  "EVA", // EVA Air Cargo
]);

// ─── Business jet ICAO24 hex prefixes (sampling) ─────────────────────────────
// In reality you'd use a full database, but prefix heuristics help

const BUSINESS_JET_CALLSIGN_HINTS = new Set([
  "EJA", // NetJets
  "EJM", // NetJets (Marquis)
  "XOJ", // XOJET
  "LXJ", // Flexjet
  "VNY", // Volato
  "JTL", // Jet Linx
]);

// ─── Classification logic ────────────────────────────────────────────────────

/**
 * Classify a flight into an operational class.
 *
 * Priority:
 * 1. ADS-B category code (definitive for helicopters, gliders, UAVs, etc.)
 * 2. Callsign prefix matching (military, cargo)
 * 3. Category + behavioral heuristics (business jet vs GA)
 */
export function classifyFlight(flight: Flight): AircraftClass {
  const category = flight.category ?? 0;
  const callsign = flight.callsign?.trim().toUpperCase() ?? "";
  const prefix3 = callsign.slice(0, 3);
  const prefix4 = callsign.slice(0, 4);
  const prefix5 = callsign.slice(0, 5);

  // ── Category-first classification ──

  // Rotorcraft
  if (category === 8) return "helicopter";

  // Glider / Sailplane / Ultralight / Hang-glider / Parachutist
  if (category === 9 || category === 11 || category === 12) return "glider";

  // Lighter-than-air
  if (category === 10) return "lighter_than_air";

  // UAV
  if (category === 14) return "uav";

  // Space vehicle
  if (category === 15) return "military"; // space ops = military

  // Ground vehicle
  if (category === 16 || category === 17) return "ground_vehicle";

  // ── Callsign-based classification ──

  // Check military prefixes
  if (
    MILITARY_CALLSIGN_PREFIXES.has(prefix3) ||
    MILITARY_CALLSIGN_PREFIXES.has(prefix4) ||
    MILITARY_CALLSIGN_PREFIXES.has(prefix5)
  ) {
    return "military";
  }

  // Military squawk codes
  if (flight.squawk === "7777") return "military";

  // Check cargo prefixes
  if (CARGO_CALLSIGN_PREFIXES.has(prefix3)) return "cargo";

  // Check business jet prefixes
  if (BUSINESS_JET_CALLSIGN_HINTS.has(prefix3)) return "business_jet";

  // ── Category + heuristic classification ──

  // High performance (cat 7) — likely military
  if (category === 7) {
    // If it has a commercial-style callsign it might be a fast airliner (Concorde-era)
    // but most cat-7 today are military
    if (callsign && /^[A-Z]{3}\d/.test(callsign)) return "commercial";
    return "military";
  }

  // Heavy (cat 6) — commercial or cargo
  if (category === 6) {
    if (CARGO_CALLSIGN_PREFIXES.has(prefix3)) return "cargo";
    return "commercial";
  }

  // High Vortex Large (cat 5) — commercial
  if (category === 5) return "commercial";

  // Large (cat 4) — commercial or cargo
  if (category === 4) {
    if (CARGO_CALLSIGN_PREFIXES.has(prefix3)) return "cargo";
    return "commercial";
  }

  // Small (cat 3) — could be GA, biz jet, or small commuter
  if (category === 3) {
    // If flying high and fast, likely business jet
    const alt = flight.baro_altitude ?? flight.geo_altitude ?? 0;
    const vel = flight.velocity ?? 0;
    if (alt > 8000 && vel > 150) return "business_jet";
    // If has airline-style callsign, it's a small commuter
    if (callsign && /^[A-Z]{3}\d/.test(callsign)) return "commercial";
    return "general_aviation";
  }

  // Light (cat 2) — general aviation
  if (category === 2) return "general_aviation";

  // No emitter / Unknown categories
  if (category === 0 || category === 1) {
    // Try to infer from callsign and speed
    if (callsign && /^[A-Z]{3}\d/.test(callsign)) {
      // Airline-format callsign
      const vel = flight.velocity ?? 0;
      if (vel > 180) return "commercial";
      if (vel > 100) return "business_jet";
    }
    // N-number or other reg-style callsign
    if (callsign && /^N\d/.test(callsign)) return "general_aviation";
    if (callsign && /^G-/.test(callsign)) return "general_aviation";
    if (callsign && /^D-/.test(callsign)) return "general_aviation";
    if (callsign && /^VT-/.test(callsign)) return "general_aviation";

    return "unknown";
  }

  return "unknown";
}

/**
 * Get the visual info for an aircraft class.
 */
export function getClassInfo(cls: AircraftClass): AircraftClassInfo {
  return AIRCRAFT_CLASSES[cls] ?? AIRCRAFT_CLASSES.unknown;
}

/**
 * Get the color for a flight based on its class.
 */
export function getFlightClassColor(flight: Flight): string {
  const cls = classifyFlight(flight);
  return AIRCRAFT_CLASSES[cls]?.color ?? AIRCRAFT_CLASSES.unknown.color;
}

/**
 * Get class label for a flight.
 */
export function getFlightClassLabel(flight: Flight): string {
  const cls = classifyFlight(flight);
  return AIRCRAFT_CLASSES[cls]?.shortLabel ?? "Unknown";
}

/**
 * Get all class entries ordered by priority for legend display.
 */
export function getClassesForLegend(): AircraftClassInfo[] {
  return Object.values(AIRCRAFT_CLASSES)
    .filter((cls) => cls.key !== "unknown" && cls.key !== "ground_vehicle")
    .sort((a, b) => b.priority - a.priority);
}

/**
 * Count flights by class.
 */
export function countByClass(flights: Flight[]): Map<AircraftClass, number> {
  const counts = new Map<AircraftClass, number>();
  for (const flight of flights) {
    const cls = classifyFlight(flight);
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
  }
  return counts;
}
