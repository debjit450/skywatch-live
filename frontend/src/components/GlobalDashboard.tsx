import {
  Activity,
  AlertTriangle,
  BarChart3,
  Filter,
  Globe,
  Keyboard,
  LayoutDashboard,
  PanelRightClose,
  PanelRightOpen,
  Satellite,
  Search,
  SlidersHorizontal,
  X,
  Flame,
  Shield,
  Package,
  Compass,
  Crown,
  Cpu,
  Plane,
  Helicopter,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { Status } from "@/hooks/useFlights";
import type { SourceHealth } from "@/hooks/useFlights";
import type { SatelliteStatus } from "@/hooks/useSatellites";
import type { AnomalousFlight, Severity } from "@/lib/anomaly";
import type { Flight } from "@/lib/opensky";
import type { SatelliteGroupSummary, SatelliteObject } from "@/lib/satellites";
import { topSeverity } from "@/lib/anomaly";
import { anomalyIcons } from "@/lib/icons";
import ErrorBoundary from "@/components/ErrorBoundary";
import { getDataSourceInfo } from "@/lib/data-sources";
import {
  getClassesForLegend,
  classifyFlight,
  AIRCRAFT_CLASSES,
  type AircraftClass,
} from "@/lib/aircraft-class";
import AircraftIcon from "@/components/AircraftIcon";
import {
  ALTITUDE_BANDS,
  FLIGHT_FILTER_MODES,
  SEVERITY_FILTERS,
  SPEED_BANDS,
  VERTICAL_BANDS,
  ANOMALY_TYPE_LABELS,
  type AltitudeBand,
  type FlightFilterMode,
  type FlightFilters,
  type SeverityFilter,
  type SpeedBand,
  type VerticalBand,
} from "@/lib/flightFilters";
import {
  airlineFromCallsign,
  altitudeFt,
  countryCode,
  fmt,
  relativeTime,
  speedKt,
} from "@/lib/format";

const sevColors: Record<string, string> = {
  critical: "text-rose-400 bg-rose-500/10 border-rose-500/20",
  high: "text-rose-400 bg-rose-500/10 border-rose-500/20",
  medium: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  low: "text-blue-400 bg-blue-500/10 border-blue-500/20",
};

const sevIconColors: Record<string, string> = {
  critical: "text-rose-400",
  high: "text-rose-400",
  medium: "text-amber-400",
  low: "text-blue-400",
};

function exportAnomaliesCsv(anomalies: AnomalousFlight[]) {
  const rows = anomalies.flatMap((flight) =>
    flight.anomalies.map((item) => ({
      icao24: flight.icao24,
      callsign: flight.callsign ?? "",
      country: flight.origin_country,
      type: item.type,
      severity: item.severity,
      detectedAt: new Date(flight.detectedAt).toISOString(),
    })),
  );
  const header = ["icao24", "callsign", "country", "type", "severity", "detectedAt"];
  const csv = [
    header.join(","),
    ...rows.map((row) =>
      header
        .map((key) => `"${String(row[key as keyof typeof row]).replace(/"/g, '""')}"`)
        .join(","),
    ),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `skywatch_visible_anomalies_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

interface Props {
  flights: Flight[];
  allFlights: Flight[];
  anomalies: AnomalousFlight[];
  totalFlights: number;
  filters: FlightFilters;
  activeFilterLabels: string[];
  activeFilterCount: number;
  selectedId: string | null;
  status: Status;
  isLoading: boolean;
  satellites: SatelliteObject[];
  satelliteGroups: SatelliteGroupSummary[];
  satelliteStatus: SatelliteStatus;
  satelliteErrorMessage: string | null;
  sourceHealth: Record<string, SourceHealth>;
  onSelect: (id: string) => void;
  onFiltersChange: Dispatch<SetStateAction<FlightFilters>>;
  onClearFilters: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

function GlobalDashboard({
  flights,
  allFlights,
  anomalies,
  totalFlights,
  filters,
  activeFilterLabels,
  activeFilterCount,
  selectedId,
  status,
  isLoading,
  satellites,
  satelliteGroups,
  satelliteStatus,
  satelliteErrorMessage,
  sourceHealth,
  onSelect,
  onFiltersChange,
  onClearFilters,
  isCollapsed,
  onToggleCollapse,
}: Props) {
  const [activeTab, setActiveTab] = useState("global");

  const {
    activeCount,
    inAirCount,
    groundCount,
    helicopterCount,
    topCountries,
    recentFlights,
    sourceCounts,
  } = useMemo(() => {
    const countries = new Map<string, number>();
    let airborne = 0;
    let helicopters = 0;
    const sourceMap = new Map<string, number>();
    const sourceConfidence = new Map<string, number[]>();

    for (const flight of flights) {
      if (!flight.on_ground) airborne += 1;
      if (flight.category === 8) helicopters += 1;
      countries.set(flight.origin_country, (countries.get(flight.origin_country) || 0) + 1);
      const src = flight.data_source || "unknown";
      sourceMap.set(src, (sourceMap.get(src) || 0) + 1);
      if (typeof flight.source_confidence === "number") {
        const list = sourceConfidence.get(src) ?? [];
        list.push(flight.source_confidence);
        sourceConfidence.set(src, list);
      }
    }

    const srcCounts = Array.from(sourceMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => {
        const confidences = sourceConfidence.get(key) ?? [];
        const confidence =
          confidences.length > 0
            ? confidences.reduce((total, item) => total + item, 0) / confidences.length
            : null;
        return { key, count, confidence, health: sourceHealth[key], info: getDataSourceInfo(key) };
      });

    return {
      activeCount: flights.length,
      inAirCount: airborne,
      groundCount: flights.length - airborne,
      helicopterCount: helicopters,
      topCountries: Array.from(countries.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
      recentFlights: flights.slice(0, 12),
      sourceCounts: srcCounts,
    };
  }, [flights, sourceHealth]);

  const countryOptions = useMemo(() => {
    const countries = new Map<string, number>();
    for (const flight of allFlights) {
      if (!flight.origin_country) continue;
      countries.set(flight.origin_country, (countries.get(flight.origin_country) || 0) + 1);
    }
    return Array.from(countries.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [allFlights]);

  const satelliteSummary = useMemo(() => {
    const leo = satellites.filter((sat) => (sat.altitudeKm ?? Infinity) < 2000).length;
    const degraded = satellites.filter(
      (sat) => sat.orbitQuality === "degraded" || sat.orbitQuality === "stale",
    ).length;
    const stations = satellites.filter((sat) => sat.group === "stations").length;
    const activeGroups = satelliteGroups
      .filter((group) => group.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);

    return { leo, degraded, stations, activeGroups };
  }, [satelliteGroups, satellites]);

  useEffect(() => {
    const openAnomalies = () => setActiveTab("anomalies");
    window.addEventListener("skywatch:open-anomalies", openAnomalies);
    return () => window.removeEventListener("skywatch:open-anomalies", openAnomalies);
  }, []);

  if (isCollapsed) {
    return (
      <aside className="fixed right-4 top-4 bottom-4 w-16 bg-[rgba(4,15,8,0.45)] backdrop-blur-xl border border-[var(--sw-border-strong)] rounded-2xl shadow-2xl flex flex-col items-center py-4 justify-between text-[var(--sw-text)] z-[1100] transition-all duration-300 overflow-hidden">
        {/* Top actions & navigation */}
        <div className="flex flex-col items-center gap-4 w-full px-2">
          {/* Expand trigger */}
          <button
            type="button"
            onClick={onToggleCollapse}
            className="p-2 rounded-lg text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
            title="Expand Dashboard"
          >
            <PanelRightOpen className="w-5 h-5" />
          </button>

          <div className="w-8 h-px bg-[var(--sw-border)]" />

          {/* Navigation shortcuts */}
          <button
            type="button"
            onClick={() => {
              setActiveTab("global");
              onToggleCollapse();
            }}
            className="relative p-2 rounded-lg text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
            title="Global Overview"
          >
            <Globe className="w-5 h-5 text-blue-400" />
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTab("flights");
              onToggleCollapse();
            }}
            className="relative p-2 rounded-lg text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
            title="Search Flights"
          >
            <Search className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => {
              setActiveTab("anomalies");
              onToggleCollapse();
            }}
            className="relative p-2 rounded-lg text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
            title="Anomaly Feed"
          >
            <AlertTriangle className="w-5 h-5" />
            {anomalies.length > 0 && (
              <span className="absolute top-1 right-1 w-2.5 h-2.5 bg-emerald-500 border-2 border-[var(--sw-surface-strong)] rounded-full animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
            )}
          </button>
        </div>

        {/* Map panel triggers */}
        <div className="flex flex-col items-center gap-4 w-full px-2">
          <div className="w-8 h-px bg-[var(--sw-border)]" />

          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("skywatch:toggle-analytics"))}
            className="p-2 rounded-lg text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
            title="Traffic Analytics"
          >
            <BarChart3 className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("skywatch:toggle-alert-rules"))}
            className="p-2 rounded-lg text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
            title="Alert Rules"
          >
            <AlertTriangle className="w-5 h-5 text-amber-500" />
          </button>

          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("skywatch:toggle-layout"))}
            className="p-2 rounded-lg text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
            title="Dashboard Layout"
          >
            <LayoutDashboard className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("skywatch:toggle-shortcuts"))}
            className="p-2 rounded-lg text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
            title="Keyboard Shortcuts"
          >
            <Keyboard className="w-5 h-5" />
          </button>
        </div>

        {/* Bottom stats badge */}
        <div className="flex flex-col items-center gap-2 mb-2 select-none">
          <div className="relative flex w-1.5 h-1.5 mb-1">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full w-1.5 h-1.5 bg-emerald-500"></span>
          </div>
          <div className="flex flex-col items-center" style={{ writingMode: "vertical-rl" }}>
            <strong className="text-xs font-mono text-blue-400 font-bold tracking-wider">
              {activeCount.toLocaleString()}
            </strong>
            <span className="text-[9px] font-semibold text-[var(--sw-dim)] uppercase tracking-widest mt-1">
              Live
            </span>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="fixed right-4 top-4 bottom-4 w-[380px] bg-[rgba(4,15,8,0.45)] backdrop-blur-xl border border-[var(--sw-border-strong)] rounded-2xl shadow-2xl flex flex-col font-sans text-[var(--sw-text)] z-[1100] transition-all duration-300 overflow-hidden">
      <Tabs.Root
        value={activeTab}
        onValueChange={setActiveTab}
        className="flex-1 flex flex-col h-full overflow-hidden"
      >
        {/* ── Header ── */}
        <div className="flex-shrink-0 px-5 pt-5 pb-0 border-b border-[var(--sw-border)] bg-[var(--sw-surface-soft)]">
          <div className="flex items-start justify-between gap-2 mb-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Globe className="h-4 w-4 text-blue-400" />
                <h2 className="text-sm font-bold text-[var(--sw-text)] tracking-wide">
                  Surveillance Operations Control Panel
                </h2>
              </div>
              <p className="text-[10px] text-[var(--sw-muted)] font-medium">
                {activeCount.toLocaleString()} active surveillance tracks /{" "}
                {totalFlights.toLocaleString()} total target files
              </p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0 bg-[var(--sw-surface-soft)] border border-[var(--sw-border)] p-1 rounded-lg">
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent("skywatch:toggle-analytics"))}
                className="p-1.5 rounded-md text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
                title="Traffic Analytics"
              >
                <BarChart3 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent("skywatch:toggle-alert-rules"))}
                className="p-1.5 rounded-md text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
                title="Alert Rules"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
              </button>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent("skywatch:toggle-layout"))}
                className="p-1.5 rounded-md text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
                title="Dashboard Layout"
              >
                <LayoutDashboard className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent("skywatch:toggle-shortcuts"))}
                className="p-1.5 rounded-md text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
                title="Keyboard Shortcuts"
              >
                <Keyboard className="w-3.5 h-3.5" />
              </button>

              <div className="w-px h-3.5 bg-[var(--sw-border)] mx-0.5" />

              <button
                type="button"
                className="p-1.5 rounded-md text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)] transition-colors outline-none"
                onClick={onToggleCollapse}
                aria-label="Collapse dashboard"
              >
                <PanelRightClose className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <FilterWorkbench
            filters={filters}
            activeFilterLabels={activeFilterLabels}
            countryOptions={countryOptions}
            onFiltersChange={onFiltersChange}
            onClearFilters={onClearFilters}
            flights={flights}
            allFlights={allFlights}
            anomalies={anomalies}
          />

          <Tabs.List className="flex gap-6 mt-4 border-b border-transparent">
            {["global", "flights", "anomalies"].map((tab) => (
              <Tabs.Trigger
                key={tab}
                value={tab}
                className="relative pb-3 text-xs font-semibold uppercase tracking-wider text-[var(--sw-muted)] hover:text-[var(--sw-text)] data-[state=active]:text-[var(--sw-text)] outline-none transition-colors"
              >
                {tab === "global" ? "Overview" : tab === "flights" ? "Search" : "Anomalies"}
                {tab === "anomalies" && anomalies.length > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 text-[9px] font-bold">
                    {anomalies.length}
                  </span>
                )}
                {/* Active Indicator */}
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 opacity-0 scale-x-50 transition-all data-[state=active]:opacity-100 data-[state=active]:scale-x-100" />
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10 overscroll-contain">
          {/* TAB: GLOBAL OVERVIEW */}
          <Tabs.Content value="global" className="h-full flex flex-col p-4 gap-4 outline-none">
            {isLoading && totalFlights === 0 ? (
              <FeedSkeleton />
            ) : flights.length === 0 ? (
              <EmptyState
                icon={<Activity className="w-8 h-8 opacity-20" />}
                title={activeFilterCount > 0 ? "No matching flights" : "No active flights detected"}
                detail={status === "error" ? "Flight feed is offline" : "Monitoring is active"}
              />
            ) : (
              <>
                <section className="bg-white/5 border border-white/5 rounded-xl p-4">
                  <h3 className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-3">
                    Feed Surveillance Metrics
                  </h3>
                  <div className="grid grid-cols-2 gap-2">
                    <SummaryTile value={inAirCount.toLocaleString()} label="Airborne Tracks" />
                    <SummaryTile value={groundCount.toLocaleString()} label="Surface Tracks" />
                    <SummaryTile
                      value={anomalies.length.toLocaleString()}
                      label="Anomalous Tracks"
                      highlight
                    />
                    <SummaryTile
                      value={Math.max(totalFlights - activeCount, 0).toLocaleString()}
                      label="Filtered / Hidden Tracks"
                    />
                  </div>
                </section>

                {sourceCounts.length > 0 && (
                  <section className="bg-white/5 border border-white/5 rounded-xl p-4">
                    <h3 className="flex justify-between items-center text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-3">
                      <span>Data Sources</span>
                      <span className="text-zinc-500">{sourceCounts.length} active</span>
                    </h3>
                    <ul className="divide-y divide-white/5">
                      {sourceCounts.map(({ key, count, confidence, health, info }) => (
                        <li
                          key={key}
                          className="flex items-center justify-between py-2 hover:bg-white/5 px-2 -mx-2 rounded-md transition-colors"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="w-2 h-2 rounded-full"
                              style={{ backgroundColor: info.color }}
                            />
                            <span className="text-xs text-zinc-300 font-medium truncate">
                              {info.shortName}
                            </span>
                            <span className="text-[10px] text-zinc-500 px-1 border border-white/10 rounded">
                              {health?.status && health.status !== "ok" ? health.status : info.type}
                            </span>
                          </div>
                          <span className="text-xs font-mono text-zinc-400">
                            {count.toLocaleString()}
                            {confidence !== null && (
                              <em className="ml-2 not-italic text-blue-400">
                                {Math.round(confidence * 100)}%
                              </em>
                            )}
                            {health?.last_success_at && (
                              <em className="ml-2 not-italic text-zinc-500">
                                {relativeTime(new Date(health.last_success_at).getTime())}
                              </em>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className="bg-white/5 border border-white/5 rounded-xl p-4">
                  <h3 className="flex justify-between items-center text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-3">
                    <span>Space Layer</span>
                    <span className="text-zinc-500">
                      {satelliteStatus === "ready" ? "SGP4" : satelliteStatus}
                    </span>
                  </h3>
                  {satellites.length > 0 ? (
                    <>
                      <div className="grid grid-cols-2 gap-2 mb-3">
                        <SummaryTile
                          value={satellites.length.toLocaleString()}
                          label="Orbiting Satellite Objects"
                        />
                        <SummaryTile
                          value={satelliteSummary.leo.toLocaleString()}
                          label="Low Earth Orbit (LEO)"
                        />
                        <SummaryTile
                          value={satelliteSummary.stations.toLocaleString()}
                          label="Space Stations"
                        />
                        <SummaryTile
                          value={satelliteSummary.degraded.toLocaleString()}
                          label="Stale / Degraded TLE States"
                          warn={satelliteSummary.degraded > 0}
                        />
                      </div>
                      {satelliteSummary.activeGroups.length > 0 && (
                        <ul className="divide-y divide-white/5 mt-2 border-t border-white/5 pt-2">
                          {satelliteSummary.activeGroups.map((group) => (
                            <li
                              key={group.key}
                              className="flex items-center justify-between py-2 hover:bg-white/5 px-2 -mx-2 rounded-md transition-colors"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className="w-2 h-2 rounded-full"
                                  style={{ backgroundColor: group.color }}
                                />
                                <span className="text-xs text-zinc-300 font-medium truncate">
                                  {group.name}
                                </span>
                                <span className="text-[10px] text-zinc-500 px-1 border border-white/10 rounded">
                                  CelesTrak
                                </span>
                              </div>
                              <span className="text-xs font-mono text-zinc-400">
                                {group.count.toLocaleString()}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  ) : (
                    <div className="flex flex-col items-center justify-center p-4 text-zinc-500 gap-2">
                      <Satellite className="w-6 h-6 opacity-50" />
                      <span className="text-xs text-center">
                        {satelliteStatus === "error"
                          ? satelliteErrorMessage || "Catalog unavailable"
                          : "Loading orbital catalog"}
                      </span>
                    </div>
                  )}
                </section>

                <section className="bg-white/5 border border-white/5 rounded-xl p-4">
                  <h3 className="flex justify-between items-center text-[10px] font-semibold uppercase tracking-widest text-zinc-400 mb-3">
                    <span>Top Countries</span>
                    <span className="text-zinc-500">Visible</span>
                  </h3>
                  <ul className="divide-y divide-white/5">
                    {topCountries.map(([country, count]) => (
                      <li key={country} className="flex justify-between items-center py-2 text-xs">
                        <span className="text-zinc-300 truncate pr-3">{country}</span>
                        <span className="font-mono text-zinc-400">{count.toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="bg-white/5 border border-white/5 rounded-xl overflow-hidden flex flex-col">
                  <h3 className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400 p-4 border-b border-white/5">
                    Priority Flights
                  </h3>
                  <ErrorBoundary label="Priority flights">
                    <FlightFeedList
                      flights={recentFlights}
                      selectedId={selectedId}
                      onSelect={onSelect}
                    />
                  </ErrorBoundary>
                </section>
              </>
            )}
          </Tabs.Content>

          {/* TAB: SEARCH FLIGHTS */}
          <Tabs.Content value="flights" className="h-full flex flex-col outline-none">
            {isLoading && totalFlights === 0 ? (
              <div className="p-4">
                <FeedSkeleton />
              </div>
            ) : flights.length === 0 ? (
              <EmptyState
                icon={<Search className="w-8 h-8 opacity-20" />}
                title="No matching flights"
                detail={status === "error" ? "Flight feed is offline" : "Adjust active filters"}
              />
            ) : (
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex justify-between items-center p-4 border-b border-white/5 bg-white/[0.02]">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                    Matched Flights
                  </span>
                  <span className="text-xs font-mono font-medium text-blue-400">
                    {flights.length.toLocaleString()}
                  </span>
                </div>
                <ErrorBoundary label="Flight list">
                  <FlightFeedList
                    flights={flights}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    virtualized
                  />
                </ErrorBoundary>
              </div>
            )}
          </Tabs.Content>

          {/* TAB: ANOMALIES */}
          <Tabs.Content
            value="anomalies"
            className="h-full flex flex-col outline-none overflow-hidden"
          >
            {/* Tactical anomaly filters */}
            <div className="flex items-center gap-3 p-4 bg-emerald-950/20 border-b border-emerald-500/10 shrink-0">
              <div className="flex-1 min-w-0">
                <label className="text-[9px] font-bold uppercase tracking-widest text-emerald-400/60 block mb-1.5">
                  Anomaly Type
                </label>
                <select
                  value={filters.anomalyType || "all"}
                  onChange={(e) =>
                    onFiltersChange((curr) => ({ ...curr, anomalyType: e.target.value }))
                  }
                  className="w-full bg-zinc-950 border border-emerald-500/20 text-emerald-100 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400/30 transition-shadow appearance-none"
                >
                  <option value="all">All Types</option>
                  {Object.entries(ANOMALY_TYPE_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-w-0">
                <label className="text-[9px] font-bold uppercase tracking-widest text-emerald-400/60 block mb-1.5">
                  Min Severity
                </label>
                <select
                  value={filters.severity || "all"}
                  onChange={(e) =>
                    onFiltersChange((curr) => ({
                      ...curr,
                      severity: e.target.value as SeverityFilter,
                    }))
                  }
                  className="w-full bg-zinc-950 border border-emerald-500/20 text-emerald-100 text-xs rounded-md px-2 py-1.5 focus:outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400/30 transition-shadow appearance-none"
                >
                  {SEVERITY_FILTERS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10">
              {isLoading && anomalies.length === 0 ? (
                <div className="p-4">
                  <FeedSkeleton />
                </div>
              ) : (
                (() => {
                  const filteredAnomalies = anomalies.filter((anomaly) => {
                    if (filters.anomalyType && filters.anomalyType !== "all") {
                      if (!anomaly.anomalies.some((a) => a.type === filters.anomalyType))
                        return false;
                    }
                    if (filters.severity && filters.severity !== "all") {
                      const sev = topSeverity(anomaly.anomalies);
                      const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
                      const minLevel = severityOrder[filters.severity as Severity] || 0;
                      const currentLevel = severityOrder[sev as Severity] || 0;
                      if (currentLevel < minLevel) return false;
                    }
                    return true;
                  });

                  return filteredAnomalies.length === 0 ? (
                    <EmptyState
                      icon={<AlertTriangle className="w-8 h-8 opacity-20 text-emerald-400" />}
                      title={
                        activeFilterCount > 0 ? "No matching anomalies" : "No active anomalies"
                      }
                      detail={
                        status === "error" ? "Flight feed is offline" : "Monitoring is active"
                      }
                    />
                  ) : (
                    <>
                      <div className="flex justify-end px-4 py-2 border-b border-white/5">
                        <button
                          type="button"
                          onClick={() => exportAnomaliesCsv(filteredAnomalies)}
                          className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 px-2 py-1 rounded transition-colors"
                        >
                          Export CSV
                        </button>
                      </div>
                      <ul className="divide-y divide-white/5">
                        {filteredAnomalies.map((anomaly) => {
                          const sev = topSeverity(anomaly.anomalies);
                          const isSelected = selectedId === anomaly.icao24;
                          const primary = anomaly.anomalies[0];
                          const Icon = anomalyIcons[primary.type];
                          const airline = airlineFromCallsign(anomaly.callsign);
                          const badgeColor = sevColors[sev] ?? sevColors.low;
                          const iconColor = sevIconColors[sev] ?? sevIconColors.low;

                          return (
                            <li key={`${anomaly.icao24}-${anomaly.detectedAt}`}>
                              <button
                                type="button"
                                onClick={() => onSelect(anomaly.icao24)}
                                className={`w-full text-left p-4 hover:bg-white/5 focus:bg-white/5 outline-none transition-colors border-l-2 ${
                                  isSelected
                                    ? "border-emerald-500 bg-white/5"
                                    : "border-transparent"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2 mb-2">
                                  <div className="flex min-w-0 items-center gap-2">
                                    <Icon className={`w-4 h-4 flex-shrink-0 ${iconColor}`} />
                                    <span className="text-sm font-semibold text-white truncate">
                                      {primary.label}
                                    </span>
                                  </div>
                                  <span
                                    className={`px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider border ${badgeColor}`}
                                  >
                                    {sev}
                                  </span>
                                </div>
                                <div className="flex justify-between items-center text-xs mb-1">
                                  <span className="font-mono text-zinc-300 font-medium">
                                    {anomaly.callsign?.trim() || "UNKNOWN"}
                                  </span>
                                  <span className="text-zinc-500">
                                    {relativeTime(anomaly.detectedAt)} ago
                                  </span>
                                </div>
                                <div className="flex justify-between items-center text-xs text-zinc-500">
                                  <span className="truncate pr-2">
                                    {airline || anomaly.origin_country}
                                  </span>
                                  <span className="font-mono tracking-wider">
                                    {countryCode(anomaly.origin_country)}
                                  </span>
                                </div>
                                {anomaly.anomalies.length > 1 && (
                                  <div className="mt-2 text-[10px] text-zinc-400 bg-white/5 rounded px-2 py-1 w-fit">
                                    +{anomaly.anomalies.length - 1} additional flag
                                    {anomaly.anomalies.length > 2 ? "s" : ""}
                                  </div>
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  );
                })()
              )}
            </div>
          </Tabs.Content>
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--sw-border)] bg-[var(--sw-surface-soft)] text-[10px] font-medium text-[var(--sw-muted)] uppercase tracking-widest shrink-0">
          <span>OpenSky + CelesTrak</span>
          <span>30s Air / 60s Orbit</span>
        </div>
      </Tabs.Root>
    </aside>
  );
}

