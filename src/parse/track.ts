import { PROFILE_POINTS, ROUTE_POINTS, SERIES_POINTS, type Activity, type Route } from '../types';
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
  series: Activity['series'];
  splits: Activity['splits'];
  np: number | null;
  powerCurve: [number, number][] | null;
  bestEfforts: [number, number][] | null;
  decoupling: number | null;
}

/** Durations (s) of the power curve: the points TrainingPeaks, Strava and intervals.icu all show. */
export const CURVE_DURATIONS = [1, 5, 10, 15, 30, 60, 120, 180, 300, 480, 600, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400, 18000];
/** Distances (m) for best efforts: running classics plus cycling ones. Sports pick the ones that apply. */
export const EFFORT_DISTANCES = [400, 1000, 1609.344, 5000, 10000, 20000, 21097.5, 40000, 42195, 50000, 100000, 160934.4];

/**
 * Resample a stream to one value per second over the time the recording was running (pauses longer than
 * MAX_GAP_S are left out, like auto-pause). Each sample's value holds until the next sample; missing
 * values count as `fill`. Returns null without timestamps.
 */
export function perSecond(t: number[], v: number[], fill: number): number[] | null {
  const out: number[] = [];
  let carry = 0;
  for (let i = 0; i < t.length - 1; i++) {
    if (!finite(t[i]!) || !finite(t[i + 1]!)) continue;
    const dt = (t[i + 1]! - t[i]!) / 1000;
    if (!(dt > 0) || dt > MAX_GAP_S) continue;
    carry += dt;
    const val = finite(v[i]!) ? v[i]! : fill;
    while (carry >= 1) { out.push(val); carry -= 1; }
  }
  return out.length ? out : null;
}

/** Highest average of any `d` consecutive values, for each duration that fits. */
export function meanMax(xs: number[], durations: number[]): [number, number][] {
  const pre = new Float64Array(xs.length + 1);
  for (let i = 0; i < xs.length; i++) pre[i + 1] = pre[i]! + xs[i]!;
  const out: [number, number][] = [];
  for (const d of durations) {
    if (d > xs.length) break;
    let best = 0;
    for (let i = d; i <= xs.length; i++) { const s = pre[i]! - pre[i - d]!; if (s > best) best = s; }
    out.push([d, Math.round(best / d)]);
  }
  return out;
}

/** Normalized power (Coggan): 30 s rolling average, raised to the 4th power, averaged, 4th root. */
export function normalizedPower(w: number[]): number | null {
  if (w.length < 60) return null;
  let sum = 0, acc = 0, n = 0;
  for (let i = 0; i < w.length; i++) {
    acc += w[i]!;
    if (i >= 30) acc -= w[i - 30]!;
    if (i >= 29) { sum += (acc / 30) ** 4; n++; }
  }
  return n ? Math.round((sum / n) ** 0.25 * 10) / 10 : null;
}

/**
 * Fastest elapsed time to cover each distance anywhere in the activity (two pointers over the
 * cumulative distance; the start of the window is interpolated so short distances are exact).
 */
export function bestEfforts(cum: number[], t: number[], distances: number[]): [number, number][] | null {
  const idx: number[] = [];
  for (let i = 0; i < cum.length; i++) if (finite(cum[i]!) && finite(t[i]!)) idx.push(i);
  if (idx.length < 2) return null;
  const c = idx.map((i) => cum[i]!), s = idx.map((i) => t[i]! / 1000);
  const total = c[c.length - 1]! - c[0]!;
  const out: [number, number][] = [];
  for (const d of distances) {
    if (d > total) break;
    let best = Infinity, i = 0;
    for (let j = 1; j < c.length; j++) {
      if (c[j]! - c[0]! < d) continue;
      while (i + 1 < j && c[j]! - c[i + 1]! >= d) i++;
      // the window starts between sample i and i+1, at distance c[j] - d
      const span = c[i + 1]! - c[i]!;
      const f = span > 0 ? Math.min(1, Math.max(0, (c[j]! - d - c[i]!) / span)) : 0;
      const dt = s[j]! - (s[i]! + f * (s[i + 1]! - s[i]!));
      if (dt > 0 && dt < best) best = dt;
    }
    // GPS glitches can teleport: ignore anything faster than 30 m/s (108 km/h).
    if (Number.isFinite(best) && d / best <= 30) out.push([Math.round(d * 10) / 10, Math.round(best)]);
  }
  return out.length ? out : null;
}

/**
 * Aerobic decoupling (Friel's Pa:HR / Pw:HR): output per heartbeat in the first half of the moving
 * samples versus the second. Positive = HR drifted up for the same output.
 */
