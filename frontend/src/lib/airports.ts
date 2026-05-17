export type AirportType =
  | "balloonport"
  | "closed_airport"
  | "heliport"
  | "large_airport"
  | "medium_airport"
  | "seaplane_base"
  | "small_airport";

export interface Airport {
  id: number | null;
  ident: string;
  icao: string;
  iata: string;
  gpsCode: string;
  localCode: string;
  type: AirportType;
  name: string;
  city: string;
  country: string;
  countryCode: string;
  region: string;
  regionCode: string;
  continent: string;
  lat: number;
  lon: number;
  elevationFt: number | null;
  scheduledService: boolean;
  homeLink: string;
  wikipediaLink: string;
  keywords: string;
}

export interface AirportDataset {
  airports: Airport[];
  countries: Map<string, string>;
  regions: Map<string, string>;
  loadedAt: number;
  source: typeof airportDataSource;
}

export const airportDataSource = {
  name: "OurAirports open data",
  pageUrl: "https://ourairports.com/data/",
  dataDictionaryUrl: "https://ourairports.com/help/data-dictionary.html",
  airportsUrl: "https://davidmegginson.github.io/ourairports-data/airports.csv",
  countriesUrl: "https://davidmegginson.github.io/ourairports-data/countries.csv",
  regionsUrl: "https://davidmegginson.github.io/ourairports-data/regions.csv",
  license: "Public Domain",
};

