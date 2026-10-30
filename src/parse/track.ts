import { PROFILE_POINTS, ROUTE_POINTS, type Route } from '../types';
import { haversine, resample, resampleSeries } from '../util/geo';

/** One parsed activity file: parallel arrays, NaN where a sample has no value. */
export interface ParsedTrack {
  sport?: string;
  name?: string;
  /** epoch ms, NaN when the file has no timestamps */
  t: number[];
  lat: number[];
  lon: number[];
  ele: number[];
  hr: number[];
  power: number[];
  cad: number[];
  /** cumulative distance in metres if the file provides it */
  dist: number[];
}

export function emptyTrack(): ParsedTrack {
  return { t: [], lat: [], lon: [], ele: [], hr: [], power: [], cad: [], dist: [] };
}

export interface TrackSummary {
  startMs: number | null;
  elapsedS: number;
  movingS: number;
  distanceM: number;
  elevGainM: number;
  maxSpeedMps: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgCadence: number | null;
  hrHist: [number, number][] | null;
  powerHist: [number, number][] | null;
  route: Route | null;
  profile: number[] | null;
}

/** Gaps longer than this between samples are treated as pauses and contribute no time. */
export const MAX_GAP_S = 30;
/** Below this speed a sample counts as stopped (not moving time). */
export const MOVING_MPS = 0.5;

/** Seconds each sample represents: gap to the next sample, 0 for pauses and for the last sample. 1 s each without timestamps. */
export function sampleDurations(t: number[]): number[] {
  const n = t.length;
  if (!n || t.every((v) => !Number.isFinite(v))) return new Array<number>(n).fill(1);
  const out = new Array<number>(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    const dt = (t[i + 1]! - t[i]!) / 1000;
    out[i] = dt > 0 && dt <= MAX_GAP_S ? dt : 0;
  }
  return out;
}

/**
 * Elevation gain with hysteresis: a climb only counts once elevation has moved
 * at least `threshold` metres from the last reference point, which suppresses GPS/barometer noise.
 */
export function elevationGain(ele: number[], threshold = 2): number {
  let gain = 0;
  let ref: number | null = null;
  for (const e of ele) {
    if (!Number.isFinite(e)) continue;
    if (ref === null) { ref = e; continue; }
    if (e - ref >= threshold) { gain += e - ref; ref = e; }
    else if (ref - e >= threshold) ref = e;
  }
  return gain;
}

const finite = (v: number) => Number.isFinite(v);

function histogram(values: number[], dur: number[], lo: number, hi: number): { hist: [number, number][]; avg: number; max: number } | null {
  const bins = new Map<number, number>();
  let sum = 0, w = 0, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (!finite(v) || v < lo || v > hi) continue;
    const d = dur[i]!;
    const k = Math.round(v);
    bins.set(k, (bins.get(k) ?? 0) + d);
    sum += v * d;
    w += d;
    if (v > max) max = v;
  }
  if (!bins.size || w === 0) return null;
  const hist = [...bins.entries()].filter(([, s]) => s > 0).sort((a, b) => a[0] - b[0]).map(([k, s]): [number, number] => [k, Math.round(s * 10) / 10]);
  return { hist, avg: sum / w, max };
}

export function summarizeTrack(tr: ParsedTrack): TrackSummary {
  const n = tr.t.length;
  const dur = sampleDurations(tr.t);
  const times = tr.t.filter(finite);
  const startMs = times.length ? times[0]! : null;
  const elapsedS = times.length > 1 ? (times[times.length - 1]! - times[0]!) / 1000 : 0;

  // Per-sample cumulative distance: file-provided if available, else haversine over GPS fixes.
  const hasDist = tr.dist.some(finite);
  const cum = new Array<number>(n).fill(NaN);
  let acc = 0;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (hasDist) {
      if (finite(tr.dist[i]!)) cum[i] = tr.dist[i]!;
    } else if (finite(tr.lat[i]!) && finite(tr.lon[i]!)) {
      if (prev >= 0) acc += haversine(tr.lat[prev]!, tr.lon[prev]!, tr.lat[i]!, tr.lon[i]!);
      cum[i] = acc;
      prev = i;
    }
  }
  const cd = cum.filter(finite);
  const distanceM = cd.length ? cd[cd.length - 1]! - cd[0]! : 0;

  // Moving time: samples whose speed to the next distance-bearing sample is above the threshold.
  let movingS = 0;
  let maxSpeed = 0;
  if (cd.length > 1 && times.length > 1) {
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (!finite(cum[i]!) || !finite(tr.t[i]!)) continue;
      if (last >= 0) {
        const dt = (tr.t[i]! - tr.t[last]!) / 1000;
        if (dt > 0 && dt <= MAX_GAP_S) {
          const v = (cum[i]! - cum[last]!) / dt;
          if (v >= MOVING_MPS) movingS += dt;
          if (v > maxSpeed && v < 40) maxSpeed = v;
        }
      }
      last = i;
    }
  } else movingS = dur.reduce((a, b) => a + b, 0);

  const hr = histogram(tr.hr, dur, 30, 250);
  const pw = histogram(tr.power, dur, 0, 3000);
  const cad = histogram(tr.cad, dur, 1, 300);

  const geo = resample(tr.lat, tr.lon, ROUTE_POINTS);
  const route = geo && geo.lengthM >= 50 ? geo.pts.map((v) => Math.round(v * 1e5) / 1e5) : null;

  let profile: number[] | null = null;
  const idxs = tr.ele.map((e, i) => (finite(e) ? i : -1)).filter((i) => i >= 0);
  if (idxs.length >= 2) {
    const ev = idxs.map((i) => tr.ele[i]!);
    const cv = idxs.map((i) => (finite(cum[i]!) ? cum[i]! : NaN));
    const usable = cv.every(finite) && cv[cv.length - 1]! - cv[0]! > 1;
    const x = usable ? cv : idxs.map((_, k) => k);
    profile = resampleSeries(ev, x, PROFILE_POINTS).map((v) => Math.round(v * 10) / 10);
  }

  return {
    startMs,
    elapsedS,
    movingS,
    distanceM,
    elevGainM: elevationGain(tr.ele),
    maxSpeedMps: maxSpeed > 0 ? maxSpeed : null,
    avgHr: hr?.avg ?? null,
    maxHr: hr?.max ?? null,
    avgPower: pw?.avg ?? null,
    maxPower: pw?.max ?? null,
    avgCadence: cad?.avg ?? null,
    hrHist: hr?.hist ?? null,
    powerHist: pw && pw.max > 0 ? pw.hist : null,
    route,
    profile,
  };
}
