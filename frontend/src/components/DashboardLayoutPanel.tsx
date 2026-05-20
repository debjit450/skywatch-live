import { useMemo, useState } from "react";
import { ResponsiveGridLayout, type LayoutItem } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { ChevronDown, ChevronUp, RotateCcw, X } from "lucide-react";

const WIDGETS = [
  "map",
  "flight list",
  "anomaly feed",
  "traffic analytics",
  "weather panel",
  "alert rules",
];

function storageKey(userId: string) {
  return `skywatch_layout_${userId}`;
}

const defaultLayout: LayoutItem[] = [
  { i: "map", x: 0, y: 0, w: 12, h: 8 },
  { i: "flight list", x: 0, y: 8, w: 6, h: 5 },
  { i: "anomaly feed", x: 6, y: 8, w: 6, h: 5 },
];

export default function DashboardLayoutPanel({
  userId,
  onClose,
}: {
  userId: string;
  onClose: () => void;
}) {
  const [layout, setLayout] = useState<LayoutItem[]>(() => {
    if (typeof window === "undefined") return defaultLayout;
    try {
      return JSON.parse(window.localStorage.getItem(storageKey(userId)) || "") as LayoutItem[];
    } catch {
      return defaultLayout;
    }
  });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const active = useMemo(() => new Set(layout.map((item) => item.i)), [layout]);
  const save = (next: LayoutItem[]) => {
    setLayout(next);
    window.localStorage.setItem(storageKey(userId), JSON.stringify(next));
  };

  return (
    <section className="sw-layout-panel">
      <header>
        <strong>Dashboard Layout</strong>
        <button type="button" onClick={() => save(defaultLayout)}>
          <RotateCcw /> Reset layout
        </button>
        <button type="button" onClick={onClose}>
          <X />
        </button>
      </header>
      <div className="sw-widget-picker">
        {WIDGETS.map((widget) => (
          <button
            type="button"
            key={widget}
            className={active.has(widget) ? "active" : ""}
            onClick={() =>
              active.has(widget)
                ? save(layout.filter((item) => item.i !== widget))
                : save([...layout, { i: widget, x: 0, y: Infinity, w: 4, h: 4 }])
            }
          >
            {widget}
          </button>
        ))}
      </div>
      <ResponsiveGridLayout
        className="sw-layout-grid"
        layouts={{ lg: layout, md: layout, sm: layout }}
        breakpoints={{ lg: 900, md: 640, sm: 0 }}
        cols={{ lg: 12, md: 8, sm: 4 }}
        rowHeight={34}
        width={488}
        onLayoutChange={(next) => save([...next])}
      >
        {layout.map((item) => (
          <div key={item.i} className="sw-layout-widget">
            <div className="sw-widget-title">
              <strong>{item.i}</strong>
              <span>
                <button
                  type="button"
                  onClick={() => setCollapsed((curr) => ({ ...curr, [item.i]: !curr[item.i] }))}
                  aria-label={collapsed[item.i] ? "Expand widget" : "Collapse widget"}
                >
                  {collapsed[item.i] ? <ChevronDown /> : <ChevronUp />}
                </button>
                <button
                  type="button"
                  onClick={() => save(layout.filter((entry) => entry.i !== item.i))}
                  aria-label="Remove widget"
                >
                  <X />
                </button>
              </span>
            </div>
            {!collapsed[item.i] && <p>Widget position preview</p>}
          </div>
        ))}
      </ResponsiveGridLayout>
    </section>
  );
}
