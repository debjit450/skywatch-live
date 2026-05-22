import type { AircraftClass } from "@/lib/aircraft-class";

export type SkywatchMarkerIconName =
  | "plane"
  | "cargoPlane"
  | "businessJet"
  | "fighterJet"
  | "jet"
  | "helicopter"
  | "glider"
  | "uav"
  | "balloon"
  | "vehicle"
  | "airport"
  | "helipad"
  | "satellite";

export interface SkywatchDeckIcon {
  id: string;
  url: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
  mask: boolean;
}

const PLANE_SVG =
  '<path d="M250.376 379.789c-1.926 1.217-90.859 83.056-90.859 83.056v22.209l90.859-24.339v-80.926zM261.613 379.789c1.926 1.217 90.859 83.056 90.859 83.056v22.209l-90.859-24.339v-80.926z" fill="#f2f1e7"/><path d="M291.965 266.212c-1.05 42.549-3.429 85.238-8.118 117.64-.7 4.899-1.469 9.517-2.24 13.926v.07c-5.528 32.892-11.757 52.557-17.076 63.613-3.359 7.138-6.368 10.637-8.538 11.827-2.169-1.19-5.179-4.689-8.538-11.827-5.318-11.057-11.547-30.722-17.076-63.613v-.07c-.77-4.409-1.539-9.028-2.239-13.926-4.689-32.402-7.068-75.091-8.118-117.64-1.4-53.816-.7-107.353-.28-139.474.14-6.998.21-12.947.21-17.706.07-2.659.07-4.969.07-6.788 0-20.365 1.82-38.21 4.969-53.047C231.641 17.915 243.888 0 255.995 0c7.348 0 14.696 6.578 20.855 18.615 7.138 14.066 12.597 35.621 14.416 63.194.49 6.439.7 13.297.7 20.435 0 5.179.14 13.576.28 24.494.419 32.121 1.119 85.658-.281 139.474z" fill="#fefffe"/><path d="M173.555 151.861v29.882c0 .56 0 1.049-.14 1.609-.77 6.438-6.299 11.477-12.947 11.477h-1.68c-5.249-.07-9.658-3.289-11.687-7.768-.56-1.33-.91-2.729-.98-4.199-.14-.35-.14-.77-.14-1.12V151.93c0-.42.07-.84.14-1.26.56-3.289 3.359-5.739 6.788-5.739h13.716c3.851.002 6.93 3.151 6.93 6.93zM100.133 247.072h-1.447c-7.195 0-13.082-5.887-13.082-13.082v-29.863c0-3.822 3.127-6.95 6.95-6.95h13.727c3.813 0 6.934 3.12 6.934 6.934v29.879c0 7.195-5.887 13.082-13.082 13.082z" fill="#dbd8bf"/><path d="M226.462 121.139v142.834l-6.438 2.24L9.798 338.784 0 342.213v-32.822s39.96-33.171 86.218-71.662c8.818-7.418 17.915-14.906 27.013-22.534 1.05-.84 2.099-1.68 3.149-2.589 10.357-8.608 20.785-17.285 30.722-25.543 9.238-7.698 18.125-15.046 26.453-21.974 20.575-17.076 37.371-31.072 46.189-38.35 4.199-3.5 6.578-5.46 6.718-5.6z" fill="#fefffe"/><path d="M15.4 310.159c57.788-55.188 150.646-116.068 195.631-158.934v56.132L15.4 312.115v-1.956z" fill="#ededec"/><path d="M351.498 194.851h1.447c7.195 0 13.082-5.887 13.082-13.082v-29.863c0-3.822-3.127-6.95-6.95-6.95H345.35c-3.813 0-6.934 3.12-6.934 6.933v29.879c-.001 7.196 5.886 13.083 13.082 13.083zM411.856 247.072h1.447c7.195 0 13.082-5.887 13.082-13.082v-29.863c0-3.822-3.128-6.95-6.95-6.95h-13.728c-3.813 0-6.934 3.12-6.934 6.934v29.879c.001 7.195 5.888 13.082 13.083 13.082z" fill="#dbd8bf"/><path d="M285.548 121.124C287.099 122.341 512 309.358 512 309.358v32.857l-226.452-78.209V121.124z" fill="#fefffe"/><path d="M496.589 310.159c-57.788-55.188-150.646-116.068-195.631-158.934v56.132l195.631 104.758v-1.956z" fill="#ededec"/><path d="m276.534 44.888-12.456-8.015h-16.166l-12.457 8.015 2.379-13.816 12.737-6.281h10.917l12.667 6.281z" fill="#697581"/><path d="M283.847 383.852c4.688-32.399 7.068-75.084 8.118-117.629L512 342.215v-32.857s-39.915-33.192-86.212-71.684c.35-1.177.597-2.398.597-3.684v-29.862c0-3.823-3.128-6.95-6.95-6.95h-13.727c-3.814 0-6.934 3.12-6.934 6.933v11.104l-33.886-28.171a12.917 12.917 0 0 0 1.138-5.274v-29.862c0-3.822-3.128-6.95-6.95-6.95h-13.727c-3.813 0-6.934 3.12-6.934 6.933v13.148a120853.018 120853.018 0 0 0-46.171-38.364c-.14-10.883-.279-19.261-.279-24.429 0-7.138-.21-13.996-.7-20.435-1.82-27.573-7.278-49.127-14.416-63.194C270.692 6.581 263.346.003 256 0v473.285c2.165-1.19 5.168-4.683 8.517-11.792l87.956 23.561v-22.209s-44.104-40.586-70.864-65.018v-.049c.769-4.409 1.539-9.028 2.238-13.926z" opacity=".06" fill="#040000"/>';

