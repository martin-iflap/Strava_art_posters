import { h, svg } from '../dom';
import type { Tz, Units } from '../types';
import { WEEKDAYS } from '../stats/summary';
import { distanceName, durationName } from '../stats/training';
import { distance, distanceUnit, elevation, elevationUnit, formatDuration } from '../util/units';
import { distanceEquivalent, type CardId, type Pr, type Wrapped } from './data';

/*
 * One function per Wrapped card. A card is real text (read out through the player's live region) plus a
 * small drawing. Animated numbers carry data-count (the player counts them up); bars and marks get their
 * size and delay as CSS custom properties, set through style.setProperty (the CSP forbids style="").
 */

export interface CardCtx { units: Units; tz: Tz }
export interface Card { el: HTMLElement; say: string }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SPORT_COLORS = ['#ff6b4a', '#ffd23f', '#3ddc97', '#4cc9f0', '#b388ff', '#ff8fab'];

const loc = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const dateLabel = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return `${d} ${MONTHS[m! - 1]!.slice(0, 3)} ${y}`; };
const setVars = <T extends Element>(el: T, vars: Record<string, string | number>): T => {
  for (const [k, v] of Object.entries(vars)) (el as unknown as ElementCSSInlineStyle).style.setProperty(k, String(v));
  return el;
};

/** A number that counts up when the card appears; the text is the final value, so it reads right without animation. */
const count = (value: number, decimals = 0, cls = 'w-big') => h('span', { class: cls, 'data-count': value, 'data-dec': decimals }, loc(value, decimals));
const kicker = (t: string) => h('p', { class: 'w-kicker' }, t);
const line = (...c: (Node | string)[]) => h('p', { class: 'w-line' }, ...c);
const wrap = (id: CardId, ...c: (Node | null)[]) => h('div', { class: `w-card w-${id}` }, ...c);

/** Vertical bars, the largest one highlighted, rising one after the other. */
function bars(values: number[], labels: string[], every = 1): HTMLElement {
  const max = Math.max(...values, 1);
  const top = values.indexOf(Math.max(...values));
  return h('div', { class: 'w-bars', 'aria-hidden': 'true' }, ...values.map((v, i) => h('div', { class: `w-bar${i === top ? ' top' : ''}` },
    setVars(h('i'), { '--h': (v / max).toFixed(3), '--i': i }),
    h('span', {}, i % every === 0 ? labels[i]! : ''))));
}

