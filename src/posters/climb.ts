import type { Activity } from '../types';
import { parts } from '../util/time';
import { distance, distanceUnit, elevation, elevationUnit } from '../util/units';
import { emptyMessage, esc, int, n1, palette, wrapSvg, type Frame, type PosterOptions } from './common';
import { recentYears } from './more';

type Poster = { svg: string; width: number; height: number };
const MON = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/** Reference mountains, tallest first. */
export const MOUNTAINS = [
  { id: 'everest', name: 'Everest', plural: 'Everests', heightM: 8849 },
  { id: 'montblanc', name: 'Mont Blanc', plural: 'Mont Blancs', heightM: 4806 },
  { id: 'olympus', name: 'Olympus', plural: 'Olympuses', heightM: 2918 },
] as const;

/**
 * Where the climbing total would get you straight up: the next milestone not yet passed
 * (edge of space at the 100 km Kármán line, then the ISS orbit at about 408 km), as a share of it.
 */
export function upward(gainM: number): { share: number; label: string; detail: string } {
  if (gainM < 100_000) return { share: gainM / 100_000, label: 'of the way to space', detail: 'KÁRMÁN LINE · 100 KM' };
  if (gainM < 408_000) return { share: gainM / 408_000, label: 'of the way to the ISS', detail: 'ORBIT · 408 KM UP' };
  return { share: gainM / 408_000, label: 'the height of the ISS', detail: 'ORBIT · 408 KM UP' };
}

/** How many times the climbing total covers each reference mountain (fractional). */
export const mountainCounts = (gainM: number) => MOUNTAINS.map((m) => ({ mountain: m, count: gainM / m.heightM }));

/**
 * Cumulative climb: activities in date order, each one starting at the distance and elevation where the
 * previous one ended, so the line ends at (total distance, total elevation gain). Inside an activity the
 * gain is spread along its elevation profile (only the uphill parts rise); without a profile it is linear.
 * Returns [metres along, metres climbed] pairs, at most about `budget` points.
 */
export function climbSeries(acts: Activity[], budget = 3000): { pts: [number, number][]; starts: { ms: number; d: number }[] } {
  const sel = acts.filter((a) => a.distanceM > 0 || a.elevGainM > 0).sort((a, b) => a.startMs - b.startMs);
  const per = Math.max(2, Math.min(50, Math.floor(budget / (sel.length || 1))));
  const pts: [number, number][] = [[0, 0]];
  const starts: { ms: number; d: number }[] = [];
  let d0 = 0, e0 = 0;
  for (const a of sel) {
    starts.push({ ms: a.startMs, d: d0 });
    const p = a.profile;
    let cum: number[] | null = null;
    if (p && p.length > 2 && a.elevGainM > 0) {
      cum = [0];
      for (let i = 1; i < p.length; i++) cum.push(cum[i - 1]! + Math.max(0, p[i]! - p[i - 1]!));
      if (cum[cum.length - 1]! <= 0) cum = null;
    }
    for (let k = 1; k < per; k++) {
      const t = k / (per - 1);
      let frac = t;
      if (cum) {
        const x = t * (cum.length - 1), i = Math.min(cum.length - 2, Math.floor(x));
        frac = (cum[i]! + (cum[i + 1]! - cum[i]!) * (x - i)) / cum[cum.length - 1]!;
      }
      pts.push([d0 + t * a.distanceM, e0 + frac * a.elevGainM]);
    }
    d0 += a.distanceM;
    e0 += a.elevGainM;
  }
  return { pts, starts };
}

function niceStep(max: number, n: number): number {
  const raw = max / n, p = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= raw) return m * p;
  return 10 * p;
}

const fmtCount = (c: number) => (c >= 100 ? int(c) : c >= 10 ? n1(c) : (Math.round(c * 100) / 100).toString());

function headline(totalM: number, o: PosterOptions, f: Frame, kicker: string): string {
  const t = f.theme, eu = elevationUnit(o.units);
  const cw = f.w / 4;
  let s = `<text x="${f.x}" y="${f.y + 24}" font-size="18" letter-spacing="3" fill="${t.muted}">${esc(kicker.toUpperCase())}</text>`;
  const col = (i: number, big: string, unit: string, label: string, detail: string, color: string) => {
    const x = f.x + i * cw;
    s += `<text x="${x}" y="${f.y + 88}" font-size="54" font-weight="700" letter-spacing="-2" fill="${color}">${esc(big)}<tspan font-size="30" font-weight="600" dx="3" fill="${t.accent}">${unit}</tspan></text>` +
      `<text x="${x}" y="${f.y + 118}" font-size="18" font-weight="600" fill="${t.fg}">${esc(label)}</text>` +
      `<text x="${x}" y="${f.y + 141}" font-size="13" letter-spacing="1" fill="${t.muted}">${esc(detail)}</text>`;
  };
  mountainCounts(totalM).forEach(({ mountain: m, count }, i) =>
    col(i, fmtCount(count), '×', count >= 1.5 || count < 0.5 ? m.plural : m.name, `${int(elevation(m.heightM, o.units))} ${eu} EACH`, t.fg));
  const up = upward(totalM);
  col(3, up.share >= 1 ? fmtCount(up.share) : String(Math.round(up.share * 100)), up.share >= 1 ? '×' : '%', up.label, up.detail, t.fg);
  return s;
}

