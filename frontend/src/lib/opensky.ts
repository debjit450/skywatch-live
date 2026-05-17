export type FlightStateTuple = [
  string, // 0 icao24
  string | null, // 1 callsign
  string, // 2 origin_country
  number | null, // 3 time_position
  number, // 4 last_contact
  number | null, // 5 longitude
  number | null, // 6 latitude
  number | null, // 7 baro_altitude
  boolean, // 8 on_ground
  number | null, // 9 velocity (m/s)
  number | null, // 10 true_track
  number | null, // 11 vertical_rate (m/s)
  number[] | null, // 12 sensors
  number | null, // 13 geo_altitude
  string | null, // 14 squawk
  boolean, // 15 spi
  number, // 16 position_source
  number, // 17 category
];

export interface Flight {
  icao24: string;
  callsign: string | null;
  origin_country: string;
  time_position: number | null;
  last_contact: number;
  longitude: number | null;
  latitude: number | null;
  baro_altitude: number | null;
  on_ground: boolean;
  velocity: number | null;
  true_track: number | null;
  vertical_rate: number | null;
  sensors: number[] | null;
  geo_altitude: number | null;
  squawk: string | null;
  spi: boolean;
  position_source: number;
  category: number;
  ml_anomaly_score?: number | null;
  data_source?: string;
}

export interface OpenSkyResponse {
  time: number;
  states: FlightStateTuple[] | null;
}

export function parseFlights(states: FlightStateTuple[] | null): Flight[] {
  if (!states) return [];
  return states
    .map((s) => ({
      icao24: s[0],
      callsign: s[1] ? s[1].trim() || null : null,
      origin_country: s[2],
      time_position: s[3],
      last_contact: s[4],
      longitude: s[5],
      latitude: s[6],
      baro_altitude: s[7],
      on_ground: s[8],
      velocity: s[9],
      true_track: s[10],
      vertical_rate: s[11],
      sensors: s[12],
      geo_altitude: s[13],
      squawk: s[14],
      spi: s[15],
      position_source: s[16],
      category: s[17] || 0,
      ml_anomaly_score: null,
    }))
    .filter((f) => f.latitude !== null && f.longitude !== null);
}
