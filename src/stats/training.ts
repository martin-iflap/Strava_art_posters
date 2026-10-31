import type { Activity, Tz } from '../types';
import { dayNumber, fromDayNumber, parts, ymd } from '../util/time';
import { RUN_LIKE, type HrZoneConfig } from './zones';

/**
 * Training-load maths as TrainingPeaks defines it (and intervals.icu and Golden Cheetah reproduce it).
 *  - TSS (Training Stress Score): 100 = one hour at threshold. TSS = hours × IF² × 100.
 *    Power (TSS): IF = normalized power / FTP. Running (rTSS): IF = normalized graded pace / threshold pace.
 *    Heart rate (hrTSS): TrainingPeaks does not publish its lookup table, so this uses the TRIMP-based
 *    heart-rate stress score that intervals.icu and Golden Cheetah use: Banister's exponentially weighted
 *    heart-rate reserve, scaled so one hour at threshold heart rate = 100.
 *    Order as in TrainingPeaks: power first, then pace (run-like sports), then heart rate.
 *  - Fitness (CTL): CTL += (TSS − CTL) / 42 each day. Fatigue (ATL): the same with 7.
 *  - Form (TSB): yesterday's fitness minus yesterday's fatigue. Positive = fresh, negative = tired.
 */

/** Earlier threshold values: these applied to activities before `untilMs` (the most recent such entry wins). */
export interface ThresholdChange { untilMs: number; ftp?: number | null; lthr?: number | null; pace?: number | null }

export interface Thresholds {
  /** functional threshold power, W */
  ftp: number | null;
  /** lactate-threshold heart rate, bpm */
  lthr: number | null;
  /** functional threshold pace as a speed, m/s (runs) */
  pace?: number | null;
  /** max and resting heart rate for the heart-rate stress model (defaults: LTHR / 0.9 and 60) */
  maxHr?: number | null;
  restHr?: number | null;
  /** Banister's weighting: 1.92 (men) or 1.67 (women) */
  trimpK?: number;
  /** values that applied before a date (TrainingPeaks lets you date threshold changes) */
  history?: ThresholdChange[];
}

/** Threshold HR from the zone settings: as set, or estimated as 90 % of max HR. */
export function lthrOf(cfg: HrZoneConfig | null): number | null {
  if (!cfg) return null;
  return cfg.mode === 'lthr' ? cfg.value : Math.round(cfg.value * 0.9);
}

/** The thresholds that applied on a date: the earliest history entry whose end lies after it, else the current ones. */
export function thresholdsAt(t: Thresholds, ms: number): Thresholds {
  const h = (t.history ?? []).filter((c) => ms < c.untilMs).sort((a, b) => a.untilMs - b.untilMs)[0];
  if (!h) return t;
  return { ...t, ftp: h.ftp ?? t.ftp, lthr: h.lthr ?? t.lthr, pace: h.pace ?? t.pace ?? null };
}

/** " Scored with FTP 230 W (an earlier value)." when a dated threshold applied, else "". */
export function effectiveLabel(t: Thresholds, ms: number): string {
  const e = thresholdsAt(t, ms);
  if (e === t) return '';
  const bits = [e.ftp !== t.ftp && e.ftp ? `FTP ${e.ftp} W` : '', e.lthr !== t.lthr && e.lthr ? `threshold HR ${e.lthr} bpm` : '', e.pace !== t.pace && e.pace ? 'an earlier threshold pace' : ''].filter(Boolean);
  return bits.length ? ` Scored with ${bits.join(' and ')}, the value of that day.` : '';
}

/** Seconds covered by a [value, seconds] histogram. */
const histSeconds = (h: [number, number][]) => h.reduce((s, [, t]) => s + t, 0);

/** Intensity factor: normalized power / FTP. */
export const intensityFactor = (a: Activity, ftp: number | null): number | null =>
  a.np !== null && ftp ? a.np / ftp : null;

export type LoadSource = 'power' | 'pace' | 'hr';
export interface Load { tss: number; source: LoadSource; if: number }

/** Banister TRIMP weight of one second at `bpm`. */
function trimpWeight(bpm: number, rest: number, max: number, k: number): number {
  const r = Math.max(0, Math.min(1.2, (bpm - rest) / (max - rest)));
  return r * Math.exp(k * r);
}

/** Heart-rate stress score: TRIMP of the activity over TRIMP of one hour at threshold HR, × 100. */
export function hrStress(hist: [number, number][], t: Thresholds): Load | null {
  const lthr = t.lthr;
  if (!lthr) return null;
  const rest = t.restHr ?? 60;
  const max = Math.max(t.maxHr ?? Math.round(lthr / 0.9), lthr + 5);
  const k = t.trimpK ?? 1.92;
  const ref = trimpWeight(lthr, rest, max, k) * 3600;
  let sum = 0, secs = 0;
  for (const [bpm, s] of hist) { sum += s * trimpWeight(bpm, rest, max, k); secs += s; }
  if (!secs || !(ref > 0)) return null;
  const tss = (sum / ref) * 100;
  return { tss, source: 'hr', if: Math.sqrt(tss / ((secs / 3600) * 100)) };
}