export function decoupling(out: number[], hr: number[]): number | null {
  const pairs: [number, number][] = [];
  for (let i = 0; i < out.length && i < hr.length; i++) if (out[i]! > 0 && hr[i]! >= 30) pairs.push([out[i]!, hr[i]!]);
  if (pairs.length < 1200) return null;
  const half = pairs.length >> 1;
  const ef = (p: [number, number][]) => p.reduce((a, x) => a + x[0], 0) / p.reduce((a, x) => a + x[1], 0);
  const e1 = ef(pairs.slice(0, half)), e2 = ef(pairs.slice(half));
  return e1 > 0 ? Math.round(((e1 - e2) / e1) * 1000) / 10 : null;
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

/** Average values into n equal-width bins along x (distance). Empty bins repeat the previous value. */
function binAverage(x: number[], v: number[], n: number, digits: number): number[] | null {
  const idx: number[] = [];
  for (let i = 0; i < x.length; i++) if (finite(x[i]!) && finite(v[i]!)) idx.push(i);
  if (idx.length < 2) return null;
  const x0 = x[idx[0]!]!;
  const span = x[idx[idx.length - 1]!]! - x0;
  if (span <= 0) return null;
  const sum = new Array<number>(n).fill(0);
  const cnt = new Array<number>(n).fill(0);
  for (const i of idx) {
    const b = Math.min(n - 1, Math.floor(((x[i]! - x0) / span) * n));
    sum[b]! += v[i]!;
    cnt[b]!++;
  }
  const out: number[] = [];
  let prev: number | null = null;
  for (let b = 0; b < n; b++) {
    const val: number | null = cnt[b]! ? sum[b]! / cnt[b]! : prev;
    if (val !== null) prev = val;
    out.push(val ?? NaN);
  }
  const first = out.find(finite);
  if (first === undefined) return null;
  const f = 10 ** digits;
  return out.map((o) => Math.round((finite(o) ? o : first) * f) / f);
}

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

  // Moving time: samples whose speed to the previous distance-bearing sample is above the threshold.
  // The same pass records per-sample speed and cumulative moving time at each full km (for splits).
  let movingS = 0;
  let maxSpeed = 0;
  const spd = new Array<number>(n).fill(NaN);
  const kmCum: number[] = [];
  let splits: TrackSummary['splits'] = null;
  if (cd.length > 1 && times.length > 1) {
    const c0 = cd[0]!;
    let nextKm = 1000;
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (!finite(cum[i]!) || !finite(tr.t[i]!)) continue;
      if (last >= 0) {
        const dt = (tr.t[i]! - tr.t[last]!) / 1000;
        if (dt > 0 && dt <= MAX_GAP_S) {
          const dd = cum[i]! - cum[last]!;
          const v = dd / dt;
          const moving = v >= MOVING_MPS;
          const before = movingS;
          if (moving) movingS += dt;
          if (v > maxSpeed && v < 40) maxSpeed = v;
          if (v >= 0 && v < 40) spd[i] = v;
          while (dd > 0 && cum[i]! - c0 >= nextKm) {
            kmCum.push(before + (moving ? ((nextKm - (cum[last]! - c0)) / dd) * dt : 0));
            nextKm += 1000;
          }
        }
      }
      last = i;
    }
    splits = { cum: kmCum.map((c) => Math.round(c * 10) / 10), endM: Math.round(cd[cd.length - 1]! - c0), endS: Math.round(movingS * 10) / 10 };
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

  // Series along distance (or sample index when the file has no distance).
  const xs = cd.length > 1 ? cum.map((c) => (finite(c) ? c - cd[0]! : NaN)) : tr.t.map((_, i) => i);
  const sp = binAverage(xs, spd, SERIES_POINTS, 2);
  const hrS = hr ? binAverage(xs, tr.hr.map((v) => (v >= 30 && v <= 250 ? v : NaN)), SERIES_POINTS, 0) : null;
  const pwS = pw && pw.max > 0 ? binAverage(xs, tr.power.map((v) => (v >= 0 && v <= 3000 ? v : NaN)), SERIES_POINTS, 0) : null;

  // Per-second streams for normalized power, the power curve and decoupling.
  const pw1 = pw && pw.max > 0 ? perSecond(tr.t, tr.power.map((v) => (v >= 0 && v <= 3000 ? v : NaN)), 0) : null;
  const hr1 = hr ? perSecond(tr.t, tr.hr.map((v) => (v >= 30 && v <= 250 ? v : NaN)), NaN) : null;
  const sp1 = hr1 ? perSecond(tr.t, spd, NaN) : null;
  const outStream = pw1 ?? sp1;

  return {
    np: pw1 ? normalizedPower(pw1) : null,
    powerCurve: pw1 ? meanMax(pw1, CURVE_DURATIONS) : null,
    bestEfforts: times.length > 1 && cd.length > 1 ? bestEfforts(cum, tr.t, EFFORT_DISTANCES) : null,
    decoupling: outStream && hr1 ? decoupling(outStream, hr1) : null,
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
    series: sp || hrS || pwS ? { speed: sp, hr: hrS, power: pwS } : null,
    splits,
  };
}
