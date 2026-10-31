import { h } from '../dom';
import type { Tz, Units } from '../types';
import { WEEKDAYS } from '../stats/summary';
import { distanceName, durationName } from '../stats/training';
import { niceStep } from '../posters/common';
import { fromDayNumber } from '../util/time';
import { distance, distanceUnit, elevation, elevationUnit, formatDuration } from '../util/units';
import { area, bars, cumulative, dayTicks, gapStrip, heatYear, heatYears, hbars, powerCurves, profile, punchCard, routesMap, scatter, shareBar, startStrip, waffle } from './charts';
import { clockQuip, distanceEquivalent, gapQuip, nameQuip, type CardId, type Pr, type Wrapped } from './data';

/*
 * One function per Wrapped card: a little text and a chart drawn from the data. The text is real text
 * (the player reads it out through a live region); numbers with data-count count up when the card shows.
 * Look: the app's dark theme, one accent colour, no decoration that is not data.
 */

export interface CardCtx { units: Units; tz: Tz }
export interface Card { el: HTMLElement; say: string }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

const loc = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const dayLabel = (ymd: string) => { const [, m, d] = ymd.split('-').map(Number); return `${d} ${MONTHS[m! - 1]!.slice(0, 3)}`; };
const clock = (hr: number) => `${String(Math.floor(hr)).padStart(2, '0')}:${String(Math.floor((hr % 1) * 60)).padStart(2, '0')}`;

