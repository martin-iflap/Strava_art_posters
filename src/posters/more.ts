import type { Activity } from '../types';
import { dayNumber, hourOf, parts } from '../util/time';
import { distance, distanceUnit } from '../util/units';
import { emptyMessage, esc, int, mix, n1, palette, ramp, wrapSvg, type Frame, type PosterOptions } from './common';

type Poster = { svg: string; width: number; height: number };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The most recent `n` calendar years that contain activities, oldest first. */
export function recentYears(acts: Activity[], tz: PosterOptions['tz'], n = 8): number[] {
  return [...new Set(acts.map((a) => parts(a.startMs, tz).y))].sort((a, b) => b - a).slice(0, n).reverse();
}

const metricOf = (a: Activity, o: PosterOptions) => (o.calendarMetric === 'distance' ? a.distanceM : a.movingS);
const metricUnit = (o: PosterOptions) => (o.calendarMetric === 'distance' ? distanceUnit(o.units) : 'h');
const metricShow = (v: number, o: PosterOptions) => (o.calendarMetric === 'distance' ? distance(v, o.units) : v / 3600);

// ---------- activity bubbles (packed circles) ----------

const MAX_BUBBLES = 1000;

/** Greedy spiral packing with a spatial hash. Radii are in units where the biggest circle has r = 1. */
export function packCircles(radii: number[], gap = 0.04): { x: number; y: number; r: number }[] {
  const out: { x: number; y: number; r: number }[] = [];
  const CELL = 2.2;
  const grid = new Map<string, number[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  const fits = (x: number, y: number, r: number) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const k of grid.get(key(cx + i, cy + j)) ?? []) {
        const c = out[k]!;
        if ((c.x - x) ** 2 + (c.y - y) ** 2 < (c.r + r + gap) ** 2) return false;
      }
    }
    return true;
  };
  let extent = 0;
  radii.forEach((r, i) => {
    let x = 0, y = 0;
    if (i > 0) {
      const pitch = Math.max(r * 0.9, 0.04);
      let rad = Math.max(0, extent * 0.55 - 2);
      let th = 0;
      for (;;) {
        x = rad * Math.cos(th); y = rad * Math.sin(th);
        if (fits(x, y, r)) break;
        const dth = Math.max(0.01, (r * 0.8) / (rad + 0.5));
        th += dth;
        rad += (pitch * dth) / (2 * Math.PI);
      }
    }
    out.push({ x, y, r });
    const k = key(Math.floor(x / CELL), Math.floor(y / CELL));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
    extent = Math.max(extent, Math.hypot(x, y) + r);
  });
  return out;
}

export function circles(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  const items = acts.filter((a) => a.distanceM > 0).sort((a, b) => b.distanceM - a.distanceM).slice(0, MAX_BUBBLES);
  if (!items.length) return wrapSvg(f, o, emptyMessage(f, 'No activities with distance in this selection'));
  const keyOf = (a: Activity) => (o.circleColor === 'sport' ? a.sport : String(parts(a.startMs, o.tz).y));
  const counts = new Map<string, number>();
  for (const a of items) counts.set(keyOf(a), (counts.get(keyOf(a)) ?? 0) + 1);
  const keys = [...counts.keys()].sort(o.circleColor === 'sport' ? (a, b) => counts.get(b)! - counts.get(a)! : undefined);
  const colors = palette(f.theme, keys.length);
  const maxD = Math.sqrt(items[0]!.distanceM);
  const placed = packCircles(items.map((a) => Math.sqrt(a.distanceM) / maxD));
  const extent = Math.max(...placed.map((c) => Math.hypot(c.x, c.y) + c.r));
  const legendH = 48;
  const R = Math.min(f.w, f.h - legendH) / 2;
  const k = R / extent;
  const cx = f.x + f.w / 2, cy = f.y + (f.h - legendH) / 2;
  const body = placed.map((c, i) => `<circle cx="${n1(cx + c.x * k)}" cy="${n1(cy + c.y * k)}" r="${n1(c.r * k)}" fill="${colors[keys.indexOf(keyOf(items[i]!))]}" fill-opacity="0.88"/>`).join('');
  let lx = f.x;
  const legend = keys.map((key, i) => {
    const x = lx;
    lx += 30 + key.length * 11 + 22;
    return `<circle cx="${x + 7}" cy="${f.y + f.h - 16}" r="7" fill="${colors[i]}"/><text x="${x + 22}" y="${f.y + f.h - 10}" font-size="18" fill="${f.theme.muted}">${esc(key)}</text>`;
  }).join('');
  return wrapSvg(f, o, `<g>${body}</g>${legend}`);
}

