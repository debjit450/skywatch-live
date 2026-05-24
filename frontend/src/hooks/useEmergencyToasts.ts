import { useCallback, useEffect, useRef, useState } from "react";
import type { Flight } from "@/lib/opensky";

const EMERGENCY_REPEAT_MS = 10 * 60 * 1000;
const EMERGENCY_TOAST_TTL_MS = 45_000;
const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);
const SQUAWK_STORAGE_KEY = "skywatch-seen-squawks";

export interface EmergencyToast {
  key: string;
  icao24: string;
  callsign: string;
  squawk: string;
  label: string;
  detectedAt: number;
}

function emergencySquawkLabel(squawk: string): string {
  if (squawk === "7500") return "Hijack squawk";
  if (squawk === "7600") return "Radio failure";
  return "General emergency";
}

export function useEmergencyToasts(flights: Flight[], lastUpdated: number | null) {
  const [alerts, setAlerts] = useState<EmergencyToast[]>([]);
  const seenEmergencyRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SQUAWK_STORAGE_KEY);
      if (!raw) return;

      const entries = JSON.parse(raw) as [string, number][];
      const now = Date.now();
      const fresh = entries.filter(([, timestamp]) => now - timestamp < EMERGENCY_REPEAT_MS);
      seenEmergencyRef.current = new Map(fresh);
      if (fresh.length !== entries.length) {
        window.localStorage.setItem(SQUAWK_STORAGE_KEY, JSON.stringify(fresh));
      }
    } catch {
      /* ignore corrupt storage */
    }
  }, []);

  useEffect(() => {
    const now = Date.now();
    const incoming: EmergencyToast[] = [];

    for (const flight of flights) {
      const squawk = flight.squawk;
      if (!squawk || !EMERGENCY_SQUAWKS.has(squawk)) continue;

      const key = `${flight.icao24}:${squawk}`;
      const seenAt = seenEmergencyRef.current.get(key);
      if (seenAt && now - seenAt < EMERGENCY_REPEAT_MS) continue;

      seenEmergencyRef.current.set(key, now);
      incoming.push({
        key,
        icao24: flight.icao24,
        callsign: flight.callsign?.trim() || flight.icao24.toUpperCase(),
        squawk,
        label: emergencySquawkLabel(squawk),
        detectedAt: now,
      });
    }

    if (incoming.length === 0) return;

    try {
      const entries = Array.from(seenEmergencyRef.current.entries());
      window.localStorage.setItem(SQUAWK_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      /* quota or private browsing */
    }

    setAlerts((current) =>
      [
        ...incoming,
        ...current.filter((toast) => !incoming.some((item) => item.key === toast.key)),
      ].slice(0, 4),
    );
  }, [flights, lastUpdated]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setAlerts((current) =>
        current.filter((toast) => Date.now() - toast.detectedAt < EMERGENCY_TOAST_TTL_MS),
      );
    }, 1_000);
    return () => window.clearInterval(id);
  }, []);

  const dismissAlert = useCallback((key: string) => {
    setAlerts((current) => current.filter((toast) => toast.key !== key));
  }, []);

  return { alerts, dismissAlert };
}