const fallbackAirports: Airport[] = [
  fallbackAirport(
    "KATL",
    "ATL",
    "Hartsfield-Jackson Atlanta International Airport",
    "Atlanta",
    "United States",
    "US",
    33.6407,
    -84.4277,
  ),
  fallbackAirport(
    "KDFW",
    "DFW",
    "Dallas Fort Worth International Airport",
    "Dallas",
    "United States",
    "US",
    32.8998,
    -97.0403,
  ),
  fallbackAirport(
    "KDEN",
    "DEN",
    "Denver International Airport",
    "Denver",
    "United States",
    "US",
    39.8561,
    -104.6737,
  ),
  fallbackAirport(
    "KORD",
    "ORD",
    "Chicago O'Hare International Airport",
    "Chicago",
    "United States",
    "US",
    41.9742,
    -87.9073,
  ),
  fallbackAirport(
    "KLAX",
    "LAX",
    "Los Angeles International Airport",
    "Los Angeles",
    "United States",
    "US",
    33.9416,
    -118.4085,
  ),
  fallbackAirport(
    "KJFK",
    "JFK",
    "John F Kennedy International Airport",
    "New York",
    "United States",
    "US",
    40.6413,
    -73.7781,
  ),
  fallbackAirport(
    "EGLL",
    "LHR",
    "London Heathrow Airport",
    "London",
    "United Kingdom",
    "GB",
    51.47,
    -0.4543,
  ),
  fallbackAirport(
    "LFPG",
    "CDG",
    "Paris Charles de Gaulle Airport",
    "Paris",
    "France",
    "FR",
    49.0097,
    2.5479,
  ),
  fallbackAirport(
    "EHAM",
    "AMS",
    "Amsterdam Airport Schiphol",
    "Amsterdam",
    "Netherlands",
    "NL",
    52.3105,
    4.7683,
  ),
  fallbackAirport(
    "EDDF",
    "FRA",
    "Frankfurt Airport",
    "Frankfurt",
    "Germany",
    "DE",
    50.0333,
    8.5705,
  ),
  fallbackAirport(
    "LEMD",
    "MAD",
    "Adolfo Suarez Madrid-Barajas Airport",
    "Madrid",
    "Spain",
    "ES",
    40.4983,
    -3.5676,
  ),
  fallbackAirport(
    "OMDB",
    "DXB",
    "Dubai International Airport",
    "Dubai",
    "United Arab Emirates",
    "AE",
    25.2528,
    55.3644,
  ),
  fallbackAirport(
    "OERK",
    "RUH",
    "King Khalid International Airport",
    "Riyadh",
    "Saudi Arabia",
    "SA",
    24.9576,
    46.6988,
  ),
  fallbackAirport(
    "VHHH",
    "HKG",
    "Hong Kong International Airport",
    "Hong Kong",
    "Hong Kong",
    "HK",
    22.308,
    113.9185,
  ),
  fallbackAirport("RJTT", "HND", "Tokyo Haneda Airport", "Tokyo", "Japan", "JP", 35.5494, 139.7798),
  fallbackAirport(
    "ZBAA",
    "PEK",
    "Beijing Capital International Airport",
    "Beijing",
    "China",
    "CN",
    40.0799,
    116.6031,
  ),
  fallbackAirport(
    "WSSS",
    "SIN",
    "Singapore Changi Airport",
    "Singapore",
    "Singapore",
    "SG",
    1.3644,
    103.9915,
  ),
  fallbackAirport(
    "VTBS",
    "BKK",
    "Suvarnabhumi Airport",
    "Bangkok",
    "Thailand",
    "TH",
    13.69,
    100.7501,
  ),
  fallbackAirport(
    "VIDP",
    "DEL",
    "Indira Gandhi International Airport",
    "Delhi",
    "India",
    "IN",
    28.5562,
    77.1,
  ),
  fallbackAirport(
    "VABB",
    "BOM",
    "Chhatrapati Shivaji Maharaj International Airport",
    "Mumbai",
    "India",
    "IN",
    19.0896,
    72.8656,
  ),
  fallbackAirport(
    "YSSY",
    "SYD",
    "Sydney Kingsford Smith Airport",
    "Sydney",
    "Australia",
    "AU",
    -33.9399,
    151.1753,
  ),
  fallbackAirport(
    "YMML",
    "MEL",
    "Melbourne Airport",
    "Melbourne",
    "Australia",
    "AU",
    -37.669,
    144.841,
  ),
  fallbackAirport(
    "NZAA",
    "AKL",
    "Auckland Airport",
    "Auckland",
    "New Zealand",
    "NZ",
    -37.0082,
    174.7915,
  ),
  fallbackAirport(
    "SBGR",
    "GRU",
    "Sao Paulo Guarulhos International Airport",
    "Sao Paulo",
    "Brazil",
    "BR",
    -23.4356,
    -46.4731,
  ),
  fallbackAirport(
    "SAEZ",
    "EZE",
    "Ministro Pistarini International Airport",
    "Buenos Aires",
    "Argentina",
    "AR",
    -34.8222,
    -58.5358,
  ),
  fallbackAirport(
    "MMMX",
    "MEX",
    "Benito Juarez International Airport",
    "Mexico City",
    "Mexico",
    "MX",
    19.4361,
    -99.0719,
  ),
  fallbackAirport(
    "CYYZ",
    "YYZ",
    "Toronto Pearson International Airport",
    "Toronto",
    "Canada",
    "CA",
    43.6777,
    -79.6248,
  ),
  fallbackAirport(
    "CYVR",
    "YVR",
    "Vancouver International Airport",
    "Vancouver",
    "Canada",
    "CA",
    49.1939,
    -123.1844,
  ),
  fallbackAirport(
    "FAOR",
    "JNB",
    "O R Tambo International Airport",
    "Johannesburg",
    "South Africa",
    "ZA",
    -26.1392,
    28.246,
  ),
  fallbackAirport(
    "HECA",
    "CAI",
    "Cairo International Airport",
    "Cairo",
    "Egypt",
    "EG",
    30.1219,
    31.4056,
  ),
  fallbackAirport(
    "HKJK",
    "NBO",
    "Jomo Kenyatta International Airport",
    "Nairobi",
    "Kenya",
    "KE",
    -1.3192,
    36.9275,
  ),
];

export const airports = fallbackAirports;

let cachedDataset: AirportDataset | null = null;
let pendingDataset: Promise<AirportDataset> | null = null;

export function getAirportCode(airport: Airport): string {
  return airport.iata || airport.icao || airport.localCode || airport.gpsCode || airport.ident;
}