// ---------- time-of-day ridges ----------

export function timeOfDay(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  if (!acts.length) return wrapSvg(f, o, emptyMessage(f, 'No activities in this selection'));
  const rowKey = (a: Activity): number => {
    const p = parts(a.startMs, o.tz);
    return o.todRows === 'year' ? p.y : o.todRows === 'month' ? p.m - 1 : p.wd;
  };
  const labels: [number, string][] =
    o.todRows === 'year' ? recentYears(acts, o.tz, 12).map((y): [number, string] => [y, String(y)])
    : o.todRows === 'month' ? MON.map((m, i): [number, string] => [i, m]) : DOW.map((d, i): [number, string] => [i, d]);
  const BINS = 96, BW = 0.9;
  const dens = labels.map(([k]) => {
    const row = new Array<number>(BINS).fill(0);
    const sel = acts.filter((a) => rowKey(a) === k);
    for (const a of sel) {
      const h = hourOf(a.startMs, o.tz);
      for (let b = 0; b < BINS; b++) {
        let d = Math.abs((b * 24) / BINS - h);
        d = Math.min(d, 24 - d); // circular: 23:30 is close to 00:30
        row[b]! += Math.exp(-0.5 * (d / BW) ** 2);
      }
    }
    return { row, n: sel.length };
  });
  const max = Math.max(...dens.flatMap((d) => d.row), 1e-9);
  const left = 90, right = 70, x0 = f.x + left, w = f.w - left - right;
  const n = labels.length;
  const spacing = (f.h - 50) / (n + 1.5);
  const amp = Math.min(spacing * 2.4, f.h * 0.26);
  let body = [0, 6, 12, 18, 24].map((h) => {
    const x = x0 + (h / 24) * w;
    return `<line x1="${n1(x)}" x2="${n1(x)}" y1="${f.y}" y2="${n1(f.y + f.h - 36)}" stroke="${f.theme.muted}" stroke-opacity="0.25"/>` +
      `<text x="${n1(x)}" y="${n1(f.y + f.h - 8)}" font-size="16" text-anchor="middle" fill="${f.theme.muted}">${String(h).padStart(2, '0')}:00</text>`;
  }).join('');
  dens.forEach((d, i) => {
    const base = f.y + spacing * 1.5 + i * spacing + spacing * 0.5;
    const pts = d.row.map((v, b) => `${n1(x0 + ((b + 0.5) / BINS) * w)},${n1(base - (v / max) * amp)}`);
    const line = `M${pts.join('L')}`;
    body += `<path d="${line}L${n1(x0 + w)},${n1(base)}L${n1(x0)},${n1(base)}Z" fill="${f.theme.bg}"/>` +
      `<path d="${line}" fill="none" stroke="${i === n - 1 && o.todRows === 'year' ? f.theme.accent : f.theme.fg}" stroke-width="${n1(Math.min(3.5, Math.max(1.4, spacing * 0.05)))}" stroke-linejoin="round"/>` +
      `<text x="${f.x}" y="${n1(base)}" font-size="${n1(Math.min(22, spacing * 0.5))}" fill="${f.theme.fg}">${esc(labels[i]![1])}</text>` +
      `<text x="${n1(x0 + w + 12)}" y="${n1(base)}" font-size="14" fill="${f.theme.muted}">${int(d.n)}</text>`;
  });
  return wrapSvg(f, o, body);
}

// ---------- weekly rhythm (punch card) ----------

