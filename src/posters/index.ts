import type { Activity } from '../types';
import { byPeriod } from '../stats/summary';
import { findRegions, regionFilter, type RegionChoice } from '../stats/regions';
import { distance, distanceUnit, elevation, elevationUnit } from '../util/units';
import { dayNumber, fromDayNumber, parts, weekStart } from '../util/time';
import { climb } from './climb';
import { world } from './world';
import { landscape, pickLabel, pickProfiles } from './landscape';
import { space } from './space';
import { circles, cumulative, punchCard, recentYears, rings, timeOfDay } from './more';
import { emptyMessage, esc, int, makeFrame, mix, n1, rangeLabel, ramp, wrapSvg, type Frame, type Poster, type PosterOptions, type PosterType } from './common';

export * from './common';

/** Project [lat,lon,...] to planar coordinates (x east, y down) around a reference latitude. */
function project(route: number[], lat0: number, step = 1): [number, number][] {
  const k = Math.cos((lat0 * Math.PI) / 180);
  const out: [number, number][] = [];
  for (let i = 0; i < route.length; i += 2 * step) out.push([route[i + 1]! * k, -route[i]!]);
  return out;
}
/**
 * A route without its first and last `m` metres, so a shared poster does not show the exact spot where
 * activities start and end (often home). The route is sampled evenly by distance, so metres map to points
 * directly. Routes shorter than the two trimmed ends together are dropped (null).
 */
export function trimRoute(route: number[] | null, distanceM: number, m: number): number[] | null {
  if (!route || m <= 0) return route;
  const n = route.length / 2;
  const cut = Math.ceil((m / Math.max(distanceM, 1)) * (n - 1));
  return n - 2 * cut >= 2 ? route.slice(2 * cut, 2 * (n - cut)) : null;
}

const pathD = (pts: [number, number][]) => 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L');
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

function fit(pts: [number, number][], bw: number, bh: number, minX: number, minY: number, box: { x: number; y: number; w: number; h: number }, pad = 0): [number, number][] {
  const s = Math.min((box.w - 2 * pad) / (bw || 1e-9), (box.h - 2 * pad) / (bh || 1e-9));
  const ox = box.x + (box.w - bw * s) / 2, oy = box.y + (box.h - bh * s) / 2;
  return pts.map(([x, y]) => [ox + (x - minX) * s, oy + (y - minY) * s]);
}

function bbox(pts: [number, number][]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  return { minX, minY, bw: maxX - minX, bh: maxY - minY };
}

// ---------- 1. route facets ----------

function facets(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  const routes = acts.filter((a) => a.route);
  routes.sort(o.facetSort === 'distance' ? (a, b) => b.distanceM - a.distanceM : (a, b) => a.startMs - b.startMs);
  const n = routes.length;
  if (!n) return wrapSvg(f, o, emptyMessage(f, 'No GPS routes in this selection'));
  let cols = 1;
  while (cols < n && Math.ceil(n / cols) * (f.w / cols) > f.h) cols++;
  const cell = f.w / cols;
  const rows = Math.ceil(n / cols);
  const oy = f.y + Math.max(0, (f.h - rows * cell) / 2);
  const sw = Math.max(0.6, Math.min(2.2, cell * 0.022));
  const body = routes.map((a, i) => {
    const pts = project(a.route!, a.route![0]!, 2);
    const b = bbox(pts);
    const box = { x: f.x + (i % cols) * cell, y: oy + Math.floor(i / cols) * cell, w: cell, h: cell };
    return `<path d="${pathD(fit(pts, b.bw, b.bh, b.minX, b.minY, box, cell * 0.14))}"/>`;
  }).join('');
  return wrapSvg(f, o, `<g fill="none" stroke="${f.theme.fg}" stroke-width="${n1(sw)}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="0.9">${body}</g>`);
}

// ---------- 2. all routes overlay ----------

type Box = { x: number; y: number; w: number; h: number };