export function getAirportTypeLabel(type: AirportType): string {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function fetchGlobalAirports(signal?: AbortSignal): Promise<AirportDataset> {
  if (cachedDataset) return cachedDataset;
  if (pendingDataset) return pendingDataset;

  pendingDataset = loadGlobalAirports(signal)
    .then((dataset) => {
      cachedDataset = dataset;
      return dataset;
    })
    .finally(() => {
      pendingDataset = null;
    });

  return pendingDataset;
}

async function loadGlobalAirports(signal?: AbortSignal): Promise<AirportDataset> {
  const [airportCsv, countryCsv, regionCsv] = await Promise.all([
    fetchText(airportDataSource.airportsUrl, signal),
    fetchText(airportDataSource.countriesUrl, signal),
    fetchText(airportDataSource.regionsUrl, signal),
  ]);

  const countries = parseLookupCsv(countryCsv, "code", "name");
  const regions = parseLookupCsv(regionCsv, "code", "name");
  const globalAirports = parseAirportsCsv(airportCsv, countries, regions);

  return {
    airports: globalAirports,
    countries,
    regions,
    loadedAt: Date.now(),
    source: airportDataSource,
  };
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { cache: "force-cache", signal });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

function parseLookupCsv(csv: string, keyColumn: string, labelColumn: string): Map<string, string> {
  const rows = parseCsvRows(csv);
  const header = rows.shift();
  const lookup = new Map<string, string>();
  if (!header) return lookup;

  const indexes = getHeaderIndexes(header);
  const keyIndex = indexes.get(keyColumn);
  const labelIndex = indexes.get(labelColumn);
  if (keyIndex === undefined || labelIndex === undefined) return lookup;

  for (const row of rows) {
    const key = row[keyIndex]?.trim();
    const label = row[labelIndex]?.trim();
    if (key && label) lookup.set(key, label);
  }

  return lookup;
}

function parseAirportsCsv(
  csv: string,
  countries: Map<string, string>,
  regions: Map<string, string>,
): Airport[] {
  const rows = parseCsvRows(csv);
  const header = rows.shift();
  if (!header) return [];

  const indexes = getHeaderIndexes(header);
  const output: Airport[] = [];

  for (const row of rows) {
    const lat = parseNumber(getValue(row, indexes, "latitude_deg"));
    const lon = parseNumber(getValue(row, indexes, "longitude_deg"));
    if (lat === null || lon === null) continue;

    const ident = getValue(row, indexes, "ident");
    if (!ident) continue;

    const countryCode = getValue(row, indexes, "iso_country");
    const regionCode = getValue(row, indexes, "iso_region");
    const type = normalizeAirportType(getValue(row, indexes, "type"));

    output.push({
      id: parseInteger(getValue(row, indexes, "id")),
      ident,
      icao: getValue(row, indexes, "icao_code"),
      iata: getValue(row, indexes, "iata_code"),
      gpsCode: getValue(row, indexes, "gps_code"),
      localCode: getValue(row, indexes, "local_code"),
      type,
      name: getValue(row, indexes, "name") || ident,
      city: getValue(row, indexes, "municipality"),
      country: countries.get(countryCode) || countryCode || "Unknown",
      countryCode,
      region: regions.get(regionCode) || regionCode,
      regionCode,
      continent: getValue(row, indexes, "continent"),
      lat,
      lon,
      elevationFt: parseInteger(getValue(row, indexes, "elevation_ft")),
      scheduledService: getValue(row, indexes, "scheduled_service") === "yes",
      homeLink: getValue(row, indexes, "home_link"),
      wikipediaLink: getValue(row, indexes, "wikipedia_link"),
      keywords: getValue(row, indexes, "keywords"),
    });
  }

  return output;
}

function parseCsvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (inQuotes) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }

  if (value.length > 0 || row.length > 0) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function getHeaderIndexes(header: string[]): Map<string, number> {
  return new Map(header.map((name, index) => [name.trim(), index]));
}

function getValue(row: string[], indexes: Map<string, number>, key: string): string {
  const index = indexes.get(key);
  return index === undefined ? "" : (row[index] ?? "").trim();
}

function normalizeAirportType(value: string): AirportType {
  if (
    value === "balloonport" ||
    value === "closed_airport" ||
    value === "heliport" ||
    value === "large_airport" ||
    value === "medium_airport" ||
    value === "seaplane_base" ||
    value === "small_airport"
  ) {
    return value;
  }

  return "small_airport";
}

function parseNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseInteger(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function fallbackAirport(
  icao: string,
  iata: string,
  name: string,
  city: string,
  country: string,
  countryCode: string,
  lat: number,
  lon: number,
): Airport {
  return {
    id: null,
    ident: icao,
    icao,
    iata,
    gpsCode: icao,
    localCode: "",
    type: "large_airport",
    name,
    city,
    country,
    countryCode,
    region: "",
    regionCode: "",
    continent: "",
    lat,
    lon,
    elevationFt: null,
    scheduledService: true,
    homeLink: "",
    wikipediaLink: "",
    keywords: "",
  };
}
