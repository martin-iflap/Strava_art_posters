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

/**
 * Heart-rate zones. Five zones, boundaries rounded to whole bpm.
 *  - maxHr: Z1 <60%, Z2 60-70%, Z3 70-80%, Z4 80-90%, Z5 >=90% of max HR.
 *  - lthr (Friel): Z1 <85%, Z2 85-90%, Z3 90-95%, Z4 95-100%, Z5 >=100% of lactate-threshold HR.
 */
export function hrZones(cfg: HrZoneConfig): Zone[] {
  const pct = cfg.mode === 'maxHr' ? [0, 0.6, 0.7, 0.8, 0.9] : [0, 0.85, 0.9, 0.95, 1];
  return build(pct.map((p) => Math.round(p * cfg.value)), (i) => `Z${i + 1}`);
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

export type Stream = 'hr' | 'power';

const histOf = (a: Activity, s: Stream) => (s === 'hr' ? a.hrHist : a.powerHist);

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
