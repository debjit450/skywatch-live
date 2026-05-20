export interface ConflictZone {
  id: string;
  name: string;
  firCode?: string;
  riskLevel: "Critical (No-Fly)" | "High Risk (Advisory)";
  authority: string;
  reason: string;
  altitudeLimits: string;
  coordinates: [number, number][]; // lat, lon
  sourceType?: "live" | "backup";
  issuedAt?: string;
  expiresAt?: string;
}

export const CONFLICT_ZONES: ConflictZone[] = [
  {
    id: "ukraine-closure",
    name: "Ukraine Airspace (UKFV FIR)",
    firCode: "UKFV",
    riskLevel: "Critical (No-Fly)",
    authority: "EASA / FAA / State CAAs",
    reason: "Ongoing military conflict, high danger of active anti-aircraft warfare and missile systems.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [52.0, 22.0],
      [52.5, 40.0],
      [49.0, 40.0],
      [47.0, 38.5],
      [44.5, 36.5],
      [45.0, 32.5],
      [46.5, 30.0],
      [48.0, 22.0]
    ]
  },
  {
    id: "russia-border-restriction",
    name: "Russia Border regions (Rostov URRV / Moscow UUWV)",
    firCode: "URRV / UUWV",
    riskLevel: "Critical (No-Fly)",
    authority: "FAA / EASA / Rosaviatsia",
    reason: "Military operations and danger of drone/missile strikes near the Ukrainian border.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [53.0, 34.0],
      [53.0, 41.5],
      [47.0, 42.5],
      [46.0, 39.5],
      [47.0, 38.5],
      [49.0, 40.0],
      [51.5, 39.0]
    ]
  },
  {
    id: "iran-risk",
    name: "Iran Airspace (OIIX FIR)",
    firCode: "OIIX",
    riskLevel: "High Risk (Advisory)",
    authority: "EASA / FAA / UK DfT",
    reason: "Potential military action, air defense activation, and GPS/GNSS spoofing risks.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [39.5, 44.0],
      [38.5, 48.5],
      [37.5, 49.0],
      [38.5, 54.0],
      [37.0, 61.0],
      [25.0, 61.5],
      [24.0, 59.0],
      [26.0, 56.0],
      [30.0, 48.0],
      [33.5, 46.0]
    ]
  },
  {
    id: "iraq-risk",
    name: "Iraq Airspace (ORBB FIR)",
    firCode: "ORBB",
    riskLevel: "High Risk (Advisory)",
    authority: "FAA / EASA",
    reason: "Military activity, drone strikes, and potential regional air defense hazards.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [37.0, 42.0],
      [37.0, 44.5],
      [36.0, 45.5],
      [33.0, 46.5],
      [30.0, 48.0],
      [29.0, 48.0],
      [31.0, 44.0],
      [33.0, 39.0],
      [34.5, 41.0]
    ]
  },
  {
    id: "yemen-closure",
    name: "Yemen Airspace (OYYE FIR)",
    firCode: "OYYE",
    riskLevel: "Critical (No-Fly)",
    authority: "FAA / EASA / UK DfT",
    reason: "Ongoing civil war and military airstrikes; high danger of surface-to-air missiles.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [18.0, 42.5],
      [19.0, 45.0],
      [19.0, 52.0],
      [16.5, 53.0],
      [12.0, 44.0],
      [12.5, 43.0]
    ]
  },
  {
    id: "syria-closure",
    name: "Syria Airspace (OSTT FIR)",
    firCode: "OSTT",
    riskLevel: "Critical (No-Fly)",
    authority: "FAA / EASA",
    reason: "Active combat zone, international military flights, and active air defense operations.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [37.0, 36.0],
      [37.0, 42.0],
      [34.5, 41.0],
      [33.0, 39.0],
      [32.5, 39.0],
      [33.0, 36.0],
      [34.5, 36.0],
      [36.0, 35.5]
    ]
  },
  {
    id: "libya-closure",
    name: "Libya Airspace (HLLL FIR)",
    firCode: "HLLL",
    riskLevel: "Critical (No-Fly)",
    authority: "EASA / FAA",
    reason: "Political instability, local clashes, and lack of radar control capability.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [33.0, 11.5],
      [33.0, 25.0],
      [25.0, 25.0],
      [20.0, 25.0],
      [19.5, 24.0],
      [21.0, 19.0],
      [23.5, 12.0],
      [26.0, 9.5]
    ]
  },
  {
    id: "afghanistan-risk",
    name: "Afghanistan Airspace (OAKB FIR)",
    firCode: "OAKB",
    riskLevel: "High Risk (Advisory)",
    authority: "FAA / EASA",
    reason: "Lack of active ATC radar service and security issues at regional airports.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [38.0, 70.0],
      [38.5, 75.0],
      [36.5, 71.5],
      [34.0, 71.0],
      [31.5, 66.0],
      [30.0, 61.5],
      [35.5, 61.0],
      [37.5, 66.5]
    ]
  },
  {
    id: "north-korea-risk",
    name: "North Korea Airspace (ZKKP FIR)",
    firCode: "ZKKP",
    riskLevel: "High Risk (Advisory)",
    authority: "ICAO / FAA",
    reason: "Unannounced ballistic missile testing and lack of communication/transparency.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [43.0, 130.0],
      [42.0, 130.5],
      [39.0, 128.5],
      [37.5, 128.0],
      [38.0, 124.0],
      [40.0, 124.0]
    ]
  },
  {
    id: "myanmar-closure",
    name: "Myanmar Airspace (Yangon FIR)",
    firCode: "VYYY",
    riskLevel: "Critical (No-Fly)",
    authority: "ICAO / State CAAs",
    reason: "Active civil war, military operations, and elevated risk from air defense activity.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [28.6, 92.0],
      [27.2, 97.5],
      [24.0, 100.5],
      [17.0, 100.0],
      [9.5, 98.2],
      [10.0, 92.3],
      [20.0, 92.0]
    ]
  },
  {
    id: "sudan-closure",
    name: "Sudan Airspace (Khartoum FIR)",
    firCode: "HSSS",
    riskLevel: "Critical (No-Fly)",
    authority: "ICAO / FAA / EASA",
    reason: "Active armed conflict since 2023 with risks from air defense, artillery, and military aviation.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [22.0, 21.5],
      [22.0, 38.5],
      [16.0, 38.5],
      [9.0, 35.5],
      [8.5, 24.0],
      [12.0, 21.8]
    ]
  },
  {
    id: "kashmir-loc-risk",
    name: "Kashmir Line of Control Corridor",
    firCode: "VIDF / OPLR",
    riskLevel: "High Risk (Advisory)",
    authority: "ICAO / India / Pakistan CAAs",
    reason: "India/Pakistan military boundary with periodic air defense alerts and cross-border escalation risk.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [35.7, 73.4],
      [35.2, 76.6],
      [34.4, 76.4],
      [33.6, 74.9],
      [33.8, 73.7],
      [34.8, 73.1]
    ]
  },
  {
    id: "taiwan-strait-risk",
    name: "Taiwan Strait ADIZ / Exercise Area",
    firCode: "RCAA / ZSHA",
    riskLevel: "High Risk (Advisory)",
    authority: "ICAO / Regional CAAs",
    reason: "Chinese military exercises, ADIZ activity, and reported GPS/GNSS interference risk.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [26.8, 119.0],
      [25.8, 122.3],
      [22.0, 121.4],
      [22.4, 118.0]
    ]
  },
  {
    id: "south-china-sea-risk",
    name: "South China Sea Disputed Airspace",
    firCode: "ZJSA / RPHI / VVHM",
    riskLevel: "High Risk (Advisory)",
    authority: "ICAO / Regional CAAs",
    reason: "Disputed airspace, military activity, Chinese ADIZ risk, and possible GNSS interference.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [23.0, 109.0],
      [23.0, 122.0],
      [12.0, 121.0],
      [4.0, 112.0],
      [6.0, 105.0],
      [16.0, 108.0]
    ]
  },
  {
    id: "niger-sahel-risk",
    name: "Niger and Sahel Corridor",
    firCode: "DRRR / GOOO / GABS / DFFD",
    riskLevel: "High Risk (Advisory)",
    authority: "ICAO / FAA / EASA",
    reason: "Post-coup instability, armed groups, and degraded civil aviation safety oversight across the central Sahel.",
    altitudeLimits: "SFC - UNL",
    coordinates: [
      [23.5, -5.0],
      [23.5, 15.5],
      [11.0, 15.5],
      [9.5, 3.0],
      [11.0, -5.0]
    ]
  }
];
