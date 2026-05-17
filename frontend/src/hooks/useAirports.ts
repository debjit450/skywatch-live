import { useEffect, useState } from "react";
import {
  airportDataSource,
  airports as fallbackAirports,
  fetchGlobalAirports,
  type Airport,
} from "@/lib/airports";

export type AirportStatus = "loading" | "ready" | "error";

interface AirportState {
  airports: Airport[];
  status: AirportStatus;
  countryCount: number;
  regionCount: number;
  loadedAt: number | null;
  errorMessage: string | null;
  isFallback: boolean;
}

export function useAirports(): AirportState {
  const [state, setState] = useState<AirportState>({
    airports: fallbackAirports,
    status: "loading",
    countryCount: 0,
    regionCount: 0,
    loadedAt: null,
    errorMessage: null,
    isFallback: true,
  });

  useEffect(() => {
    const controller = new AbortController();

    fetchGlobalAirports(controller.signal)
      .then((dataset) => {
        setState({
          airports: dataset.airports,
          status: "ready",
          countryCount: dataset.countries.size,
          regionCount: dataset.regions.size,
          loadedAt: dataset.loadedAt,
          errorMessage: null,
          isFallback: false,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;

        const message = error instanceof Error ? error.message : "Unable to load airport data";
        setState({
          airports: fallbackAirports,
          status: "error",
          countryCount: 0,
          regionCount: 0,
          loadedAt: null,
          errorMessage: message,
          isFallback: true,
        });
      });

    return () => controller.abort();
  }, []);

  return state;
}

export { airportDataSource };