export function punchCard(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  if (!acts.length) return wrapSvg(f, o, emptyMessage(f, 'No activities in this selection'));
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const count = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const a of acts) {
    const wd = parts(a.startMs, o.tz).wd, h = Math.min(23, Math.floor(hourOf(a.startMs, o.tz)));
    grid[wd]![h]! += o.punchMetric === 'count' ? 1 : a.distanceM;
    count[wd]![h]!++;
  }
  const max = Math.max(...grid.flat(), 1e-9);
  const labelW = 70;
  const cell = Math.min((f.w - labelW) / 24, f.h / 9);
  const gw = cell * 24, gh = cell * 7;
  const gx = f.x + (f.w - gw - labelW) / 2 + labelW, gy = f.y + (f.h - gh - cell * 3) / 2 + cell * 0.8;
  let body = '';
  for (let d = 0; d < 7; d++) {
    body += `<text x="${n1(gx - 14)}" y="${n1(gy + d * cell + cell * 0.62)}" font-size="${n1(Math.min(24, cell * 0.5))}" text-anchor="end" fill="${f.theme.muted}">${DOW[d]}</text>`;
    for (let h = 0; h < 24; h++) {
      const v = grid[d]![h]!;
      const r = v > 0 ? Math.max(cell * 0.09, Math.sqrt(v / max) * cell * 0.46) : cell * 0.05;
      body += `<circle cx="${n1(gx + h * cell + cell / 2)}" cy="${n1(gy + d * cell + cell / 2)}" r="${n1(r)}" fill="${v > 0 ? f.theme.accent : mix(f.theme.bg, f.theme.fg, 0.2)}"/>`;
    }
  }
  for (let h = 0; h < 24; h += 3) body += `<text x="${n1(gx + h * cell + cell / 2)}" y="${n1(gy - cell * 0.35)}" font-size="${n1(Math.min(20, cell * 0.42))}" text-anchor="middle" fill="${f.theme.muted}">${String(h).padStart(2, '0')}</text>`;
  let best = [0, 0, 0];
  for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) if (grid[d]![h]! > best[2]!) best = [d, h, grid[d]![h]!];
  const bn = count[best[0]!]![best[1]!]!;
  body += `<text x="${n1(gx)}" y="${n1(gy + gh + cell * 1.6)}" font-size="${n1(Math.min(26, cell * 0.6))}" fill="${f.theme.fg}">Busiest slot: ${DOW[best[0]!]} ${String(best[1]).padStart(2, '0')}:00 · ${int(bn)} ${bn === 1 ? 'activity' : 'activities'}</text>`;
  return wrapSvg(f, o, body);
}

// ---------- year rings (polar calendar) ----------