/** Route as an SVG line (equirectangular, x scaled by cos(latitude)) that draws itself. */
function routeSvg(route: number[], w = 320, hgt = 260): SVGElement {
  const lat: number[] = [], lon: number[] = [];
  for (let i = 0; i < route.length; i += 2) { lat.push(route[i]!); lon.push(route[i + 1]!); }
  const k = Math.cos((((Math.min(...lat) + Math.max(...lat)) / 2) * Math.PI) / 180);
  const xs = lon.map((x) => x * k), ys = lat.map((y) => -y);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), bw = Math.max(...xs) - x0 || 1e-9, bh = Math.max(...ys) - y0 || 1e-9;
  const s = Math.min((w - 20) / bw, (hgt - 20) / bh);
  const ox = (w - bw * s) / 2, oy = (hgt - bh * s) / 2;
  const d = 'M' + xs.map((x, i) => `${(ox + (x - x0) * s).toFixed(1)},${(oy + (ys[i]! - y0) * s).toFixed(1)}`).join('L');
  return svg('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'w-route', 'aria-hidden': 'true' },
    svg('path', { d, class: 'w-draw', pathLength: 1, fill: 'none', stroke: 'currentColor', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
}

/** Arc clockwise from 12 o'clock over `f` of a circle (0..1). */
function arcD(cx: number, cy: number, r: number, f: number): string {
  const a = Math.min(f, 0.9999) * 2 * Math.PI;
  const x = cx + r * Math.sin(a), y = cy - r * Math.cos(a);
  return `M${cx},${cy - r}A${r},${r} 0 ${a > Math.PI ? 1 : 0} 1 ${x.toFixed(2)},${y.toFixed(2)}`;
}

function intro(w: Wrapped, all: boolean): Card {
  const stripes = h('div', { class: 'w-stripes', 'aria-hidden': 'true' }, ...w.sports.slice(0, 6).map((s, i) =>
    setVars(h('i'), { '--w': Math.max(s.share, 0.02).toFixed(3), '--c': SPORT_COLORS[i]!, '--i': i })));
  const head = all ? 'All your years' : `Your ${w.label}`;
  const sub = `${loc(w.summary.count)} activities on ${loc(w.activeDays)} days`;
  return {
    el: wrap('intro', kicker('Sport Wrapped'), h('h2', { class: 'w-title' }, head, h('br'), h('em', {}, 'wrapped')), stripes,
      line(sub), h('p', { class: 'w-legend' }, ...w.sports.slice(0, 6).map((s, i) => h('span', {}, setVars(h('b'), { '--c': SPORT_COLORS[i]! }), s.sport)))),
    say: `${head}, wrapped. ${sub}.`,
  };
}

function distanceCard(w: Wrapped, c: CardCtx): Card {
  const v = distance(w.summary.distanceM, c.units);
  const eq = distanceEquivalent(w.summary.distanceM);
  const laps = w.summary.distanceM / 40_075_000;
  const frac = laps >= 1 ? laps - Math.floor(laps) || 1 : laps;
  const ring = svg('svg', { viewBox: '0 0 200 200', class: 'w-ring', 'aria-hidden': 'true' },
    svg('circle', { cx: 100, cy: 100, r: 84, fill: 'none', stroke: 'currentColor', 'stroke-opacity': 0.18, 'stroke-width': 10 }),
    svg('path', { d: arcD(100, 100, 84, Math.max(frac, 0.01)), class: 'w-draw', pathLength: 1, fill: 'none', stroke: 'currentColor', 'stroke-width': 10, 'stroke-linecap': 'round' }),
    svg('text', { x: 100, y: 108, 'text-anchor': 'middle', fill: 'currentColor', 'font-size': 22, 'font-weight': 700 }, document.createTextNode(laps >= 1 ? `${laps.toFixed(1)}×` : `${Math.round(laps * 100)} %`)),
    svg('text', { x: 100, y: 130, 'text-anchor': 'middle', fill: 'currentColor', 'fill-opacity': 0.7, 'font-size': 11 }, document.createTextNode('of the Earth')));
  const unit = distanceUnit(c.units);
  return {
    el: wrap('distance', kicker('You covered'), h('p', { class: 'w-num' }, count(v, v < 100 ? 1 : 0), h('span', { class: 'w-unit' }, unit)), ring, line(`That’s ${eq}.`)),
    say: `You covered ${loc(v, v < 100 ? 1 : 0)} ${unit}. That’s ${eq}.`,
  };
}

function timeCard(w: Wrapped): Card {
  const hours = w.summary.movingS / 3600;
  const days = hours / 24;
  const top = w.sports.slice(0, 5);
  const max = Math.max(...top.map((s) => s.summary.movingS), 1);
  const rows = h('div', { class: 'w-hbars' }, ...top.map((s, i) => h('div', { class: 'w-hbar' },
    h('span', {}, s.sport), setVars(h('i', { 'aria-hidden': 'true' }), { '--w': (s.summary.movingS / max).toFixed(3), '--c': SPORT_COLORS[i]!, '--i': i }),
    h('b', {}, `${loc(s.summary.movingS / 3600)} h`))));
  const sub = days >= 1 ? `That’s ${loc(days, 1)} days without stopping.` : `That’s ${loc(hours * 60)} minutes on the move.`;
  return {
    el: wrap('time', kicker('Time moving'), h('p', { class: 'w-num' }, count(hours, hours < 10 ? 1 : 0), h('span', { class: 'w-unit' }, 'hours')), line(sub), rows),
    say: `${loc(hours, hours < 10 ? 1 : 0)} hours moving. ${sub} ${top.map((s) => `${s.sport} ${loc(s.summary.movingS / 3600)} hours`).join(', ')}.`,
  };
}

function climbCard(w: Wrapped, c: CardCtx): Card {
  const ev = w.summary.elevGainM / 8849;
  const shown = Math.min(Math.ceil(ev), 12);
  const scale = ev > 12 ? ev / 12 : 1; // past 12 mountains, each one stands for several Everests
  const peaks = svg('svg', { viewBox: `0 0 ${shown * 40 + 10} 110`, class: 'w-peaks', 'aria-hidden': 'true' },
    ...Array.from({ length: shown }, (_, i) => {
      const f = Math.min(1, ev / scale - i);
      const ht = 100 * Math.max(f, 0.08);
      return setVars(svg('path', { d: `M${i * 40 + 5},105L${i * 40 + 25},${(105 - ht).toFixed(1)}L${i * 40 + 45},105Z`, fill: 'currentColor', 'fill-opacity': f < 1 ? 0.45 : 0.95, class: 'w-pop' }), { '--i': i });
    }));
  const v = elevation(w.summary.elevGainM, c.units);
  const what = ev >= 1 ? `${loc(ev, 1)} times up Everest` : `${Math.round(ev * 100)} % of the way up Everest`;
  return {
    el: wrap('climb', kicker('You climbed'), h('p', { class: 'w-num' }, count(v), h('span', { class: 'w-unit' }, elevationUnit(c.units))), peaks,
      line(`${what}${scale > 1 ? ` (each peak is ${loc(scale, 1)} Everests)` : ''}.`)),
    say: `You climbed ${loc(v)} ${elevationUnit(c.units)}: ${what}.`,
  };
}

function rhythmCard(w: Wrapped): Card {
  const day = w.weekdays.indexOf(Math.max(...w.weekdays));
  const hour = w.hours.indexOf(Math.max(...w.hours));
  const month = w.months.indexOf(Math.max(...w.months));
  const hourLabel = `${hour}:00–${hour + 1}:00`;
  return {
    el: wrap('rhythm', kicker('Your rhythm'),
      h('div', { class: 'w-facts' },
        h('div', {}, h('small', {}, 'Favourite day'), h('b', {}, DAYS[day]!), bars(w.weekdays, WEEKDAYS.map((d) => d[0]!))),
        h('div', {}, h('small', {}, 'Favourite hour'), h('b', {}, hourLabel), bars(w.hours, w.hours.map((_, i) => String(i)), 6)),
        h('div', {}, h('small', {}, 'Biggest month'), h('b', {}, MONTHS[month]!), bars(w.months, MONTHS.map((m) => m[0]!))))),
    say: `Your favourite day was ${DAYS[day]}, your favourite hour ${hourLabel}, and your biggest month ${MONTHS[month]}.`,
  };
}

function longestCard(w: Wrapped, c: CardCtx): Card {
  const a = w.longest!;
  const v = distance(a.distanceM, c.units);
  const d = new Date(a.startMs);
  const when = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: c.tz === 'UTC' ? 'UTC' : undefined });
  return {
    el: wrap('longest', kicker('Your longest'), h('h2', { class: 'w-name' }, a.name || a.sport),
      w.longestRoute ? routeSvg(w.longestRoute) : null,
      h('p', { class: 'w-num small' }, count(v, 1), h('span', { class: 'w-unit' }, distanceUnit(c.units))),
      line(`${a.sport} · ${formatDuration(a.movingS)} · ${when}`)),
    say: `Your longest: ${a.name || a.sport}, ${loc(v, 1)} ${distanceUnit(c.units)} in ${formatDuration(a.movingS)} on ${when}.`,
  };
}

