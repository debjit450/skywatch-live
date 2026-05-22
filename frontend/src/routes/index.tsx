import { createFileRoute } from "@tanstack/react-router";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  BarChart3,
  Crosshair,
  Keyboard,
  LayoutDashboard,
  Loader2,
  Maximize2,
  Plane,
  Radar,
  RefreshCw,
  Route as RouteIcon,
  X,
} from "lucide-react";
import { useFlights } from "@/hooks/useFlights";
import { useAirports } from "@/hooks/useAirports";
import { useEnrichment } from "@/hooks/useEnrichment";
import { useFlightTrack } from "@/hooks/useFlightTrack";
import { useSatellites } from "@/hooks/useSatellites";
import TopBar from "@/components/TopBar";
import GlobalDashboard from "@/components/GlobalDashboard";
import FlightDetailPanel from "@/components/FlightDetailPanel";
import HelicopterIcon from "@/components/HelicopterIcon";
import ErrorBoundary from "@/components/ErrorBoundary";
import type { AnomalousFlight } from "@/lib/anomaly";
import type { Flight } from "@/lib/opensky";
import type { FlightTrackData, FlightTrackPoint } from "@/lib/flightTrack";
import {
  analyzeFlightTrack,
  calculateSegmentDistanceKm,
  detectFlightLayovers,
  sanitizeTrackSegments,
} from "@/lib/flightTrack";
import { predictFlightState } from "@/lib/prediction";
import { COUNTRIES } from "@/lib/countries";
import {
  applyFlightFilters,
  DEFAULT_FLIGHT_FILTERS,
  type FlightFilters,
} from "@/lib/flightFilters";
import { Sentry } from "@/lib/sentry";

const MapView = lazy(() => import("@/components/MapView"));
const AnalyticsPanel = lazy(() => import("@/components/AnalyticsPanel"));
const AlertRulesPanel = lazy(() => import("@/components/AlertRulesPanel"));
const DashboardLayoutPanel = lazy(() => import("@/components/DashboardLayoutPanel"));
type ThemeMode = "dark" | "light";
const THEME_STORAGE_KEY = "skywatch-theme";
const TOUR_STORAGE_KEY = "skywatch_tour_complete";
const SELECTED_TRAIL_MAX_POINTS = 360;
const MIN_TRAIL_DISTANCE_KM = 0.03;
const EMERGENCY_REPEAT_MS = 10 * 60 * 1000;
const EMERGENCY_TOAST_TTL_MS = 45_000;
const EMERGENCY_SQUAWKS = new Set(["7500", "7600", "7700"]);
const SQUAWK_STORAGE_KEY = "skywatch-seen-squawks";

interface EmergencyToast {
  key: string;
  icao24: string;
  callsign: string;
  squawk: string;
  label: string;
  detectedAt: number;
}

function trackPointTimeMs(point: FlightTrackPoint): number {
  const ms = Date.parse(point.time);
  return Number.isFinite(ms) ? ms : 0;
}

