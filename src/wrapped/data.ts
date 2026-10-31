import type { Activity, Tz } from '../types';
import { bySport, records, streaks, summarize, type Summary } from '../stats/summary';
import { activityLoad, bestPowerCurve, trainingLoad, type Thresholds } from '../stats/training';
import { findRegions } from '../stats/regions';
import { dayNumber, fromDayNumber, hourOf, parts, ymd } from '../util/time';
import { workEquivalents, workKj } from '../posters/power';
import { trimRoute } from '../posters';

/*
 * Sport Wrapped: the numbers behind the year-in-review story. Pure functions, so they can be tested on the
 * demo data like the other stats. The cards (cards.ts) only format and draw what this returns.
 */

export type WrappedPeriod = number | 'all';

export type CardId = 'intro' | 'distance' | 'time' | 'climb' | 'rhythm' | 'longest' | 'week' | 'prs' | 'fitness' | 'work' | 'places' | 'type' | 'compare' | 'summary';

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

export interface Wrapped {
  period: WrappedPeriod;
  /** "2025" or "2016–2025" */
  label: string;
  /** first year with data (for "since 2016") */
  firstYear: number;
  acts: Activity[];
  summary: Summary;
  sports: { sport: string; summary: Summary; share: number }[];
  activeDays: number;
  /** activities per weekday (Mon first), per hour of the start, distance per calendar month */
  weekdays: number[];
  hours: number[];
  months: number[];
  longest: Activity | null;
  /** route of the longest activity with the ends trimmed (privacy), null without GPS */
  longestRoute: number[] | null;
  biggestWeek: { start: string; distanceM: number; movingS: number; count: number } | null;
  longestStreak: { days: number; start: string; end: string } | null;
  prs: Pr[];
  /** highest fitness (CTL) in the period, only when thresholds give a training load */
  peakCtl: { ctl: number; date: string } | null;
  /** fitness (CTL) on each day of the period, for the sparkline */
  ctlSeries: number[];
  workKj: number;
  pizza: number;
  places: { count: number; names: string[] };
  archetype: Archetype;
  /** the year before (year mode), or every year (all time) */
  previous: { year: number; summary: Summary } | null;
  years: { year: number; summary: Summary }[];
  cards: CardId[];
}

export interface WrappedOptions {
  tz: Tz;
  thresholds: Thresholds | null;
  /** metres cut from both ends of the longest route */
  hideEnds: number;
}

/** Years with activities, newest first. */
export function wrappedYears(acts: Activity[], tz: Tz): number[] {
  return [...new Set(acts.map((a) => parts(a.startMs, tz).y))].sort((a, b) => b - a);
}

const POWER_SPANS = [5, 60, 300, 1200, 3600];
const EFFORT_SPANS: Record<string, number[]> = { Run: [1000, 5000, 10000, 21097.5, 42195], Ride: [20000, 40000, 100000] };