function weekCard(w: Wrapped, c: CardCtx): Card {
  const b = w.biggestWeek!;
  const v = distance(b.distanceM, c.units);
  const st = w.longestStreak;
  const dots = st && st.days > 1 ? h('div', { class: 'w-dots', 'aria-hidden': 'true' }, ...Array.from({ length: Math.min(st.days, 60) }, (_, i) => setVars(h('i'), { '--i': i }))) : null;
  const streakText = st && st.days > 1 ? `Longest streak: ${st.days} days in a row (${dateLabel(st.start)} – ${dateLabel(st.end)}).` : '';
  return {
    el: wrap('week', kicker('Your biggest week'), h('p', { class: 'w-num' }, count(v, v < 100 ? 1 : 0), h('span', { class: 'w-unit' }, distanceUnit(c.units))),
      line(`Week of ${dateLabel(b.start)} · ${b.count} activities · ${formatDuration(b.movingS)}`),
      st && st.days > 1 ? h('h3', { class: 'w-sub' }, h('span', { 'data-count': st.days, 'data-dec': 0 }, String(st.days)), ' days in a row') : null, dots,
      st && st.days > 1 ? line(`${dateLabel(st.start)} – ${dateLabel(st.end)}`) : null),
    say: `Your biggest week: ${loc(v, 1)} ${distanceUnit(c.units)}, the week of ${dateLabel(b.start)}. ${streakText}`,
  };
}

