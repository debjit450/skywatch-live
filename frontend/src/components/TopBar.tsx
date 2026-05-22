import {
  Activity,
  AlertTriangle,
  Database,
  MapPin,
  Plane,
  Radar,
  Satellite,
  ChevronDown,
  Moon,
  Sun,
  Info,
} from "lucide-react";
import React, { memo, useState, useRef, useEffect, useMemo } from "react";
import * as Select from "@radix-ui/react-select";
import { COUNTRIES } from "@/lib/countries";
import type { AirportStatus } from "@/hooks/useAirports";
import type { Status } from "@/hooks/useFlights";
import type { SatelliteStatus } from "@/hooks/useSatellites";
import { formatClock } from "@/lib/format";
import type { Flight } from "@/lib/opensky";
import { countByClass, getClassesForLegend } from "@/lib/aircraft-class";
import {
  MARKER_ICON_SVG_CONTENT,
  MARKER_ICON_VIEW_BOX,
  type SkywatchMarkerIconName,
} from "./map/markerIcons";

interface Props {
  flights: Flight[];
  flightCount: number;
  inAir: number;
  anomalyCount: number;
  lastUpdated: number | null;
  status: Status;
  isFetching: boolean;
  airportCount: number;
  airportCountryCount: number;
  airportStatus: AirportStatus;
  airportIsFallback: boolean;
  satelliteCount: number;
  satelliteStatus: SatelliteStatus;
  feedSource: string | null;
  sourceCounts: Record<string, number>;
  staleCount: number;
  maxAgeSeconds: number | null;
  filteredFlightCount: number;
  activeFilterCount: number;
  selectedCountry: string;
  onSelectCountry: (country: string) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  isDashboardCollapsed: boolean;
}

