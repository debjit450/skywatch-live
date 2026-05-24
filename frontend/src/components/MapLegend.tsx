/**
 * MapLegend — interactive aircraft class legend overlay for the map.
 *
 * Displays a collapsible panel showing all aircraft classes with:
 *  - Color swatch
 *  - Label and count
 *  - Toggle visibility (future feature)
 *
 * Premium dark glassmorphism aesthetic matching the SkyWatch design system.
 */

import { memo, useState, useMemo } from "react";
import type { Flight } from "@/lib/opensky";
import {
  classifyFlight,
  getClassesForLegend,
  countByClass,
  AIRCRAFT_CLASSES,
  type AircraftClass,
  type AircraftClassInfo,
} from "@/lib/aircraft-class";
import AircraftIcon from "@/components/AircraftIcon";

interface MapLegendProps {
  flights: Flight[];
}

// ─── Anomaly severity colors ─────────────────────────────────────────────────

const ANOMALY_LEGEND = [
  { label: "Selected", color: "#3b82f6", shape: "ring" as const },
  { label: "Anomaly", color: "#f59e0b", shape: "ring" as const },
  { label: "Ground", color: "#64748b", shape: "dot" as const },
  { label: "Flight Track", color: "#3b82f6", shape: "route" as const },
  { label: "Planned Route", color: "#facc15", shape: "route" as const },
];

const AIRPORT_LEGEND = [
  { label: "Large / Hub", color: "#a855f7", shape: "square" as const },
  { label: "Medium / Regional", color: "#60a5fa", shape: "square" as const },
  { label: "Small / Local", color: "#94a3b8", shape: "square" as const },
  { label: "Heliport", color: "#fb7187", shape: "square" as const },
  { label: "Route Origin/Dest", color: "#facc15", shape: "square" as const },
];

// ─── Styles ──────────────────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: 88,
  right: 24,
  zIndex: 1000,
  background: "rgba(9, 9, 11, 0.9)",
  backdropFilter: "blur(24px)",
  WebkitBackdropFilter: "blur(24px)",
  border: "1px solid rgba(255, 255, 255, 0.1)",
  borderRadius: 16,
  padding: 0,
  fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
  fontSize: 11,
  color: "#e2e8f0",
  minWidth: 180,
  maxWidth: 220,
  boxShadow: "0 18px 48px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255,255,255,0.03)",
  transition: "all 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
  userSelect: "none" as const,
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 12px",
  cursor: "pointer",
  borderBottom: "1px solid rgba(0, 229, 255, 0.15)",
  background: "linear-gradient(to right, rgba(15, 23, 42, 0.8), rgba(0, 0, 0, 0.9))",
  letterSpacing: "0.05em",
  textTransform: "uppercase" as const,
  fontSize: 9.5,
  fontWeight: 700,
  color: "#38bdf8",
  textShadow: "0 0 8px rgba(56, 189, 248, 0.3)",
};

const itemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 12px",
  lineHeight: "18px",
};

const countBadgeStyle: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: 9,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  color: "#64748b",
  minWidth: 20,
  textAlign: "right" as const,
};

const separatorStyle: React.CSSProperties = {
  height: 1,
  margin: "4px 12px",
  background: "rgba(0, 229, 255, 0.08)",
};

function Swatch({
  color,
  shape = "filled",
}: {
  color: string;
  shape?: "filled" | "ring" | "dot" | "square" | "route";
}) {
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

function MapLegend({ flights }: MapLegendProps) {
  const [expanded, setExpanded] = useState(true);

  const classCounts = useMemo(() => countByClass(flights), [flights]);
  const legendClasses = useMemo(() => getClassesForLegend(), []);

  return (
    <div
      style={panelStyle}
      id="map-legend"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div style={headerStyle} onClick={() => setExpanded(!expanded)}>
        <span>Legend</span>
        <span
          style={{
            fontSize: 10,
            transform: expanded ? "rotate(0)" : "rotate(-90deg)",
            transition: "transform 0.2s",
          }}
        >
          ▾
        </span>
      </div>

      {expanded && (
        <div style={{ padding: "4px 0 6px" }}>
          {legendClasses.map((cls) => {
            const count = classCounts.get(cls.key) ?? 0;
            return (
              <div key={cls.key} style={itemStyle} title={cls.description}>
                <AircraftIcon
                  aircraftClass={cls.key}
                  size={12}
                  style={{
                    color: cls.color,
                    filter: `drop-shadow(0 0 4px ${cls.color}50)`,
                  }}
                />
                <span style={{ color: count > 0 ? "#e2e8f0" : "#475569" }}>{cls.shortLabel}</span>
                <span
                  style={{
                    ...countBadgeStyle,
                    color: count > 0 ? cls.color : "#334155",
                  }}
                >
                  {count > 0 ? count.toLocaleString() : "—"}
                </span>
              </div>
            );
          })}

          <div style={separatorStyle} />

          {ANOMALY_LEGEND.map((item) => (
            <div key={item.label} style={itemStyle}>
              <Swatch color={item.color} shape={item.shape} />
              <span style={{ color: "#94a3b8" }}>{item.label}</span>
            </div>
          ))}

          <div style={separatorStyle} />

          <div
            style={{
              padding: "0 12px 4px",
              fontSize: 9.5,
              fontWeight: 700,
              color: "#64748b",
              marginTop: 4,
            }}
          >
            AIRPORTS
          </div>
          {AIRPORT_LEGEND.map((item) => (
            <div key={item.label} style={itemStyle}>
              <Swatch color={item.color} shape={item.shape} />
              <span style={{ color: "#94a3b8" }}>{item.label}</span>
            </div>
          ))}

          <div style={separatorStyle} />
        </div>
      )}
    </div>
  );
}

export default memo(MapLegend);
