// Types for flight enrichment data from adsbdb.com API

export interface AircraftInfo {
  manufacturer: string | null;
  type: string | null; // e.g. "A320 214SL"
  icaoType: string | null; // e.g. "A320"
  registration: string | null; // e.g. "D-AIZR"
  registeredOwner: string | null;
  ownerCountry: string | null;
  ownerCountryIso: string | null;
  operatorFlagCode: string | null;
  photoUrl: string | null;
  photoThumbUrl: string | null;
}

export interface RouteAirport {
  name: string;
  iataCode: string;
  icaoCode: string;
  municipality: string;
  countryName: string;
  countryIso: string;
  latitude: number;
  longitude: number;
  elevation: number;
}

export interface AirlineInfo {
  name: string;
  icao: string;
  iata: string;
  country: string;
  countryIso: string;
  callsign: string;
}

export interface FlightRouteInfo {
  callsign: string | null;
  callsignIata: string | null;
  airline: AirlineInfo | null;
  origin: RouteAirport | null;
  destination: RouteAirport | null;
  routeConfidence: "high" | "low";
  routeWarning: string | null;
  routeSource: "opensky" | "adsbdb" | "unknown";
}

export interface EnrichmentData {
  aircraft: AircraftInfo | null;
  route: FlightRouteInfo | null;
  fetchedAt: number;
  dataSource?: string;
}

// --- adsbdb raw API response shapes ---

export interface AdsbdbAircraftResponse {
  response: {
    aircraft: {
      type: string;
      icao_type: string;
      manufacturer: string;
      mode_s: string;
      registration: string;
      registered_owner: string;
      registered_owner_country_iso_name: string;
      registered_owner_country_name: string;
      registered_owner_operator_flag_code: string;
      url_photo: string | null;
      url_photo_thumbnail: string | null;
    } | null;
  };
}

export interface AdsbdbCallsignResponse {
  response: {
    flightroute: {
      callsign: string;
      callsign_icao: string;
      callsign_iata: string;
      airline: {
        name: string;
        icao: string;
        iata: string;
        country: string;
        country_iso: string;
        callsign: string;
      };
      origin: {
        country_iso_name: string;
        country_name: string;
        elevation: number;
        iata_code: string;
        icao_code: string;
        latitude: number;
        longitude: number;
        municipality: string;
        name: string;
      };
      destination: {
        country_iso_name: string;
        country_name: string;
        elevation: number;
        iata_code: string;
        icao_code: string;
        latitude: number;
        longitude: number;
        municipality: string;
        name: string;
      };
    } | null;
  };
}