const CARGO_PLANE_SVG = PLANE_SVG.replaceAll("#f2f1e7", "#fed7aa")
  .replaceAll("#fefffe", "#f59e0b")
  .replaceAll("#dbd8bf", "#fbbf24")
  .replaceAll("#ededec", "#f97316")
  .replaceAll("#697581", "#475569")
  .replaceAll("#040000", "#431407");

const BUSINESS_JET_SVG =
  '<g fill="#acb8bf"><path d="m7.212 12.752 8.132-8.132 1.98 1.98-8.132 8.132zM21.421 14.797l8.133-8.13 1.98 1.98-8.133 8.13zM49.31 54.854l8.134-8.13 1.98 1.981-8.134 8.13zM47.279 40.557l8.134-8.13 1.98 1.981-8.135 8.13z"/></g><path fill="#42ade2" d="m56.4 60.7-4.7-42.1-6.3-6.3L3.3 7.6c-2-.2-1.6 4.8.7 5.9l31.7 14.8L50.5 60c1.1 2.3 6.1 2.7 5.9.7"/><path fill="#dae3ea" d="M61.3 8.1c2.2-4.3-1.1-7.6-5.4-5.4-5.5 2.8-13.6 9.1-21.8 17.2-12.8 12.8-21 25.5-18.3 28.3 2.7 2.7 15.5-5.5 28.3-18.3 8.1-8.1 14.4-16.3 17.2-21.8"/><path fill="#42ade2" d="m22.4 60.2-1.6-14.8-2.2-2.2-14.8-1.6c-.7-.1-.6 1.7.2 2.1l11.1 5.2L20.3 60c.4.8 2.2.9 2.1.2"/><path fill="#acb8bf" d="M20.2 46.2c-4.5 4.5-8.6 7.6-9.2 6.9-.6-.6 2.5-4.8 6.9-9.3 4.5-4.5 8.6-7.6 9.3-6.9.5.6-2.6 4.8-7 9.3"/><path fill="#3e4347" d="M59.8 9.7c.5-1.8.3-3.5-.8-4.7-1.1-1.1-2.9-1.4-4.6-.8L51 6.3c1.7-.6 4.2.3 5.3 1.4 1.2 1.2 2 3.6 1.4 5.3l2.1-3.3"/><path fill="#dae3ea" d="m53.664 9.695 5.654-5.659.637.636-5.655 5.66z"/>';