/** Parse a chart string into an element (all text in it was escaped by the chart code). */
function chart(s: string): Element {
  const doc = new DOMParser().parseFromString(s, 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}

const count = (value: number, decimals = 0) => h('span', { class: 'w-big', 'data-count': value, 'data-dec': decimals }, loc(value, decimals));
const kicker = (t: string) => h('p', { class: 'w-kicker' }, t);
const num = (value: number, unit: string, decimals = 0) => h('p', { class: 'w-num' }, count(value, decimals), h('span', { class: 'w-unit' }, unit));
const headline = (t: string) => h('h2', { class: 'w-head' }, t);
const caption = (...c: (Node | string)[]) => h('p', { class: 'w-line' }, ...c);
const figure = (...c: (Element | null)[]) => h('div', { class: 'w-fig' }, ...c);
const wrap = (id: CardId, ...c: (Node | null)[]) => h('div', { class: `w-card w-${id}` }, ...c);
const stats = (rows: [string, string][]) => h('dl', { class: 'w-stats' }, ...rows.map(([v, l]) => h('div', {}, h('dd', {}, v), h('dt', {}, l))));
const legend = (items: [string, string][]) => h('p', { class: 'w-legend' }, ...items.map(([cls, t]) => h('span', {}, h('b', { class: cls }), t)));

/** Tick positions (index into the daily arrays) for the period. */
const ticksOf = (w: Wrapped) => dayTicks(w.day0, w.day1).map((t) => ({ at: t.day - w.day0, label: t.label }));
const cum = (xs: number[]) => { let s = 0; return xs.map((v) => (s += v)); };

function intro(w: Wrapped): Card {
  const all = w.period === 'all';
  const sub = `${loc(w.summary.count)} activities on ${loc(w.activeDays)} days${all ? ` since ${w.firstYear}` : ''}.`;
  return {
    el: wrap('intro', kicker('Sport Wrapped'), h('h2', { class: 'w-title' }, w.label),
      caption(all ? 'Every year you have recorded, in one story.' : 'Your year in sport.'),
      figure(chart(all ? heatYears(w.daily.map((d) => d.m), w.day0) : heatYear(w.daily.map((d) => d.s), w.day0))),
      caption(sub, h('br'), h('span', { class: 'w-muted' }, all ? 'Each square is a week, brighter for further.' : 'Each dot is a day, brighter for longer.'))),
    say: `Sport Wrapped ${w.label}. ${sub}`,
  };
}

function distanceCard(w: Wrapped, c: CardCtx): Card {
  const v = distance(w.summary.distanceM, c.units), u = distanceUnit(c.units);
  const eq = distanceEquivalent(w.summary.distanceM);
  const series = cum(w.daily.map((d) => distance(d.m, c.units)));
  return {
    el: wrap('distance', kicker('Distance'), num(v, u, v < 100 ? 1 : 0),
      figure(chart(cumulative(series, { ticks: ticksOf(w), end: `${loc(v)} ${u}` }))),
      caption(`That’s ${eq}.`)),
    say: `You covered ${loc(v, v < 100 ? 1 : 0)} ${u}. That’s ${eq}.`,
  };
}

function timeCard(w: Wrapped): Card {
  const hours = w.summary.movingS / 3600;
  const [s1, s2] = w.sports;
  const stack = w.weeks.map((wk): [number, number, number] => {
    const a = s1 ? wk.bySport.get(s1.sport) ?? 0 : 0, b = s2 ? wk.bySport.get(s2.sport) ?? 0 : 0;
    return [a, b, wk.movingS - a - b];
  });
  const rest = w.sports.slice(2).reduce((s, x) => s + x.summary.movingS, 0) / 3600;
  const items: [string, string][] = [];
  if (s1) items.push(['acc', `${s1.sport} ${loc(s1.summary.movingS / 3600)} h`]);
  if (s2) items.push(['light', `${s2.sport} ${loc(s2.summary.movingS / 3600)} h`]);
  if (rest > 0) items.push(['faint', `Other ${loc(rest)} h`]);
  const days = hours / 24;
  const sub = days >= 1 ? `${loc(days, 1)} days, if you had done it all in one go.` : `${loc(hours * 60)} minutes, all told.`;
  return {
    el: wrap('time', kicker('Time moving'), num(hours, 'hours', hours < 10 ? 1 : 0),
      figure(chart(bars(w.weeks.map((x) => x.movingS), { stack, h: 140 }))), legend(items), caption(sub)),
    say: `${loc(hours, hours < 10 ? 1 : 0)} hours moving. ${items.map((i) => i[1]).join(', ')}. ${sub}`,
  };
}

function climbCard(w: Wrapped, c: CardCtx): Card {
  const ev = w.summary.elevGainM / 8849;
  const v = elevation(w.summary.elevGainM, c.units), u = elevationUnit(c.units);
  const every = ev <= 8 ? 1 : niceStep(ev, 6);
  const lines = Array.from({ length: Math.floor(ev / every) }, (_, i) => ({ at: elevation((i + 1) * every * 8849, c.units), label: `Everest × ${(i + 1) * every}` }));
  const series = cum(w.daily.map((d) => elevation(d.e, c.units)));
  const what = ev >= 1 ? `${loc(ev, 1)} times up Everest from sea level.` : `${Math.round(ev * 100)} % of the way up Everest.`;
  return {
    el: wrap('climb', kicker('Climbing'), num(v, u), figure(chart(cumulative(series, { ticks: ticksOf(w), lines, h: 200 }))), caption(what)),
    say: `You climbed ${loc(v)} ${u}: ${what}`,
  };
}

function rhythmCard(w: Wrapped): Card {
  let bd = 0, bh = 0;
  w.punch.forEach((row, d) => row.forEach((v, hr) => { if (v > w.punch[bd]![bh]!) { bd = d; bh = hr; } }));
  const months = Array<number>(12).fill(0);
  w.daily.forEach((x, i) => { months[fromDayNumber(w.day0 + i).m - 1]! += x.s; });
  const month = months.indexOf(Math.max(...months));
  const head = `${DAYS[bd]}, around ${bh}:00`;
  return {
    el: wrap('rhythm', kicker('When you go'), headline(head), figure(chart(punchCard(w.punch, WEEKDAYS))),
      caption(`Your busiest month was ${MONTHS[month]}. `, h('span', { class: 'w-muted' }, 'Bigger dots, more starts.'))),
    say: `Your favourite time: ${head}. Your busiest month was ${MONTHS[month]}.`,
  };
}

function clockCard(w: Wrapped, c: CardCtx): Card {
  const e = w.earliest!, l = w.latest!;
  const when = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: c.tz === 'UTC' ? 'UTC' : undefined });
  const quip = clockQuip(e.hour, l.hour);
  return {
    el: wrap('clock', kicker('Early and late'), headline(quip),
      figure(chart(startStrip(w.starts, e.hour, l.hour, `${clock(e.hour)} earliest`, `latest ${clock(l.hour)}`))),
      caption(`Earliest start ${clock(e.hour)} on ${when(e.a.startMs)}, latest ${clock(l.hour)} on ${when(l.a.startMs)}.`)),
    say: `${quip} Your earliest start was ${clock(e.hour)} on ${when(e.a.startMs)}, your latest ${clock(l.hour)} on ${when(l.a.startMs)}.`,
  };
}

