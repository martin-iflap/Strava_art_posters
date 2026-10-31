import type { Activity, Tz } from '../types';
import { dayNumber, fromDayNumber, parts, ymd } from '../util/time';
import type { HrZoneConfig } from './zones';

/**
 * Training-load maths as used by TrainingPeaks, intervals.icu and (in spirit) Strava's Fitness & Freshness.
 *  - TSS (Training Stress Score): 100 = one hour at threshold. From power when the activity has a power
 *    stream and an FTP is set, otherwise estimated from heart rate against threshold heart rate (hrTSS).
 *  - Fitness (CTL): 42-day exponentially weighted average of daily TSS. Fatigue (ATL): the 7-day one.
 *  - Form (TSB): yesterday's fitness minus yesterday's fatigue. Positive = fresh, negative = tired.
 */

export interface Thresholds {
  /** functional threshold power, W */
  ftp: number | null;
  /** lactate-threshold heart rate, bpm */
  lthr: number | null;
}

/** Threshold HR from the zone settings: as set, or estimated as 90 % of max HR. */
export function lthrOf(cfg: HrZoneConfig | null): number | null {
  if (!cfg) return null;
  return cfg.mode === 'lthr' ? cfg.value : Math.round(cfg.value * 0.9);
}

/** Seconds covered by a [value, seconds] histogram. */
const histSeconds = (h: [number, number][]) => h.reduce((s, [, t]) => s + t, 0);

/** Intensity factor: normalized power / FTP. */
export const intensityFactor = (a: Activity, ftp: number | null): number | null =>
  a.np !== null && ftp ? a.np / ftp : null;

export type LoadSource = 'power' | 'hr';
export interface Load { tss: number; source: LoadSource; if: number }

/** Training stress of one activity, or null when it has neither power (with FTP) nor heart rate (with a threshold). */
export function activityLoad(a: Activity, t: Thresholds): Load | null {
  if (a.np !== null && a.powerHist && t.ftp) {
    const s = histSeconds(a.powerHist);
    const f = a.np / t.ftp;
    return { tss: (s * f * f * 100) / 3600, source: 'power', if: f };
  }
  if (a.hrHist && t.lthr) {
    // hrTSS: every second weighted by (HR / threshold HR)², the same shape as power TSS.
    let sum = 0, secs = 0;
    for (const [bpm, s] of a.hrHist) { sum += s * (bpm / t.lthr) ** 2; secs += s; }
    if (!secs) return null;
    return { tss: (sum * 100) / 3600, source: 'hr', if: Math.sqrt(sum / secs) };
  }
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
  /** activities whose load came from power / heart rate / that had neither */
  fromPower: number;
  fromHr: number;
  without: number;
}

/** Daily fitness, fatigue and form from the first to the last activity (every day, rest days included). */
export function trainingLoad(acts: Activity[], t: Thresholds, tz: Tz): LoadSummary {
  const perDay = new Map<number, number>();
  let fromPower = 0, fromHr = 0, without = 0;
  for (const a of acts) {
    const l = activityLoad(a, t);
    if (!l) { without++; continue; }
    if (l.source === 'power') fromPower++; else fromHr++;
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
  return { days, fromPower, fromHr, without };
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
export function bestPowerCurve(acts: Activity[]): CurvePoint[] {
  const best = new Map<number, CurvePoint>();
  for (const a of acts) {
    for (const [s, w] of a.powerCurve ?? []) {
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

const RUN_LIKE = new Set(['Run', 'Walk', 'Hike', 'Trail Run', 'Virtual Run']);
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
