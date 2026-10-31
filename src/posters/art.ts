import type { Activity } from '../types';
import { dayNumber, parts } from '../util/time';
import { distance, distanceUnit } from '../util/units';
import { emptyMessage, esc, int, mix, n1, palette, wrapSvg, type Frame, type Poster, type PosterOptions } from './common';

/*
 * Three abstract posters. None of them shows a place: routes are moved to a common centre and turned,
 * so the shapes keep their character but not their location.
 */

const metricOf = (a: Activity, o: PosterOptions) => (o.calendarMetric === 'distance' ? a.distanceM : a.movingS);
const metricShow = (v: number, o: PosterOptions) => (o.calendarMetric === 'distance' ? distance(v, o.units) : v / 3600);
const metricUnit = (o: PosterOptions) => (o.calendarMetric === 'distance' ? distanceUnit(o.units) : 'h');

const MAX_PETALS = 600;

/**
 * Route bloom: every GPS route starts at the centre and is turned so its farthest point lies on its own
 * angle, in date order around the circle, like petals. Petal length follows the square root of how far
 * the route reached. With symmetry > 1 each petal is repeated around the centre (a kaleidoscope).
 */
export function bloom(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  let routes = acts.filter((a) => a.route && a.route.length >= 8).sort((a, b) => a.startMs - b.startMs);
  if (!routes.length) return wrapSvg(f, o, emptyMessage(f, 'No GPS routes in this selection'));
  // with symmetry every petal is drawn several times: keep the total line count readable
  const cap = Math.floor(MAX_PETALS / Math.max(1, o.bloomSymmetry) ** 0.85);
  if (routes.length > cap) { const step = routes.length / cap; routes = Array.from({ length: cap }, (_, i) => routes[Math.floor(i * step)]!); }
  const shapes = routes.map((a) => {
    const r = a.route!, lat0 = r[0]!, lon0 = r[1]!, k = Math.cos((lat0 * Math.PI) / 180);
    const pts: [number, number][] = [];
    for (let i = 0; i < r.length; i += 2) pts.push([(r[i + 1]! - lon0) * k * 111_320, -(r[i]! - lat0) * 111_320]);
    let far = 0, fx = 1, fy = 0;
    for (const [x, y] of pts) { const d = Math.hypot(x, y); if (d > far) { far = d; fx = x; fy = y; } }
    return { a, pts, far, ang: Math.atan2(fy, fx) };
  }).filter((s) => s.far > 20);
  if (!shapes.length) return wrapSvg(f, o, emptyMessage(f, 'No GPS routes in this selection'));
  const sorted = shapes.map((s) => s.far).sort((x, y) => x - y);
  const ref = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]!;
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  const R = Math.min(f.w, f.h) / 2 - 10;
  const years = [...new Set(shapes.map((s) => parts(s.a.startMs, o.tz).y))].sort();
  const cols = palette(f.theme, Math.max(2, years.length));
  const sym = Math.max(1, o.bloomSymmetry);
  const sw = Math.max(0.5, Math.min(1.6, 260 / Math.sqrt(shapes.length * sym)));
  const opacity = Math.max(0.12, Math.min(0.75, 24 / Math.sqrt(shapes.length * sym)));
  let body = `<g fill="none" stroke-width="${n1(sw)}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${n1(opacity)}">`;
  shapes.forEach((s, i) => {
    const len = Math.min(1, Math.sqrt(s.far / ref)) * R;
    const scale = len / s.far;
    const target = -Math.PI / 2 + (i / shapes.length) * (2 * Math.PI / sym);
    const col = cols[years.indexOf(parts(s.a.startMs, o.tz).y)]!;
    for (let k = 0; k < sym; k++) {
      const rot = target + (k * 2 * Math.PI) / sym - s.ang;
      const c = Math.cos(rot), sn = Math.sin(rot);
      const d = 'M' + s.pts.map(([x, y]) => `${n1(cx + (x * c - y * sn) * scale)},${n1(cy + (x * sn + y * c) * scale)}`).join('L');
      body += `<path d="${d}" stroke="${col}"/>`;
    }
  });
  body += '</g>';
  body += `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(Math.max(3, R * 0.012))}" fill="${f.theme.fg}"/>`;
  if (years.length > 1) {
    const lw = f.w / years.length;
    body += years.map((y, i) => `<circle cx="${n1(f.x + i * lw + 8)}" cy="${n1(f.y + f.h - 6)}" r="6" fill="${cols[i]}"/><text x="${n1(f.x + i * lw + 20)}" y="${n1(f.y + f.h)}" font-size="16" fill="${f.theme.muted}">${y}</text>`).join('');
  }
  return wrapSvg(f, o, body);
}

