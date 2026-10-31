import type { Activity, Tz } from '../types';
import { bySport, streaks, summarize, type Summary } from '../stats/summary';
import { activityLoad, bestPowerCurve, trainingLoad, type CurvePoint, type Thresholds } from '../stats/training';
import { findRegions } from '../stats/regions';
import { dayNumber, fromDayNumber, hourOf, parts, ymd } from '../util/time';
import { workEquivalents, workKj } from '../posters/power';
import { trimRoute } from '../posters';

/*
 * Sport Wrapped: the numbers behind the year-in-review story. Pure functions, so they can be tested on the
 * demo data like the other stats. The cards (cards.ts) only format and draw what this returns.
 */

export type WrappedPeriod = number | 'all';

export type CardId = 'intro' | 'distance' | 'time' | 'climb' | 'rhythm' | 'clock' | 'longest' | 'week' | 'gap' | 'prs' | 'fitness' | 'work' | 'places' | 'names' | 'type' | 'compare' | 'summary';

export interface Pr {
  kind: 'effort' | 'power';
  /** sport of a best effort ('' for power) */
  sport: string;
  /** metres (effort) or seconds (power) */
  span: number;
  /** seconds (effort) or watts (power) */
  value: number;
  /** the best before this period, null when there is none (all time) */
  before: number | null;
  activityId: string;
}

export interface Archetype { id: 'early' | 'owl' | 'weekend' | 'climber' | 'metronome' | 'explorer' | 'allrounder'; name: string; why: string }

export interface Week { start: number; distanceM: number; movingS: number; count: number; bySport: Map<string, number> }

export interface Wrapped {
  period: WrappedPeriod;
  /** "2025" or "2016–2025" */
  label: string;
  firstYear: number;
  acts: Activity[];
  summary: Summary;
  sports: { sport: string; summary: Summary; share: number }[];
  activeDays: number;
  /** first and last day (day numbers) the period covers: 1 Jan – 31 Dec, or first – last activity */
  day0: number;
  day1: number;
  /** per day of the period: distance (m), elevation (m), moving seconds */
  daily: { m: number; e: number; s: number }[];
  /** every week (Monday start) from the first to the last of the period, rest weeks included */
  weeks: Week[];
  /** activities per weekday (Mon first), per hour of the start, and a weekday × hour grid */
  weekdays: number[];
  hours: number[];
  punch: number[][];
  /** start time of day of every activity (hours, 0–24), and the earliest and latest (after 3 am counts as early) */
  starts: number[];
  earliest: { a: Activity; hour: number } | null;
  latest: { a: Activity; hour: number } | null;
  longest: Activity | null;
  /** route of the longest activity with the ends trimmed (privacy), null without GPS */
  longestRoute: number[] | null;
  biggestWeek: Week | null;
  longestStreak: { days: number; start: string; end: string } | null;
  /** longest run of days without an activity between two active days */
  gap: { days: number; from: string; to: string; d0: number } | null;
  prs: Pr[];
  curveNow: CurvePoint[];
  curveBefore: CurvePoint[];
  peakCtl: { ctl: number; date: string } | null;
  /** fitness (CTL) on each day of the period */
  ctlSeries: number[];
  workKj: number;
  pizza: number;
  /** work per month (year) or per year (all time), kJ */
  workBy: { label: string; kj: number }[];
  places: { count: number; names: string[] };
  /** routes of the busiest region, ends trimmed (at most 400) */
  routes: number[][];
  /** most used activity names, and the share of activities with a name used only once */
  names: { name: string; n: number }[];
  uniqueNames: number;
  archetype: Archetype;
  previous: { year: number; summary: Summary; cum: number[] } | null;
  /** each year with its summary and cumulative distance at the end of each week of the year (53 points) */
  years: { year: number; summary: Summary; cum: number[] }[];
  cards: CardId[];
}

export interface WrappedOptions {
  tz: Tz;
  thresholds: Thresholds | null;
  /** metres cut from both ends of the routes shown */
  hideEnds: number;
}

/** Years with activities, newest first. */
export function wrappedYears(acts: Activity[], tz: Tz): number[] {
  return [...new Set(acts.map((a) => parts(a.startMs, tz).y))].sort((a, b) => b - a);
}

/**
 * The stats page shows the Wrapped banner from 15 December to 15 January, offering the year that is ending
 * (in January, the one just ended). Otherwise null: Wrapped stays reachable from the sidebar and the records.
 */