function prText(p: Pr): { what: string; value: string; gain: string } {
  if (p.kind === 'power') {
    return { what: `${durationName(p.span)} power`, value: `${Math.round(p.value)} W`, gain: p.before !== null ? `+${Math.round(p.value - p.before)} W` : '' };
  }
  return { what: `${p.sport} ${distanceName(p.span)}`, value: formatDuration(p.value), gain: p.before !== null ? `−${formatDuration(p.before - p.value)}` : '' };
}

function prsCard(w: Wrapped, all: boolean): Card {
  const list = w.prs.slice(0, 6).map(prText);
  return {
    el: wrap('prs', kicker(all ? 'Your all-time bests' : 'New personal records'),
      h('p', { class: 'w-num small' }, count(w.prs.length), h('span', { class: 'w-unit' }, all ? 'bests' : w.prs.length === 1 ? 'record broken' : 'records broken')),
      h('ul', { class: 'w-list' }, ...list.map((p, i) => setVars(h('li', {}, h('span', {}, p.what), h('b', {}, p.value), p.gain ? h('em', {}, p.gain) : null), { '--i': i })))),
    say: `${all ? 'Your all-time bests' : `${w.prs.length} new personal records`}: ${list.map((p) => `${p.what} ${p.value}${p.gain ? ` (${p.gain})` : ''}`).join('; ')}.`,
  };
}

function fitnessCard(w: Wrapped): Card {
  const p = w.peakCtl!;
  const s = w.ctlSeries;
  const step = Math.max(1, Math.floor(s.length / 180));
  const pts = s.filter((_, i) => i % step === 0);
  const max = Math.max(...pts, 1);
  const d = 'M' + pts.map((v, i) => `${((i / Math.max(pts.length - 1, 1)) * 300).toFixed(1)},${(110 - (v / max) * 100).toFixed(1)}`).join('L');
  return {
    el: wrap('fitness', kicker('Peak fitness'), h('p', { class: 'w-num' }, count(p.ctl), h('span', { class: 'w-unit' }, 'CTL')),
      svg('svg', { viewBox: '0 0 300 115', class: 'w-spark', 'aria-hidden': 'true' }, svg('path', { d, class: 'w-draw', pathLength: 1, fill: 'none', stroke: 'currentColor', 'stroke-width': 3, 'stroke-linejoin': 'round' })),
      line(`Your fitness peaked on ${dateLabel(p.date)}.`)),
    say: `Peak fitness: ${Math.round(p.ctl)} CTL on ${dateLabel(p.date)}.`,
  };
}

function workCard(w: Wrapped): Card {
  const slices = Math.round(w.pizza);
  const per = slices > 60 ? Math.ceil(slices / 60) : 1;
  const icons = h('div', { class: 'w-pizza', 'aria-hidden': 'true' }, ...Array.from({ length: Math.min(Math.ceil(slices / per), 60) }, (_, i) => setVars(h('i'), { '--i': i })));
  return {
    el: wrap('work', kicker('Work at the pedals'), h('p', { class: 'w-num' }, count(w.workKj), h('span', { class: 'w-unit' }, 'kJ')), icons,
      line(`About ${loc(slices)} slices of pizza burned${per > 1 ? ` (each triangle is ${per})` : ''}.`)),
    say: `${loc(w.workKj)} kilojoules of work: about ${loc(slices)} slices of pizza.`,
  };
}

function placesCard(w: Wrapped): Card {
  return {
    el: wrap('places', kicker('Where you went'), h('p', { class: 'w-num' }, count(w.places.count), h('span', { class: 'w-unit' }, 'places')),
      h('ul', { class: 'w-list' }, ...w.places.names.map((n, i) => setVars(h('li', {}, h('span', {}, n)), { '--i': i }))),
      line('Places are areas more than 150 km apart. Start points are never shown.')),
    say: `You went to ${w.places.count} places: ${w.places.names.join(', ')}.`,
  };
}

const TYPE_ICONS: Record<string, string> = {
  early: 'M20,70H180M50,70A50,50 0 0 1 150,70M100,8V-2M38,28L30,20M162,28L170,20',
  owl: 'M130,20A50,50 0 1 0 150,90A40,40 0 1 1 130,20Z',
  weekend: 'M30,20H170V100H30ZM30,45H170M110,45V100M140,45V100',
  climber: 'M10,100L70,30L95,60L125,15L190,100Z',
  metronome: 'M30,100V70M60,100V70M90,100V70M120,100V70M150,100V70M180,100V70',
  explorer: 'M100,5A50,50 0 1 0 100.1,5ZM100,25L112,60L100,95L88,60Z',
  allrounder: 'M100,5L122,45L168,50L134,80L144,118L100,98L56,118L66,80L32,50L78,45Z',
};