/** Training stress of one activity, or null when it has no stream that can be scored with the thresholds set. */
export function activityLoad(a: Activity, t0: Thresholds): Load | null {
  const t = thresholdsAt(t0, a.startMs);
  if (a.np !== null && a.powerHist && t.ftp) {
    const s = histSeconds(a.powerHist);
    const f = a.np / t.ftp;
    return { tss: (s * f * f * 100) / 3600, source: 'power', if: f };
  }
  if (a.ngp && t.pace && RUN_LIKE.has(a.sport) && a.movingS > 0) {
    const f = a.ngp / t.pace;
    return { tss: (a.movingS * f * f * 100) / 3600, source: 'pace', if: f };
  }
  if (a.hrHist) return hrStress(a.hrHist, t);
  return null;
}

export interface LoadDay {
  /** YYYY-MM-DD */
  date: string;
  day: number;
  tss: number;
  ctl: number;
  atl: number;
  tsb: number;
}

export interface LoadSummary {
  days: LoadDay[];
  /** activities whose load came from power / pace / heart rate / that had none */
  fromPower: number;
  fromPace: number;
  fromHr: number;
  without: number;
}

/** Daily fitness, fatigue and form from the first to the last activity (every day, rest days included). */
export function trainingLoad(acts: Activity[], t: Thresholds, tz: Tz): LoadSummary {
  const perDay = new Map<number, number>();
  let fromPower = 0, fromPace = 0, fromHr = 0, without = 0;
  for (const a of acts) {
    const l = activityLoad(a, t);
    if (!l) { without++; continue; }
    if (l.source === 'power') fromPower++; else if (l.source === 'pace') fromPace++; else fromHr++;
    const d = dayNumber(parts(a.startMs, tz));
    perDay.set(d, (perDay.get(d) ?? 0) + l.tss);
  }
  const days: LoadDay[] = [];
  if (perDay.size) {
    const keys = [...perDay.keys()];
    const first = Math.min(...keys), last = Math.max(...keys);
    let ctl = 0, atl = 0;
    for (let d = first; d <= last; d++) {
      const tss = perDay.get(d) ?? 0;
      const tsb = ctl - atl;
      ctl += (tss - ctl) / 42;
      atl += (tss - atl) / 7;
      days.push({ date: ymd(fromDayNumber(d)), day: d, tss, ctl, atl, tsb });
    }
  }
  return { days, fromPower, fromPace, fromHr, without };
}

/** Plain-language reading of form, using the bands TrainingPeaks and intervals.icu popularised. */
export function formLabel(tsb: number): { label: string; advice: string } {
  if (tsb > 25) return { label: 'Very fresh', advice: 'Well rested; fitness slowly fades if this lasts.' };
  if (tsb > 5) return { label: 'Fresh', advice: 'Ready for a race or a hard day.' };
  if (tsb >= -10) return { label: 'Neutral', advice: 'Balanced: training and recovery are even.' };
  if (tsb >= -30) return { label: 'Productive training', advice: 'Tired in the way that builds fitness.' };
  return { label: 'Overreaching', advice: 'Fatigue far above fitness; plan some easy days.' };
}

/** Change in fitness over the last 7 days of the data (TrainingPeaks' ramp rate). */
export function rampRate(days: LoadDay[]): number | null {
  if (days.length < 8) return null;
  return days[days.length - 1]!.ctl - days[days.length - 8]!.ctl;
}

export interface CurvePoint { seconds: number; watts: number; activityId: string; startMs: number }

/** Best power for each duration over a set of activities, with the activity that set it. */
export function bestPowerCurve(acts: Activity[], pick: (a: Activity) => [number, number][] | null = (a) => a.powerCurve): CurvePoint[] {
  const best = new Map<number, CurvePoint>();
  for (const a of acts) {
    for (const [s, w] of pick(a) ?? []) {
      const b = best.get(s);
      if (!b || w > b.watts) best.set(s, { seconds: s, watts: w, activityId: a.id, startMs: a.startMs });
    }
  }
  return [...best.values()].sort((x, y) => x.seconds - y.seconds);
}

/** Estimated FTP: 95 % of the best 20-minute power (the classic field test). */
export function estimateFtp(curve: CurvePoint[]): number | null {
  const p20 = curve.find((p) => p.seconds === 1200);
  return p20 ? Math.round(p20.watts * 0.95) : null;
}

/** Distances that make sense as best efforts for a sport (a ride's fastest 400 m says little). */
export function effortDistances(sport: string): number[] {
  return RUN_LIKE.has(sport)
    ? [400, 1000, 1609.344, 5000, 10000, 21097.5, 42195]
    : [5000, 10000, 20000, 40000, 50000, 100000, 160934.4];
}

export interface Effort { meters: number; seconds: number; activityId: string; startMs: number }