export function wrappedSeason(now: Date): number | null {
  const m = now.getMonth() + 1, d = now.getDate();
  if (m === 12 && d >= 15) return now.getFullYear();
  if (m === 1 && d <= 15) return now.getFullYear() - 1;
  return null;
}

const POWER_SPANS = [5, 60, 300, 1200, 3600];
const EFFORT_SPANS: Record<string, number[]> = { Run: [1000, 5000, 10000, 21097.5, 42195], Ride: [20000, 40000, 100000] };

/** Best efforts and power bests of the period that beat everything before it (all time: the all-time bests). */
export function personalRecords(all: Activity[], period: WrappedPeriod, tz: Tz): Pr[] {
  const yearOf = (a: Activity) => parts(a.startMs, tz).y;
  const now = all.filter((a) => period === 'all' || yearOf(a) === period);
  const earlier = all.filter((a) => period !== 'all' && yearOf(a) < period);
  const out: Pr[] = [];
  const curNow = bestPowerCurve(now), curBefore = bestPowerCurve(earlier);
  for (const s of POWER_SPANS) {
    const p = curNow.find((c) => c.seconds === s);
    if (!p) continue;
    const b = curBefore.find((c) => c.seconds === s)?.watts ?? null;
    if (period === 'all' || (b !== null && p.watts > b)) out.push({ kind: 'power', sport: '', span: s, value: p.watts, before: b, activityId: p.activityId });
  }
  for (const [sport, spans] of Object.entries(EFFORT_SPANS)) {
    for (const m of spans) {
      const best = (xs: Activity[]) => {
        let b: { s: number; id: string } | null = null;
        for (const a of xs) {
          if (a.sport !== sport) continue;
          const e = a.bestEfforts?.find(([d]) => Math.abs(d - m) < 1);
          if (e && (!b || e[1] < b.s)) b = { s: e[1], id: a.id };
        }
        return b;
      };
      const n = best(now);
      if (!n) continue;
      const b = best(earlier)?.s ?? null;
      if (period === 'all' || (b !== null && n.s < b)) out.push({ kind: 'effort', sport, span: m, value: n.s, before: b, activityId: n.id });
    }
  }
  return out;
}

/**
 * What kind of athlete the period shows, by simple rules. Each rule gives a score (1 = just meets it);
 * the highest score of at least 1 wins, else "All-rounder".
 */
export function archetype(acts: Activity[], tz: Tz): Archetype {
  const n = acts.length;
  if (n < 5) return { id: 'allrounder', name: 'All-rounder', why: 'A bit of everything.' };
  const hours = acts.map((a) => hourOf(a.startMs, tz));
  const early = hours.filter((x) => x >= 3 && x < 8).length / n;
  const late = hours.filter((x) => x >= 19 || x < 3).length / n;
  const moving = acts.reduce((s, a) => s + a.movingS, 0) || 1;
  const weekend = acts.filter((a) => parts(a.startMs, tz).wd >= 5).reduce((s, a) => s + a.movingS, 0) / moving;
  const dist = acts.reduce((s, a) => s + a.distanceM, 0);
  const climb = dist > 0 ? acts.reduce((s, a) => s + a.elevGainM, 0) / (dist / 1000) : 0;
  const weeks = new Map<number, number>();
  for (const a of acts) { const p = parts(a.startMs, tz); const w = dayNumber(p) - p.wd; weeks.set(w, (weeks.get(w) ?? 0) + a.movingS); }
  const ks = [...weeks.keys()];
  const k0 = Math.min(...ks);
  const span = (Math.max(...ks) - k0) / 7 + 1;
  const vols = Array.from({ length: span }, (_, i) => weeks.get(k0 + i * 7) ?? 0);
  const mean = vols.reduce((s, v) => s + v, 0) / vols.length;
  const cv = mean > 0 ? Math.sqrt(vols.reduce((s, v) => s + (v - mean) ** 2, 0) / vols.length) / mean : Infinity;
  const routed = acts.filter((a) => a.route && a.route.length >= 4);
  const mids = new Set(routed.map((a) => { const i = (a.route!.length >> 2) * 2; return `${Math.round(a.route![i]! * 50)},${Math.round(a.route![i + 1]! * 50)}`; }));
  const explore = routed.length >= 10 ? mids.size / routed.length : 0;

  const pct = (x: number) => `${Math.round(x * 100)} %`;
  const rules: (Archetype & { score: number })[] = [
    { id: 'early', name: 'Early bird', why: `${pct(early)} of your activities started before 8 am.`, score: early / 0.4 },
    { id: 'owl', name: 'Night owl', why: `${pct(late)} of your activities started after 7 pm.`, score: late / 0.3 },
    { id: 'weekend', name: 'Weekend warrior', why: `${pct(weekend)} of your time moving was on Saturdays and Sundays.`, score: weekend / 0.55 },
    { id: 'climber', name: 'Climber', why: `You climbed ${Math.round(climb)} m for every kilometre.`, score: climb / 15 },
    { id: 'metronome', name: 'Metronome', why: 'Week after week, about the same amount of training.', score: span >= 12 ? 0.45 / cv : 0 },
    { id: 'explorer', name: 'Explorer', why: `${pct(explore)} of your routes went somewhere new.`, score: explore / 0.6 },
  ];
  const top = rules.sort((a, b) => b.score - a.score)[0]!;
  return top.score >= 1 ? { id: top.id, name: top.name, why: top.why } : { id: 'allrounder', name: 'All-rounder', why: 'No single habit stood out. You mix it up.' };
}

