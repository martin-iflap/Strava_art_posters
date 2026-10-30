import type { Activity, Tz } from '../types';
import { dayNumber, fromDayNumber, isoWeekKey, monthKey, parts, weekStart, yearKey, ymd } from '../util/time';

export interface Summary {
  count: number;
  distanceM: number;
  movingS: number;
  elapsedS: number;
  elevGainM: number;
  avgDistanceM: number;
  medianDistanceM: number;
  /** total distance / total moving time (time-weighted, not a mean of per-activity speeds) */
  avgSpeedMps: number;
  /** mean of per-activity average HR, weighted by moving time; null if no activity has HR */
  avgHr: number | null;
  avgPower: number | null;
  maxHr: number | null;
  maxPower: number | null;
}

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function weighted(acts: Activity[], pick: (a: Activity) => number | null): number | null {
  let sum = 0, w = 0;
  for (const a of acts) {
    const v = pick(a);
    if (v === null) continue;
    const wt = a.movingS > 0 ? a.movingS : 1;
    sum += v * wt;
    w += wt;
  }
  return w ? sum / w : null;
}

const maxOf = (acts: Activity[], pick: (a: Activity) => number | null): number | null => {
  let m: number | null = null;
  for (const a of acts) {
    const v = pick(a);
    if (v !== null && (m === null || v > m)) m = v;
  }
  return m;
};

export function summarize(acts: Activity[]): Summary {
  const distanceM = acts.reduce((s, a) => s + a.distanceM, 0);
  const movingS = acts.reduce((s, a) => s + a.movingS, 0);
  return {
    count: acts.length,
    distanceM,
    movingS,
    elapsedS: acts.reduce((s, a) => s + a.elapsedS, 0),
    elevGainM: acts.reduce((s, a) => s + a.elevGainM, 0),
    avgDistanceM: acts.length ? distanceM / acts.length : 0,
    medianDistanceM: median(acts.map((a) => a.distanceM)),
    avgSpeedMps: movingS > 0 ? distanceM / movingS : 0,
    avgHr: weighted(acts, (a) => a.avgHr),
    avgPower: weighted(acts, (a) => a.avgPower),
    maxHr: maxOf(acts, (a) => a.maxHr),
    maxPower: maxOf(acts, (a) => a.maxPower),
  };
}

export const filterSport = (acts: Activity[], sport: string | 'all') => (sport === 'all' ? acts : acts.filter((a) => a.sport === sport));