function longestCard(w: Wrapped, c: CardCtx): Card {
  const a = w.longest!;
  const v = distance(a.distanceM, c.units), u = distanceUnit(c.units);
  const when = new Date(a.startMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: c.tz === 'UTC' ? 'UTC' : undefined });
  return {
    el: wrap('longest', kicker(`Longest activity · ${when}`), headline(a.name || a.sport),
      w.longestRoute ? figure(chart(routesMap([w.longestRoute], { h: 240, accentFirst: true }))) : null,
      a.profile && a.profile.length > 2 ? figure(chart(profile(a.profile))) : null,
      stats([[`${loc(v, 1)} ${u}`, a.sport], [formatDuration(a.movingS), 'moving'], [`${loc(elevation(a.elevGainM, c.units))} ${elevationUnit(c.units)}`, 'climbed']])),
    say: `Your longest: ${a.name || a.sport} on ${when}, ${loc(v, 1)} ${u} in ${formatDuration(a.movingS)}.`,
  };
}

function weekCard(w: Wrapped, c: CardCtx): Card {
  const b = w.biggestWeek!;
  const v = distance(b.distanceM, c.units), u = distanceUnit(c.units);
  const i = w.weeks.indexOf(b);
  const st = w.longestStreak;
  const start = fromDayNumber(b.start);
  const wk = `${start.d} ${MONTHS[start.m - 1]!.slice(0, 3)}`;
  const streak = st && st.days > 1 ? `Longest streak: ${st.days} days in a row, ${dayLabel(st.start)} – ${dayLabel(st.end)}.` : '';
  return {
    el: wrap('week', kicker('Biggest week'), num(v, u, v < 100 ? 1 : 0),
      figure(chart(bars(w.weeks.map((x) => x.distanceM), { highlight: i, topLabel: `week of ${wk}`, h: 150 }))),
      stats([[String(b.count), 'activities'], [formatDuration(b.movingS), 'moving'], ...(st && st.days > 1 ? [[`${st.days} days`, 'longest streak'] as [string, string]] : [])]),
      streak ? caption(h('span', { class: 'w-muted' }, streak)) : null),
    say: `Your biggest week: ${loc(v, 1)} ${u}, the week of ${wk}, ${b.count} activities. ${streak}`,
  };
}

function gapCard(w: Wrapped): Card {
  const g = w.gap!;
  const quip = gapQuip(g.days);
  return {
    el: wrap('gap', kicker('Longest break'), num(g.days, g.days === 1 ? 'day' : 'days'),
      figure(chart(gapStrip(w.daily.map((d) => d.s), g.d0 - w.day0, g.days, `${dayLabel(g.from)} – ${dayLabel(g.to)}`))),
      headline(quip)),
    say: `Your longest break: ${g.days} days, ${dayLabel(g.from)} to ${dayLabel(g.to)}. ${quip}`,
  };
}

function prText(p: Pr): { what: string; value: string; gain: string } {
  if (p.kind === 'power') return { what: `${durationName(p.span)} power`, value: `${Math.round(p.value)} W`, gain: p.before !== null ? `+${Math.round(p.value - p.before)} W` : '' };
  return { what: `${p.sport} ${distanceName(p.span)}`, value: formatDuration(p.value), gain: p.before !== null ? `−${formatDuration(p.before - p.value)}` : '' };
}