const FIGHTER_JET_SVG =
  '<path d="M195.999 184.538H138.391l15.299 5.251 22.229 49.034c19.111.107 41.09 21.312 62.893 19.721 10.39-.758 20.176-23.816 30.644-24.822l-73.457-49.184z" fill="#999"/><path d="M504.224 258.769c-12.243-6.166-26.111-12.22-38.511-15.315h-.011s-19.888-5.392-41.527-5.09c-22.008.307-46.008 6.139-74.444-14.104v-.011c-24.161 3.307-52.044 6.76-80.274 9.474-32.435 3.117-65.318 5.258-93.537 5.101-12.377-.067-23.858-.583-34.016-1.648l-75.262-76.832H1.664l30.374 10.424 19.704 67.977V256l41.942 21.952c21.672 2.96 50.62 6.536 84.108 9.743l2.085.953 100.914 6.234c71.787 3.027 150.245 1.827 219.262-9.462 13.555-2.221 16.436-20.462 4.171-26.651z" fill="#ccc"/><path d="m445.633 228.678 20.069 14.777s-59.578 20.954-115.971-19.194v-.011a2499.873 2499.873 0 0 0 48.534-7.13 63.313 63.313 0 0 1 47.368 11.558z" fill="#f2f2f2"/><path d="m93.683 277.952-62.325 27.446H0l30.204-28.836L51.741 256l84.68 3.139z" fill="#999"/><path d="m191.301 263.456-11.424 25.192-25.773 56.845-17.956 6.163h59.851l84.781-56.775h.011l46.931-31.425zM72.316 198.101l4.732 9.588 10.581 1.537-7.657 7.463 1.808 10.538-9.464-4.976-9.463 4.976 1.807-10.538-7.655-7.463 10.58-1.537z" fill="#b3b3b3"/>';

const HELICOPTER_SVG =
  '<path d="M60.64 28.1a1.24 1.24 0 0 0-1.27-1.22l-14.89-.33c.61-.91 1.51-2.05 2.78-3.57 6.16-7.36 4.19-9.8 4.19-9.8s-2.28-2-9.91 3.84c-1.31 1-2.34 1.76-3.19 2.31l.3-14.09a1.19 1.19 0 1 0-2.38 0l-.34 15.33c-2 .44-3-1.25-7.33-3.31 0 0-2.34.91-2.86 2.77a39.41 39.41 0 0 1 3.39 6.24l-14.5-.31a1.2 1.2 0 1 0-.05 2.39l14.6.31a1.28 1.28 0 0 0 .35.59l-9.69 12.36-4.57-3.24.54-1.25S12 39.7 11.5 41.34l-.14 2 1.37-.48.41-1.31L16 45.91s-.79.9-.24 1.47 1.55-.1 1.55-.1l4.35 3.1-1.32.35-.54 1.35h2c1.65-.39 4.4-4.13 4.4-4.13l-1.28.49-3-4.71 12.81-9.15a1.31 1.31 0 0 0 1 .45l-.32 15a1.19 1.19 0 1 0 2.38 0l.21-14.8a42.17 42.17 0 0 1 5.67 3.47c1.88-.44 2.87-2.75 2.87-2.75-1.71-4.1-3.24-5.34-3.09-7l15.87.34a1.25 1.25 0 0 0 1.32-1.19Z"/>';

const AIRPORT_SVG =
  '<path d="M2.6 17h19v2h-19v-2zM20.7 5h-2.5L7.1 10.8l-4-2.1-1 .8L4.7 13l-.7.5.3.7 6.8-2.2-1.3 2.2h1.8l4.1-4.5 6.1-3.6S22.3 5 20.7 5z" fill="#404040"/>';