function sector(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${n1(cx + r * Math.cos(a))},${n1(cy + r * Math.sin(a))}`;
  return `M${p(r1, a0)}A${n1(r1)},${n1(r1)} 0 0 1 ${p(r1, a1)}L${p(r0, a1)}A${n1(r0)},${n1(r0)} 0 0 0 ${p(r0, a0)}Z`;
}

export function rings(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  if (!acts.length) return wrapSvg(f, o, emptyMessage(f, 'No activities in this selection'));
  const years = recentYears(acts, o.tz);
  const perDay = new Map<number, number>();
  for (const a of acts) {
    const d = dayNumber(parts(a.startMs, o.tz));
    perDay.set(d, (perDay.get(d) ?? 0) + metricOf(a, o));
  }
  const nz = [...perDay.values()].filter((v) => v > 0).sort((a, b) => a - b);
  const cut = [0.25, 0.5, 0.75].map((p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] ?? 0);
  const level = (v: number) => (v <= 0 ? 0 : v < cut[0]! ? 1 : v < cut[1]! ? 2 : v < cut[2]! ? 3 : 4);
  const colors = ramp(f.theme);
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  const R = Math.min(f.w, f.h) / 2 - 34;
  const r0 = R * 0.26;
  const band = (R - r0) / years.length;
  let body = '';
  years.forEach((y, yi) => {
    const jan1 = dayNumber({ y, m: 1, d: 1, wd: 0 });
    const days = dayNumber({ y: y + 1, m: 1, d: 1, wd: 0 }) - jan1;
    const inner = r0 + yi * band + band * 0.06, outer = r0 + (yi + 1) * band - band * 0.06;
    for (let i = 0; i < days; i++) {
      const a0 = -Math.PI / 2 + (i / days) * 2 * Math.PI, a1 = -Math.PI / 2 + ((i + 0.88) / days) * 2 * Math.PI;
      body += `<path d="${sector(cx, cy, inner, outer, a0, a1)}" fill="${colors[level(perDay.get(jan1 + i) ?? 0)]}"/>`;
    }
  });
  for (let m = 0; m < 12; m++) {
    const first = dayNumber({ y: 2023, m: m + 1, d: 1, wd: 0 }) - dayNumber({ y: 2023, m: 1, d: 1, wd: 0 });
    const a = -Math.PI / 2 + ((first + 14) / 365) * 2 * Math.PI;
    body += `<text x="${n1(cx + (R + 22) * Math.cos(a))}" y="${n1(cy + (R + 22) * Math.sin(a) + 6)}" font-size="17" text-anchor="middle" fill="${f.theme.muted}">${MON[m]}</text>`;
  }
  const total = acts.filter((a) => years.includes(parts(a.startMs, o.tz).y)).reduce((s, a) => s + metricOf(a, o), 0);
  body += `<text x="${cx}" y="${n1(cy + 8)}" font-size="${n1(r0 * 0.46)}" font-weight="700" text-anchor="middle" fill="${f.theme.fg}">${int(metricShow(total, o))}</text>` +
    `<text x="${cx}" y="${n1(cy + 8 + r0 * 0.34)}" font-size="${n1(r0 * 0.17)}" letter-spacing="3" text-anchor="middle" fill="${f.theme.muted}">${esc(metricUnit(o).toUpperCase())} · ${years[0]}${years.length > 1 ? `–${years[years.length - 1]}` : ''}</text>`;
  return wrapSvg(f, o, body);
}

// ---------- year over year (cumulative lines) ----------

export function cumulative(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  if (!acts.length) return wrapSvg(f, o, emptyMessage(f, 'No activities in this selection'));
  const years = recentYears(acts, o.tz, 8);
  const colors = palette(f.theme, years.length);
  const series = years.map((y) => {
    const days = new Array<number>(366).fill(0);
    let lastDay = 0;
    for (const a of acts) {
      const p = parts(a.startMs, o.tz);
      if (p.y !== y) continue;
      const doy = dayNumber(p) - dayNumber({ y, m: 1, d: 1, wd: 0 });
      days[doy]! += metricShow(metricOf(a, o), o);
      lastDay = Math.max(lastDay, doy);
    }
    const isLatest = y === years[years.length - 1];
    const end = isLatest ? lastDay : y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 365 : 364;
    let acc = 0;
    return { y, pts: Array.from({ length: end + 1 }, (_, d) => (acc += days[d]!)) };
  });
  const maxV = Math.max(...series.map((s) => s.pts[s.pts.length - 1]!), 1e-9);
  const nice = niceCeil(maxV);
  const left = 70, right = 170, top = 20, bottom = 50;
  const px = f.x + left, pw = f.w - left - right, py = f.y + top, ph = f.h - top - bottom;
  const X = (d: number) => px + (d / 365) * pw, Y = (v: number) => py + ph - (v / nice) * ph;
  let body = '';
  for (let i = 0; i <= 4; i++) {
    const v = (nice * i) / 4;
    body += `<line x1="${px}" x2="${px + pw}" y1="${n1(Y(v))}" y2="${n1(Y(v))}" stroke="${f.theme.muted}" stroke-opacity="0.25"/>` +
      `<text x="${px - 12}" y="${n1(Y(v) + 6)}" font-size="16" text-anchor="end" fill="${f.theme.muted}">${int(v)}</text>`;
  }
  for (let m = 0; m < 12; m++) {
    const d = dayNumber({ y: 2023, m: m + 1, d: 1, wd: 0 }) - dayNumber({ y: 2023, m: 1, d: 1, wd: 0 });
    body += `<text x="${n1(X(d))}" y="${n1(py + ph + 30)}" font-size="16" fill="${f.theme.muted}">${MON[m]}</text>`;
  }
  const ends: { y: number; label: string; color: string; latest: boolean }[] = [];
  series.forEach((s, i) => {
    const latest = i === series.length - 1;
    body += `<path d="M${s.pts.map((v, d) => `${n1(X(d))},${n1(Y(v))}`).join('L')}" fill="none" stroke="${colors[i]}" stroke-width="${latest ? 5 : 3}" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="${latest ? 1 : 0.8}"/>`;
    ends.push({ y: Y(s.pts[s.pts.length - 1]!), label: `${s.y} · ${int(s.pts[s.pts.length - 1]!)} ${metricUnit(o)}`, color: colors[i]!, latest });
  });
  // De-overlap the end labels (at least 24 units apart, top to bottom).
  const order = ends.map((e, i) => i).sort((a, b) => ends[a]!.y - ends[b]!.y);
  let prev = -Infinity;
  for (const i of order) { ends[i]!.y = Math.max(ends[i]!.y, prev + 24); prev = ends[i]!.y; }
  body += ends.map((e, i) => {
    const s = series[i]!;
    return `<text x="${n1(X(Math.min(365, s.pts.length - 1)) + 12)}" y="${n1(e.y + 5)}" font-size="${e.latest ? 19 : 17}" font-weight="${e.latest ? 700 : 400}" fill="${e.color}">${esc(e.label)}</text>`;
  }).join('');
  return wrapSvg(f, o, body);
}

function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