function TopBar({
  flights,
  flightCount,
  inAir,
  anomalyCount,
  lastUpdated,
  status,
  isFetching,
  airportCount,
  airportCountryCount,
  airportStatus,
  airportIsFallback,
  satelliteCount,
  satelliteStatus,
  feedSource,
  sourceCounts,
  staleCount,
  maxAgeSeconds,
  filteredFlightCount,
  activeFilterCount,
  selectedCountry,
  onSelectCountry,
  theme,
  onToggleTheme,
  isDashboardCollapsed,
}: Props) {
  const [isLegendOpen, setIsLegendOpen] = useState(false);
  const [legendTab, setLegendTab] = useState<"flights" | "airspace" | "env">("flights");
  const legendRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (legendRef.current && !legendRef.current.contains(event.target as Node)) {
        setIsLegendOpen(false);
      }
    }
    if (isLegendOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isLegendOpen]);

  const classCounts = useMemo(() => countByClass(flights || []), [flights]);
  const legendClasses = useMemo(() => getClassesForLegend(), []);
  const statusTone =
    status === "live"
      ? "good"
      : status === "error"
        ? "bad"
        : status === "reconnecting"
          ? "warn"
          : "neutral";

  const statusLabel =
    status === "live" && isFetching
      ? "Refreshing"
      : status === "live"
        ? "Live"
        : status === "reconnecting"
          ? "Retrying"
          : status === "error"
            ? "Offline"
            : "Loading";

  const aircraftDetail =
    activeFilterCount > 0
      ? `${filteredFlightCount.toLocaleString()} matched / ${activeFilterCount} filter${
          activeFilterCount === 1 ? "" : "s"
        }`
      : `${inAir.toLocaleString()} airborne`;

  const airportDetail =
    airportStatus === "loading"
      ? "Loading index..."
      : airportStatus === "error"
        ? "Fallback index"
        : `${airportCountryCount.toLocaleString()} countries${
            airportIsFallback ? " (fallback)" : ""
          }`;

  const satelliteDetail =
    satelliteStatus === "loading" || satelliteStatus === "idle"
      ? "Loading orbital layer..."
      : satelliteStatus === "error"
        ? "Layer offline"
        : "CelesTrak SGP4";

  // Build source breakdown label from per-source aircraft counts
  const safeSourceCounts = sourceCounts || {};
  const sourceBreakdown =
    Object.keys(safeSourceCounts).length > 0
      ? Object.entries(safeSourceCounts)
          .filter(([, count]) => count > 0)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 4)
          .map(([src, count]) => `${src.replace(/_/g, "\u00a0")}\u00a0${count.toLocaleString()}`)
          .join(" / ")
      : feedSource
        ? feedSource.replace(/_/g, " ")
        : "live feed";

  const sourceDetail = [
    sourceBreakdown,
    maxAgeSeconds !== null ? `${Math.round(maxAgeSeconds)}s max age` : null,
    staleCount > 0 ? `${staleCount.toLocaleString()} stale rejected` : null,
  ]
    .filter(Boolean)
    .join(" • ");

  return (
    <header
      style={{
        right: isDashboardCollapsed ? "96px" : "412px",
      }}
      className="fixed top-4 left-4 z-[2000] flex items-center justify-between h-14 px-4 bg-[rgba(4,15,8,0.45)] backdrop-blur-xl border border-[var(--sw-border-strong)] rounded-xl shadow-2xl transition-all duration-300 overflow-visible"
    >
      {/* Liquid glass ambient shimmers */}
      <div className="absolute inset-0 overflow-hidden rounded-xl pointer-events-none">
        <div className="absolute inset-0 w-full h-full opacity-40 dark:opacity-65 bg-gradient-to-r from-transparent via-emerald-500/5 to-transparent dark:via-emerald-500/10 animate-pulse duration-[8000ms]" />
        <div className="absolute -top-[10px] left-1/4 w-[120px] h-[20px] bg-emerald-400/20 dark:bg-emerald-400/40 rounded-full blur-[20px]" />
        <div className="absolute -top-[10px] right-1/4 w-[120px] h-[20px] bg-blue-400/20 dark:bg-blue-400/40 rounded-full blur-[20px]" />
      </div>

      {/* ── Brand Identity ── */}
      <div className="flex items-center gap-2.5 min-w-0 pr-4 border-r border-white/20 dark:border-white/10 relative z-10 flex-shrink-0">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-white/30 dark:bg-white/5 border border-white/40 dark:border-white/10 text-emerald-400 flex-shrink-0 shadow-[inset_0_1px_2px_rgba(255,255,255,0.2)] hover:scale-105 transition-all duration-300">
          <img
            src="/logo.svg"
            className="w-7 h-7 object-contain filter drop-shadow-[0_0_4px_rgba(74,222,128,0.6)] dark:drop-shadow-[0_0_8px_rgba(74,222,128,0.8)]"
            alt="SkyWatch Logo"
          />
        </div>
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-1.5">
            <h1 className="text-sm font-black tracking-wider bg-clip-text text-transparent bg-gradient-to-r from-zinc-900 to-zinc-700 dark:from-zinc-50 dark:to-zinc-300">
              SkyWatch
            </h1>
            <StatusBadge tone={statusTone} label={statusLabel} isLive={statusTone === "good"} />
          </div>
          <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest truncate">
            Global Airspace Intelligence
          </span>
        </div>
      </div>

      {/* ── Primary Metrics ── */}
      <div className="hidden md:flex items-center flex-1 px-4 gap-2 xl:gap-3 overflow-hidden justify-center min-w-0">
        <SummaryItem
          icon={<Plane />}
          label="Aircraft"
          value={flightCount.toLocaleString()}
          detail={aircraftDetail}
        />
        <SummaryItem
          icon={<Database />}
          label="Airports"
          value={airportCount.toLocaleString()}
          detail={airportDetail}
        />
        <SummaryItem
          icon={<Satellite />}
          label="Satellites"
          value={satelliteCount.toLocaleString()}
          detail={satelliteDetail}
          tone={satelliteStatus === "error" ? "warn" : "neutral"}
        />
        <SummaryItem
          icon={<AlertTriangle />}
          label="Anomalies"
          value={anomalyCount.toLocaleString()}
          detail={
            flightCount > 0 ? `${((anomalyCount / flightCount) * 100).toFixed(2)}% rate` : "No feed"
          }
          tone={anomalyCount > 0 ? "bad" : "neutral"}
        />
        <SummaryItem
          icon={<Activity />}
          label="Updated"
          value={formatClock(lastUpdated)}
          detail={sourceDetail}
          tone={staleCount > 0 ? "warn" : "neutral"}
          mono
        />
      </div>

      {/* ── Controls ── */}
      <div className="flex items-center gap-2 pl-4 border-l border-white/20 dark:border-white/10 relative z-10 flex-shrink-0">
        <Select.Root value={selectedCountry} onValueChange={onSelectCountry}>
          <Select.Trigger
            className="flex items-center gap-2 px-3 py-1.5 h-8 bg-white/20 dark:bg-white/5 border border-white/30 dark:border-white/10 rounded-full text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-white/30 dark:hover:bg-white/10 transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 shadow-sm"
            aria-label="Select country"
          >
            <Select.Icon>
              <MapPin className="h-3.5 w-3.5 text-zinc-500 dark:text-zinc-400" />
            </Select.Icon>
            <Select.Value className="truncate max-w-[100px]" />
            <Select.Icon>
              <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
            </Select.Icon>
          </Select.Trigger>

          <Select.Portal>
            <Select.Content
              className="z-[2500] w-48 bg-white/90 dark:bg-zinc-950/90 border border-white/20 dark:border-white/10 rounded-xl shadow-2xl overflow-hidden backdrop-blur-2xl shadow-black/30 dark:shadow-black/50 ring-1 ring-white/5"
              position="popper"
              sideOffset={8}
              align="end"
            >
              <Select.Viewport className="p-1 max-h-[300px] overflow-y-auto scrollbar-thin scrollbar-thumb-zinc-200 dark:scrollbar-thumb-white/10">
                {COUNTRIES.map((c) => (
                  <Select.Item
                    key={c.code}
                    value={c.name}
                    className="flex items-center px-3 py-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300 rounded-lg cursor-pointer outline-none data-[highlighted]:bg-emerald-50 dark:data-[highlighted]:bg-emerald-500/20 data-[highlighted]:text-emerald-600 dark:data-[highlighted]:text-emerald-400 select-none transition-all duration-200"
                  >
                    <Select.ItemText>{c.name}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>

        <div className="relative" ref={legendRef}>
          <button
            type="button"
            onClick={() => setIsLegendOpen(!isLegendOpen)}
            aria-label="Map Legend"
            title="Map Legend"
            className={`flex items-center justify-center w-8 h-8 rounded-full border text-zinc-500 dark:text-zinc-400 hover:bg-white/30 dark:hover:bg-white/10 transition-all duration-300 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${
              isLegendOpen
                ? "bg-emerald-500/10 border-emerald-500/30 dark:bg-emerald-500/20 dark:border-emerald-500/30 text-emerald-600 dark:text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.2)]"
                : "bg-transparent border-transparent"
            }`}
          >
            <Info className="w-4 h-4" />
          </button>

          {isLegendOpen && (
            <div className="absolute right-0 top-10 mt-2 z-[2500] w-80 bg-white/90 dark:bg-zinc-950/90 border border-white/20 dark:border-white/10 backdrop-blur-3xl rounded-2xl p-4 shadow-2xl shadow-black/30 dark:shadow-black/80 ring-1 ring-white/5 font-sans text-zinc-700 dark:text-zinc-200 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="flex items-center justify-between border-b border-zinc-100 dark:border-white/5 pb-2 mb-3">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-500 dark:text-emerald-400">
                  Map Legend
                </span>
              </div>

              {/* Tabs */}
              <div className="flex border-b border-zinc-100 dark:border-white/5 mb-3 gap-1">
                <button
                  type="button"
                  onClick={() => setLegendTab("flights")}
                  className={`flex-1 pb-1.5 text-center text-[10px] font-bold uppercase tracking-wider transition-all border-b-2 ${
                    legendTab === "flights"
                      ? "text-emerald-500 dark:text-emerald-400 border-emerald-500"
                      : "text-zinc-500 border-transparent hover:text-zinc-800 dark:hover:text-zinc-300"
                  }`}
                >
                  Flights
                </button>
                <button
                  type="button"
                  onClick={() => setLegendTab("airspace")}
                  className={`flex-1 pb-1.5 text-center text-[10px] font-bold uppercase tracking-wider transition-all border-b-2 ${
                    legendTab === "airspace"
                      ? "text-emerald-500 dark:text-emerald-400 border-emerald-500"
                      : "text-zinc-500 border-transparent hover:text-zinc-800 dark:hover:text-zinc-300"
                  }`}
                >
                  Airports
                </button>
                <button
                  type="button"
                  onClick={() => setLegendTab("env")}
                  className={`flex-1 pb-1.5 text-center text-[10px] font-bold uppercase tracking-wider transition-all border-b-2 ${
                    legendTab === "env"
                      ? "text-emerald-500 dark:text-emerald-400 border-emerald-500"
                      : "text-zinc-500 border-transparent hover:text-zinc-800 dark:hover:text-zinc-300"
                  }`}
                >
                  Env & Space
                </button>
              </div>

              <div className="flex flex-col gap-2 max-h-[320px] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-white/10">
                {legendTab === "flights" && (
                  <>
                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                      Aircraft Classes
                    </div>
                    {legendClasses.map((cls) => {
                      const count = classCounts.get(cls.key) ?? 0;
                      return (
                        <div
                          key={cls.key}
                          className="flex items-center gap-3 text-xs"
                          title={cls.description}
                        >
                          <Swatch color={cls.color} shape={cls.iconType} />
                          <span
                            className={count > 0 ? "text-zinc-200 font-medium" : "text-zinc-600"}
                          >
                            {cls.shortLabel}
                          </span>
                          <span
                            className="ml-auto font-mono text-[10px] font-semibold"
                            style={{ color: count > 0 ? cls.color : "#4b5563" }}
                          >
                            {count > 0 ? count.toLocaleString() : "—"}
                          </span>
                        </div>
                      );
                    })}

                    <div className="h-px bg-white/5 my-2" />

                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                      Telemetry Status
                    </div>
                    {TELEMETRY_LEGEND.map((item) => (
                      <div key={item.label} className="flex items-center gap-3 text-xs">
                        <Swatch color={item.color} shape={item.shape} />
                        <span className="text-zinc-400">{item.label}</span>
                      </div>
                    ))}
                  </>
                )}

                {legendTab === "airspace" && (
                  <>
                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                      Airports
                    </div>
                    {AIRPORT_LEGEND.map((item) => (
                      <div key={item.label} className="flex items-center gap-3 text-xs">
                        <Swatch color={item.color} shape={item.shape} />
                        <span className="text-zinc-400">{item.label}</span>
                      </div>
                    ))}

                    <div className="h-px bg-white/5 my-2" />

                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                      Airspace Restrictions (TFR)
                    </div>
                    {TFR_LEGEND.map((item) => (
                      <div key={item.label} className="flex items-center gap-3 text-xs">
                        <Swatch color={item.color} shape={item.shape} />
                        <span className="text-zinc-400">{item.label}</span>
                      </div>
                    ))}
                  </>
                )}

                {legendTab === "env" && (
                  <>
                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                      Weather Categories (METAR)
                    </div>
                    {WEATHER_LEGEND.map((item) => (
                      <div key={item.label} className="flex items-center gap-3 text-xs">
                        <Swatch color={item.color} shape={item.shape} />
                        <span className="text-zinc-400">{item.label}</span>
                      </div>
                    ))}

                    <div className="h-px bg-white/5 my-2" />

                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">
                      Satellites
                    </div>
                    {SATELLITE_LEGEND.map((item) => (
                      <div key={item.label} className="flex items-center gap-3 text-xs">
                        <Swatch color={item.color} shape={item.shape} />
                        <span className="text-zinc-400">{item.label}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          className="flex items-center justify-center w-8 h-8 rounded-md bg-transparent border border-transparent text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-white/10 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
        >
          {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>
    </header>
  );
}

export default memo(TopBar);

// ─── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ tone, label, isLive }: { tone: string; label: string; isLive: boolean }) {
  const styles: Record<string, string> = {
    good: "bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.2)]",
    warn: "bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.2)]",
    bad: "bg-rose-500/10 border-rose-500/30 text-rose-600 dark:text-rose-400 shadow-[0_0_12px_rgba(244,63,94,0.2)]",
    neutral:
      "bg-zinc-500/10 border-zinc-500/30 text-zinc-600 dark:text-zinc-400 shadow-[0_0_12px_rgba(113,113,122,0.2)]",
  };

  return (
    <div
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[8px] font-bold uppercase tracking-wider backdrop-blur-md transition-all duration-300 ${styles[tone]}`}
    >
      {isLive && (
        <span className="relative flex w-1 h-1">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full w-1 h-1 bg-emerald-400 shadow-[0_0_6px_#10b981]"></span>
        </span>
      )}
      {label}
    </div>
  );
}

function SummaryItem({
  icon,
  label,
  value,
  detail,
  tone = "neutral",
  mono,
}: {
  icon: React.ReactElement<{ className?: string }>;
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "bad" | "warn";
  mono?: boolean;
}) {
  const labelColor =
    tone === "bad"
      ? "text-rose-500"
      : tone === "warn"
        ? "text-amber-500"
        : "text-zinc-500 dark:text-zinc-400";
  const valueColor =
    tone === "bad"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-zinc-900 dark:text-zinc-100";

  return (
    <div className="flex flex-col min-w-0 shrink px-2 py-0.5 rounded-lg border border-transparent hover:border-white/20 dark:hover:border-white/10 hover:bg-white/10 dark:hover:bg-white/[0.03] transition-all duration-300 cursor-default">
      <div className="flex items-center gap-1 mb-0.5">
        <div className={`opacity-70 ${labelColor}`}>
          {/* Ensure the icon passed down adopts the standard size */}
          {React.cloneElement(icon, { className: "w-3 h-3" })}
        </div>
        <span className={`text-[9px] font-semibold uppercase tracking-wider ${labelColor}`}>
          {label}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span
          className={`text-xs font-bold leading-none ${valueColor} ${mono ? "font-mono tracking-tight" : ""}`}
        >
          {value}
        </span>
        {detail && (
          <span className="text-[9px] text-zinc-500 dark:text-zinc-500 truncate max-w-[100px] leading-none">
            {detail}
          </span>
        )}
      </div>
    </div>
  );
}

const TELEMETRY_LEGEND = [
  { label: "Normal Flight", color: "#00e5ff", shape: "filled" as const },
  { label: "Selected Flight", color: "#3b82f6", shape: "ring" as const },
  { label: "Anomalous Flight", color: "#f59e0b", shape: "ring" as const },
  { label: "Ground Aircraft", color: "#52525b", shape: "dot" as const },
  { label: "Flight Track", color: "#3b82f6", shape: "route" as const },
];

const AIRPORT_LEGEND = [
  { label: "Large / Hub", color: "#a882c8", shape: "square" as const },
  { label: "Medium / Regional", color: "#8296c8", shape: "square" as const },
  { label: "Small Airport", color: "#8c8c8c", shape: "square" as const },
  { label: "Heliport", color: "#c86464", shape: "square" as const },
  { label: "Seaplane Base", color: "#50b4a0", shape: "square" as const },
  { label: "Closed Airport", color: "#505a64", shape: "square" as const },
];

const TFR_LEGEND = [
  { label: "Critical (No-Fly)", color: "#ef4444", shape: "square" as const },
  { label: "Advisory (Warning)", color: "#f59e0b", shape: "square" as const },
];

const WEATHER_LEGEND = [
  { label: "VFR (Visual)", color: "#10b981", shape: "filled" as const },
  { label: "MVFR (Marginal)", color: "#3b82f6", shape: "filled" as const },
  { label: "IFR (Instrument)", color: "#ef4444", shape: "filled" as const },
  { label: "LIFR (Low IFR)", color: "#d946ef", shape: "filled" as const },
];

const SATELLITE_LEGEND = [
  { label: "Space Station", color: "#22c55e", shape: "satellite" as const },
  { label: "Visual / Bright", color: "#facc15", shape: "satellite" as const },
  { label: "Weather Sat", color: "#38bdf8", shape: "satellite" as const },
  { label: "Earth Resources", color: "#4ade80", shape: "satellite" as const },
  { label: "Galileo / Nav", color: "#c084fc", shape: "satellite" as const },
  { label: "Starlink", color: "#94a3b8", shape: "satellite" as const },
  { label: "OneWeb", color: "#60a5fa", shape: "satellite" as const },
];

type SwatchShape = "filled" | "ring" | "dot" | "square" | "route" | SkywatchMarkerIconName;

function isMarkerIconShape(shape: SwatchShape): shape is SkywatchMarkerIconName {
  return shape in MARKER_ICON_SVG_CONTENT;
}

function Swatch({ color, shape = "filled" }: { color: string; shape?: SwatchShape }) {
  const size = shape === "dot" ? 6 : 10;

  if (shape === "route") {
    return (
      <span
        style={{
          display: "inline-block",
          width: 14,
          height: 2,
          background: color,
          flexShrink: 0,
        }}
      />
    );
  }

  if (isMarkerIconShape(shape)) {
    const svgContent = MARKER_ICON_SVG_CONTENT[shape].replaceAll("black", "currentColor");

    return (
      <span
        style={{
          display: "inline-flex",
          width: 16,
          height: 16,
          alignItems: "center",
          justifyContent: "center",
          color,
          flexShrink: 0,
          filter: `drop-shadow(0 0 4px ${color}66)`,
        }}
      >
        <svg
          viewBox={MARKER_ICON_VIEW_BOX[shape]}
          aria-hidden="true"
          style={{ width: 16, height: 16, display: "block", fill: "currentColor" }}
          dangerouslySetInnerHTML={{ __html: svgContent }}
        />
      </span>
    );
  }

  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: shape === "square" ? "2px" : "50%",
        flexShrink: 0,
        background: shape === "ring" ? "transparent" : color,
        border: shape === "ring" ? `2px solid ${color}` : "none",
        boxShadow:
          shape === "filled"
            ? `0 0 6px ${color}50, 0 0 2px ${color}30`
            : shape === "ring"
              ? `0 0 8px ${color}40`
              : shape === "square"
                ? `0 0 4px ${color}40`
                : `0 0 4px ${color}60`,
      }}
    />
  );
}
