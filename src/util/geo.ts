const R = 6_371_000;
const RAD = Math.PI / 180;

/** Great-circle distance in metres. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Resample a polyline (flat [lat,lon,...]) to n points evenly spaced along its length. */
export function resample(lat: ArrayLike<number>, lon: ArrayLike<number>, n: number): { pts: number[]; lengthM: number } | null {
  const la: number[] = [];
  const lo: number[] = [];
  for (let i = 0; i < lat.length; i++) {
    if (Number.isFinite(lat[i]) && Number.isFinite(lon[i])) {
      la.push(lat[i]!);
      lo.push(lon[i]!);
    }
  }
  if (la.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < la.length; i++) cum.push(cum[i - 1]! + haversine(la[i - 1]!, lo[i - 1]!, la[i]!, lo[i]!));
  const total = cum[cum.length - 1]!;
  if (total < 1) return null;
  const pts: number[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < cum.length - 2 && cum[j + 1]! < target) j++;
    const span = cum[j + 1]! - cum[j]!;
    const f = span > 0 ? (target - cum[j]!) / span : 0;
    pts.push(la[j]! + (la[j + 1]! - la[j]!) * f, lo[j]! + (lo[j + 1]! - lo[j]!) * f);
  }
  return { pts, lengthM: total };
}

/** Resample a value series to n points, spaced by an accompanying cumulative-distance series. */
export function resampleSeries(values: number[], cum: number[], n: number): number[] {
  const total = cum[cum.length - 1]!;
  const out: number[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < cum.length - 2 && cum[j + 1]! < target) j++;
    const span = cum[j + 1]! - cum[j]!;
    const f = span > 0 ? (target - cum[j]!) / span : 0;
    out.push(values[j]! + (values[j + 1]! - values[j]!) * f);
  }
  return out;
}