/** Top `n` efforts per distance among activities of one sport (one per activity). */
export function bestEffortsBySport(acts: Activity[], sport: string, n = 3): { meters: number; top: Effort[] }[] {
  const ds = effortDistances(sport);
  const same = acts.filter((a) => a.sport === sport && a.bestEfforts);
  return ds.map((meters) => {
    const all: Effort[] = [];
    for (const a of same) {
      const e = a.bestEfforts!.find(([m]) => Math.abs(m - meters) < 1);
      if (e) all.push({ meters, seconds: e[1], activityId: a.id, startMs: a.startMs });
    }
    return { meters, top: all.sort((x, y) => x.seconds - y.seconds).slice(0, n) };
  }).filter((r) => r.top.length);
}

/** "5 km", "Half marathon", "1 mile" … */
export function distanceName(m: number): string {
  if (Math.abs(m - 1609.344) < 1) return '1 mile';
  if (Math.abs(m - 160934.4) < 1) return '100 miles';
  if (Math.abs(m - 21097.5) < 1) return 'Half marathon';
  if (Math.abs(m - 42195) < 1) return 'Marathon';
  return m < 1000 ? `${m} m` : `${m / 1000} km`;
}

/** "5 s", "1 min", "20 min", "1 h", "1 h 30 min" */
export function durationName(s: number): string {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${s / 60} min`;
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Best heart rate and best pace for every duration, the same way as the power curve. */
export const bestHrCurve = (acts: Activity[]) => bestPowerCurve(acts, (a) => a.hrCurve);
export const bestPaceCurve = (acts: Activity[]) => bestPowerCurve(acts, (a) => a.paceCurve);

/** Estimated threshold pace (m/s): the best 30-minute average speed (Friel's 30-minute run test). */
export function estimateThresholdPace(curve: CurvePoint[]): number | null {
  const p = curve.find((x) => x.seconds === 1800);
  return p && p.watts > 1 ? Math.round(p.watts * 0.98 * 100) / 100 : null;
}

/**
 * Two-parameter critical-power model (Monod and Scherrer, as in WKO and intervals.icu): work done over the
 * best efforts of 3 to 20 minutes is a straight line in time, W = CP × t + W′. CP is the power you can hold
 * for a long time (close to FTP), W′ the energy (J) you can spend above it.
 */
export function criticalPower(curve: CurvePoint[]): { cp: number; wPrime: number } | null {
  const pts = curve.filter((p) => p.seconds >= 180 && p.seconds <= 1200);
  if (pts.length < 3 || pts[pts.length - 1]!.seconds - pts[0]!.seconds < 300) return null;
  const xs = pts.map((p) => p.seconds), ys = pts.map((p) => p.watts * p.seconds);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i]! - my); sxx += (x - mx) ** 2; });
  const cp = sxy / sxx, wPrime = my - cp * mx;
  return cp > 0 && wPrime > 0 ? { cp: Math.round(cp), wPrime: Math.round(wPrime) } : null;
}

/** Best power for some durations per period (TrainingPeaks' peak-power table): key → seconds → best. */
export function peaksBy(acts: Activity[], key: (a: Activity) => string, durations: number[]): { key: string; best: (CurvePoint | null)[] }[] {
  const groups = new Map<string, Activity[]>();
  for (const a of acts) if (a.powerCurve) (groups.get(key(a)) ?? groups.set(key(a), []).get(key(a))!).push(a);
  return [...groups.keys()].sort().reverse().map((k) => {
    const c = bestPowerCurve(groups.get(k)!);
    return { key: k, best: durations.map((d) => c.find((p) => p.seconds === d) ?? null) };
  });
}

/**
 * Efficiency factor (TrainingPeaks): output per heartbeat. Rides with power: normalized power / average HR.
 * Runs: normalized graded pace in metres per minute / average HR. Only activities of 20 minutes or more.
 */
export function efficiencyFactor(a: Activity): { ef: number; kind: 'power' | 'pace' } | null {
  if (!a.avgHr || a.movingS < 1200) return null;
  if (a.np !== null) return { ef: a.np / a.avgHr, kind: 'power' };
  if (RUN_LIKE.has(a.sport) && a.ngp) return { ef: (a.ngp * 60) / a.avgHr, kind: 'pace' };
  return null;
}

/**
 * Eddington number: the largest E such that you covered at least E km (or miles) on at least E days.
 * Also how many more days of E + 1 you need for the next one.
 */
export function eddington(acts: Activity[], unitM: number, dayOf: (a: Activity) => number): { e: number; next: number } {
  const perDay = new Map<number, number>();
  for (const a of acts) perDay.set(dayOf(a), (perDay.get(dayOf(a)) ?? 0) + a.distanceM / unitM);
  const ds = [...perDay.values()].sort((a, b) => b - a);
  let e = 0;
  while (e < ds.length && ds[e]! >= e + 1) e++;
  const next = Math.max(0, e + 1 - ds.filter((d) => d >= e + 1).length);
  return { e, next };
}