const dayOf = (y: number, m: number, d: number) => dayNumber({ y, m, d, wd: 0 });

/** Cumulative distance at the end of each of the 53 weeks of a year. */
function weeklyCum(acts: Activity[], year: number, tz: Tz): number[] {
  const d0 = dayOf(year, 1, 1);
  const per = Array<number>(53).fill(0);
  for (const a of acts) per[Math.min(52, Math.floor((dayNumber(parts(a.startMs, tz)) - d0) / 7))]! += a.distanceM;
  let s = 0;
  return per.map((v) => (s += v));
}

export function wrappedStats(all: Activity[], period: WrappedPeriod, o: WrappedOptions): Wrapped {
  const { tz } = o;
  const yearOf = (a: Activity) => parts(a.startMs, tz).y;
  const acts = (period === 'all' ? all : all.filter((a) => yearOf(a) === period)).slice().sort((a, b) => a.startMs - b.startMs);
  const years = wrappedYears(all, tz).sort((a, b) => a - b);
  const firstYear = years[0] ?? (period === 'all' ? new Date().getFullYear() : period);
  const label = period === 'all' ? (years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : String(firstYear)) : String(period);
  const summary = summarize(acts);
  const totalS = summary.movingS || 1;
  const sports = bySport(acts).map((x) => ({ ...x, share: x.summary.movingS / totalS })).sort((a, b) => b.summary.movingS - a.summary.movingS);

  const dn = (a: Activity) => dayNumber(parts(a.startMs, tz));
  const day0 = period === 'all' ? (acts.length ? dn(acts[0]!) : 0) : dayOf(period, 1, 1);
  const day1 = period === 'all' ? (acts.length ? dn(acts[acts.length - 1]!) : 0) : dayOf(period, 12, 31);
  const daily = Array.from({ length: day1 - day0 + 1 }, () => ({ m: 0, e: 0, s: 0 }));
  const weekdays = Array<number>(7).fill(0), hours = Array<number>(24).fill(0);
  const punch = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const starts: number[] = [];
  let earliest: Wrapped['earliest'] = null, latest: Wrapped['latest'] = null;
  const w0 = day0 - parts(Date.UTC(1970, 0, 1) + day0 * 86_400_000, 'UTC').wd;
  const weeks: Week[] = [];
  for (let s = w0; s <= day1; s += 7) weeks.push({ start: s, distanceM: 0, movingS: 0, count: 0, bySport: new Map() });
  const days = new Set<number>();
  for (const a of acts) {
    const p = parts(a.startMs, tz);
    const d = dayNumber(p);
    days.add(d);
    const x = daily[d - day0]!;
    x.m += a.distanceM; x.e += a.elevGainM; x.s += a.movingS;
    const hr = hourOf(a.startMs, tz);
    weekdays[p.wd]!++;
    hours[Math.floor(hr) % 24]!++;
    punch[p.wd]![Math.floor(hr) % 24]!++;
    starts.push(hr);
    const late = hr < 3 ? hr + 24 : hr; // half past midnight is late, not early
    if (!earliest || late < (earliest.hour < 3 ? earliest.hour + 24 : earliest.hour)) earliest = { a, hour: hr };
    if (!latest || late > (latest.hour < 3 ? latest.hour + 24 : latest.hour)) latest = { a, hour: hr };
    const wk = weeks[Math.floor((d - w0) / 7)]!;
    wk.distanceM += a.distanceM; wk.movingS += a.movingS; wk.count++;
    wk.bySport.set(a.sport, (wk.bySport.get(a.sport) ?? 0) + a.movingS);
  }
  let biggestWeek: Week | null = null;
  for (const w of weeks) if (w.count && (!biggestWeek || w.distanceM > biggestWeek.distanceM || (w.distanceM === biggestWeek.distanceM && w.movingS > biggestWeek.movingS))) biggestWeek = w;

  const sortedDays = [...days].sort((a, b) => a - b);
  let gap: Wrapped['gap'] = null;
  for (let i = 1; i < sortedDays.length; i++) {
    const g = sortedDays[i]! - sortedDays[i - 1]! - 1;
    if (g > 0 && (!gap || g > gap.days)) gap = { days: g, from: ymd(fromDayNumber(sortedDays[i - 1]! + 1)), to: ymd(fromDayNumber(sortedDays[i]! - 1)), d0: sortedDays[i - 1]! + 1 };
  }

  let longest: Activity | null = null;
  for (const a of acts) if (!longest || a.distanceM > longest.distanceM || (a.distanceM === longest.distanceM && a.movingS > longest.movingS)) longest = a;
  const longestRoute = longest ? trimRoute(longest.route, longest.distanceM, o.hideEnds) : null;

  let peakCtl: Wrapped['peakCtl'] = null;
  const ctlSeries: number[] = [];
  const t = o.thresholds;
  if (t && (t.ftp || t.lthr || t.pace) && acts.some((a) => activityLoad(a, t))) {
    for (const d of trainingLoad(all, t, tz).days) {
      if (d.day < day0 || d.day > day1) continue;
      ctlSeries.push(d.ctl);
      if (!peakCtl || d.ctl > peakCtl.ctl) peakCtl = { ctl: d.ctl, date: d.date };
    }
    if (peakCtl && peakCtl.ctl < 1) { peakCtl = null; ctlSeries.length = 0; }
  }

  const kj = acts.reduce((s, a) => s + workKj(a), 0);
  const workBy = period === 'all'
    ? years.map((y) => ({ label: `’${String(y).slice(2)}`, kj: acts.filter((a) => yearOf(a) === y).reduce((s, a) => s + workKj(a), 0) }))
    : 'JFMAMJJASOND'.split('').map((label, m) => ({ label, kj: acts.filter((a) => parts(a.startMs, tz).m === m + 1).reduce((s, a) => s + workKj(a), 0) }));

  // Places: regions found over the whole history (so "Home area" means the same everywhere), counted here.
  const regions = findRegions(all);
  const ids = new Set(acts.map((a) => a.id));
  const here = regions.map((r) => ({ r, n: [...r.activityIds].filter((id) => ids.has(id)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const places = { count: here.length, names: here.slice(0, 4).map((x) => x.r.name) };
  const home = here[0]?.r.activityIds;
  const routes = acts.filter((a) => a.route && (!home || home.has(a.id))).slice(-400)
    .map((a) => trimRoute(a.route, a.distanceM, o.hideEnds)).filter((r): r is number[] => !!r && r.length >= 4);

  const nameCount = new Map<string, number>();
  for (const a of acts) { const n = a.name.trim(); if (n) nameCount.set(n, (nameCount.get(n) ?? 0) + 1); }
  const names = [...nameCount].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n).slice(0, 5);
  const uniqueNames = acts.length ? [...nameCount.values()].filter((n) => n === 1).length / acts.length : 0;

  const perYear = years.map((y) => {
    const ya = all.filter((a) => yearOf(a) === y);
    return { year: y, summary: summarize(ya), cum: weeklyCum(ya, y, tz) };
  });
  const previous = period === 'all' ? null : perYear.find((x) => x.year === period - 1) ?? null;
  const curveNow = bestPowerCurve(acts);
  const curveBefore = period === 'all' ? [] : bestPowerCurve(all.filter((a) => yearOf(a) < period));

  const w: Wrapped = {
    period, label, firstYear, acts, summary, sports, activeDays: days.size, day0, day1, daily, weeks, weekdays, hours, punch, starts, earliest, latest,
    longest, longestRoute, biggestWeek, longestStreak: streaks(sortedDays).longest, gap, prs: personalRecords(all, period, tz), curveNow, curveBefore,
    peakCtl, ctlSeries, workKj: kj, pizza: workEquivalents(kj)[0]!.value, workBy, places, routes, names, uniqueNames,
    archetype: archetype(acts, tz), previous, years: perYear, cards: [],
  };
  w.cards = cardsFor(w);
  return w;
}

/** The cards this period has data for, in story order. */
function cardsFor(w: Wrapped): CardId[] {
  if (!w.acts.length) return [];
  const n = w.acts.length;
  const c: CardId[] = ['intro'];
  if (w.summary.distanceM > 0) c.push('distance');
  if (w.summary.movingS > 0) c.push('time');
  if (w.summary.elevGainM >= 100) c.push('climb');
  if (n >= 10) c.push('rhythm', 'clock');
  if (w.longest) c.push('longest');
  if (w.biggestWeek && n >= 3) c.push('week');
  if (w.gap && n >= 10) c.push('gap');
  if (w.prs.length) c.push('prs');
  if (w.peakCtl) c.push('fitness');
  if (w.workKj >= 1) c.push('work');
  if (w.routes.length >= 5) c.push('places');
  if (w.names[0] && n >= 10) c.push('names');
  if (n >= 5) c.push('type');
  if (w.period === 'all' ? w.years.length >= 2 : !!w.previous) c.push('compare');
  c.push('summary');
  return c;
}

/** Landmark distances (km) for "further than …". Great-circle distances, rounded. */
export const LANDMARKS: [number, string][] = [
  [42.195, 'a marathon'],
  [344, 'London to Paris'],
  [1_407, 'Land’s End to John o’ Groats'],
  [3_900, 'Lisbon to Moscow'],
  [4_500, 'coast to coast across the USA'],
  [5_570, 'London to New York'],
  [7_200, 'Cape Town to Cairo'],
  [16_990, 'London to Sydney'],
];

/** A sentence that puts a distance into perspective. */
export function distanceEquivalent(m: number): string {
  const km = m / 1000;
  const earth = km / 40_075;
  if (km >= 384_400) return `${(km / 384_400).toFixed(1)}× the way to the Moon`;
  if (earth >= 1) return `${earth.toFixed(1)} times around the Earth`;
  const mark = [...LANDMARKS].reverse().find(([d]) => km >= d);
  const pct = Math.round(earth * 100);
  if (!mark) return 'a good start';
  return pct >= 5 ? `further than ${mark[1]}, ${pct} % of the way around the Earth` : `further than ${mark[1]}`;
}

/** The light-hearted line under the earliest and latest start. */
export function clockQuip(earliest: number, latest: number): string {
  const late = latest < 3 ? latest + 24 : latest;
  if (late >= 23) return 'Midnight sessions. Everything all right at home?';
  if (late >= 21) return 'Some people watch TV in the evening. Not you.';
  if (earliest < 5.5) return 'Up before the birds. They have questions.';
  if (earliest < 6.5) return 'The alarm went off before six. More than once.';
  if (earliest >= 8 && late < 19) return 'Never before eight, never after seven. Office hours.';
  return 'Neither too early nor too late. Very civilised.';
}

/** The line under the longest break. */
export function gapQuip(days: number): string {
  if (days >= 60) return 'A long break. The bike missed you.';
  if (days >= 21) return 'Recovery, we assume. Thorough recovery.';
  if (days >= 14) return 'More than two weeks off. Holiday, or just the weather?';
  if (days >= 7) return 'A whole week off. Somebody needed a rest.';
  if (days >= 3) return 'Your longest rest was a few days. Do you ever stop?';
  return 'Barely a rest day all year. Your legs would like a word.';
}

/** The line under the most used activity name. */
export function nameQuip(top: { name: string; n: number }, total: number, unique: number): string {
  if (unique >= 0.6) return `${Math.round(unique * 100)} % of your activities got a name of their own. A poet.`;
  if (top.n / total >= 0.25) return `“${top.name}” ${top.n} times. Creative.`;
  return `“${top.name}” was your favourite, ${top.n} times.`;
}