function typeCard(w: Wrapped): Card {
  const t = w.archetype;
  return {
    el: wrap('type', kicker('Your sporting type'),
      svg('svg', { viewBox: '0 -10 200 135', class: 'w-icon', 'aria-hidden': 'true' }, svg('path', { d: TYPE_ICONS[t.id]!, class: 'w-draw', pathLength: 1, fill: 'none', stroke: 'currentColor', 'stroke-width': 6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })),
      h('h2', { class: 'w-title' }, t.name), line(t.why)),
    say: `Your sporting type: ${t.name}. ${t.why}`,
  };
}

function compareCard(w: Wrapped, c: CardCtx): Card {
  if (w.period === 'all') {
    const max = Math.max(...w.years.map((y) => y.summary.distanceM), 1);
    const best = w.years.reduce((a, b) => (b.summary.distanceM > a.summary.distanceM ? b : a));
    const v = distance(best.summary.distanceM, c.units);
    return {
      el: wrap('compare', kicker('Your biggest year'), h('h2', { class: 'w-title' }, String(best.year)),
        line(`${loc(v)} ${distanceUnit(c.units)} in ${loc(best.summary.count)} activities`),
        h('div', { class: 'w-bars years', 'aria-hidden': 'true' }, ...w.years.map((y, i) => h('div', { class: `w-bar${y === best ? ' top' : ''}` },
          setVars(h('i'), { '--h': (y.summary.distanceM / max).toFixed(3), '--i': i }), h('span', {}, `’${String(y.year).slice(2)}`))))),
      say: `Your biggest year was ${best.year}: ${loc(v)} ${distanceUnit(c.units)} in ${best.summary.count} activities.`,
    };
  }
  const prev = w.previous!;
  const rows: [string, number, number, (x: number) => string][] = [
    ['Distance', w.summary.distanceM, prev.summary.distanceM, (x) => `${loc(distance(x, c.units))} ${distanceUnit(c.units)}`],
    ['Time', w.summary.movingS, prev.summary.movingS, (x) => `${loc(x / 3600)} h`],
    ['Climbing', w.summary.elevGainM, prev.summary.elevGainM, (x) => `${loc(elevation(x, c.units))} ${elevationUnit(c.units)}`],
    ['Activities', w.summary.count, prev.summary.count, (x) => loc(x)],
  ];
  const change = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
  const fmtChange = (p: number | null) => (p === null ? 'new' : `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p)} %`);
  return {
    el: wrap('compare', kicker(`${w.label} vs ${prev.year}`),
      h('div', { class: 'w-vs' }, ...rows.map(([name, a, b, f], i) => {
        const m = Math.max(a, b, 1);
        const p = change(a, b);
        return setVars(h('div', { class: 'w-vsrow' }, h('span', {}, name), h('b', { class: p !== null && p < 0 ? 'down' : 'up' }, fmtChange(p)),
          h('div', { class: 'w-pair', 'aria-hidden': 'true' }, setVars(h('i', { class: 'now' }), { '--w': (a / m).toFixed(3) }), setVars(h('i'), { '--w': (b / m).toFixed(3) })),
          h('small', {}, `${f(a)} · ${f(b)}`)), { '--i': i });
      })),
      h('p', { class: 'w-legend' }, h('span', {}, h('b', { class: 'now' }), w.label), h('span', {}, h('b'), String(prev.year)))),
    say: `Compared with ${prev.year}: ${rows.map(([n, a, b, f]) => `${n} ${f(a)}, ${fmtChange(change(a, b))}`).join('; ')}.`,
  };
}

export function buildCard(id: CardId, w: Wrapped, c: CardCtx): Card | null {
  const all = w.period === 'all';
  switch (id) {
    case 'intro': return intro(w, all);
    case 'distance': return distanceCard(w, c);
    case 'time': return timeCard(w);
    case 'climb': return climbCard(w, c);
    case 'rhythm': return rhythmCard(w);
    case 'longest': return longestCard(w, c);
    case 'week': return weekCard(w, c);
    case 'prs': return prsCard(w, all);
    case 'fitness': return fitnessCard(w);
    case 'work': return workCard(w);
    case 'places': return placesCard(w);
    case 'type': return typeCard(w);
    case 'compare': return compareCard(w, c);
    case 'summary': return null; // built by the player (it needs the share image and buttons)
  }
}
