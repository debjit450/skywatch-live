export function unwrapLongitudes(points: [number, number][]): [number, number][] {
  if (points.length === 0) return [];
  const result: [number, number][] = [[points[0][0], points[0][1]]];
  for (let i = 1; i < points.length; i++) {
    const prevLon = result[i - 1][1];
    let lon = points[i][1];
    while (lon - prevLon > 180) lon -= 360;
    while (prevLon - lon > 180) lon += 360;
    result.push([points[i][0], lon]);
  }
  return result;
}

export function calculateGreatCirclePoints(
  start: [number, number],
  end: [number, number],
  numPoints: number = 50,
): [number, number][] {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;

  const lat1 = toRad(start[0]);
  const lon1 = toRad(start[1]);
  const lat2 = toRad(end[0]);
  const lon2 = toRad(end[1]);

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.pow(Math.sin((lat1 - lat2) / 2), 2) +
          Math.cos(lat1) * Math.cos(lat2) * Math.pow(Math.sin((lon1 - lon2) / 2), 2),
      ),
    );

  if (d < 0.0001) return [start, end];

  const points: [number, number][] = [];
  for (let i = 0; i <= numPoints; i++) {
    const f = i / numPoints;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);

    const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
    const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
    const z = A * Math.sin(lat1) + B * Math.sin(lat2);

    const lat = Math.atan2(z, Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2)));
    const lon = Math.atan2(y, x);

    points.push([toDeg(lat), toDeg(lon)]);
  }

  return unwrapLongitudes(points);
}

export function getAltitudeColor(altitudeMeters: number | null): string {
  if (altitudeMeters === null) return "#94a3b8"; // Slate 400 for unknown

  const feet = altitudeMeters * 3.28084;

  if (feet < 500) return "#fbbf24"; // Amber 400 (Ground / Final approach)
  if (feet < 3000) return "#f59e0b"; // Amber 500 (Initial climb)
  if (feet < 10000) return "#84cc16"; // Lime 500 (Climb)
  if (feet < 20000) return "#22c55e"; // Green 500 (Mid-altitude)
  if (feet < 30000) return "#06b6d4"; // Cyan 500 (High altitude)
  if (feet < 40000) return "#3b82f6"; // Blue 500 (Cruising)
  return "#8b5cf6"; // Violet 500 (Very high altitude)
}