/** Best efforts and power bests of the period that beat everything before it (all time: the all-time bests). */
export function personalRecords(all: Activity[], period: WrappedPeriod, tz: Tz): Pr[] {
  const yearOf = (a: Activity) => parts(a.startMs, tz).y;
  const inP = (a: Activity) => period === 'all' || yearOf(a) === period;
  const before = (a: Activity) => period !== 'all' && yearOf(a) < period;
  const out: Pr[] = [];
  const now = all.filter(inP), earlier = all.filter(before);

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
  const early = hours.filter((x) => x < 8).length / n;
  const late = hours.filter((x) => x >= 19).length / n;
  const moving = acts.reduce((s, a) => s + a.movingS, 0) || 1;
  const weekend = acts.filter((a) => parts(a.startMs, tz).wd >= 5).reduce((s, a) => s + a.movingS, 0) / moving;
  const dist = acts.reduce((s, a) => s + a.distanceM, 0);
  const climb = dist > 0 ? acts.reduce((s, a) => s + a.elevGainM, 0) / (dist / 1000) : 0;
  // weekly volume (moving time) between the first and the last week: low spread = metronome
  const weeks = new Map<number, number>();
  for (const a of acts) { const p = parts(a.startMs, tz); const w = dayNumber(p) - p.wd; weeks.set(w, (weeks.get(w) ?? 0) + a.movingS); }
  const ks = [...weeks.keys()];
  const span = ks.length ? (Math.max(...ks) - Math.min(...ks)) / 7 + 1 : 0;
  const vols = Array.from({ length: span }, (_, i) => weeks.get(Math.min(...ks) + i * 7) ?? 0);
  const mean = vols.reduce((s, v) => s + v, 0) / (vols.length || 1);
  const cv = mean > 0 ? Math.sqrt(vols.reduce((s, v) => s + (v - mean) ** 2, 0) / vols.length) / mean : Infinity;
  // distinct places (the middle of each route on a ~2 km grid) per activity with GPS
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
  return top.score >= 1 ? { id: top.id, name: top.name, why: top.why } : { id: 'allrounder', name: 'All-rounder', why: 'No single habit stood out: you mix it up.' };
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

  const weekdays = Array<number>(7).fill(0), hours = Array<number>(24).fill(0), months = Array<number>(12).fill(0);
  const days = new Set<number>();
  const weeks = new Map<number, { distanceM: number; movingS: number; count: number }>();
  for (const a of acts) {
    const p = parts(a.startMs, tz);
    weekdays[p.wd]!++;
    hours[Math.floor(hourOf(a.startMs, tz)) % 24]!++;
    months[p.m - 1]! += a.distanceM;
    const d = dayNumber(p);
    days.add(d);
    const w = weeks.get(d - p.wd) ?? { distanceM: 0, movingS: 0, count: 0 };
    w.distanceM += a.distanceM; w.movingS += a.movingS; w.count++;
    weeks.set(d - p.wd, w);
  }
  let biggestWeek: Wrapped['biggestWeek'] = null;
  for (const [start, w] of weeks) if (!biggestWeek || w.distanceM > biggestWeek.distanceM || (w.distanceM === biggestWeek.distanceM && w.movingS > biggestWeek.movingS)) biggestWeek = { start: ymd(fromDayNumber(start)), ...w };

  const rec = records(acts, tz);
  const longest = rec.longest ?? rec.longestDuration;
  const longestRoute = longest ? trimRoute(longest.route, longest.distanceM, o.hideEnds) : null;
  const st = streaks([...days]).longest;

  // Fitness: the load model runs over the whole history (fitness carries over from the year before).
  let peakCtl: Wrapped['peakCtl'] = null;
  const ctlSeries: number[] = [];
  const t = o.thresholds;
  if (t && (t.ftp || t.lthr || t.pace) && acts.some((a) => activityLoad(a, t))) {
    const prefix = period === 'all' ? '' : `${period}-`;
    for (const d of trainingLoad(all, t, tz).days) {
      if (!d.date.startsWith(prefix)) continue;
      ctlSeries.push(d.ctl);
      if (!peakCtl || d.ctl > peakCtl.ctl) peakCtl = { ctl: d.ctl, date: d.date };
    }
    if (peakCtl && peakCtl.ctl < 1) { peakCtl = null; ctlSeries.length = 0; }
  }

  const kj = acts.reduce((s, a) => s + workKj(a), 0);

  // Places: regions found over the whole history (so "Home area" means the same everywhere), counted here.
  const regions = findRegions(all);
  const ids = new Set(acts.map((a) => a.id));
  const here = regions.map((r) => ({ r, n: [...r.activityIds].filter((id) => ids.has(id)).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n);
  const places = { count: here.length, names: here.slice(0, 4).map((x) => x.r.name) };

  const perYear = years.map((y) => ({ year: y, summary: summarize(all.filter((a) => yearOf(a) === y)) }));
  const previous = period === 'all' ? null : perYear.find((x) => x.year === period - 1) ?? null;
  const prs = personalRecords(all, period, tz);

  const w: Wrapped = {
    period, label, firstYear, acts, summary, sports, activeDays: days.size, weekdays, hours, months, longest, longestRoute,
    biggestWeek, longestStreak: st, prs, peakCtl, ctlSeries, workKj: kj, pizza: workEquivalents(kj)[0]!.value, places,
    archetype: archetype(acts, tz), previous, years: perYear, cards: [],
  };
  w.cards = cardsFor(w);
  return w;
}

/** The cards this period has data for, in story order. */
function cardsFor(w: Wrapped): CardId[] {
  if (!w.acts.length) return [];
  const c: CardId[] = ['intro'];
  if (w.summary.distanceM > 0) c.push('distance');
  if (w.summary.movingS > 0) c.push('time');
  if (w.summary.elevGainM >= 100) c.push('climb');
  if (w.acts.length >= 3) c.push('rhythm');
  if (w.longest) c.push('longest');
  if (w.biggestWeek && w.acts.length >= 3) c.push('week');
  if (w.prs.length) c.push('prs');
  if (w.peakCtl) c.push('fitness');
  if (w.workKj >= 1) c.push('work');
  if (w.places.count >= 2) c.push('places');
  if (w.acts.length >= 5) c.push('type');
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
