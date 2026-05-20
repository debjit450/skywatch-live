import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Download, RefreshCw, Table2, X } from "lucide-react";
import { fetchBackendJson } from "@/lib/backend-api";
import type { AnomalousFlight } from "@/lib/anomaly";
import type { Flight } from "@/lib/opensky";

type Row = Record<string, string | number | null>;

interface AnalyticsPayload {
  points?: Row[];
  routes?: Row[];
  types?: Row[];
}

interface AnalyticsPanelProps {
  onClose: () => void;
  flights?: Flight[];
  anomalies?: AnomalousFlight[];
}

function filename(type: string, ext: "csv" | "json") {
  return `skywatch_${type}_${new Date().toISOString().slice(0, 10)}.${ext}`;
}

function download(dataType: string, rows: Row[], ext: "csv" | "json") {
  const body =
    ext === "json"
      ? JSON.stringify(rows, null, 2)
      : [
          Object.keys(rows[0] ?? {}).join(","),
          ...rows.map((row) =>
            Object.values(row)
              .map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`)
              .join(","),
          ),
        ].join("\n");
  const blob = new Blob([body], { type: ext === "json" ? "application/json" : "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename(dataType, ext);
  a.click();
  URL.revokeObjectURL(url);
}

export default function AnalyticsPanel({
  onClose,
  flights = [],
  anomalies = [],
}: AnalyticsPanelProps) {
  const [traffic, setTraffic] = useState<Row[]>([]);
  const [routes, setRoutes] = useState<Row[]>([]);
  const [rate, setRate] = useState<Row[]>([]);
  const [types, setTypes] = useState<Row[]>([]);
  const [showTables, setShowTables] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const liveFallback = useMemo(() => buildLiveAnalytics(flights, anomalies), [anomalies, flights]);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const [trafficResult, routeResult, rateResult, typeResult] = await Promise.allSettled([
        fetchBackendJson<AnalyticsPayload>("/api/v1/analytics/traffic/?range=7d"),
        fetchBackendJson<AnalyticsPayload>("/api/v1/analytics/routes/?limit=10"),
        fetchBackendJson<AnalyticsPayload>("/api/v1/analytics/anomaly-rate/?range=30d"),
        fetchBackendJson<AnalyticsPayload>("/api/v1/analytics/aircraft-types/"),
      ]);

      const trafficRows =
        trafficResult.status === "fulfilled" ? (trafficResult.value.points ?? []) : [];
      const routeRows = routeResult.status === "fulfilled" ? (routeResult.value.routes ?? []) : [];
      const rateRows = rateResult.status === "fulfilled" ? (rateResult.value.points ?? []) : [];
      const typeRows = typeResult.status === "fulfilled" ? (typeResult.value.types ?? []) : [];

      setTraffic(trafficRows.length > 0 ? trafficRows : liveFallback.traffic);
      setRoutes(routeRows.length > 0 ? routeRows : liveFallback.routes);
      setRate(rateRows.length > 0 ? rateRows : liveFallback.rate);
      setTypes(typeRows.length > 0 ? typeRows : liveFallback.types);

      const failed = [trafficResult, routeResult, rateResult, typeResult].some(
        (result) => result.status === "rejected",
      );
      setErrorMessage(
        failed ? "Showing live fallback until historical analytics are reachable." : null,
      );
    } finally {
      setLoading(false);
    }
  }, [liveFallback]);

  useEffect(() => {
    void load();
  }, [load]);

  const pieData = useMemo(() => types.slice(0, 8), [types]);
  const colors = [
    "#22c55e",
    "#3b82f6",
    "#f59e0b",
    "#ef4444",
    "#a855f7",
    "#14b8a6",
    "#eab308",
    "#64748b",
  ];

  return (
    <section className="sw-analytics-panel">
      <header>
        <div>
          <strong>Air Traffic Density & Surveillance Analytics</strong>
          <span>{errorMessage ?? "Historical Trends with Live Telemetry Fallback"}</span>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>
          <RefreshCw /> {loading ? "Loading" : "Refresh"}
        </button>
        <button type="button" onClick={() => setShowTables((value) => !value)}>
          <Table2 /> View Raw Tabular Data
        </button>
        <button type="button" onClick={onClose} aria-label="Close analytics">
          <X />
        </button>
      </header>
      <div className="sw-analytics-grid">
        <ChartBlock title="Hourly Traffic" dataType="traffic" rows={traffic}>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={traffic}>
              <XAxis dataKey="hour" hide />
              <YAxis hide />
              <Tooltip />
              <Line type="monotone" dataKey="active_flights" stroke="#22c55e" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartBlock>
        <ChartBlock title="Surveillance Anomaly Detection Rate" dataType="anomaly_rate" rows={rate}>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={rate}>
              <XAxis dataKey="day" hide />
              <YAxis hide />
              <Tooltip />
              <Line
                type="monotone"
                dataKey="anomalies_per_100_flights"
                stroke="#f59e0b"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartBlock>
        <ChartBlock
          title="Aircraft Classification Categories"
          dataType="aircraft_types"
          rows={types}
        >
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Tooltip />
              <Pie
                data={pieData}
                dataKey="count"
                nameKey="aircraft_type"
                innerRadius={45}
                outerRadius={75}
              >
                {pieData.map((_, index) => (
                  <Cell key={index} fill={colors[index % colors.length]} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
        </ChartBlock>
        <ChartBlock title="Busiest Flight Corridors" dataType="routes" rows={routes}>
          <ol className="sw-route-rank">
            {routes.map((route, index) => (
              <li key={`${route.origin_airport}-${route.destination_airport}`}>
                <span>{index + 1}</span>
                <strong>
                  {route.origin_airport} {"->"} {route.destination_airport}
                </strong>
                <em>{route.flight_count}</em>
              </li>
            ))}
          </ol>
        </ChartBlock>
      </div>
      {showTables && (
        <div className="sw-analytics-tables">
          <DataTable title="Traffic" rows={traffic} />
          <DataTable title="Routes" rows={routes} />
          <DataTable title="Anomaly Rate" rows={rate} />
          <DataTable title="Aircraft Types" rows={types} />
        </div>
      )}
    </section>
  );
}

function buildLiveAnalytics(flights: Flight[], anomalies: AnomalousFlight[]) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const airborne = flights.filter((flight) => !flight.on_ground).length;
  const traffic = [
    {
      hour: now.toISOString(),
      active_flights: flights.length,
      airborne,
      ground: Math.max(flights.length - airborne, 0),
    },
  ];

  const byCountry = new Map<string, number>();
  const byType = new Map<string, number>();
  for (const flight of flights) {
    byCountry.set(
      flight.origin_country || "Unknown",
      (byCountry.get(flight.origin_country || "Unknown") || 0) + 1,
    );
    const type = aircraftCategoryLabel(flight.category);
    byType.set(type, (byType.get(type) || 0) + 1);
  }

  const routes = Array.from(byCountry.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([country, count]) => ({
      origin_airport: country,
      destination_airport: "Live area",
      flight_count: count,
    }));

  const types = Array.from(byType.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([aircraft_type, count]) => ({ aircraft_type, count }));

  const rate = [
    {
      day,
      flights: flights.length,
      anomalies: anomalies.length,
      anomalies_per_100_flights: flights.length > 0 ? (anomalies.length / flights.length) * 100 : 0,
    },
  ];

  return { traffic, routes, types, rate };
}

function aircraftCategoryLabel(category: number): string {
  const labels: Record<number, string> = {
    0: "Unknown / Not Provided",
    1: "No ADS-B Emitter Category",
    2: "Light (< 15,500 lbs)",
    3: "Small (15,500 - 75,000 lbs)",
    4: "Large (75,000 - 300,000 lbs)",
    5: "High Vortex Large",
    6: "Heavy (> 300,000 lbs)",
    7: "High Performance",
    8: "Rotorcraft / Helicopter",
    9: "Glider / Sailplane",
    10: "Lighter-than-air",
    11: "Parachutist / Skydiver",
    12: "Ultralight / Hang-glider",
    14: "Unmanned Aerial Vehicle",
    15: "Space / Trans-atmospheric",
    16: "Surface Vehicle - Emergency",
    17: "Surface Vehicle - Service",
    18: "Point Obstacle",
    19: "Cluster Obstacle",
    20: "Line Obstacle",
  };
  return labels[category] ?? `Category ${category}`;
}

function ChartBlock({
  title,
  dataType,
  rows,
  children,
}: {
  title: string;
  dataType: string;
  rows: Row[];
  children: React.ReactNode;
}) {
  return (
    <div className="sw-chart-block">
      <div className="sw-chart-head">
        <strong>{title}</strong>
        <span>
          <button type="button" onClick={() => download(dataType, rows, "csv")}>
            <Download /> CSV
          </button>
          <button type="button" onClick={() => download(dataType, rows, "json")}>
            <Download /> JSON
          </button>
        </span>
      </div>
      {children}
    </div>
  );
}

function DataTable({ title, rows }: { title: string; rows: Row[] }) {
  const columns = Object.keys(rows[0] ?? {});
  if (columns.length === 0) return null;
  return (
    <details>
      <summary>{title}</summary>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column}>{row[column]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