/** Paths of routes fitted into a box, with robust bounds (2nd–98th percentile) so one stray trip doesn't shrink the rest. */
function overlayPaths(routes: Activity[], box: Box): string {
  const lat0 = mean(routes.map((a) => a.route![0]!));
  const all = routes.map((a) => project(a.route!, lat0, 2));
  const xs: number[] = [], ys: number[] = [];
  for (const r of all) for (let i = 0; i < r.length; i += 2) { xs.push(r[i]![0]); ys.push(r[i]![1]); }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (v: number[], p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))]!;
  const minX = q(xs, 0.02), maxX = q(xs, 0.98), minY = q(ys, 0.02), maxY = q(ys, 0.98);
  return all.map((r) => `<path d="${pathD(fit(r, maxX - minX, maxY - minY, minX, minY, box, 0))}"/>`).join('');
}

/**
 * Every route on top of each other. With several regions (home, a holiday, Watopia), the biggest fills the
 * poster and the others are labelled insets along the bottom, each at its own scale.
 */
function overlay(groups: { name: string; acts: Activity[] }[], o: PosterOptions, f: Frame): Poster {
  const parts = groups.map((g) => ({ name: g.name, routes: g.acts.filter((a) => a.route) })).filter((g) => g.routes.length);
  if (!parts.length) return wrapSvg(f, o, emptyMessage(f, 'No GPS routes in this selection'));
  const boxes: Box[] = [];
  let labels = '';
  if (parts.length === 1) boxes.push({ x: f.x, y: f.y, w: f.w, h: f.h });
  else {
    const insets = parts.slice(1, 5); // at most four insets; more would be too small to read
    const gap = 24, label = 30;
    const side = Math.min(f.h * 0.22, (f.w - gap * (insets.length - 1)) / insets.length);
    boxes.push({ x: f.x, y: f.y, w: f.w, h: f.h - side - label - gap });
    insets.forEach((g, i) => {
      const b = { x: f.x + i * (side + gap), y: f.y + f.h - side - label, w: side, h: side };
      boxes.push(b);
      labels += `<rect x="${n1(b.x)}" y="${n1(b.y)}" width="${n1(side)}" height="${n1(side)}" rx="12" fill="none" stroke="${f.theme.muted}" stroke-opacity="0.35"/>` +
        `<text x="${n1(b.x)}" y="${n1(b.y + side + 22)}" font-size="15" letter-spacing="1.5" fill="${f.theme.muted}">${esc(`${g.name} · ${g.routes.length}`.toUpperCase())}</text>`;
    });
  }
  const paths = boxes.map((b, i) => overlayPaths(parts[i]!.routes, i === 0 ? b : { x: b.x + 12, y: b.y + 12, w: b.w - 24, h: b.h - 24 })).join('');
  const defs = `<filter id="glow" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="5"/></filter>` +
    `<clipPath id="clip">${boxes.map((b) => `<rect x="${n1(b.x)}" y="${n1(b.y)}" width="${n1(b.w)}" height="${n1(b.h)}"/>`).join('')}</clipPath><g id="routes">${paths}</g>`;
  const a = f.theme.accent;
  const body = `<g clip-path="url(#clip)" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<use href="#routes" stroke="${a}" stroke-width="7" stroke-opacity="0.22" filter="url(#glow)"/>` +
    `<use href="#routes" stroke="${a}" stroke-width="1.6" stroke-opacity="0.5"/>` +
    `<use href="#routes" stroke="${mix(a, f.theme.fg, 0.55)}" stroke-width="0.6" stroke-opacity="0.35"/></g>` + labels;
  return wrapSvg(f, o, body, defs);
}

// ---------- 3. calendar heatmap ----------