/** Catmull-Rom spline through points, as cubic Bézier segments (starting with L/M handled by the caller). */
function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return '';
  let d = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!, p1 = pts[i]!, p2 = pts[i + 1]!, p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${n1(c1[0])},${n1(c1[1])} ${n1(c2[0])},${n1(c2[1])} ${n1(p2[0])},${n1(p2[1])}`;
  }
  return d;
}

/**
 * Stream: weekly volume per sport as flowing ribbons, time running down the poster. Each week is
 * smoothed with its neighbours and the ribbons are centred (a streamgraph), so busy seasons swell and
 * quiet ones narrow.
 */
export function stream(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  if (!acts.length) return wrapSvg(f, o, emptyMessage(f, 'No activities in this selection'));
  const wk = (a: Activity) => { const p = parts(a.startMs, o.tz); return Math.floor((dayNumber(p) - p.wd) / 7); };
  const w0 = Math.min(...acts.map(wk)), w1 = Math.max(...acts.map(wk));
  const n = w1 - w0 + 1;
  const sportTotals = new Map<string, number>();
  for (const a of acts) sportTotals.set(a.sport, (sportTotals.get(a.sport) ?? 0) + metricOf(a, o));
  let sports = [...sportTotals.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  if (sports.length > 6) sports = [...sports.slice(0, 5), 'Other'];
  const idx = (s: string) => { const i = sports.indexOf(s); return i >= 0 ? i : sports.length - 1; };
  const raw = sports.map(() => new Array<number>(n).fill(0));
  for (const a of acts) raw[idx(a.sport)]![wk(a) - w0]! += metricOf(a, o);
  // gaussian smoothing over about ±4 weeks
  const kernel = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((k) => [k, Math.exp(-(k * k) / (2 * 1.8 * 1.8))] as const);
  const sm = raw.map((row) => row.map((_, i) => { let s = 0, w = 0; for (const [k, g] of kernel) { const v = row[i + k]; if (v !== undefined) { s += v * g; w += g; } } return s / w; }));
  const tot = sm[0]!.map((_, i) => sm.reduce((s, r) => s + r[i]!, 0));
  const max = Math.max(...tot) || 1;
  const cx = f.x + f.w / 2;
  const top = f.y + 34, bottom = f.y + f.h - 10;
  const Y = (i: number) => top + (n === 1 ? 0.5 : i / (n - 1)) * (bottom - top);
  const half = (f.w * 0.92) / 2;
  const cols = palette(f.theme, Math.max(2, sports.length));
  let body = '';
  // year marks
  const firstY = parts(Math.min(...acts.map((a) => a.startMs)), o.tz).y, lastY = parts(Math.max(...acts.map((a) => a.startMs)), o.tz).y;
  for (let y = firstY; y <= lastY + 1; y++) {
    const p = { y, m: 1, d: 1, wd: 0 };
    const jan = Math.floor(dayNumber(p) / 7);
    const i = jan - w0;
    if (i < 0 || i >= n) continue;
    body += `<line x1="${f.x}" x2="${f.x + f.w}" y1="${n1(Y(i))}" y2="${n1(Y(i))}" stroke="${f.theme.muted}" stroke-opacity="0.25" stroke-dasharray="2 6"/>` +
      `<text x="${f.x}" y="${n1(Y(i) - 8)}" font-size="18" font-weight="600" fill="${f.theme.muted}">${y}</text>`;
  }
  let acc = tot.map((t) => -t / 2);
  sports.forEach((sp, k) => {
    const left: [number, number][] = [], right: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = acc[i]!, b = a + sm[k]![i]!;
      left.push([cx + (a / max) * half, Y(i)]);
      right.push([cx + (b / max) * half, Y(i)]);
    }
    acc = acc.map((v, i) => v + sm[k]![i]!);
    const rev = [...right].reverse();
    const d = `M${n1(left[0]![0])},${n1(left[0]![1])}${smoothPath(left)}L${n1(rev[0]![0])},${n1(rev[0]![1])}${smoothPath(rev)}Z`;
    body += `<path d="${d}" fill="${cols[k]}" fill-opacity="0.88" stroke="${mix(cols[k]!, f.theme.bg, 0.5)}" stroke-width="0.6"/>`;
  });
  body += sports.map((sp, k) => `<circle cx="${n1(f.x + f.w - 150 + 8)}" cy="${n1(f.y + 6 + k * 24)}" r="7" fill="${cols[k]}"/><text x="${n1(f.x + f.w - 150 + 22)}" y="${n1(f.y + 12 + k * 24)}" font-size="16" fill="${f.theme.fg}">${esc(sp)}</text>`).join('');
  const peak = Math.max(...raw[0]!.map((_, i) => raw.reduce((s, rr) => s + rr[i]!, 0)));
  body += `<text x="${f.x}" y="${n1(f.y + 12)}" font-size="15" fill="${f.theme.muted}">Width: ${o.calendarMetric} per week · busiest week ${int(metricShow(peak, o))} ${esc(metricUnit(o))}</text>`;
  return wrapSvg(f, o, body);
}

/**
 * Spiral: one turn per year, from the centre outward. Every day with activities raises a stroke across
 * the spiral, as long as that day's distance or time, coloured by sport.
 */
export function spiral(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  if (!acts.length) return wrapSvg(f, o, emptyMessage(f, 'No activities in this selection'));
  const dayOf = (a: Activity) => dayNumber(parts(a.startMs, o.tz));
  const firstYear = parts(Math.min(...acts.map((a) => a.startMs)), o.tz).y;
  const lastYear = parts(Math.max(...acts.map((a) => a.startMs)), o.tz).y;
  const start = dayNumber({ y: firstYear, m: 1, d: 1, wd: 0 });
  const end = dayNumber({ y: lastYear + 1, m: 1, d: 1, wd: 0 });
  const turns = (end - start) / 365.25;
  const perDay = new Map<number, { v: number; sport: string; best: number }>();
  for (const a of acts) {
    const d = dayOf(a), m = metricOf(a, o);
    const e = perDay.get(d) ?? { v: 0, sport: a.sport, best: 0 };
    e.v += m;
    if (m > e.best) { e.best = m; e.sport = a.sport; }
    perDay.set(d, e);
  }
  const vals = [...perDay.values()].map((e) => e.v).sort((a, b) => a - b);
  const cap = vals[Math.floor(vals.length * 0.97)] ?? vals[vals.length - 1]!;
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  const R = Math.min(f.w, f.h) / 2 - 20;
  const r0 = R * 0.12;
  const pitch = (R - r0) / (turns + 0.6);
  const pos = (d: number) => {
    const t = (d - start) / 365.25;
    const ang = -Math.PI / 2 + t * 2 * Math.PI;
    const r = r0 + t * pitch;
    return { ang, r };
  };
  const sports = [...new Set(acts.map((a) => a.sport))];
  const cols = palette(f.theme, Math.max(2, sports.length));
  let guide = '';
  for (let d = start; d <= end; d += 3) { const p = pos(d); guide += `${guide ? 'L' : 'M'}${n1(cx + p.r * Math.cos(p.ang))},${n1(cy + p.r * Math.sin(p.ang))}`; }
  let body = `<path d="${guide}" fill="none" stroke="${f.theme.muted}" stroke-opacity="0.35" stroke-width="1"/>`;
  body += '<g stroke-linecap="round">';
  const sw = Math.max(1, Math.min(3.2, (2 * Math.PI * (r0 + pitch * turns * 0.6)) / 365 * 0.8));
  for (const [d, e] of [...perDay.entries()].sort((a, b) => a[0] - b[0])) {
    const p = pos(d);
    const len = Math.max(0.08, Math.min(1, e.v / cap)) * pitch * 0.8;
    const c = Math.cos(p.ang), s = Math.sin(p.ang);
    const a0 = p.r - len * 0.25, a1 = p.r + len * 0.75;
    body += `<line x1="${n1(cx + a0 * c)}" y1="${n1(cy + a0 * s)}" x2="${n1(cx + a1 * c)}" y2="${n1(cy + a1 * s)}" stroke="${cols[sports.indexOf(e.sport)]}" stroke-width="${n1(sw)}" stroke-opacity="0.82"/>`;
  }
  body += '</g>';
  for (let y = firstYear; y <= lastYear; y++) {
    const p = pos(dayNumber({ y, m: 1, d: 1, wd: 0 }));
    body += `<text x="${n1(cx + 6)}" y="${n1(cy - p.r - 4)}" font-size="13" fill="${f.theme.muted}">${y}</text>`;
  }
  const total = acts.reduce((s, a) => s + metricOf(a, o), 0);
  body += `<text x="${n1(cx)}" y="${n1(cy + 6)}" font-size="${n1(r0 * 0.42)}" font-weight="700" text-anchor="middle" fill="${f.theme.fg}">${int(metricShow(total, o))}</text>` +
    `<text x="${n1(cx)}" y="${n1(cy + 6 + r0 * 0.32)}" font-size="${n1(r0 * 0.16)}" letter-spacing="2" text-anchor="middle" fill="${f.theme.muted}">${esc(metricUnit(o).toUpperCase())}</text>`;
  if (sports.length > 1) {
    const lw = f.w / Math.min(sports.length, 6);
    body += sports.slice(0, 6).map((sp, i) => `<circle cx="${n1(f.x + i * lw + 8)}" cy="${n1(f.y + f.h - 6)}" r="6" fill="${cols[i]}"/><text x="${n1(f.x + i * lw + 20)}" y="${n1(f.y + f.h)}" font-size="16" fill="${f.theme.muted}">${esc(sp)}</text>`).join('');
  }
  return wrapSvg(f, o, body);
}