const HELIPAD_SVG =
  '<g fill="#434343" fill-rule="evenodd"><path d="M8 .055c-4.418 0-8 3.566-8 7.968 0 4.4 3.582 7.968 8 7.968s8-3.567 8-7.968C16 3.621 12.418.055 8 .055Zm.004 15.057c-3.934 0-7.121-3.181-7.121-7.105C.883 4.083 4.071.902 8.004.902c3.933 0 7.121 3.181 7.121 7.105 0 3.924-3.187 7.105-7.121 7.105Z"/><path d="M8.018 2.08c-3.264 0-5.91 2.654-5.91 5.927 0 3.273 2.646 5.927 5.91 5.927 3.264 0 5.911-2.654 5.911-5.927 0-3.273-2.648-5.927-5.911-5.927Zm2.059 8.039h-1.14V9.062H7.062v1.057H5.944V5.961h1.118v1.914h1.875V5.961h1.14v4.158Z"/></g>';

export const MARKER_ICON_SVG_CONTENT: Record<SkywatchMarkerIconName, string> = {
  plane: PLANE_SVG,
  cargoPlane: CARGO_PLANE_SVG,
  businessJet: BUSINESS_JET_SVG,
  fighterJet: FIGHTER_JET_SVG,
  jet: FIGHTER_JET_SVG,
  helicopter: HELICOPTER_SVG,
  glider: '<path fill="black" d="M5 29h54v6H36v20h-8V35H5zM29 8h6v21h-6zM20 52h24v5H20z"/>',
  uav: '<g fill="black"><path d="M20 18l12 10 12-10 4 4-11 10 11 10-4 4-12-10-12 10-4-4 11-10-11-10z"/><rect x="25" y="25" width="14" height="14" rx="4"/><circle cx="16" cy="16" r="8"/><circle cx="48" cy="16" r="8"/><circle cx="16" cy="48" r="8"/><circle cx="48" cy="48" r="8"/></g>',
  balloon:
    '<path fill="black" d="M32 4c-10.8 0-18 9.2-18 20.8 0 13.6 11.8 22.1 15.1 26.2h5.8C38.2 46.9 50 38.4 50 24.8 50 13.2 42.8 4 32 4zm-7 50h14v6H25z"/>',
  vehicle:
    '<g fill="black"><path d="M14 26l5-11h26l5 11h5c2.2 0 4 1.8 4 4v14h-7.2a7 7 0 0 1-13.6 0H25.8a7 7 0 0 1-13.6 0H5V30c0-2.2 1.8-4 4-4zm9-7l-3 7h24l-3-7z"/><circle cx="19" cy="44" r="5"/><circle cx="45" cy="44" r="5"/></g>',
  airport: AIRPORT_SVG,
  helipad: HELIPAD_SVG,
  satellite:
    '<g fill="black"><path d="M13 18h14v28H13zM37 18h14v28H37zM29 24h6l5 5v10l-5 5h-6l-5-5V29z"/><path d="M28 31H15v-4h13zm21 0H36v-4h13zM28 39H15v-4h13zm21 0H36v-4h13zM31 9h3v12h-3zM33 9l8-5 2 3-9 6zM31 9l-8-5-2 3 9 6z"/></g>',
};

export const MARKER_ICON_VIEW_BOX: Record<SkywatchMarkerIconName, string> = {
  plane: "0 0 512 512",
  cargoPlane: "0 0 512 512",
  businessJet: "0 0 64 64",
  fighterJet: "0 0 512 512",
  jet: "0 0 512 512",
  helicopter: "0 -8 72 72",
  glider: "0 0 64 64",
  uav: "0 0 64 64",
  balloon: "0 0 64 64",
  vehicle: "0 0 64 64",
  airport: "0 0 24 24",
  helipad: "0 -0.5 17 17",
  satellite: "0 0 64 64",
};

export const MARKER_ICON_HEADING_OFFSET: Record<SkywatchMarkerIconName, number> = {
  plane: 0,
  cargoPlane: 0,
  businessJet: 45,
  fighterJet: 90,
  jet: 90,
  helicopter: 90,
  glider: 0,
  uav: 0,
  balloon: 0,
  vehicle: 0,
  airport: 0,
  helipad: 0,
  satellite: 0,
};