function trackDistanceKm(a: FlightTrackPoint, b: FlightTrackPoint): number {
  const toRad = (degrees: number) => (degrees * Math.PI) / 180;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function flightToTrackPoint(flight: Flight): FlightTrackPoint | null {
  if (flight.latitude === null || flight.longitude === null) return null;
  const timestamp = flight.time_position ?? flight.last_contact ?? Date.now() / 1000;
  return {
    lat: flight.latitude,
    lon: flight.longitude,
    alt: flight.baro_altitude ?? flight.geo_altitude ?? null,
    speed: flight.velocity ?? null,
    heading: flight.true_track ?? null,
    time: new Date(timestamp * 1000).toISOString(),
    onGround: flight.on_ground,
  };
}

function mergeDisplayTrack(
  baseTrack: FlightTrackData | null | undefined,
  liveTrail: FlightTrackPoint[],
  icao24: string | null,
): FlightTrackData | null {
  if (!icao24) return baseTrack ?? null;

  const segments = baseTrack?.segments ? [...baseTrack.segments] : [];
  const basePoints = segments
    .flatMap((segment) => segment.points)
    .sort((a, b) => trackPointTimeMs(a) - trackPointTimeMs(b));
  const lastBasePoint = basePoints[basePoints.length - 1];
  const livePoints = lastBasePoint
    ? liveTrail.filter(
        (point) =>
          trackPointTimeMs(point) > trackPointTimeMs(lastBasePoint) + 1_000 &&
          trackDistanceKm(point, lastBasePoint) > MIN_TRAIL_DISTANCE_KM,
      )
    : liveTrail;

  if (livePoints.length > 0) {
    segments.push({
      id: "selected-live-trail",
      source: "live-selected",
      startedAt: livePoints[0].time,
      endedAt: livePoints[livePoints.length - 1].time,
      distanceKm: calculateSegmentDistanceKm(livePoints),
      points: livePoints,
    });
  }

  const cleanSegments = sanitizeTrackSegments(segments);
  const pointCount = cleanSegments.reduce((total, segment) => total + segment.points.length, 0);
  if (pointCount < 2) return baseTrack ?? null;
  const computedDistanceKm = cleanSegments.reduce(
    (total, segment) => total + (segment.distanceKm ?? 0),
    0,
  );
  const totalDistanceKm =
    baseTrack?.totalDistanceKm ?? (computedDistanceKm > 0 ? computedDistanceKm : null);
  const layovers = baseTrack?.layovers?.length
    ? baseTrack.layovers
    : detectFlightLayovers(cleanSegments);

  return {
    icao24,
    source: baseTrack?.source ?? "backend",
    fetchedAt: Date.now(),
    pointCount,
    totalDistanceKm,
    segments: cleanSegments,
    layovers,
    intelligence: analyzeFlightTrack(cleanSegments, totalDistanceKm),
  };
}

function emergencySquawkLabel(squawk: string): string {
  if (squawk === "7500") return "Hijack squawk";
  if (squawk === "7600") return "Radio failure";
  return "General emergency";
}

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "SkyWatch - Live global air surveillance" },
      {
        name: "description",
        content:
          "Real-time global flight awareness with anomaly detection, public ADS-B feeds, and CelesTrak satellite data.",
      },
    ],
  }),
});

