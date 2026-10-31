import type { Activity, Tz } from '../types';
import { monthKey, parts, yearKey } from '../util/time';

export interface Zone {
  name: string;
  /** inclusive lower bound (bpm or watts) */
  lower: number;
  /** exclusive upper bound; null = open-ended */
  upper: number | null;
}

export type HrZoneConfig = { mode: 'maxHr' | 'lthr'; value: number };

/** Sports whose heart-rate and pace zones follow the running tables. */
export const RUN_LIKE = new Set(['Run', 'Trail Run', 'Virtual Run', 'Walk', 'Hike']);

const FRIEL_NAMES = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5a', 'Z5b', 'Z5c'];

/**
 * Heart-rate zones, boundaries rounded to whole bpm.
 *  - maxHr: five zones, Z1 <60%, Z2 60-70%, Z3 70-80%, Z4 80-90%, Z5 >=90% of max HR (Strava, Garmin).
 *  - lthr: Joe Friel's seven zones from lactate-threshold HR, as TrainingPeaks uses them by default.
 *    Cycling: Z1 <81%, Z2 81-89%, Z3 90-93%, Z4 94-99%, Z5a 100-102%, Z5b 103-106%, Z5c >106%.
 *    Running (pass a run-like sport): Z1 <85%, Z2 85-89%, Z3 90-94%, Z4 95-99%, then the same Z5a-c.
 */
export function hrZones(cfg: HrZoneConfig, sport?: string): Zone[] {
  if (cfg.mode === 'maxHr') return build([0, 0.6, 0.7, 0.8, 0.9].map((p) => Math.round(p * cfg.value)), (i) => `Z${i + 1}`);
  const pct = sport && RUN_LIKE.has(sport) ? [0, 0.85, 0.9, 0.95, 1, 1.03, 1.07] : [0, 0.81, 0.9, 0.94, 1, 1.03, 1.07];
  return build(pct.map((p) => Math.round(p * cfg.value)), (i) => FRIEL_NAMES[i]!);
}

/**
 * Joe Friel's running pace zones from threshold pace (as TrainingPeaks uses them), in the speed-histogram
 * unit (0.1 m/s). Pace as % of threshold pace: Z1 slower than 129 %, Z2 114-129 %, Z3 106-113 %,
 * Z4 101-105 %, Z5a 97-100 %, Z5b 90-96 %, Z5c faster than 90 %.
 */
export function paceZones(thresholdMps: number): Zone[] {
  const pct = [Infinity, 1.29, 1.14, 1.06, 1.01, 0.97, 0.9];
  return build(pct.map((p) => (p === Infinity ? 0 : Math.round((thresholdMps / p) * 100) / 10)), (i) => FRIEL_NAMES[i]!);
}

/** Coggan 7-zone power model from FTP (<55, 55-75, 75-90, 90-105, 105-120, 120-150, >=150 % of FTP). */
export function powerZones(ftp: number): Zone[] {
  const names = ['Z1 Recovery', 'Z2 Endurance', 'Z3 Tempo', 'Z4 Threshold', 'Z5 VO2max', 'Z6 Anaerobic', 'Z7 Neuromuscular'];
  const pct = [0, 0.55, 0.75, 0.9, 1.05, 1.2, 1.5];
  return build(pct.map((p) => Math.round(p * ftp)), (i) => names[i]!);
}

function build(bounds: number[], name: (i: number) => string): Zone[] {
  return bounds.map((lower, i) => ({ name: name(i), lower, upper: i + 1 < bounds.length ? bounds[i + 1]! : null }));
}

export function zoneIndex(value: number, zones: Zone[]): number {
  for (let i = zones.length - 1; i >= 0; i--) if (value >= zones[i]!.lower) return i;
  return 0;
}

/** Seconds per zone from a [value, seconds] histogram. */
export function secondsInZones(hist: [number, number][], zones: Zone[]): number[] {
  const out = new Array<number>(zones.length).fill(0);
  for (const [v, s] of hist) out[zoneIndex(v, zones)]! += s;
  return out;
}

/** Default max HR when the user has not set one: the highest plausible value recorded (30-230 bpm). */
export function observedMaxHr(acts: Activity[]): number | null {
  let m: number | null = null;
  for (const a of acts) if (a.maxHr !== null && a.maxHr <= 230 && (m === null || a.maxHr > m)) m = a.maxHr;
  return m;
}

export type Stream = 'hr' | 'power' | 'pace';

const histOf = (a: Activity, s: Stream) => (s === 'hr' ? a.hrHist : s === 'pace' ? a.speedHist : a.powerHist);

/** Per-activity zone seconds, or null when the activity has no such stream (never zeros). */
export function activityZones(a: Activity, s: Stream, zones: Zone[]): number[] | null {
  const h = histOf(a, s);
  return h ? secondsInZones(h, zones) : null;
}

export interface ZoneRow {
  key: string;
  seconds: number[];
  totalS: number;
  /** activities in the group that have the stream / activities in the group */
  withData: number;
  count: number;
}

export function zoneTotals(acts: Activity[], s: Stream, zones: Zone[]): ZoneRow {
  const seconds = new Array<number>(zones.length).fill(0);
  let withData = 0;
  for (const a of acts) {
    const z = activityZones(a, s, zones);
    if (!z) continue;
    withData++;
    z.forEach((v, i) => (seconds[i]! += v));
  }
  return { key: 'all', seconds, totalS: seconds.reduce((x, y) => x + y, 0), withData, count: acts.length };
}

export function zonesBy(acts: Activity[], s: Stream, zones: Zone[], by: 'month' | 'year', tz: Tz): ZoneRow[] {
  const groups = new Map<string, Activity[]>();
  for (const a of acts) {
    const p = parts(a.startMs, tz);
    const k = by === 'month' ? monthKey(p) : yearKey(p);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(a);
  }
  return [...groups.keys()].sort().map((key) => ({ ...zoneTotals(groups.get(key)!, s, zones), key }));
}
