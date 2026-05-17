import {
  Activity,
  AlertTriangle,
  Filter,
  Globe,
  PanelRightClose,
  PanelRightOpen,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { memo, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import * as Tabs from "@radix-ui/react-tabs";
import type { Status } from "@/hooks/useFlights";
import type { AnomalousFlight } from "@/lib/anomaly";
import type { Flight } from "@/lib/opensky";
import { topSeverity } from "@/lib/anomaly";
import { anomalyIcons } from "@/lib/icons";
import { DATA_SOURCES, getDataSourceInfo } from "@/lib/data-sources";
import { getClassesForLegend } from "@/lib/aircraft-class";
import {
  ALTITUDE_BANDS,
  FLIGHT_FILTER_MODES,
  SEVERITY_FILTERS,
  SPEED_BANDS,
  VERTICAL_BANDS,
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

const sevClass: Record<string, string> = {
  critical: "high",
  high: "high",
  medium: "medium",
  low: "low",
};

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
  onSelect,
  onFiltersChange,
  onClearFilters,
  isCollapsed,
  onToggleCollapse,
}: Props) {
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

    for (const flight of flights) {
      if (!flight.on_ground) airborne += 1;
      if (flight.category === 8) helicopters += 1;
      countries.set(flight.origin_country, (countries.get(flight.origin_country) || 0) + 1);
      const src = flight.data_source || "unknown";
      sourceMap.set(src, (sourceMap.get(src) || 0) + 1);
    }

    const sourceCounts = Array.from(sourceMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count, info: getDataSourceInfo(key) }));

    return {
      activeCount: flights.length,
      inAirCount: airborne,
      groundCount: flights.length - airborne,
      helicopterCount: helicopters,
      topCountries: Array.from(countries.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
      recentFlights: flights.slice(0, 12),
      sourceCounts,
    };
  }, [flights]);

  const countryOptions = useMemo(() => {
    const countries = new Map<string, number>();
    for (const flight of allFlights) {
      if (!flight.origin_country) continue;
      countries.set(flight.origin_country, (countries.get(flight.origin_country) || 0) + 1);
    }
    return Array.from(countries.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [allFlights]);

  if (isCollapsed) {
    return (
      <button
        type="button"
        className="sw-dashboard-reopen"
        onClick={onToggleCollapse}
        aria-label="Open dashboard panel"
      >
        <PanelRightOpen />
        <span>Dashboard</span>
        <strong>{activeCount.toLocaleString()}</strong>
      </button>
    );
  }

  return (
    <aside className="sw-sidebar flex flex-col">
      <Tabs.Root defaultValue="global" className="flex-1 flex flex-col h-full overflow-hidden">
        <div className="sw-sidebar-header flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4" />
                <h2>Global Dashboard</h2>
              </div>
              <p>
                {activeCount.toLocaleString()} visible / {totalFlights.toLocaleString()} tracked
              </p>
            </div>
            <div className="flex items-center gap-2 sw-sidebar-toggle-container">
              {!isCollapsed && (
                <span className="sw-count-badge">
                  {activeFilterCount > 0 ? `${activeFilterCount} Filters` : `${activeCount} Live`}
                </span>
              )}
              <button
                type="button"
                className="sw-sidebar-toggle"
                onClick={onToggleCollapse}
                aria-label={isCollapsed ? "Expand dashboard" : "Collapse dashboard"}
              >
                {isCollapsed ? <PanelRightOpen /> : <PanelRightClose />}
              </button>
            </div>
          </div>

          <FilterWorkbench
            filters={filters}
            activeFilterLabels={activeFilterLabels}
            countryOptions={countryOptions}
            onFiltersChange={onFiltersChange}
            onClearFilters={onClearFilters}
          />

          <Tabs.List className="sw-tabs-list">
            <Tabs.Trigger value="global" className="sw-tabs-trigger">
              Overview
            </Tabs.Trigger>
            <Tabs.Trigger value="flights" className="sw-tabs-trigger">
              Search
            </Tabs.Trigger>
            <Tabs.Trigger value="anomalies" className="sw-tabs-trigger anomalies">
              Anomalies
              {anomalies.length > 0 && <span className="sw-tab-badge">{anomalies.length}</span>}
            </Tabs.Trigger>
          </Tabs.List>
        </div>

        <div className="sw-sidebar-body sw-scroll flex-1">
          <Tabs.Content value="global" className="h-full flex flex-col outline-none">
            {isLoading && totalFlights === 0 ? (
              <FeedSkeleton />
            ) : flights.length === 0 ? (
              <EmptyState
                icon={<Activity />}
                title={activeFilterCount > 0 ? "No matching flights" : "No active flights detected"}
                detail={status === "error" ? "Flight feed is offline" : "Monitoring is active"}
              />
            ) : (
              <div className="sw-overview-stack">
                <section className="sw-overview-section">
                  <h3 className="sw-list-heading">Visible State</h3>
                  <div className="sw-overview-grid">
                    <div className="sw-summary-tile">
                      <span>{inAirCount.toLocaleString()}</span>
                      <small>Airborne</small>
                    </div>
                    <div className="sw-summary-tile neutral">
                      <span>{groundCount.toLocaleString()}</span>
                      <small>Ground</small>
                    </div>
                    <div className="sw-summary-tile">
                      <span>{anomalies.length.toLocaleString()}</span>
                      <small>Anomaly</small>
                    </div>
                    <div className="sw-summary-tile neutral">
                      <span>{Math.max(totalFlights - activeCount, 0).toLocaleString()}</span>
                      <small>Hidden</small>
                    </div>
                  </div>
                </section>

                {sourceCounts.length > 0 && (
                  <section className="sw-overview-section">
                    <h3 className="sw-list-heading sw-list-heading-row">
                      <span>Data Sources</span>
                      <span>{sourceCounts.length} active</span>
                    </h3>
                    <ul className="sw-source-list">
                      {sourceCounts.map(({ key, count, info }) => (
                        <li key={key} className="sw-source-row">
                          <span className="sw-source-dot" style={{ backgroundColor: info.color }} />
                          <span className="sw-source-name truncate">{info.shortName}</span>
                          <span className="sw-source-type">{info.type}</span>
                          <span className="sw-source-count">{count.toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className="sw-overview-section">
                  <h3 className="sw-list-heading sw-list-heading-row">
                    <span>Top Countries</span>
                    <span>Visible</span>
                  </h3>
                  <ul className="sw-country-list">
                    {topCountries.map(([country, count]) => (
                      <li key={country} className="sw-country-row">
                        <span className="truncate pr-2">{country}</span>
                        <span className="sw-country-count">{count}</span>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="sw-overview-section">
                  <h3 className="sw-list-heading">Priority Flights</h3>
                  <FlightFeedList
                    flights={recentFlights}
                    selectedId={selectedId}
                    onSelect={onSelect}
                  />
                </section>
              </div>
            )}
          </Tabs.Content>

          <Tabs.Content value="flights" className="h-full flex flex-col outline-none">
            {isLoading && totalFlights === 0 ? (
              <FeedSkeleton />
            ) : flights.length === 0 ? (
              <EmptyState
                icon={<Search />}
                title="No matching flights"
                detail={status === "error" ? "Flight feed is offline" : "Adjust active filters"}
              />
            ) : (
              <section className="sw-overview-section">
                <h3 className="sw-list-heading sw-list-heading-row">
                  <span>Matched Flights</span>
                  <span>{flights.length.toLocaleString()}</span>
                </h3>
                <FlightFeedList
                  flights={flights.slice(0, 80)}
                  selectedId={selectedId}
                  onSelect={onSelect}
                />
              </section>
            )}
          </Tabs.Content>

          <Tabs.Content value="anomalies" className="h-full flex flex-col outline-none">
            {isLoading && anomalies.length === 0 ? (
              <FeedSkeleton />
            ) : anomalies.length === 0 ? (
              <EmptyState
                icon={<AlertTriangle />}
                title={activeFilterCount > 0 ? "No matching anomalies" : "No active anomalies"}
                detail={status === "error" ? "Flight feed is offline" : "Monitoring is active"}
              />
            ) : (
              <ul className="sw-feed-list p-3">
                {anomalies.map((anomaly) => {
                  const sev = topSeverity(anomaly.anomalies);
                  const isSelected = selectedId === anomaly.icao24;
                  const primary = anomaly.anomalies[0];
                  const Icon = anomalyIcons[primary.type];
                  const sc = sevClass[sev] ?? "low";
                  const airline = airlineFromCallsign(anomaly.callsign);

                  return (
                    <li key={`${anomaly.icao24}-${anomaly.detectedAt}`}>
                      <button
                        type="button"
                        onClick={() => onSelect(anomaly.icao24)}
                        className={`sw-feed-card ${isSelected ? "selected" : ""}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className={`sw-feed-icon ${sc}`}>
                              <Icon />
                            </span>
                            <span className="sw-feed-title">{primary.label}</span>
                          </div>
                          <span className={`sw-severity ${sc}`}>{sev}</span>
                        </div>

                        <div className="sw-feed-meta strong">
                          <span className="sw-feed-number">
                            {anomaly.callsign?.trim() || "UNKNOWN"}
                          </span>
                          <span>{relativeTime(anomaly.detectedAt)} ago</span>
                        </div>

                        <div className="sw-feed-meta">
                          <span className="truncate">{airline || anomaly.origin_country}</span>
                          <span className="sw-feed-code">
                            {countryCode(anomaly.origin_country)}
                          </span>
                        </div>

                        {anomaly.anomalies.length > 1 && (
                          <div className="sw-feed-note">
                            +{anomaly.anomalies.length - 1} additional flag
                            {anomaly.anomalies.length > 2 ? "s" : ""}
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Tabs.Content>
        </div>

        <div className="sw-sidebar-footer shrink-0">
          <span>OpenSky Network</span>
          <span>30s refresh</span>
        </div>
      </Tabs.Root>
    </aside>
  );
}

export default memo(GlobalDashboard);

function FilterWorkbench({
  filters,
  activeFilterLabels,
  countryOptions,
  onFiltersChange,
  onClearFilters,
}: {
  filters: FlightFilters;
  activeFilterLabels: string[];
  countryOptions: Array<[string, number]>;
  onFiltersChange: Dispatch<SetStateAction<FlightFilters>>;
  onClearFilters: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const setFilter = <K extends keyof FlightFilters>(key: K, value: FlightFilters[K]) => {
    onFiltersChange((current) => ({ ...current, [key]: value }));
  };

  const legendClasses = useMemo(() => getClassesForLegend(), []);

  return (
    <div className={`sw-filter-workbench ${showAdvanced ? "advanced-open" : ""}`}>
      <div className="sw-search-row">
        <label className="sw-search-box">
          <Search />
          <input
            value={filters.query}
            onChange={(event) => setFilter("query", event.target.value)}
            placeholder="Target search"
            aria-label="Target search"
          />
          {filters.query && (
            <button type="button" onClick={() => setFilter("query", "")} aria-label="Clear search">
              <X />
            </button>
          )}
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`sw-filter-advanced-toggle ${showAdvanced ? "active" : ""}`}
            onClick={() => setShowAdvanced(!showAdvanced)}
            title={showAdvanced ? "Hide advanced filters" : "Show advanced filters"}
          >
            <SlidersHorizontal />
            <span>Filters</span>
          </button>
          <button
            type="button"
            className="sw-filter-clear"
            onClick={onClearFilters}
            disabled={activeFilterLabels.length === 0}
          >
            <Filter />
            Clear
          </button>
        </div>
      </div>

      <div className={`sw-advanced-filters ${showAdvanced ? "visible" : "hidden"}`}>
        <div className="sw-filter-mode-grid" aria-label="Flight mode filter">
          {FLIGHT_FILTER_MODES.map((item) => (
            <button
              type="button"
              key={item.value}
              className={filters.mode === item.value ? "active" : ""}
              onClick={() => setFilter("mode", item.value as FlightFilterMode)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="sw-filter-grid">
          <FilterSelect
            label="Class"
            value={filters.aircraftClass}
            onChange={(value) => setFilter("aircraftClass", value)}
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
            onChange={(value) => setFilter("country", value)}
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
            onChange={(value) => setFilter("altitudeBand", value as AltitudeBand)}
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
            onChange={(value) => setFilter("speedBand", value as SpeedBand)}
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
            onChange={(value) => setFilter("verticalBand", value as VerticalBand)}
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
            onChange={(value) => setFilter("severity", value as SeverityFilter)}
          >
            {SEVERITY_FILTERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </FilterSelect>
        </div>

        <div className="sw-filter-range-grid">
          <RangeInput
            label="Min alt"
            value={filters.minAltitudeFt}
            suffix="ft"
            onChange={(value) => setFilter("minAltitudeFt", value)}
          />
          <RangeInput
            label="Max alt"
            value={filters.maxAltitudeFt}
            suffix="ft"
            onChange={(value) => setFilter("maxAltitudeFt", value)}
          />
          <RangeInput
            label="Min spd"
            value={filters.minSpeedKt}
            suffix="kt"
            onChange={(value) => setFilter("minSpeedKt", value)}
          />
          <RangeInput
            label="Max spd"
            value={filters.maxSpeedKt}
            suffix="kt"
            onChange={(value) => setFilter("maxSpeedKt", value)}
          />
        </div>
      </div>

      {activeFilterLabels.length > 0 && (
        <div className="sw-filter-chips" aria-label="Active filters">
          <SlidersHorizontal />
          {activeFilterLabels.slice(0, 5).map((label) => (
            <span key={label}>{label}</span>
          ))}
          {activeFilterLabels.length > 5 && <span>+{activeFilterLabels.length - 5}</span>}
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
    <label className="sw-filter-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
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
    <label className="sw-range-input">
      <span>{label}</span>
      <input
        value={value}
        inputMode="numeric"
        onChange={(event) => onChange(event.target.value.replace(/[^\d.-]/g, ""))}
      />
      <em>{suffix}</em>
    </label>
  );
}

function FlightFeedList({
  flights,
  selectedId,
  onSelect,
}: {
  flights: Flight[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="sw-feed-list">
      {flights.map((flight) => {
        const isSelected = selectedId === flight.icao24;
        const airline = airlineFromCallsign(flight.callsign);
        const alt = altitudeFt(flight.baro_altitude ?? flight.geo_altitude);
        const speed = speedKt(flight.velocity);

        return (
          <li key={flight.icao24}>
            <button
              type="button"
              onClick={() => onSelect(flight.icao24)}
              className={`sw-feed-card ${isSelected ? "selected" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="sw-feed-title">
                  {flight.callsign?.trim() || flight.icao24.toUpperCase()}
                </span>
                <span className="sw-feed-code">{countryCode(flight.origin_country)}</span>
              </div>
              <div className="sw-feed-meta">
                <span className="truncate">{airline || flight.origin_country}</span>
                <span className="sw-feed-number">{flight.on_ground ? "GROUND" : "AIRBORNE"}</span>
              </div>
              <div className="sw-feed-meta strong">
                <span>{fmt(alt, { suffix: " ft", digits: 0 })}</span>
                <span className="sw-feed-number">{fmt(speed, { suffix: " kt", digits: 0 })}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FeedSkeleton() {
  return (
    <div className="sw-feed-loading">
      {Array.from({ length: 5 }).map((_, index) => (
        <div className="sw-feed-skeleton" key={index}>
          <span />
          <div>
            <span />
            <span />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, detail }: { icon: ReactNode; title: string; detail: string }) {
  return (
    <div className="sw-empty-state">
      {icon}
      <span>{title}</span>
      <small>{detail}</small>
    </div>
  );
}
