import { useEffect, useRef, useState } from "react";
import {
  flightTrackDistanceKm,
  flightTrackPointTimeMs,
  type FlightTrackPoint,
} from "@/lib/flightTrack";
import type { Flight } from "@/lib/opensky";

const SELECTED_TRAIL_MAX_POINTS = 360;
const MIN_TRAIL_DISTANCE_KM = 0.03;

function flightToTrackPoint(flight: Flight): FlightTrackPoint | null {
  if (flight.latitude === null || flight.longitude === null) return null;
  const timestamp = flight.time_position ?? flight.last_contact ?? Date.now() / 1000;
  return {
    lat: flight.latitude,
    lon: flight.longitude,
    alt: flight.baro_altitude ?? flight.geo_altitude ?? null,
    speed: flight.velocity ?? null,
    heading: flight.true_track ?? null,
    time: new Date(timestamp * 1000).toISOString(),
    onGround: flight.on_ground,
  };
}

export function useSelectedLiveTrail(selectedFlight: Flight | null) {
  const [selectedLiveTrail, setSelectedLiveTrail] = useState<FlightTrackPoint[]>([]);
  const selectedTrailIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedFlight) {
      selectedTrailIdRef.current = null;
      setSelectedLiveTrail([]);
      return;
    }

    const point = flightToTrackPoint(selectedFlight);
    if (!point) return;

    setSelectedLiveTrail((current) => {
      if (selectedTrailIdRef.current !== selectedFlight.icao24) {
        selectedTrailIdRef.current = selectedFlight.icao24;
        return [point];
      }

      const last = current[current.length - 1];
      if (last) {
        const newer = flightTrackPointTimeMs(point) > flightTrackPointTimeMs(last);
        const movedEnough = flightTrackDistanceKm(last, point) >= MIN_TRAIL_DISTANCE_KM;
        if (!newer || !movedEnough) return current;
      }

      return [...current, point].slice(-SELECTED_TRAIL_MAX_POINTS);
    });
  }, [
    selectedFlight?.baro_altitude,
    selectedFlight?.geo_altitude,
    selectedFlight?.icao24,
    selectedFlight?.last_contact,
    selectedFlight?.latitude,
    selectedFlight?.longitude,
    selectedFlight?.on_ground,
    selectedFlight?.time_position,
    selectedFlight?.true_track,
    selectedFlight?.velocity,
    selectedFlight,
  ]);

  return selectedLiveTrail;
}