function Index() {
  const {
    flights,
    currentAnomalies,
    lastUpdated,
    status,
    isFetching,
    isInitialLoading,
    errorMessage,
    authenticated,
    feedSource,
    sourceCounts,
    staleCount,
    maxAgeSeconds,
    refresh,
    anomalyHistory,
    firstSeenPositions,
  } = useFlights();
  const {
    airports,
    status: airportStatus,
    countryCount: airportCountryCount,
    errorMessage: airportErrorMessage,
    isFallback: airportIsFallback,
  } = useAirports();
  const satelliteCatalog = useSatellites();
  const [mounted, setMounted] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isFlightPanelMinimized, setIsFlightPanelMinimized] = useState(false);
  const [isDashboardCollapsed, setIsDashboardCollapsed] = useState(false);
  const [isFollowingSelected, setIsFollowingSelected] = useState(true);
  const [isSelectedPathVisible, setIsSelectedPathVisible] = useState(true);
  const [focusKey, setFocusKey] = useState(0);
  const [selectedCountry, setSelectedCountry] = useState<string>("India");
  const [flightFilters, setFlightFilters] = useState<FlightFilters>(DEFAULT_FLIGHT_FILTERS);
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [themeReady, setThemeReady] = useState(false);
  const [selectedLiveTrail, setSelectedLiveTrail] = useState<FlightTrackPoint[]>([]);
  const [emergencyToasts, setEmergencyToasts] = useState<EmergencyToast[]>([]);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showAlertRules, setShowAlertRules] = useState(false);
  const [showLayoutPanel, setShowLayoutPanel] = useState(false);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const selectedTrailIdRef = useRef<string | null>(null);
  const seenEmergencyRef = useRef<Map<string, number>>(new Map());

  // Hydrate seenEmergencyRef from localStorage on mount
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SQUAWK_STORAGE_KEY);
      if (raw) {
        const entries = JSON.parse(raw) as [string, number][];
        const now = Date.now();
        const fresh = entries.filter(([, ts]) => now - ts < EMERGENCY_REPEAT_MS);
        seenEmergencyRef.current = new Map(fresh);
        if (fresh.length !== entries.length) {
          window.localStorage.setItem(SQUAWK_STORAGE_KEY, JSON.stringify(fresh));
        }
      }
    } catch {
      /* ignore corrupt storage */
    }
  }, []);

  const resetSelectedTracking = useCallback(() => {
    setIsFollowingSelected(false);
    setIsSelectedPathVisible(false);
  }, []);

  const handleSelect = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setIsFlightPanelMinimized(false);

      if (id) {
        setIsSelectedPathVisible(true);
        setIsFollowingSelected(true);
        setIsPanelOpen(true);
        return;
      }

      resetSelectedTracking();
      setIsPanelOpen(false);
    },
    [resetSelectedTracking],
  );

  const handleSelectCountry = useCallback((country: string) => {
    setSelectedCountry(country);
    setFocusKey((key) => key + 1);
  }, []);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const toggleAnalytics = () => setShowAnalytics((v) => !v);
    const toggleAlertRules = () => setShowAlertRules((v) => !v);
    const toggleLayout = () => setShowLayoutPanel((v) => !v);
    const toggleShortcuts = () => setShowShortcutHelp((v) => !v);

    window.addEventListener("skywatch:toggle-analytics", toggleAnalytics);
    window.addEventListener("skywatch:toggle-alert-rules", toggleAlertRules);
    window.addEventListener("skywatch:toggle-layout", toggleLayout);
    window.addEventListener("skywatch:toggle-shortcuts", toggleShortcuts);

    return () => {
      window.removeEventListener("skywatch:toggle-analytics", toggleAnalytics);
      window.removeEventListener("skywatch:toggle-alert-rules", toggleAlertRules);
      window.removeEventListener("skywatch:toggle-layout", toggleLayout);
      window.removeEventListener("skywatch:toggle-shortcuts", toggleShortcuts);
    };
  }, []);

  useEffect(() => {
    if (window.localStorage.getItem(TOUR_STORAGE_KEY) !== "true") {
      setTourStep(0);
    }
  }, []);

  useEffect(() => {
    if (authenticated !== null) {
      Sentry.setUser({ id: authenticated ? "authenticated" : "anonymous" });
    }
  }, [authenticated]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;
      if (typing && event.key !== "Escape") return;

      if (event.key === "?") {
        event.preventDefault();
        setShowShortcutHelp(true);
      } else if (event.key.toLowerCase() === "f") {
        document.querySelector<HTMLInputElement>('input[aria-label="Target search"]')?.focus();
      } else if (event.key.toLowerCase() === "a") {
        setIsDashboardCollapsed(false);
        window.dispatchEvent(new CustomEvent("skywatch:open-anomalies"));
      } else if (event.key.toLowerCase() === "m") {
        window.dispatchEvent(new CustomEvent("skywatch:toggle-map-layers"));
      } else if (event.key === "Escape") {
        setShowShortcutHelp(false);
        setShowAnalytics(false);
        setShowAlertRules(false);
        setShowLayoutPanel(false);
        setTourStep(null);
        setIsPanelOpen(false);
        setIsFlightPanelMinimized(false);
        resetSelectedTracking();
      } else if (["1", "2", "3", "4", "5"].includes(event.key)) {
        const zooms = [2, 4, 6, 8, 10];
        window.dispatchEvent(
          new CustomEvent("skywatch:set-map-zoom", { detail: zooms[Number(event.key) - 1] }),
        );
      } else if (event.key.toLowerCase() === "r") {
        void refresh();
      } else if (event.key.toLowerCase() === "p") {
        window.dispatchEvent(new CustomEvent("skywatch:toggle-predictions"));
      } else if (event.key.toLowerCase() === "w") {
        window.dispatchEvent(new CustomEvent("skywatch:toggle-weather"));
      } else if (event.key.toLowerCase() === "s") {
        window.dispatchEvent(new CustomEvent("skywatch:toggle-satellites"));
      } else if (event.key.toLowerCase() === "t") {
        window.dispatchEvent(new CustomEvent("skywatch:toggle-tfr"));
      } else if (event.key.toLowerCase() === "c") {
        setShowAnalytics((value) => !value);
      } else if (event.key.toLowerCase() === "u") {
        setShowAlertRules((value) => !value);
      } else if (event.key.toLowerCase() === "l") {
        setShowLayoutPanel((value) => !value);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [refresh, resetSelectedTracking]);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null;
    const nextTheme: ThemeMode = stored === "light" || stored === "dark" ? stored : "dark";
    setTheme(nextTheme);
    setThemeReady(true);
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.classList.toggle("dark", nextTheme === "dark");
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme, themeReady]);

  const currentAnomalousMap = useMemo(() => {
    const map = new Map<string, AnomalousFlight>();
    for (const flight of currentAnomalies) map.set(flight.icao24, flight);
    return map;
  }, [currentAnomalies]);

  const flightFilterResult = useMemo(
    () => applyFlightFilters(flights, currentAnomalousMap, flightFilters),
    [currentAnomalousMap, flightFilters, flights],
  );

  const visibleFlights = flightFilterResult.flights;

  const visibleFlightIds = useMemo(() => {
    const ids = new Set<string>();
    for (const flight of visibleFlights) ids.add(flight.icao24);
    return ids;
  }, [visibleFlights]);

  const visibleAnomalies = useMemo(
    () => currentAnomalies.filter((flight) => visibleFlightIds.has(flight.icao24)),
    [currentAnomalies, visibleFlightIds],
  );

  const selectedFlight = useMemo(
    () => visibleFlights.find((flight) => flight.icao24 === selectedId) || null,
    [selectedId, visibleFlights],
  );

  const firstSeen = selectedId ? firstSeenPositions.get(selectedId) : undefined;

  const enrichment = useEnrichment(
    selectedId,
    flights.find((f) => f.icao24 === selectedId)?.callsign?.trim() || null,
    selectedFlight ? currentAnomalousMap.has(selectedFlight.icao24) : false,
    firstSeen?.lat ?? selectedFlight?.latitude ?? null,
    firstSeen?.lon ?? selectedFlight?.longitude ?? null,
  );
  const flightTrack = useFlightTrack(selectedId, Boolean(selectedId));
  const displayFlightTrack = useMemo(
    () => mergeDisplayTrack(flightTrack.data, selectedLiveTrail, selectedId),
    [flightTrack.data, selectedId, selectedLiveTrail],
  );
  const selectedTrackSourceLabel = displayFlightTrack
    ? flightTrack.data?.source === "opensky"
      ? "OpenSky"
      : selectedLiveTrail.length > 1 && !flightTrack.data
        ? "live log"
        : "local log"
    : null;

  useEffect(() => {
    if (!selectedFlight) {
      selectedTrailIdRef.current = null;
      setSelectedLiveTrail([]);
      return;
    }

    const point = flightToTrackPoint(selectedFlight);
    if (!point) return;

    setSelectedLiveTrail((current) => {
      if (selectedTrailIdRef.current !== selectedFlight.icao24) {
        selectedTrailIdRef.current = selectedFlight.icao24;
        return [point];
      }

      const last = current[current.length - 1];
      if (last) {
        const newer = trackPointTimeMs(point) > trackPointTimeMs(last);
        const movedEnough = trackDistanceKm(last, point) >= MIN_TRAIL_DISTANCE_KM;
        if (!newer || !movedEnough) return current;
      }

      return [...current, point].slice(-SELECTED_TRAIL_MAX_POINTS);
    });
  }, [
    selectedFlight?.baro_altitude,
    selectedFlight?.geo_altitude,
    selectedFlight?.icao24,
    selectedFlight?.last_contact,
    selectedFlight?.latitude,
    selectedFlight?.longitude,
    selectedFlight?.on_ground,
    selectedFlight?.time_position,
    selectedFlight?.true_track,
    selectedFlight?.velocity,
    selectedFlight,
  ]);

  useEffect(() => {
    const now = Date.now();
    const incoming: EmergencyToast[] = [];

    for (const flight of flights) {
      const squawk = flight.squawk;
      if (!squawk || !EMERGENCY_SQUAWKS.has(squawk)) continue;

      const key = `${flight.icao24}:${squawk}`;
      const seenAt = seenEmergencyRef.current.get(key);
      if (seenAt && now - seenAt < EMERGENCY_REPEAT_MS) continue;

      seenEmergencyRef.current.set(key, now);
      incoming.push({
        key,
        icao24: flight.icao24,
        callsign: flight.callsign?.trim() || flight.icao24.toUpperCase(),
        squawk,
        label: emergencySquawkLabel(squawk),
        detectedAt: now,
      });
    }

    if (incoming.length > 0) {
      // Persist to localStorage so refreshes don't re-trigger
      try {
        const entries = Array.from(seenEmergencyRef.current.entries());
        window.localStorage.setItem(SQUAWK_STORAGE_KEY, JSON.stringify(entries));
      } catch {
        /* quota or private browsing */
      }

      setEmergencyToasts((current) =>
        [
          ...incoming,
          ...current.filter((toast) => !incoming.some((item) => item.key === toast.key)),
        ].slice(0, 4),
      );
    }
  }, [flights, lastUpdated]);

  useEffect(() => {
    const id = window.setInterval(() => {
      setEmergencyToasts((current) =>
        current.filter((toast) => Date.now() - toast.detectedAt < EMERGENCY_TOAST_TTL_MS),
      );
    }, 1_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    const exists = flights.some((flight) => flight.icao24 === selectedId);
    const isVisible = visibleFlightIds.has(selectedId);
    if (!exists || !isVisible) {
      setSelectedId(null);
      setIsPanelOpen(false);
      setIsFlightPanelMinimized(false);
      resetSelectedTracking();
    }
  }, [flights, resetSelectedTracking, selectedId, visibleFlightIds]);

  const focus = useMemo(() => {
    if (selectedFlight) {
      const predicted = predictFlightState(selectedFlight);
      return predicted.latitude !== null && predicted.longitude !== null
        ? {
            lat: predicted.latitude,
            lng: predicted.longitude,
            id: `${selectedFlight.icao24}-${isFollowingSelected ? (lastUpdated ?? focusKey) : focusKey}`,
          }
        : null;
    }

    if (flightFilters.aircraftClass === "helicopter") {
      const helicopter = visibleFlights.find((flight) => flight.category === 8);
      if (helicopter) {
        const predicted = predictFlightState(helicopter);
        return predicted.latitude !== null && predicted.longitude !== null
          ? {
              lat: predicted.latitude,
              lng: predicted.longitude,
              id: `helicopter-${helicopter.icao24}-${visibleFlights.length}-${focusKey}`,
            }
          : null;
      }
    }

    const country = COUNTRIES.find((c) => c.name === selectedCountry);
    return country
      ? {
          lat: country.lat,
          lng: country.lng,
          id: `country-${country.code}-${focusKey}`,
        }
      : null;
  }, [
    flightFilters.aircraftClass,
    focusKey,
    isFollowingSelected,
    lastUpdated,
    selectedCountry,
    selectedFlight,
    visibleFlights,
  ]);

  const inAir = useMemo(() => flights.filter((flight) => !flight.on_ground).length, [flights]);
  const flightPanelStyle = useMemo(
    () => ({
      left: "24px",
      right: "auto",
      bottom: "24px",
      zIndex: 1300,
    }),
    [],
  );
  const flightPanelDockStyle = useMemo(
    () => ({
      left: "24px",
      right: "auto",
      bottom: "24px",
      zIndex: 1210,
    }),
    [],
  );
  const trackingPanelStyle = useMemo(
    () => ({
      right: isDashboardCollapsed ? "96px" : "412px",
      left: "auto",
      bottom: "24px",
      zIndex: 1200,
      transition: "all 0.3s ease",
    }),
    [isDashboardCollapsed],
  );
  const closeFlightPanel = useCallback(() => {
    setIsPanelOpen(false);
    setIsFlightPanelMinimized(false);
    resetSelectedTracking();
  }, [resetSelectedTracking]);
  const minimizeFlightPanel = useCallback(() => setIsFlightPanelMinimized(true), []);
  const restoreFlightPanel = useCallback(() => setIsFlightPanelMinimized(false), []);
  const toggleFollowSelected = useCallback(() => setIsFollowingSelected((value) => !value), []);
  const toggleSelectedPath = useCallback(() => setIsSelectedPathVisible((value) => !value), []);

  return (
    <div
      className={`sw-app-shell theme-${theme} ${isDashboardCollapsed ? "sidebar-collapsed" : ""}`}
    >
      <TopBar
        flights={flights}
        flightCount={flights.length}
        inAir={inAir}
        anomalyCount={currentAnomalousMap.size}
        lastUpdated={lastUpdated}
        status={status}
        isFetching={isFetching}
        airportCount={airports.length}
        airportCountryCount={airportCountryCount}
        airportStatus={airportStatus}
        airportIsFallback={airportIsFallback}
        satelliteCount={satelliteCatalog.satellites.length}
        satelliteStatus={satelliteCatalog.status}
        feedSource={feedSource}
        sourceCounts={sourceCounts}
        staleCount={staleCount}
        maxAgeSeconds={maxAgeSeconds}
        filteredFlightCount={flightFilterResult.matched}
        activeFilterCount={flightFilterResult.activeFilterCount}
        selectedCountry={selectedCountry}
        onSelectCountry={handleSelectCountry}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        isDashboardCollapsed={isDashboardCollapsed}
      />

      <main className="sw-map-stage">
        {mounted ? (
          <Suspense fallback={<MapFallback />}>
            <ErrorBoundary label="Map">
              <MapView
                flights={visibleFlights}
                anomalyMap={currentAnomalousMap}
                selectedId={selectedId}
                onSelect={handleSelect}
                focus={focus}
                airports={airports}
                enrichmentRoute={enrichment.data?.route ?? null}
                selectedFlight={selectedFlight}
                selectedFlightTrack={displayFlightTrack}
                isolateSelected={Boolean(selectedFlight && isFollowingSelected)}
                selectedPathVisible={isSelectedPathVisible}
                satellites={satelliteCatalog.satellites}
                theme={theme}
                isPanelOpen={isPanelOpen && !isFlightPanelMinimized}
              />
            </ErrorBoundary>
          </Suspense>
        ) : (
          <MapFallback />
        )}

        {isInitialLoading && flights.length === 0 && (
          <LoadingOverlay label="Loading flight feed" source="Connecting to OpenSky Network" />
        )}
        {isFetching && flights.length > 0 && <RefreshPill />}
        {errorMessage && flights.length === 0 && (
          <FeedErrorNotice
            title="Flight feed unavailable"
            message={errorMessage}
            onRetry={refresh}
          />
        )}
        {errorMessage && flights.length > 0 && (
          <div className="sw-feed-warning">
            <AlertTriangle />
            <span>{errorMessage}</span>
          </div>
        )}
        {airportStatus === "error" && (
          <div className="sw-airport-warning">
            <AlertTriangle />
            <span>
              Airport source unavailable. Showing fallback airports. {airportErrorMessage}
            </span>
          </div>
        )}
        <EmergencyAlertStack
          alerts={emergencyToasts}
          onSelect={handleSelect}
          onDismiss={(key) =>
            setEmergencyToasts((current) => current.filter((toast) => toast.key !== key))
          }
        />

        {selectedFlight && isPanelOpen && !isFlightPanelMinimized ? (
          <FlightDetailPanel
            flight={selectedFlight}
            anomaly={currentAnomalousMap.get(selectedFlight.icao24)}
            anomalyHistory={anomalyHistory[selectedFlight.icao24]}
            onClose={closeFlightPanel}
            onMinimize={minimizeFlightPanel}
            enrichment={enrichment.data}
            enrichmentLoading={enrichment.loading}
            flightTrack={displayFlightTrack}
            flightTrackLoading={flightTrack.loading}
            style={flightPanelStyle}
          />
        ) : selectedFlight && isPanelOpen && isFlightPanelMinimized ? (
          <FlightDetailRestoreDock
            callsign={selectedFlight.callsign?.trim() || "UNKNOWN"}
            icao24={selectedFlight.icao24}
            onOpen={restoreFlightPanel}
            onClose={closeFlightPanel}
            style={flightPanelDockStyle}
          />
        ) : (
          <></>
        )}

        {selectedFlight && (
          <TrackingPanel
            callsign={selectedFlight.callsign?.trim() || selectedFlight.icao24.toUpperCase()}
            isFollowing={isFollowingSelected}
            pathVisible={isSelectedPathVisible}
            pointCount={displayFlightTrack?.pointCount ?? 0}
            sourceLabel={selectedTrackSourceLabel}
            isLoading={flightTrack.loading}
            onToggleFollow={toggleFollowSelected}
            onTogglePath={toggleSelectedPath}
            style={trackingPanelStyle}
          />
        )}
        <Suspense fallback={null}>
          {showAnalytics && (
            <AnalyticsPanel
              flights={flights}
              anomalies={currentAnomalies}
              onClose={() => setShowAnalytics(false)}
            />
          )}
          {showAlertRules && <AlertRulesPanel onClose={() => setShowAlertRules(false)} />}
          {showLayoutPanel && (
            <DashboardLayoutPanel
              userId={authenticated ? "authenticated" : "anonymous"}
              onClose={() => setShowLayoutPanel(false)}
            />
          )}
        </Suspense>
        {showShortcutHelp && (
          <ShortcutHelp
            onClose={() => setShowShortcutHelp(false)}
            onRestartTour={() => {
              window.localStorage.removeItem(TOUR_STORAGE_KEY);
              setTourStep(0);
              setShowShortcutHelp(false);
            }}
          />
        )}
        {tourStep !== null && (
          <OnboardingTour
            step={tourStep}
            onNext={() => {
              if (tourStep >= 4) {
                window.localStorage.setItem(TOUR_STORAGE_KEY, "true");
                setTourStep(null);
              } else {
                setTourStep(tourStep + 1);
              }
            }}
            onSkip={() => {
              window.localStorage.setItem(TOUR_STORAGE_KEY, "true");
              setTourStep(null);
            }}
          />
        )}
      </main>

      <ErrorBoundary label="Global dashboard">
        <GlobalDashboard
          flights={visibleFlights}
          allFlights={flights}
          anomalies={currentAnomalies}
          totalFlights={flightFilterResult.total}
          filters={flightFilters}
          satellites={satelliteCatalog.satellites}
          satelliteGroups={satelliteCatalog.groups}
          satelliteStatus={satelliteCatalog.status}
          satelliteErrorMessage={satelliteCatalog.errorMessage}
          activeFilterLabels={flightFilterResult.activeFilterLabels}
          activeFilterCount={flightFilterResult.activeFilterCount}
          selectedId={selectedId}
          status={status}
          isLoading={isInitialLoading}
          onSelect={handleSelect}
          onFiltersChange={setFlightFilters}
          onClearFilters={() => setFlightFilters({ ...DEFAULT_FLIGHT_FILTERS })}
          isCollapsed={isDashboardCollapsed}
          onToggleCollapse={() => setIsDashboardCollapsed((v) => !v)}
        />
      </ErrorBoundary>
    </div>
  );
}

