import type { Activity } from '../types';
import { haversine } from '../util/geo';

/**
 * Regions: groups of activities whose start points are near each other (single linkage: two starts within
 * LINK_KM join the same region, and so do their neighbours' neighbours). Used to keep far-away activities
 * (a holiday, Zwift's Watopia in the Pacific) from shrinking the home area of a route poster to a dot.
 *
 * Starts are first rounded to a ~1 km grid and deduplicated (a rider starts from a few places hundreds of
 * times), then linked through a hash of LINK_KM-sized cells, so the cost stays near linear.
 */
export const LINK_KM = 150;

export interface Region {
  /** stable for the same data: the rounded position of the region's busiest start cell */
  id: string;
  /** e.g. "Home area", "Watopia (Zwift)", "1,230 km south-west" */
  name: string;
  count: number;
  /** centroid of the starts */
  lat: number;
  lon: number;
  activityIds: Set<string>;
}

/** Zwift places its main world on an island in the Pacific; virtual rides there are labelled as such. */
const WATOPIA = { lat: [-11.8, -11.5], lon: [166.8, 167.1] };
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

export function findRegions(acts: Activity[], linkKm = LINK_KM): Region[] {
  // 1. dedupe starts on a 0.01° grid
  const cells = new Map<string, { lat: number; lon: number; ids: string[] }>();
  for (const a of acts) {
    if (!a.route || a.route.length < 2) continue;
    const lat = a.route[0]!, lon = a.route[1]!;
    const key = `${Math.round(lat * 100)},${Math.round(lon * 100)}`;
    const c = cells.get(key) ?? cells.set(key, { lat, lon, ids: [] }).get(key)!;
    c.ids.push(a.id);
  }
  const pts = [...cells.entries()];
  if (!pts.length) return [];

  // 2. union-find over points closer than linkKm, looking only at neighbouring buckets
  const parent = pts.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const deg = linkKm / 111.2; // bucket size in degrees of latitude
  const buckets = new Map<string, number[]>();
  const bucketOf = (lat: number, lon: number): [number, number] => [Math.floor(lat / deg), Math.floor((lon * Math.max(0.05, Math.cos((lat * Math.PI) / 180))) / deg)];
  pts.forEach(([, p], i) => {
    const [by, bx] = bucketOf(p.lat, p.lon);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const j of buckets.get(`${by + dy},${bx + dx}`) ?? []) {
        const q = pts[j]![1];
        if (find(i) !== find(j) && haversine(p.lat, p.lon, q.lat, q.lon) <= linkKm * 1000) parent[find(i)] = find(j);
      }
    }
    const k = `${by},${bx}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
  });

  // 3. collect regions, biggest first
  const groups = new Map<number, number[]>();
  pts.forEach((_, i) => { const r = find(i); (groups.get(r) ?? groups.set(r, []).get(r)!).push(i); });
  const regions = [...groups.values()].map((members) => {
    let n = 0, lat = 0, lon = 0, busiest = members[0]!;
    const ids = new Set<string>();
    for (const i of members) {
      const [, c] = pts[i]!;
      n += c.ids.length; lat += c.lat * c.ids.length; lon += c.lon * c.ids.length;
      c.ids.forEach((id) => ids.add(id));
      if (c.ids.length > pts[busiest]![1].ids.length) busiest = i;
    }
    return { id: pts[busiest]![0], name: '', count: n, lat: lat / n, lon: lon / n, activityIds: ids };
  }).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));

  // 4. names, relative to the biggest region
  const home = regions[0]!;
  for (const r of regions) r.name = r === home ? 'Home area' : regionName(r, home);
  return regions;
}

function regionName(r: Region, home: Region): string {
  if (r.lat >= WATOPIA.lat[0] && r.lat <= WATOPIA.lat[1] && r.lon >= WATOPIA.lon[0] && r.lon <= WATOPIA.lon[1]) return 'Watopia (Zwift)';
  const km = haversine(home.lat, home.lon, r.lat, r.lon) / 1000;
  // initial bearing from home to the region
  const φ1 = (home.lat * Math.PI) / 180, φ2 = (r.lat * Math.PI) / 180, Δλ = ((r.lon - home.lon) * Math.PI) / 180;
  const bearing = (Math.atan2(Math.sin(Δλ) * Math.cos(φ2), Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)) * 180) / Math.PI;
  const dir = COMPASS[Math.round(((bearing + 360) % 360) / 45) % 8]!;
  const rounded = km >= 1000 ? Math.round(km / 100) * 100 : Math.round(km / 10) * 10;
  return `${rounded.toLocaleString('en-US')} km ${dir}`;
}

/**
 * Which activities a region choice keeps. 'all' keeps everything; 'auto' keeps the home region only when
 * there is more than one (activities without GPS are kept either way: they have no position to judge);
 * a list keeps the named regions, falling back to 'auto' when none of them exists in this data.
 */
export type RegionChoice = 'all' | 'auto' | string[];

export function regionFilter(regions: Region[], choice: RegionChoice): ((a: Activity) => boolean) & { picked: Region[] } {
  let picked: Region[];
  if (choice === 'all' || regions.length < 2) picked = regions;
  else if (choice === 'auto') picked = regions.slice(0, 1);
  else {
    picked = regions.filter((r) => choice.includes(r.id));
    if (!picked.length) picked = regions.slice(0, 1);
  }
  const keep = new Set<string>();
  for (const r of picked) r.activityIds.forEach((id) => keep.add(id));
  const everything = picked.length === regions.length;
  return Object.assign((a: Activity) => everything || !a.route || keep.has(a.id), { picked });
}