function prsCard(w: Wrapped): Card {
  const all = w.period === 'all';
  const list = w.prs.slice(0, 5).map(prText);
  const curve = w.curveNow.length > 4 ? chart(powerCurves(w.curveNow, w.curveBefore, all ? 'best' : w.label, 'before')) : null;
  return {
    el: wrap('prs', kicker(all ? 'All-time bests' : 'Personal records'),
      all ? headline('The best you have done') : num(w.prs.length, w.prs.length === 1 ? 'record broken' : 'records broken'),
      curve ? figure(curve) : null,
      h('ul', { class: 'w-list' }, ...list.map((p) => h('li', {}, h('span', {}, p.what), h('b', {}, p.value), p.gain ? h('em', {}, p.gain) : null)))),
    say: `${all ? 'Your all-time bests' : `${w.prs.length} personal records`}: ${list.map((p) => `${p.what} ${p.value}${p.gain ? ` (${p.gain})` : ''}`).join('; ')}.`,
  };
}

function fitnessCard(w: Wrapped): Card {
  const p = w.peakCtl!;
  return {
    el: wrap('fitness', kicker('Fitness'), num(p.ctl, 'peak CTL'),
      figure(chart(area(w.ctlSeries, dayLabel(p.date), ticksOf(w)))),
      caption(`Highest on ${dayLabel(p.date)}. `, h('span', { class: 'w-muted' }, 'Fitness (CTL) is your training load averaged over six weeks.'))),
    say: `Peak fitness: ${Math.round(p.ctl)} CTL on ${dayLabel(p.date)}.`,
  };
}

function workCard(w: Wrapped): Card {
  const unit = niceStep(Math.max(...w.workBy.map((x) => x.kj)), 10);
  const slices = Math.round(w.pizza);
  return {
    el: wrap('work', kicker('Work at the pedals'), num(w.workKj, 'kJ'),
      figure(chart(waffle(w.workBy.map((x) => ({ label: x.label, v: x.kj })), unit))),
      caption(`About ${loc(slices)} slices of pizza burned. `, h('span', { class: 'w-muted' }, `Each square is ${loc(unit)} kJ.`))),
    say: `${loc(w.workKj)} kilojoules of work: about ${loc(slices)} slices of pizza.`,
  };
}

function placesCard(w: Wrapped): Card {
  const others = w.places.names.slice(1);
  return {
    el: wrap('places', kicker('Where you went'), headline(w.places.names[0] ?? 'Your roads'),
      figure(chart(routesMap(w.routes, { h: 320 }))),
      caption(`${loc(w.routes.length)} routes, start and finish trimmed off. `, others.length ? h('span', { class: 'w-muted' }, `Also: ${others.join(', ')}.`) : '')),
    say: `Where you went: ${w.routes.length} routes around ${w.places.names[0] ?? 'home'}${others.length ? `, and also ${others.join(', ')}` : ''}.`,
  };
}

function namesCard(w: Wrapped): Card {
  const quip = nameQuip(w.names[0]!, w.acts.length, w.uniqueNames);
  return {
    el: wrap('names', kicker('Naming things'), headline(quip),
      figure(chart(hbars(w.names.map((n) => ({ label: n.name, v: n.n, value: `×${n.n}` }))))),
      caption(h('span', { class: 'w-muted' }, 'Your most used activity names.'))),
    say: `${quip} Your most used names: ${w.names.map((n) => `${n.name}, ${n.n} times`).join('; ')}.`,
  };
}

function typeEvidence(w: Wrapped, c: CardCtx): Element {
  const t = w.archetype.id;
  if (t === 'early' || t === 'owl') {
    const lab = [0, 6, 12, 18].map((at) => ({ at, label: `${at}:00` }));
    const hi = w.hours.map((_, hr) => (t === 'early' ? hr >= 3 && hr < 8 : hr >= 19 || hr < 3));
    return chart(bars(w.hours, { labels: lab, highlight: w.hours.indexOf(Math.max(...w.hours.filter((_, i) => hi[i]))), h: 130 }));
  }
  if (t === 'weekend') return chart(bars(w.weekdays, { labels: WEEKDAYS.map((label, at) => ({ at, label })), highlight: w.weekdays[5]! > w.weekdays[6]! ? 5 : 6, h: 130 }));
  if (t === 'climber') return chart(scatter(w.acts.map((a) => [distance(a.distanceM, c.units), elevation(a.elevGainM, c.units)]), distanceUnit(c.units), elevationUnit(c.units)));
  if (t === 'metronome') return chart(bars(w.weeks.map((x) => x.movingS), { h: 130 }));
  if (t === 'explorer' && w.routes.length) return chart(routesMap(w.routes, { h: 220 }));
  return chart(shareBar(w.sports.map((s) => ({ label: s.sport, share: s.share }))));
}

