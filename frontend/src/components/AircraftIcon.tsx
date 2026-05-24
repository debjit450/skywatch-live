import type { SVGProps } from "react";
import type { AircraftClass } from "@/lib/aircraft-class";
import {
  markerIconForAircraftClass,
  MARKER_ICON_SVG_CONTENT,
  MARKER_ICON_VIEW_BOX,
  MARKER_ICON_HEADING_OFFSET,
} from "@/components/map/markerIcons";

interface AircraftIconProps extends SVGProps<SVGSVGElement> {
  aircraftClass: AircraftClass;
  heading?: number;
  size?: number | string;
}

export default function AircraftIcon({
  aircraftClass,
  heading,
  size = "1em",
  style,
  ...props
}: AircraftIconProps) {
  const iconName = markerIconForAircraftClass(aircraftClass);
  const rawSvg = MARKER_ICON_SVG_CONTENT[iconName] || MARKER_ICON_SVG_CONTENT.plane;
  const viewBox = MARKER_ICON_VIEW_BOX[iconName] || "0 0 512 512";
  const offset = MARKER_ICON_HEADING_OFFSET[iconName] ?? 0;

  // Since aircraft icons on the map are masked, we should render them with a solid color.
  // We replace all fill/stroke definitions with currentColor so they can be styled dynamically.
  const processedSvg = rawSvg
    .replace(/fill="[^"]*"/g, 'fill="currentColor"')
    .replace(/stroke="[^"]*"/g, 'stroke="currentColor"');

  const rotation = heading !== undefined && heading !== null ? heading - offset : 0;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      width={size}
      height={size}
      style={{
        transform: rotation ? `rotate(${rotation}deg)` : undefined,
        transition: "transform 0.4s ease",
        flexShrink: 0,
        ...style,
      }}
      dangerouslySetInnerHTML={{ __html: processedSvg }}
      {...props}
    />
  );
}