function EmergencyAlertStack({
  alerts,
  onSelect,
  onDismiss,
}: {
  alerts: EmergencyToast[];
  onSelect: (id: string) => void;
  onDismiss: (key: string) => void;
}) {
  if (alerts.length === 0) return null;

  return (
    <div className="sw-emergency-stack" role="status" aria-live="assertive">
      {alerts.map((alert) => (
        <div className="sw-emergency-toast" key={alert.key}>
          <button
            type="button"
            className="sw-emergency-toast-main"
            onClick={() => onSelect(alert.icao24)}
          >
            <span className="sw-emergency-toast-icon">
              <AlertTriangle />
            </span>
            <span className="sw-emergency-toast-copy">
              <strong>{alert.label}</strong>
              <small>
                {alert.callsign} / SQ {alert.squawk}
              </small>
            </span>
          </button>
          <button
            type="button"
            className="sw-emergency-toast-close"
            onClick={() => onDismiss(alert.key)}
            aria-label={`Dismiss emergency alert for ${alert.callsign}`}
          >
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}

function ShortcutHelp({
  onClose,
  onRestartTour,
}: {
  onClose: () => void;
  onRestartTour: () => void;
}) {
  const shortcuts = [
    ["F", "Focus flight search"],
    ["A", "Open anomaly feed"],
    ["Esc", "Close panels"],
    ["1-5", "Jump map zoom"],
    ["R", "Refresh data"],
    ["P", "Toggle predictions"],
    ["W", "Toggle weather"],
    ["S", "Toggle satellites"],
    ["T", "Toggle TFR"],
    ["C", "Traffic analytics"],
    ["U", "Alert rules"],
    ["L", "Dashboard layout"],
  ];
  return (
    <div className="sw-modal-backdrop" role="dialog" aria-modal="true">
      <section className="sw-shortcut-modal">
        <header>
          <strong>Keyboard Shortcuts</strong>
          <button type="button" onClick={onClose}>
            <X />
          </button>
        </header>
        <dl>
          {shortcuts.map(([key, label]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
        <button type="button" onClick={onRestartTour}>
          Restart tour
        </button>
      </section>
    </div>
  );
}

function OnboardingTour({
  step,
  onNext,
  onSkip,
}: {
  step: number;
  onNext: () => void;
  onSkip: () => void;
}) {
  const steps = [
    ["Map overview", "Track live aircraft, selected routes, predictions, and weather."],
    ["Flight search", "Use the dashboard search and filters to narrow the live feed."],
    ["Anomaly feed", "Open the anomaly tab to review live detector and custom-rule alerts."],
    ["Alert rules", "Create threshold rules or geofences from the alert rules panel."],
    ["Shortcuts", "Press ? any time to review keyboard shortcuts."],
  ];
  const current = steps[step] ?? steps[0];
  return (
    <div className="sw-tour-card">
      <strong>{current[0]}</strong>
      <p>{current[1]}</p>
      <div>
        <button type="button" onClick={onSkip}>
          Skip tour
        </button>
        <button type="button" onClick={onNext}>
          {step >= steps.length - 1 ? "Done" : "Next"}
        </button>
      </div>
    </div>
  );
}

function FlightDetailRestoreDock({
  callsign,
  icao24,
  onOpen,
  onClose,
  style,
}: {
  callsign: string;
  icao24: string;
  onOpen: () => void;
  onClose: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <div className="sw-flight-dock" style={style}>
      <button
        type="button"
        className="sw-flight-dock-open"
        onClick={onOpen}
        aria-label={`Open flight details for ${callsign}`}
      >
        <Maximize2 />
        <span>
          <strong>{callsign}</strong>
          <small>{icao24.toUpperCase()} / Flight details minimized</small>
        </span>
        <em>Open</em>
      </button>
      <button
        type="button"
        className="sw-flight-dock-close"
        onClick={onClose}
        aria-label="Close flight details"
      >
        <X />
      </button>
    </div>
  );
}

function TrackingPanel({
  callsign,
  isFollowing,
  pathVisible,
  pointCount,
  sourceLabel,
  isLoading,
  followToggleEnabled = true,
  onToggleFollow,
  onTogglePath,
  style,
}: {
  callsign: string;
  isFollowing: boolean;
  pathVisible: boolean;
  pointCount: number;
  sourceLabel: string | null;
  isLoading: boolean;
  followToggleEnabled?: boolean;
  onToggleFollow: () => void;
  onTogglePath: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <div className="sw-tracking-panel" style={style}>
      <div className="sw-tracking-copy">
        <Crosshair />
        <span>
          <strong>{callsign}</strong>
          <small>
            {isLoading
              ? "Loading track"
              : pointCount > 1
                ? `${pointCount.toLocaleString()} log points / ${sourceLabel ?? "local"}`
                : "No path log yet"}
          </small>
        </span>
      </div>
      <div className="sw-tracking-actions">
        <button
          type="button"
          className={isFollowing ? "active" : ""}
          onClick={onToggleFollow}
          disabled={!followToggleEnabled}
          title={
            followToggleEnabled
              ? isFollowing
                ? "Show all map traffic"
                : "Isolate and follow target"
              : "Selected target is in focus"
          }
        >
          <Crosshair />
          <span>{followToggleEnabled ? (isFollowing ? "Following" : "Follow") : "Tracking"}</span>
        </button>
        <button
          type="button"
          className={pathVisible ? "active" : ""}
          onClick={onTogglePath}
          title={pathVisible ? "Hide selected path" : "Show selected path"}
        >
          <RouteIcon />
          <span>Path</span>
        </button>
      </div>
    </div>
  );
}

function LegendDot({
  color,
  label,
  className,
  icon,
}: {
  color: string;
  label: string;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <span className={className}>
      {icon ? (
        <i className="sw-legend-icon" style={{ color }}>
          {icon}
        </i>
      ) : (
        <i style={{ backgroundColor: color }} />
      )}
      {label}
    </span>
  );
}

function MapFallback() {
  return (
    <div className="sw-map-fallback">
      <Radar />
      <span>Preparing map</span>
    </div>
  );
}

function LoadingOverlay({ label, source }: { label: string; source: string }) {
  return (
    <div className="sw-loading-overlay">
      <div className="sw-loading-card">
        <Loader2 />
        <div>
          <strong>{label}</strong>
          <span>{source}</span>
        </div>
        <div className="sw-loading-bar">
          <span />
        </div>
      </div>
    </div>
  );
}

function RefreshPill() {
  return (
    <div className="sw-refresh-pill">
      <RefreshCw />
      <span>Refreshing</span>
    </div>
  );
}

function FeedErrorNotice({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="sw-error-card">
      <AlertTriangle />
      <div>
        <strong>{title}</strong>
        <span>{message}</span>
      </div>
      <button onClick={onRetry}>Retry</button>
    </div>
  );
}