function typeCard(w: Wrapped, c: CardCtx): Card {
  const t = w.archetype;
  return {
    el: wrap('type', kicker('Your sporting type'), h('h2', { class: 'w-title' }, t.name), figure(typeEvidence(w, c)), caption(t.why)),
    say: `Your sporting type: ${t.name}. ${t.why}`,
  };
}

function compareCard(w: Wrapped, c: CardCtx): Card {
  const u = distanceUnit(c.units);
  const ticks = 'JFMAMJJASOND'.split('').map((label, m) => ({ at: (m * 53) / 12, label }));
  if (w.period === 'all') {
    const best = w.years.reduce((a, b) => (b.summary.distanceM > a.summary.distanceM ? b : a));
    const v = distance(best.summary.distanceM, c.units);
    const others = w.years.filter((y) => y !== best).map((y) => ({ values: y.cum.map((x) => distance(x, c.units)) }));
    return {
      el: wrap('compare', kicker('Year by year'), headline(`${best.year} was your biggest year`),
        figure(chart(cumulative(best.cum.map((x) => distance(x, c.units)), { ticks, end: `${best.year} · ${loc(v)} ${u}`, others }))),
        caption(h('span', { class: 'w-muted' }, 'Distance through each year; the blue line is the biggest.'))),
      say: `Your biggest year was ${best.year}: ${loc(v)} ${u} in ${best.summary.count} activities.`,
    };
  }
  const prev = w.previous!;
  const me = w.years.find((y) => y.year === w.period)!;
  const change = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
  const fmt = (p: number | null) => (p === null ? 'new' : `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p)} %`);
  const dc = change(w.summary.distanceM, prev.summary.distanceM);
  const head = dc === null ? `More than in ${prev.year}` : `${fmt(dc)} distance on ${prev.year}`;
  // the current year may not be over: draw it only up to its last activity
  const ongoing = w.period === new Date().getFullYear();
  const lastWeek = ongoing ? Math.min(52, Math.floor(((w.acts[w.acts.length - 1]?.startMs ?? 0) / 86_400_000 - w.day0) / 7)) : 52;
  const rows: [string, string][] = [
    [fmt(change(w.summary.movingS, prev.summary.movingS)), 'time'],
    [fmt(change(w.summary.elevGainM, prev.summary.elevGainM)), 'climbing'],
    [fmt(change(w.summary.count, prev.summary.count)), 'activities'],
  ];
  return {
    el: wrap('compare', kicker(`${w.label} against ${prev.year}`), headline(head),
      figure(chart(cumulative(me.cum.slice(0, lastWeek + 1).map((x) => distance(x, c.units)), { ticks, end: w.label, others: [{ values: prev.cum.map((x) => distance(x, c.units)), label: String(prev.year) }] }))),
      stats(rows)),
    say: `Compared with ${prev.year}: distance ${fmt(dc)}, ${rows.map(([v, l]) => `${l} ${v}`).join(', ')}.`,
  };
}

export function buildCard(id: CardId, w: Wrapped, c: CardCtx): Card | null {
  switch (id) {
    case 'intro': return intro(w);
    case 'distance': return distanceCard(w, c);
    case 'time': return timeCard(w);
    case 'climb': return climbCard(w, c);
    case 'rhythm': return rhythmCard(w);
    case 'clock': return clockCard(w, c);
    case 'longest': return longestCard(w, c);
    case 'week': return weekCard(w, c);
    case 'gap': return gapCard(w);
    case 'prs': return prsCard(w);
    case 'fitness': return fitnessCard(w);
    case 'work': return workCard(w);
    case 'places': return placesCard(w);
    case 'names': return namesCard(w);
    case 'type': return typeCard(w, c);
    case 'compare': return compareCard(w, c);
    case 'summary': return null; // built by the player (it needs the share image and buttons)
  }
}