export const sportsOf = (acts: Activity[]): string[] => {
  const c = new Map<string, number>();
  for (const a of acts) c.set(a.sport, (c.get(a.sport) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
};

export function bySport(acts: Activity[]): { sport: string; summary: Summary }[] {
  return sportsOf(acts).map((sport) => ({ sport, summary: summarize(acts.filter((a) => a.sport === sport)) }));
}

export interface PeriodRow {
  key: string;
  /** first day of the period, YYYY-MM-DD (weeks start on Monday) */
  start: string;
  summary: Summary;
}

export type Period = 'week' | 'month' | 'year';

/**
 * Group by calendar period. Empty periods between the first and last activity are included
 * (count 0) so that charts have no gaps.
 */
export function byPeriod(acts: Activity[], period: Period, tz: Tz): PeriodRow[] {
  if (!acts.length) return [];
  const keyOf = (ms: number) => {
    const p = parts(ms, tz);
    return period === 'week' ? isoWeekKey(p) : period === 'month' ? monthKey(p) : yearKey(p);
  };
  const groups = new Map<string, Activity[]>();
  for (const a of acts) {
    const k = keyOf(a.startMs);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(a);
  }
  const first = parts(Math.min(...acts.map((a) => a.startMs)), tz);
  const last = parts(Math.max(...acts.map((a) => a.startMs)), tz);
  const rows: PeriodRow[] = [];
  const push = (key: string, start: string) => rows.push({ key, start, summary: summarize(groups.get(key) ?? []) });
  if (period === 'year') {
    for (let y = first.y; y <= last.y; y++) push(String(y), `${y}-01-01`);
  } else if (period === 'month') {
    for (let y = first.y, m = first.m; y < last.y || (y === last.y && m <= last.m); m === 12 ? (y++, (m = 1)) : m++) {
      const p = { y, m, d: 1, wd: 0 };
      push(monthKey(p), ymd(p));
    }
  } else {
    for (let d = weekStart(first); d <= weekStart(last); d += 7) {
      const p = fromDayNumber(d);
      push(isoWeekKey(p), ymd(p));
    }
  }
  return rows;
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function byWeekday(acts: Activity[], tz: Tz): { weekday: number; label: string; summary: Summary }[] {
  return WEEKDAYS.map((label, weekday) => ({
    weekday,
    label,
    summary: summarize(acts.filter((a) => parts(a.startMs, tz).wd === weekday)),
  }));
}

export interface Streak { days: number; start: string; end: string }

export interface Records {
  longest: Activity | null;
  biggestClimb: Activity | null;
  fastest: Activity | null;
  longestDuration: Activity | null;
  mostActiveDay: { date: string; count: number; distanceM: number } | null;
  mostActiveMonth: { key: string; count: number; distanceM: number } | null;
  longestStreak: Streak | null;
  /** Streak of consecutive active days ending on the last day with an activity in the data. */
  currentStreak: Streak | null;
}

const best = (acts: Activity[], score: (a: Activity) => number): Activity | null => {
  let b: Activity | null = null;
  for (const a of acts) if (score(a) > 0 && (!b || score(a) > score(b))) b = a;
  return b;
};

/** Days (as sorted unique day numbers) → longest run of consecutive days, and the run ending at the last day. */
export function streaks(dayNumbers: number[]): { longest: Streak | null; current: Streak | null } {
  const days = [...new Set(dayNumbers)].sort((a, b) => a - b);
  if (!days.length) return { longest: null, current: null };
  const mk = (s: number, e: number): Streak => ({ days: e - s + 1, start: ymd(fromDayNumber(s)), end: ymd(fromDayNumber(e)) });
  let bestS = days[0]!, bestE = days[0]!, runS = days[0]!;
  for (let i = 1; i <= days.length; i++) {
    if (i === days.length || days[i]! !== days[i - 1]! + 1) {
      const runE = days[i - 1]!;
      if (runE - runS > bestE - bestS) { bestS = runS; bestE = runE; }
      if (i === days.length) return { longest: mk(bestS, bestE), current: mk(runS, runE) };
      runS = days[i]!;
    }
  }
  return { longest: mk(bestS, bestE), current: null };
}

export function records(acts: Activity[], tz: Tz): Records {
  const perDay = new Map<number, { count: number; distanceM: number }>();
  const perMonth = new Map<string, { count: number; distanceM: number }>();
  for (const a of acts) {
    const p = parts(a.startMs, tz);
    const dn = dayNumber(p);
    const d = perDay.get(dn) ?? { count: 0, distanceM: 0 };
    d.count++; d.distanceM += a.distanceM;
    perDay.set(dn, d);
    const mk = monthKey(p);
    const m = perMonth.get(mk) ?? { count: 0, distanceM: 0 };
    m.count++; m.distanceM += a.distanceM;
    perMonth.set(mk, m);
  }
  let mostDay: Records['mostActiveDay'] = null;
  for (const [dn, v] of perDay) if (!mostDay || v.distanceM > mostDay.distanceM) mostDay = { date: ymd(fromDayNumber(dn)), ...v };
  let mostMonth: Records['mostActiveMonth'] = null;
  for (const [key, v] of perMonth) if (!mostMonth || v.distanceM > mostMonth.distanceM) mostMonth = { key, ...v };
  const st = streaks([...perDay.keys()]);
  return {
    longest: best(acts, (a) => a.distanceM),
    biggestClimb: best(acts, (a) => a.elevGainM),
    // Fastest average speed, ignoring very short activities (< 5 km or < 10 min) that skew it.
    fastest: best(acts.filter((a) => a.distanceM >= 5000 && a.movingS >= 600), (a) => (a.movingS > 0 ? a.distanceM / a.movingS : 0)),
    longestDuration: best(acts, (a) => a.movingS),
    mostActiveDay: mostDay,
    mostActiveMonth: mostMonth,
    longestStreak: st.longest,
    currentStreak: st.current,
  };
}