const MARKER_ICON_MASK: Record<SkywatchMarkerIconName, boolean> = {
  plane: false,
  cargoPlane: false,
  businessJet: false,
  fighterJet: false,
  jet: false,
  helicopter: true,
  glider: true,
  uav: true,
  balloon: true,
  vehicle: true,
  airport: true,
  helipad: true,
  satellite: true,
};

export function markerIconForAircraftClass(type: AircraftClass): SkywatchMarkerIconName {
  if (type === "cargo") return "cargoPlane";
  if (type === "business_jet") return "businessJet";
  if (type === "military") return "fighterJet";
  if (type === "helicopter") return "helicopter";
  if (type === "glider") return "glider";
  if (type === "uav") return "uav";
  if (type === "lighter_than_air") return "balloon";
  if (type === "ground_vehicle") return "vehicle";
  return "plane";
}

export function markerIconForAircraftType(type: string): SkywatchMarkerIconName {
  if (type === "cargoPlane") return "cargoPlane";
  if (type === "businessJet") return "businessJet";
  if (type === "fighterJet" || type === "jet") return "fighterJet";
  if (type === "helicopter") return "helicopter";
  if (type === "glider") return "glider";
  if (type === "uav") return "uav";
  if (type === "balloon") return "balloon";
  if (type === "vehicle") return "vehicle";
  return "plane";
}

function markerSvg(name: SkywatchMarkerIconName): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="${MARKER_ICON_VIEW_BOX[name]}">${MARKER_ICON_SVG_CONTENT[name]}</svg>`;
}

function markerDataUrl(name: SkywatchMarkerIconName): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markerSvg(name))}`;
}

/**
 * Compute anchor (in texture pixels) so that the visual center of
 * the SVG aligns with the geographic coordinate on the map.
 *
 * The SVG is always rendered into a 64×64 PNG/texture.  The viewBox
 * may be non-square or offset, so we convert the viewBox midpoint
 * to texture coordinates.
 */
function computeAnchor(name: SkywatchMarkerIconName): { anchorX: number; anchorY: number } {
  const vb = MARKER_ICON_VIEW_BOX[name];
  const parts = vb.split(/\s+/).map(Number);
  // viewBox = "minX minY width height"
  const [minX, minY, vbWidth, vbHeight] = parts;

  // The visual center of the content in viewBox coords
  const centerVbX = minX + vbWidth / 2;
  const centerVbY = minY + vbHeight / 2;

  // Map viewBox coords to the 64×64 texture
  // x_texture = (centerVbX - minX) / vbWidth  * textureWidth
  // y_texture = (centerVbY - minY) / vbHeight * textureHeight
  const textureWidth = 64;
  const textureHeight = 64;
  const anchorX = ((centerVbX - minX) / vbWidth) * textureWidth;
  const anchorY = ((centerVbY - minY) / vbHeight) * textureHeight;

  return {
    anchorX: Math.round(anchorX),
    anchorY: Math.round(anchorY),
  };
}

function deckIcon(name: SkywatchMarkerIconName): SkywatchDeckIcon {
  const { anchorX, anchorY } = computeAnchor(name);
  return {
    id: `skywatch-${name}-64`,
    url: markerDataUrl(name),
    width: 64,
    height: 64,
    anchorX,
    anchorY,
    mask: MARKER_ICON_MASK[name],
  };
}

export const MARKER_DECK_ICONS: Record<SkywatchMarkerIconName, SkywatchDeckIcon> = {
  plane: deckIcon("plane"),
  cargoPlane: deckIcon("cargoPlane"),
  businessJet: deckIcon("businessJet"),
  fighterJet: deckIcon("fighterJet"),
  jet: deckIcon("jet"),
  helicopter: deckIcon("helicopter"),
  glider: deckIcon("glider"),
  uav: deckIcon("uav"),
  balloon: deckIcon("balloon"),
  vehicle: deckIcon("vehicle"),
  airport: deckIcon("airport"),
  helipad: deckIcon("helipad"),
  satellite: deckIcon("satellite"),
};
