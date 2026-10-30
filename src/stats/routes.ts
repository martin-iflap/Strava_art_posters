import type { Activity } from '../types';
import { ROUTE_POINTS } from '../types';

/**
 * Route clustering (heuristic).
 *
 * Every route is the stored GPS track resampled to ROUTE_POINTS points evenly spaced by distance. Two
 * routes are "the same" when ALL of these hold:
 *   1. total lengths differ by at most LENGTH_TOLERANCE (15 %);
 *   2. their bounding-box centres are within CENTRE_LIMIT_M (cheap pre-filter);
 *   3. the symmetric Chamfer distance (mean distance from every 4th point of one route to the nearest point
 *      on the other route's polyline, worst of both directions) is at most CHAMFER_LIMIT_M (80 m).
 * Chamfer ignores direction and start point, so a loop ridden clockwise or from a different start still
 * matches, and an out-and-back matches its reverse. Different routes sharing a long common section can
 * still merge or split near the thresholds, so this is a best-effort grouping, not ground truth.
 * Clustering is greedy: activities are visited in chronological order and join the first cluster whose
 * representative (its first member) matches, else start a new cluster. Cost is O(activities x clusters).
 */
export const LENGTH_TOLERANCE = 0.15;
export const CENTRE_LIMIT_M = 1000;
export const CHAMFER_LIMIT_M = 80;
export const MIN_ROUTE_LENGTH_M = 1000;

interface Prepared {
  a: Activity;
  /** local metric coordinates [x0,y0,x1,y1...] in metres (equirectangular projection) */
  xy: number[];
  cx: number;
  cy: number;
  lengthM: number;
}

const M_PER_DEG = 111_320;
/** Every QUERY_STRIDE-th vertex is used as a query point; all vertices form the segments compared against. */
const QUERY_STRIDE = 4;

function prepare(a: Activity, refLat: number, refLon: number): Prepared | null {
  if (!a.route || a.route.length < 4 || a.distanceM < MIN_ROUTE_LENGTH_M) return null;
  const n = a.route.length / 2;
  const kx = M_PER_DEG * Math.cos((refLat * Math.PI) / 180);
  const xy: number[] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, len = 0;
  for (let i = 0; i < n; i++) {
    const x = (a.route[2 * i + 1]! - refLon) * kx;
    const y = (a.route[2 * i]! - refLat) * M_PER_DEG;
    xy.push(x, y);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    if (i) len += Math.hypot(x - xy[2 * i - 2]!, y - xy[2 * i - 1]!);
  }
  return { a, xy, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, lengthM: len };
}

/** Mean distance from every `stride`-th vertex of p to the polyline q (point-to-segment). Gives up early above `limit`. */
function meanToPolyline(p: number[], q: number[], stride: number, limit: number): number {
  let total = 0, count = 0;
  const queries = Math.ceil(p.length / 2 / stride);
  for (let i = 0; i < p.length; i += 2 * stride) {
    const px = p[i]!, py = p[i + 1]!;
    let best = Infinity;
    for (let j = 0; j + 3 < q.length; j += 2) {
      const ax = q[j]!, ay = q[j + 1]!, dx = q[j + 2]! - ax, dy = q[j + 3]! - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d < best) best = d;
    }
    total += Math.sqrt(best);
    count++;
    if (total > limit * queries) return Infinity;
  }
  return total / count;
}

/** Symmetric Chamfer distance (metres) between two flat [x,y,...] polylines: the worse of the two directions. */
export const chamfer = (p: number[], q: number[], stride = 1, limit = Infinity) => {
  const d1 = meanToPolyline(p, q, stride, limit);
  return d1 > limit ? Infinity : Math.max(d1, meanToPolyline(q, p, stride, limit));
};

export interface RouteCluster {
  id: number;
  count: number;
  activityIds: string[];
  avgMovingS: number;
  bestMovingS: number;
  avgDistanceM: number;
  /** flat [lat,lon,...] preview of the representative route */
  preview: number[];
}

export function clusterRoutes(acts: Activity[], minCount = 2): RouteCluster[] {
  const gps = acts.filter((a) => a.route).sort((a, b) => a.startMs - b.startMs);
  if (!gps.length) return [];
  const refLat = gps[0]!.route![0]!;
  const refLon = gps[0]!.route![1]!;
  const clusters: { rep: Prepared; members: Activity[] }[] = [];
  for (const a of gps) {
    const p = prepare(a, refLat, refLon);
    if (!p) continue;
    let home: (typeof clusters)[number] | undefined;
    for (const c of clusters) {
      const r = c.rep;
      if (Math.abs(r.lengthM - p.lengthM) > LENGTH_TOLERANCE * Math.max(r.lengthM, p.lengthM)) continue;
      if (Math.hypot(r.cx - p.cx, r.cy - p.cy) > CENTRE_LIMIT_M) continue;
      if (chamfer(r.xy, p.xy, QUERY_STRIDE, CHAMFER_LIMIT_M) <= CHAMFER_LIMIT_M) { home = c; break; }
    }
    if (home) home.members.push(a);
    else clusters.push({ rep: p, members: [a] });
  }
  return clusters
    .filter((c) => c.members.length >= minCount)
    .sort((a, b) => b.members.length - a.members.length || a.rep.a.startMs - b.rep.a.startMs)
    .map((c, i) => {
      const m = c.members;
      const times = m.map((x) => x.movingS).filter((t) => t > 0);
      return {
        id: i + 1,
        count: m.length,
        activityIds: m.map((x) => x.id),
        avgMovingS: times.length ? times.reduce((s, t) => s + t, 0) / times.length : 0,
        bestMovingS: times.length ? Math.min(...times) : 0,
        avgDistanceM: m.reduce((s, x) => s + x.distanceM, 0) / m.length,
        preview: c.rep.a.route!.slice(0, ROUTE_POINTS * 2),
      };
    });
}