export default memo(GlobalDashboard);

// ─── Sub-components ────────────────────────────────────────────────────────────

function SummaryTile({
  value,
  label,
  highlight,
  warn,
}: {
  value: string;
  label: string;
  highlight?: boolean;
  warn?: boolean;
}) {
  const valueColor = warn
    ? "text-[var(--sw-amber)]"
    : highlight
      ? "text-[var(--sw-blue)]"
      : "text-[var(--sw-text)]";
  return (
    <div className="bg-[var(--sw-surface-soft)] border border-[var(--sw-border)] rounded-lg p-3 flex flex-col justify-center">
      <span className={`text-lg font-mono font-medium leading-none mb-1 ${valueColor}`}>
        {value}
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sw-muted)]">
        {label}
      </span>
    </div>
  );
}

function FilterWorkbench({
  filters,
  activeFilterLabels,
  countryOptions,
  onFiltersChange,
  onClearFilters,
  flights,
  allFlights,
  anomalies,
}: {
  filters: FlightFilters;
  activeFilterLabels: string[];
  countryOptions: Array<[string, number]>;
  onFiltersChange: Dispatch<SetStateAction<FlightFilters>>;
  onClearFilters: () => void;
  flights: Flight[];
  allFlights: Flight[];
  anomalies: AnomalousFlight[];
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const setFilter = <K extends keyof FlightFilters>(key: K, value: FlightFilters[K]) => {
    onFiltersChange((current) => ({ ...current, [key]: value }));
  };

  const legendClasses = useMemo(() => getClassesForLegend(), []);

  const classCounts = useMemo(() => {
    const counts = {
      commercial: 0,
      cargo: 0,
      military: 0,
      general_aviation: 0,
      helicopter: 0,
      business_jet: 0,
      uav: 0,
    };
    for (const flight of allFlights) {
      const cls = classifyFlight(flight);
      if (cls in counts) {
        counts[cls as keyof typeof counts]++;
      }
    }
    return counts;
  }, [allFlights]);

  const modeCounts = useMemo(() => {
    let airborne = 0;
    let emergency = 0;
    for (const flight of allFlights) {
      if (!flight.on_ground) airborne++;
      if (flight.squawk && ["7500", "7600", "7700"].includes(flight.squawk)) emergency++;
    }
    return {
      all: allFlights.length,
      airborne,
      ground: allFlights.length - airborne,
      anomaly: anomalies.length,
      emergency,
    };
  }, [allFlights, anomalies]);

  return (
    <div className="mb-2">
      <div className="flex gap-2 mb-3">
        <label className="relative flex-1 flex items-center bg-[var(--sw-surface-soft)] border border-[var(--sw-border)] rounded-md px-3 py-1.5 focus-within:border-blue-500/50 focus-within:ring-1 focus-within:ring-blue-500/50 transition-shadow">
          <Search className="w-3.5 h-3.5 text-[var(--sw-muted)] mr-2 flex-shrink-0" />
          <input
            value={filters.query}
            onChange={(event) => setFilter("query", event.target.value)}
            placeholder="Target search"
            aria-label="Target search"
            className="bg-transparent text-xs text-[var(--sw-text)] placeholder-[var(--sw-dim)] w-full outline-none"
          />
          {filters.query && (
            <button
              type="button"
              onClick={() => setFilter("query", "")}
              className="text-[var(--sw-muted)] hover:text-[var(--sw-text)] ml-2"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </label>
        <div className="flex gap-1">
          <button
            type="button"
            className={`flex items-center justify-center w-8 h-8 rounded-md border transition-colors ${
              showAdvanced
                ? "bg-blue-500/10 border-blue-500/30 text-blue-400"
                : "bg-[var(--sw-surface-soft)] border-[var(--sw-border)] text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)]"
            }`}
            onClick={() => setShowAdvanced(!showAdvanced)}
            title="Toggle advanced filters"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            className="flex items-center justify-center w-8 h-8 rounded-md bg-[var(--sw-surface-soft)] border border-[var(--sw-border)] text-[var(--sw-muted)] hover:text-[var(--sw-rose)] hover:bg-[var(--sw-danger-soft)] disabled:opacity-30 disabled:pointer-events-none transition-colors"
            onClick={onClearFilters}
            disabled={activeFilterLabels.length === 0}
            title="Clear filters"
          >
            <Filter className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ── Quick Filters & Status Toggles ── */}
      <div className="flex flex-col gap-2 mb-3">
        {/* Status Mode Pills */}
        <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none pb-0.5 select-none">
          {/* ALL Tracks Pill */}
          <button
            type="button"
            className={`flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${
              filters.mode === "all"
                ? "bg-blue-500/20 border-blue-500/40 text-blue-400"
                : "bg-white/[0.02] border-white/5 text-[var(--sw-muted)] hover:bg-white/[0.04] hover:text-[var(--sw-text)]"
            }`}
            onClick={() => setFilter("mode", "all")}
          >
            <Activity className="w-3 h-3" />
            <span>All ({modeCounts.all})</span>
          </button>

          {/* Anomalies Pill */}
          <button
            type="button"
            className={`flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${
              filters.mode === "anomaly"
                ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.2)]"
                : modeCounts.anomaly > 0
                  ? "bg-emerald-950/20 border-emerald-500/20 text-emerald-400/80 animate-pulse hover:bg-emerald-950/30"
                  : "bg-white/[0.02] border-white/5 text-[var(--sw-muted)] hover:bg-white/[0.04] hover:text-[var(--sw-text)]"
            }`}
            onClick={() => setFilter("mode", "anomaly")}
          >
            <AlertTriangle className="w-3 h-3" />
            <span>Anomalies ({modeCounts.anomaly})</span>
          </button>

          {/* Emergencies Pill */}
          <button
            type="button"
            className={`flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${
              filters.mode === "emergency"
                ? "bg-rose-500/20 border-rose-500/50 text-rose-400 shadow-[0_0_12px_rgba(244,63,94,0.3)] animate-pulse"
                : modeCounts.emergency > 0
                  ? "bg-rose-950/30 border-rose-500/30 text-rose-400 animate-pulse hover:bg-rose-950/40"
                  : "bg-white/[0.02] border-white/5 text-[var(--sw-muted)] hover:bg-white/[0.04] hover:text-[var(--sw-text)]"
            }`}
            onClick={() => setFilter("mode", "emergency")}
          >
            <Flame className="w-3 h-3" />
            <span>Emergencies ({modeCounts.emergency})</span>
          </button>

          {/* Airborne Pill */}
          <button
            type="button"
            className={`flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${
              filters.mode === "airborne"
                ? "bg-blue-500/20 border-blue-500/40 text-blue-400"
                : "bg-white/[0.02] border-white/5 text-[var(--sw-muted)] hover:bg-white/[0.04] hover:text-[var(--sw-text)]"
            }`}
            onClick={() => setFilter("mode", "airborne")}
          >
            <Plane className="w-3 h-3 rotate-45" />
            <span>Air ({modeCounts.airborne})</span>
          </button>

          {/* Ground Pill */}
          <button
            type="button"
            className={`flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider border transition-all ${
              filters.mode === "ground"
                ? "bg-blue-500/20 border-blue-500/40 text-blue-400"
                : "bg-white/[0.02] border-white/5 text-[var(--sw-muted)] hover:bg-white/[0.04] hover:text-[var(--sw-text)]"
            }`}
            onClick={() => setFilter("mode", "ground")}
          >
            <Activity className="w-3 h-3 rotate-90" />
            <span>Ground ({modeCounts.ground})</span>
          </button>
        </div>

        {/* Aircraft Class Grid */}
        <div className="grid grid-cols-2 gap-1 px-0.5">
          {legendClasses.map((item) => {
            const isActive = filters.aircraftClass === item.key;
            const count = classCounts[item.key as keyof typeof classCounts] || 0;
            return (
              <button
                type="button"
                key={item.key}
                onClick={() => setFilter("aircraftClass", isActive ? "all" : item.key)}
                className={`flex items-center justify-between p-2 rounded-lg border text-left transition-all ${
                  isActive
                    ? ""
                    : "bg-white/[0.01] border-white/5 text-[var(--sw-muted)] hover:bg-white/[0.04] hover:border-white/10 hover:text-[var(--sw-text)]"
                }`}
                style={
                  isActive
                    ? {
                        backgroundColor: item.bgColor,
                        borderColor: item.borderColor,
                        color: item.color,
                        boxShadow: `0 0 10px ${item.glowColor}`,
                      }
                    : undefined
                }
              >
                <div className="flex items-center gap-1.5 truncate">
                  {/* Swatch matching the legend and map markers! */}
                  <AircraftIcon
                    aircraftClass={item.key}
                    size={12}
                    className="shrink-0"
                    style={{
                      color: item.color,
                      filter: `drop-shadow(0 0 4px ${item.color}60)`,
                    }}
                  />
                  <span className="text-[10px] font-bold uppercase tracking-wider truncate">
                    {item.shortLabel}
                  </span>
                </div>
                <span className="text-[10px] font-mono font-medium shrink-0 ml-1 opacity-70">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {showAdvanced && (
        <div className="bg-[var(--sw-surface-soft)] border border-[var(--sw-border)] rounded-lg p-3 mb-3 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="grid grid-cols-2 bg-[var(--sw-surface-strong)] rounded p-1 gap-1 mb-4 border border-[var(--sw-border)]">
            {FLIGHT_FILTER_MODES.map((item) => (
              <button
                type="button"
                key={item.value}
                className={`text-[10px] font-bold uppercase tracking-wider py-1.5 rounded transition-colors ${
                  filters.mode === item.value
                    ? "bg-[var(--sw-surface-hover)] text-[var(--sw-text)]"
                    : "text-[var(--sw-muted)] hover:text-[var(--sw-text)] hover:bg-[var(--sw-surface-hover)]"
                }`}
                onClick={() => setFilter("mode", item.value as FlightFilterMode)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            <FilterSelect
              label="Class"
              value={filters.aircraftClass}
              onChange={(v) => setFilter("aircraftClass", v)}
            >
              <option value="all">Any class</option>
              {legendClasses.map((cls) => (
                <option key={cls.key} value={cls.key}>
                  {cls.label}
                </option>
              ))}
            </FilterSelect>

            <FilterSelect
              label="Country"
              value={filters.country}
              onChange={(v) => setFilter("country", v)}
            >
              <option value="all">Any country</option>
              {countryOptions.map(([country, count]) => (
                <option key={country} value={country}>
                  {country} ({count})
                </option>
              ))}
            </FilterSelect>

            <FilterSelect
              label="Altitude"
              value={filters.altitudeBand}
              onChange={(v) => setFilter("altitudeBand", v as AltitudeBand)}
            >
              {ALTITUDE_BANDS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </FilterSelect>

            <FilterSelect
              label="Speed"
              value={filters.speedBand}
              onChange={(v) => setFilter("speedBand", v as SpeedBand)}
            >
              {SPEED_BANDS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </FilterSelect>

            <FilterSelect
              label="Vertical"
              value={filters.verticalBand}
              onChange={(v) => setFilter("verticalBand", v as VerticalBand)}
            >
              {VERTICAL_BANDS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </FilterSelect>

            <FilterSelect
              label="Severity"
              value={filters.severity}
              onChange={(v) => setFilter("severity", v as SeverityFilter)}
            >
              {SEVERITY_FILTERS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </FilterSelect>
          </div>

          <div className="grid grid-cols-2 gap-3 border-t border-[var(--sw-border)] pt-4">
            <RangeInput
              label="Min alt"
              value={filters.minAltitudeFt}
              suffix="ft"
              onChange={(v) => setFilter("minAltitudeFt", v)}
            />
            <RangeInput
              label="Max alt"
              value={filters.maxAltitudeFt}
              suffix="ft"
              onChange={(v) => setFilter("maxAltitudeFt", v)}
            />
            <RangeInput
              label="Min spd"
              value={filters.minSpeedKt}
              suffix="kt"
              onChange={(v) => setFilter("minSpeedKt", v)}
            />
            <RangeInput
              label="Max spd"
              value={filters.maxSpeedKt}
              suffix="kt"
              onChange={(v) => setFilter("maxSpeedKt", v)}
            />
          </div>
        </div>
      )}

      {activeFilterLabels.length > 0 && !showAdvanced && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1">
          <SlidersHorizontal className="w-3 h-3 text-[var(--sw-muted)] mr-1" />
          {activeFilterLabels.slice(0, 4).map((label) => (
            <span
              key={label}
              className="px-1.5 py-0.5 bg-[var(--sw-surface-hover)] text-[var(--sw-text)] text-[10px] rounded border border-[var(--sw-border)]"
            >
              {label}
            </span>
          ))}
          {activeFilterLabels.length > 4 && (
            <span className="text-[10px] text-[var(--sw-muted)] font-medium">
              +{activeFilterLabels.length - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--sw-muted)]">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="bg-[var(--sw-surface-strong)] border border-[var(--sw-border)] text-[var(--sw-text)] text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500/50 appearance-none"
      >
        {children}
      </select>
    </label>
  );
}

function RangeInput({
  label,
  value,
  suffix,
  onChange,
}: {
  label: string;
  value: string;
  suffix: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center bg-[var(--sw-surface-strong)] border border-[var(--sw-border)] rounded px-2 py-1.5 focus-within:border-blue-500/50">
      <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--sw-muted)] w-12 shrink-0">
        {label}
      </span>
      <input
        value={value}
        inputMode="numeric"
        onChange={(event) => onChange(event.target.value.replace(/[^\d.-]/g, ""))}
        className="bg-transparent text-xs text-[var(--sw-text)] w-full outline-none text-right font-mono pr-1"
      />
      <em className="text-[10px] text-[var(--sw-dim)] not-italic shrink-0">{suffix}</em>
    </label>
  );
}

function FlightFeedList({
  flights,
  selectedId,
  onSelect,
  virtualized = false,
}: {
  flights: Flight[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  virtualized?: boolean;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: flights.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 80, // Updated to match actual compact layout
    overscan: 5,
  });

  if (virtualized) {
    return (
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-white/10"
      >
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((item) => {
            const flight = flights[item.index];
            if (!flight) return null;
            return (
              <div
                key={flight.icao24}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)`, height: `${item.size}px` }}
              >
                <FlightFeedCard flight={flight} selectedId={selectedId} onSelect={onSelect} />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-[var(--sw-border)]">
      {flights.map((flight) => (
        <li key={flight.icao24}>
          <FlightFeedCard flight={flight} selectedId={selectedId} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}

function FlightFeedCard({
  flight,
  selectedId,
  onSelect,
}: {
  flight: Flight;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const isSelected = selectedId === flight.icao24;
  const airline = airlineFromCallsign(flight.callsign);
  const alt = altitudeFt(flight.baro_altitude ?? flight.geo_altitude);
  const speed = speedKt(flight.velocity);
  const confidence =
    typeof flight.source_confidence === "number"
      ? `${Math.round(flight.source_confidence * 100)}%`
      : null;

  const aircraftClass = classifyFlight(flight);
  const classColor = AIRCRAFT_CLASSES[aircraftClass]?.color || "#64748b";

  return (
    <button
      type="button"
      onClick={() => onSelect(flight.icao24)}
      className={`w-full text-left px-4 py-3 hover:bg-[var(--sw-surface-hover)] focus:bg-[var(--sw-surface-hover)] outline-none transition-colors border-l-2 ${
        isSelected ? "border-blue-500 bg-[var(--sw-surface-hover)]" : "border-transparent"
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <AircraftIcon
            aircraftClass={aircraftClass}
            heading={flight.true_track ?? undefined}
            size={12}
            style={{
              color: classColor,
              filter: `drop-shadow(0 0 3px ${classColor}50)`,
            }}
          />
          <span className="text-sm font-bold font-mono text-[var(--sw-text)] tracking-tight truncate">
            {flight.callsign?.trim() || flight.icao24.toUpperCase()}
          </span>
        </div>
        <span className="text-[10px] font-mono bg-[var(--sw-surface-soft)] border border-[var(--sw-border)] px-1.5 py-0.5 rounded text-[var(--sw-muted)] tracking-wider">
          {countryCode(flight.origin_country)}
        </span>
      </div>
      <div className="flex justify-between items-center text-xs text-[var(--sw-muted)] mb-1.5">
        <span className="truncate pr-2 text-[var(--sw-text)]">
          {airline || flight.origin_country}
        </span>
        <span
          className={`text-[9px] font-bold uppercase tracking-wider ${flight.on_ground ? "text-amber-500" : "text-blue-400"}`}
        >
          {flight.on_ground ? "GROUND" : "AIR"}
        </span>
      </div>
      <div className="flex justify-between items-center text-xs font-mono font-medium text-[var(--sw-dim)]">
        <span>{fmt(alt, { suffix: " ft", digits: 0 })}</span>
        <span className="text-[var(--sw-text)]">{fmt(speed, { suffix: " kt", digits: 0 })}</span>
        {confidence && <span className="text-[var(--sw-blue)]">{confidence}</span>}
      </div>
    </button>
  );
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col divide-y divide-[var(--sw-border)] w-full">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="px-4 py-3 w-full animate-pulse flex flex-col gap-2">
          <div className="flex justify-between">
            <div className="h-4 w-20 bg-[var(--sw-surface-soft)] rounded" />
            <div className="h-4 w-8 bg-[var(--sw-surface-hover)] rounded" />
          </div>
          <div className="flex justify-between">
            <div className="h-3 w-32 bg-[var(--sw-surface-soft)] rounded" />
            <div className="h-3 w-10 bg-[var(--sw-surface-soft)] rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center text-[var(--sw-muted)] gap-3">
      {icon}
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-[var(--sw-text)]">{title}</span>
        <span className="text-xs">{detail}</span>
      </div>
    </div>
  );
}
