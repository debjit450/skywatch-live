import type { Airport } from "./airports";

export interface FlightRoute {
  origin: Airport;
  destination: Airport;
}
