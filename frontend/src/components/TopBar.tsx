import {
  Activity,
  AlertTriangle,
  Database,
  MapPin,
  Plane,
  Radar,
  ChevronDown,
  Moon,
  Sun,
} from "lucide-react";
import { memo } from "react";
import * as Select from "@radix-ui/react-select";
import { COUNTRIES } from "@/lib/countries";
import type { AirportStatus } from "@/hooks/useAirports";
import type { Status } from "@/hooks/useFlights";
import { formatClock } from "@/lib/format";

interface Props {
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
  filteredFlightCount: number;
  activeFilterCount: number;
  selectedCountry: string;
  onSelectCountry: (country: string) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

function TopBar({
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
  filteredFlightCount,
  activeFilterCount,
  selectedCountry,
  onSelectCountry,
  theme,
  onToggleTheme,
}: Props) {
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
      ? "Loading airport index"
      : airportStatus === "error"
        ? "Fallback airport index"
        : `${airportCountryCount.toLocaleString()} countries${
            airportIsFallback ? " / fallback" : ""
          }`;

  return (
    <header className="sw-topbar">
      <div className="sw-brand">
        <div className="sw-brand-mark">
          <Radar className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <div className="sw-brand-title">SkyWatch</div>
            <span className={`sw-status-chip ${statusTone}`}>
              {statusTone === "good" && <span className="sw-live-ping" aria-hidden="true" />}
              {statusLabel}
            </span>
          </div>
          <div className="sw-brand-subtitle">Live Global Aircraft Surveillance</div>
        </div>
      </div>

      <div className="sw-ops-summary" aria-label="Live feed summary">
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
          icon={<AlertTriangle />}
          label="Anomalies"
          value={anomalyCount.toLocaleString()}
          detail={
            flightCount > 0 ? `${((anomalyCount / flightCount) * 100).toFixed(2)}% rate` : "No feed"
          }
          tone={anomalyCount > 0 ? "bad" : "neutral"}
        />
        <SummaryItem icon={<Activity />} label="Updated" value={formatClock(lastUpdated)} mono />
      </div>

      <div className="sw-topbar-controls">
        <Select.Root value={selectedCountry} onValueChange={onSelectCountry}>
          <Select.Trigger className="sw-country-select" aria-label="Select country">
            <Select.Icon>
              <MapPin className="h-4 w-4" />
            </Select.Icon>
            <Select.Value />
            <Select.Icon>
              <ChevronDown className="h-4 w-4 opacity-50" />
            </Select.Icon>
          </Select.Trigger>

          <Select.Portal>
            <Select.Content
              className="sw-country-content"
              position="popper"
              sideOffset={8}
              align="center"
            >
              <Select.Viewport className="sw-country-viewport sw-scroll">
                {COUNTRIES.map((c) => (
                  <Select.Item key={c.code} value={c.name} className="sw-country-item">
                    <Select.ItemText>{c.name}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>

        <button
          type="button"
          className="sw-theme-toggle"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        >
          {theme === "dark" ? <Sun /> : <Moon />}
          <span>{theme === "dark" ? "Light" : "Dark"}</span>
        </button>
      </div>
    </header>
  );
}

export default memo(TopBar);

function SummaryItem({
  icon,
  label,
  value,
  detail,
  tone = "neutral",
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "bad";
  mono?: boolean;
}) {
  return (
    <div className={`sw-summary-item ${tone}`}>
      <span className="sw-summary-icon">{icon}</span>
      <span className="sw-summary-copy">
        <span className="sw-summary-label">{label}</span>
        <strong className={mono ? "sw-mono" : ""}>{value}</strong>
        {detail && <small>{detail}</small>}
      </span>
    </div>
  );
}