/** `mode`: a year, 'all' (one line over every activity) or 'overlay' (one line per year, each from zero). */
export function climb(acts: Activity[], o: PosterOptions, f: Frame, mode: number | 'all' | 'overlay'): Poster {
  const totalAll = acts.reduce((s, a) => s + a.elevGainM, 0);
  if (!acts.length || totalAll <= 0) return wrapSvg(f, o, emptyMessage(f, 'No elevation gain in this selection'));
  const t = f.theme;
  const eu = elevationUnit(o.units);
  const years = mode === 'overlay' ? recentYears(acts, o.tz, 8) : [];
  const series = mode === 'overlay'
    ? years.map((y) => ({ y, ...climbSeries(acts.filter((a) => parts(a.startMs, o.tz).y === y), 1500) }))
    : [{ y: 0, ...climbSeries(acts) }];
  const end = (s: (typeof series)[number]) => s.pts[s.pts.length - 1]!;
  const maxD = Math.max(...series.map((s) => end(s)[0]), 1e-9);
  const maxM = Math.max(...series.map((s) => end(s)[1]), 1e-9);

  let body = headline(totalAll, o, f, mode === 'overlay' ? `You climbed, ${years[0]} – ${years[years.length - 1]}` : mode === 'all' ? 'You climbed, all time' : `You climbed in ${mode}`);

  const top = f.y + 200, bottom = f.y + f.h - 46;
  const ph = bottom - top;
  const left = 64, right = mode === 'overlay' ? 190 : 10;
  const px = f.x + left, pw = f.w - left - right;
  const maxY = elevation(maxM, o.units) * 1.06;
  const Y = (m: number) => bottom - (elevation(m, o.units) / maxY) * ph;
  const X = (m: number) => px + (m / maxD) * pw;
  const step = niceStep(maxY, 5);
  for (let v = 0; v <= maxY; v += step) {
    const yy = bottom - (v / maxY) * ph;
    body += `<line x1="${px}" x2="${px + pw}" y1="${n1(yy)}" y2="${n1(yy)}" stroke="${t.muted}" stroke-opacity="${v === 0 ? 0.5 : 0.18}"/>` +
      `<text x="${px - 10}" y="${n1(yy + 5)}" font-size="15" text-anchor="end" fill="${t.muted}">${int(v)}</text>`;
  }
  body += `<text x="${px - 10}" y="${top - 14}" font-size="14" text-anchor="end" fill="${t.muted}">${eu}</text>`;
  const dMax = distance(maxD, o.units), dStep = niceStep(dMax, 4);
  for (let v = 0; v <= dMax + 1e-9; v += dStep) {
    const xx = px + (v / dMax) * pw;
    body += `<text x="${n1(xx)}" y="${bottom + 26}" font-size="15" text-anchor="${v === 0 ? 'start' : v + dStep > dMax + 1e-9 ? 'end' : 'middle'}" fill="${t.muted}">${int(v)}</text>`;
  }
  body += `<text x="${px + pw}" y="${bottom + 44}" font-size="14" text-anchor="end" fill="${t.muted}">${distanceUnit(o.units)} covered</text>`;
  const pathOf = (pts: [number, number][]) => 'M' + pts.map(([d, e]) => `${n1(X(d))},${n1(Y(e))}`).join('L');

  if (mode === 'overlay') {
    const colors = palette(t, series.length);
    const ends = series.map((s, i) => ({ y: Y(end(s)[1]), i }));
    series.forEach((s, i) => {
      const latest = i === series.length - 1;
      body += `<path d="${pathOf(s.pts)}" fill="none" stroke="${colors[i]}" stroke-width="${latest ? 4.5 : 2.8}" stroke-opacity="${latest ? 1 : 0.85}" stroke-linejoin="round" stroke-linecap="round"/>`;
    });
    // De-overlap end labels (at least 24 units apart).
    const order = [...ends].sort((a, b) => a.y - b.y);
    let prev = -Infinity;
    for (const e of order) { e.y = Math.max(e.y, prev + 24); prev = e.y; }
    for (const e of ends) {
      const s = series[e.i]!, latest = e.i === series.length - 1;
      body += `<text x="${n1(X(end(s)[0]) + 12)}" y="${n1(e.y + 5)}" font-size="${latest ? 19 : 17}" font-weight="${latest ? 700 : 400}" fill="${colors[e.i]}">${s.y} · ${int(elevation(end(s)[1], o.units))} ${eu}</text>`;
    }
    return wrapSvg(f, o, body);
  }

  const { pts, starts } = series[0]!;
  if (typeof mode === 'number') {
    let m = 0, lastLabel = -Infinity;
    for (const s of starts) {
      const mm = parts(s.ms, o.tz).m;
      if (mm <= m) continue;
      m = mm;
      if (s.d > 0) body += `<line x1="${n1(X(s.d))}" x2="${n1(X(s.d))}" y1="${top}" y2="${bottom}" stroke="${t.muted}" stroke-opacity="0.12"/>`;
      if (X(s.d) - lastLabel < 16) continue; // months with little distance would print on top of each other
      lastLabel = X(s.d);
      body += `<text x="${n1(X(s.d) + 4)}" y="${bottom - 8}" font-size="13" fill="${t.muted}" fill-opacity="0.8">${MON[mm - 1]}</text>`;
    }
  }
  const [lastD, lastM] = end(series[0]!);
  const topY = Y(lastM);
  body += `<path d="${pathOf(pts)}" fill="none" stroke="${t.accent}" stroke-width="3.6" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<line x1="${px}" x2="${n1(X(lastD))}" y1="${n1(topY)}" y2="${n1(topY)}" stroke="${t.fg}" stroke-opacity="0.4" stroke-dasharray="6 6"/>` +
    `<circle cx="${n1(X(lastD))}" cy="${n1(topY)}" r="6" fill="${t.accent}"/>` +
    `<text x="${n1(X(lastD) - 12)}" y="${n1(topY - 14)}" font-size="20" font-weight="700" text-anchor="end" fill="${t.fg}">${int(elevation(lastM, o.units))} ${eu}</text>`;
  return wrapSvg(f, o, body);
}