function calendar(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  if (!acts.length) return wrapSvg(f, o, emptyMessage(f, 'No activities in this selection'));
  const perDay = new Map<number, number>();
  for (const a of acts) {
    const d = dayNumber(parts(a.startMs, o.tz));
    perDay.set(d, (perDay.get(d) ?? 0) + (o.calendarMetric === 'distance' ? a.distanceM : a.movingS));
  }
  const nz = [...perDay.values()].filter((v) => v > 0).sort((a, b) => a - b);
  const cut = [0.25, 0.5, 0.75].map((p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] ?? 0);
  const level = (v: number) => (v <= 0 ? 0 : v < cut[0]! ? 1 : v < cut[1]! ? 2 : v < cut[2]! ? 3 : 4);
  const years = [...new Set(acts.map((a) => parts(a.startMs, o.tz).y))].sort((a, b) => b - a).slice(0, 8).reverse();
  const colors = ramp(f.theme);
  const labelW = 0;
  const cellByW = (f.w - labelW) / 54;
  const cell = Math.min(cellByW, (f.h / years.length - 64) / 7.2);
  const blockH = Math.min(f.h / years.length, cell * 7.2 + 64);
  const startY = f.y + (f.h - blockH * years.length) / 2;
  const gridW = cell * 53;
  const gx = f.x + (f.w - gridW) / 2;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let body = '';
  years.forEach((y, yi) => {
    const top = startY + yi * blockH + 52;
    body += `<text x="${gx}" y="${top - 26}" font-size="${n1(Math.max(18, cell * 1.5))}" font-weight="700" fill="${f.theme.fg}">${y}</text>`;
    const jan1 = dayNumber({ y, m: 1, d: 1, wd: 0 });
    const start = weekStart(fromDayNumber(jan1));
    const end = dayNumber({ y, m: 12, d: 31, wd: 0 });
    for (let m = 0; m < 12; m++) {
      const col = Math.floor((dayNumber({ y, m: m + 1, d: 1, wd: 0 }) - start) / 7);
      body += `<text x="${n1(gx + col * cell)}" y="${top - 8}" font-size="${n1(Math.max(9, cell * 0.8))}" fill="${f.theme.muted}">${MON[m]}</text>`;
    }
    let cells = '';
    for (let d = jan1; d <= end; d++) {
      const col = Math.floor((d - start) / 7);
      const row = fromDayNumber(d).wd;
      cells += `<rect x="${n1(gx + col * cell)}" y="${n1(top + row * cell)}" width="${n1(cell * 0.84)}" height="${n1(cell * 0.84)}" rx="${n1(cell * 0.2)}" fill="${colors[level(perDay.get(d) ?? 0)]}"/>`;
    }
    body += cells;
  });
  return wrapSvg(f, o, body);
}

// ---------- 4. elevation ridgelines ----------

function ridgelines(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  const sel = pickProfiles(acts, o.ridgeSelect, Math.max(3, o.ridgeCount));
  if (!sel.length) return wrapSvg(f, o, emptyMessage(f, 'No elevation data in this selection'));
  const ranges = sel.map((a) => Math.max(...a.profile!) - Math.min(...a.profile!)).sort((a, b) => a - b);
  const ref = Math.max(ranges[Math.floor(ranges.length * 0.9)] ?? 1, 20); // 90th-percentile range sets the scale
  const n = sel.length;
  const spacing = f.h / (n + 3);
  const amp = spacing * 3;
  const body = sel.map((a, i) => {
    const p = a.profile!;
    const lo = Math.min(...p);
    const base = f.y + spacing * 3 + i * spacing;
    const pts = p.map((v, k) => `${n1(f.x + (k / (p.length - 1)) * f.w)},${n1(base - Math.min(1.25, (v - lo) / ref) * amp)}`);
    const line = 'M' + pts.join('L');
    // Opaque fill hides rows behind it; only the profile itself is stroked (no baseline or side edges).
    return `<path d="${line}L${f.x + f.w},${n1(base)}L${f.x},${n1(base)}Z" fill="${f.theme.bg}"/>` +
      `<path d="${line}" fill="none" stroke="${i === n - 1 ? f.theme.accent : f.theme.fg}" stroke-width="${n1(Math.max(1.2, spacing * 0.06))}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  return wrapSvg(f, o, `<g>${body}</g>`);
}

// ---------- 5. season overview ----------

function season(acts: Activity[], o: PosterOptions, f: Frame, year: number): Poster {
  if (!acts.length) return wrapSvg(f, o, emptyMessage(f, `No activities in ${year}`));
  const rows = byPeriod(acts, 'month', o.tz).filter((r) => r.key.startsWith(`${year}-`));
  const byMonth = new Array(12).fill(null).map((_, i) => rows.find((r) => r.key === `${year}-${String(i + 1).padStart(2, '0')}`)?.summary);
  const MON = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const chart = (title: string, vals: number[], fmtv: (v: number) => string, top: number, h: number) => {
    const max = Math.max(...vals, 1e-9);
    const bw = f.w / 12;
    const plotTop = top + 44, plotH = h - 44 - 36;
    let s = `<text x="${f.x}" y="${top + 20}" font-size="18" letter-spacing="3" fill="${f.theme.muted}">${esc(title.toUpperCase())}</text>` +
      `<line x1="${f.x}" x2="${f.x + f.w}" y1="${n1(plotTop + plotH)}" y2="${n1(plotTop + plotH)}" stroke="${f.theme.muted}" stroke-opacity="0.4"/>`;
    vals.forEach((v, i) => {
      const bh = (v / max) * plotH;
      const x = f.x + i * bw + bw * 0.14;
      s += `<rect x="${n1(x)}" y="${n1(plotTop + plotH - bh)}" width="${n1(bw * 0.72)}" height="${n1(Math.max(bh, v > 0 ? 2 : 0))}" rx="${n1(Math.min(8, bw * 0.12))}" fill="${f.theme.accent}"/>`;
      if (v > 0) s += `<text x="${n1(x + bw * 0.36)}" y="${n1(plotTop + plotH - bh - 8)}" font-size="14" text-anchor="middle" fill="${f.theme.fg}">${esc(fmtv(v))}</text>`;
      s += `<text x="${n1(x + bw * 0.36)}" y="${n1(plotTop + plotH + 26)}" font-size="16" text-anchor="middle" fill="${f.theme.muted}">${MON[i]}</text>`;
    });
    return s;
  };
  const tot = acts.reduce((t, a) => ({ d: t.d + a.distanceM, s: t.s + a.movingS, e: t.e + a.elevGainM }), { d: 0, s: 0, e: 0 });
  const stats: [string, string][] = [
    [`${int(distance(tot.d, o.units))}`, `distance (${distanceUnit(o.units)})`],
    [`${int(tot.s / 3600)}`, 'hours moving'],
    [`${int(acts.length)}`, 'activities'],
    [`${int(o.units === 'metric' ? tot.e : tot.e / 0.3048)}`, `climbing (${o.units === 'metric' ? 'm' : 'ft'})`],
  ];
  const cw = f.w / 2;
  let body = stats.map(([v, l], i) =>
    `<text x="${f.x + (i % 2) * cw}" y="${f.y + 62 + Math.floor(i / 2) * 120}" font-size="64" font-weight="700" letter-spacing="-2" fill="${f.theme.fg}">${esc(v)}</text>` +
    `<text x="${f.x + (i % 2) * cw}" y="${f.y + 92 + Math.floor(i / 2) * 120}" font-size="16" letter-spacing="3" fill="${f.theme.muted}">${esc(l.toUpperCase())}</text>`).join('');
  const chartsTop = f.y + 270;
  const each = (f.y + f.h - chartsTop) / 2 - 10;
  body += chart(`Distance per month (${distanceUnit(o.units)})`, byMonth.map((s) => (s ? distance(s.distanceM, o.units) : 0)), (v) => int(v), chartsTop, each);
  body += chart('Moving time per month (hours)', byMonth.map((s) => (s ? s.movingS / 3600 : 0)), (v) => (v < 10 ? n1(v) : int(v)), chartsTop + each + 20, each);
  return wrapSvg(f, o, body);
}

// ---------- entry point ----------

export function latestYear(acts: Activity[], tz: PosterOptions['tz']): number | null {
  return acts.length ? Math.max(...acts.map((a) => parts(a.startMs, tz).y)) : null;
}

/**
 * Activities of a route poster: one year (or all), in the chosen regions, grouped by region (biggest first);
 * plus the subtitle's description.
 */
function routeSelection(all: Activity[], o: PosterOptions, year: number | 'all', choice: RegionChoice): { sel: Activity[]; groups: { name: string; acts: Activity[] }[]; label: string } {
  const regions = findRegions(all); // over every year, so a region choice means the same in each period
  const keep = regionFilter(regions, choice);
  const sel = all.filter((a) => (year === 'all' || parts(a.startMs, o.tz).y === year) && keep(a))
    .map((a) => (o.hideEnds > 0 && a.route ? { ...a, route: trimRoute(a.route, a.distanceM, o.hideEnds) } : a));
  const groups = keep.picked.length > 1 ? keep.picked.map((r) => ({ name: r.name, acts: sel.filter((a) => r.activityIds.has(a.id)) })) : [{ name: '', acts: sel }];
  const where = keep.picked.length === regions.length ? '' : keep.picked.length === 1 ? keep.picked[0]!.name : `${keep.picked.length} of ${regions.length} regions`;
  return { sel, groups, label: [year === 'all' ? rangeLabel(sel, o.tz) : String(year), where].filter(Boolean).join(' · ') };
}

export function renderPoster(type: PosterType, all: Activity[], o: PosterOptions): Poster {
  const range = rangeLabel(all, o.tz);
  // Posters that draw whole calendar years only cover the most recent 8; keep subtitle and totals consistent with that.
  const recent = (): Activity[] => {
    const ys = recentYears(all, o.tz);
    return all.filter((a) => ys.includes(parts(a.startMs, o.tz).y));
  };
  const metric = o.calendarMetric === 'distance' ? 'distance' : 'time';
  switch (type) {
    case 'facets': {
      const { sel, label } = routeSelection(all, o, o.facetYear, o.facetRegions);
      const f = makeFrame(sel, o, 'Route facets', `${label} · ${sel.filter((a) => a.route).length} routes · by ${o.facetSort}`, o.strip);
      return facets(sel, o, f);
    }
    case 'overlay': {
      const { sel, groups, label } = routeSelection(all, o, o.overlayYear, o.overlayRegions);
      const f = makeFrame(sel, o, 'Every route', `${label} · ${sel.filter((a) => a.route).length} routes`, o.strip);
      return overlay(groups, o, f);
    }
    case 'calendar': {
      const sel = recent();
      const f = makeFrame(sel, o, 'Calendar', `${rangeLabel(sel, o.tz)} · ${metric} per day`, o.strip);
      return calendar(sel, o, f);
    }
    case 'ridgelines': {
      const f = makeFrame(all, o, 'Elevation profiles', `${pickLabel(o.ridgeSelect)} · ${Math.min(o.ridgeCount, all.filter((a) => a.profile).length)} activities`, o.strip);
      return ridgelines(all, o, f);
    }
    case 'season': {
      const year = o.seasonYear ?? latestYear(all, o.tz) ?? new Date().getFullYear();
      const ys = all.filter((a) => parts(a.startMs, o.tz).y === year);
      const f = makeFrame(ys, o, 'Season', `${year} · ${ys.length} activities`, false);
      return season(ys, o, f, year);
    }
    case 'circles': {
      const year = o.circleYear;
      const sel = year === 'all' ? all : all.filter((a) => parts(a.startMs, o.tz).y === year);
      const per = o.circleGroup === 'none' ? '' : ` · one cluster per ${o.circleGroup}`;
      const f = makeFrame(sel, o, 'Activity bubbles', `${year === 'all' ? rangeLabel(sel, o.tz) : year} · area shows distance · ${Math.min(1000, sel.filter((a) => a.distanceM > 0).length)} activities${per}`, o.strip);
      return circles(sel, o, f);
    }
    case 'timeofday': {
      const f = makeFrame(all, o, 'Time of day', `${range} · when you start (${o.tz === 'UTC' ? 'UTC' : 'local time'}) · by ${o.todRows}`, o.strip);
      return timeOfDay(all, o, f);
    }
    case 'punchcard': {
      const f = makeFrame(all, o, 'Weekly rhythm', `${range} · weekday and hour · by ${o.punchMetric}`, o.strip);
      return punchCard(all, o, f);
    }
    case 'rings': {
      const sel = recent();
      const f = makeFrame(sel, o, 'Year rings', `${rangeLabel(sel, o.tz)} · ${metric} per day · oldest year inside`, o.strip);
      return rings(sel, o, f);
    }
    case 'cumulative': {
      const sel = recent();
      const f = makeFrame(sel, o, 'Year over year', `${rangeLabel(sel, o.tz)} · cumulative ${metric}`, o.strip);
      return cumulative(sel, o, f);
    }
    case 'world': {
      const year = o.worldYear;
      const sel = year === 'all' ? all : all.filter((a) => parts(a.startMs, o.tz).y === year);
      const f = makeFrame(sel, o, 'Around the world', `${year === 'all' ? rangeLabel(sel, o.tz) : year} · your distance wound around the equator · one ring per lap`, o.strip);
      return world(sel, o, f);
    }
    case 'todweek': {
      const year = o.todYear ?? latestYear(all, o.tz) ?? new Date().getFullYear();
      const sel = all.filter((a) => parts(a.startMs, o.tz).y === year);
      const f = makeFrame(sel, o, 'Time of day', `${year} · when you start, by weekday (${o.tz === 'UTC' ? 'UTC' : 'local time'})`, o.strip);
      return timeOfDay(sel, { ...o, todRows: 'weekday' }, f);
    }
    case 'landscape': {
      const n = pickProfiles(all, o.landSelect, o.landCount).length;
      const f = makeFrame(all, o, 'Landscape', `${pickLabel(o.landSelect)} · ${n} elevation profiles · heights ${o.landHeight === 'absolute' ? 'above sea level' : 'from each start'}`, o.strip);
      return landscape(all, o, f);
    }
    case 'space': {
      const year = o.spaceYear;
      const sel = year === 'all' ? all : all.filter((a) => parts(a.startMs, o.tz).y === year);
      const f = makeFrame(sel, o, 'To space', `${year === 'all' ? rangeLabel(sel, o.tz) : year} · ${o.spaceMetric === 'distance' ? 'your distance' : 'your climbing'}, pointed straight up`, o.strip);
      return space(sel, o, f);
    }
    case 'climb': {
      const mode = o.climbYear === 'all' || o.climbYear === 'overlay' ? o.climbYear : o.climbYear ?? latestYear(all, o.tz) ?? new Date().getFullYear();
      const sel = mode === 'all' ? all : mode === 'overlay' ? recent() : all.filter((a) => parts(a.startMs, o.tz).y === mode);
      const gain = sel.reduce((s, a) => s + a.elevGainM, 0);
      const what = mode === 'overlay' ? 'each year from zero' : 'activity after activity';
      const f = makeFrame(sel, o, 'Mountains climbed', `${typeof mode === 'number' ? mode : rangeLabel(sel, o.tz)} · ${int(elevation(gain, o.units))} ${elevationUnit(o.units)} of climbing, ${what}`, o.strip);
      return climb(sel, o, f, mode);
    }
  }
}
