import type { Activity } from '../types';
import { parts } from '../util/time';
import { distance, distanceUnit, elevation, elevationUnit } from '../util/units';
import { emptyMessage, esc, int, mix, n1, palette, wrapSvg, type Frame, type PosterOptions } from './common';

type Poster = { svg: string; width: number; height: number };
const MON = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/**
 * Reference mountains, tallest first. Outlines are hand-drawn sketches in a unit box
 * (x 0..1 left to right, y 0 = summit .. 1 = base); `snow` is the snow cap drawn on top.
 */
export const MOUNTAINS = [
  {
    id: 'everest', name: 'Everest', plural: 'Everests', heightM: 8849,
    outline: [[0, 1], [0.12, 0.78], [0.2, 0.7], [0.28, 0.52], [0.36, 0.46], [0.44, 0.24], [0.52, 0], [0.6, 0.2], [0.66, 0.17], [0.74, 0.42], [0.84, 0.6], [0.92, 0.8], [1, 1]],
    snow: [[0.31, 0.49], [0.36, 0.46], [0.44, 0.24], [0.52, 0], [0.6, 0.2], [0.66, 0.17], [0.71, 0.35], [0.66, 0.3], [0.61, 0.37], [0.55, 0.29], [0.49, 0.4], [0.43, 0.33], [0.37, 0.51]],
  },
  {
    id: 'montblanc', name: 'Mont Blanc', plural: 'Mont Blancs', heightM: 4806,
    outline: [[0, 1], [0.1, 0.8], [0.2, 0.6], [0.3, 0.36], [0.4, 0.14], [0.5, 0], [0.6, 0.07], [0.72, 0.28], [0.8, 0.42], [0.88, 0.66], [1, 1]],
    snow: [[0.24, 0.5], [0.3, 0.36], [0.4, 0.14], [0.5, 0], [0.6, 0.07], [0.72, 0.28], [0.78, 0.4], [0.71, 0.45], [0.63, 0.37], [0.55, 0.5], [0.47, 0.4], [0.39, 0.53], [0.31, 0.46]],
  },
  {
    id: 'olympus', name: 'Olympus', plural: 'Olympuses', heightM: 2918,
    outline: [[0, 1], [0.1, 0.7], [0.2, 0.56], [0.28, 0.3], [0.34, 0.36], [0.42, 0.06], [0.48, 0.16], [0.54, 0], [0.6, 0.2], [0.66, 0.14], [0.74, 0.4], [0.86, 0.62], [1, 1]],
    snow: [[0.38, 0.19], [0.42, 0.06], [0.48, 0.16], [0.54, 0], [0.6, 0.2], [0.57, 0.25], [0.52, 0.15], [0.48, 0.26], [0.44, 0.19]],
  },
] as const;

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

const poly = (pts: readonly (readonly [number, number])[], x: number, y: number, w: number, h: number) =>
  'M' + pts.map(([px, py]) => `${n1(x + px * w)},${n1(y + py * h)}`).join('L') + 'Z';

/** `year` null = all time. */
export function climb(acts: Activity[], o: PosterOptions, f: Frame, year: number | null): Poster {
  const { pts, starts } = climbSeries(acts);
  const totalM = pts[pts.length - 1]![1], totalD = pts[pts.length - 1]![0];
  if (!acts.length || totalM <= 0) return wrapSvg(f, o, emptyMessage(f, 'No elevation gain in this selection'));
  const t = f.theme;
  const colors = palette(t, 3);
  const counts = mountainCounts(totalM);
  const eu = elevationUnit(o.units);

  // Headline: one figure per mountain.
  const cw = f.w / 3;
  let body = `<text x="${f.x}" y="${f.y + 24}" font-size="18" letter-spacing="3" fill="${t.muted}">YOU CLIMBED</text>`;
  counts.forEach(({ mountain: m, count }, i) => {
    const x = f.x + i * cw;
    const v = count >= 100 ? int(count) : count >= 10 ? n1(count) : (Math.round(count * 100) / 100).toString();
    body += `<text x="${x}" y="${f.y + 92}" font-size="62" font-weight="700" letter-spacing="-2" fill="${colors[i]}">${esc(v)}<tspan font-size="34" font-weight="600" dx="4">×</tspan></text>` +
      `<text x="${x}" y="${f.y + 124}" font-size="19" font-weight="600" fill="${t.fg}">${esc(count >= 1.5 || count < 0.5 ? m.plural : m.name)}</text>` +
      `<text x="${x}" y="${f.y + 148}" font-size="15" letter-spacing="1" fill="${t.muted}">${int(elevation(m.heightM, o.units))} ${eu} EACH</text>`;
  });

  // Plot area: cumulative climb on the left, mountain towers on the right, sharing the vertical scale.
  const top = f.y + 200, bottom = f.y + f.h - 46;
  const ph = bottom - top;
  const towersW = Math.min(f.w * 0.36, 330);
  const left = 64;
  const px = f.x + left, pw = f.w - left - towersW - 28;
  const maxY = elevation(totalM, o.units) * 1.06;
  const Y = (m: number) => bottom - (elevation(m, o.units) / maxY) * ph;
  const X = (m: number) => px + (totalD > 0 ? m / totalD : 0) * pw;
  const step = niceStep(maxY, 5);
  for (let v = 0; v <= maxY; v += step) {
    const yy = bottom - (v / maxY) * ph;
    body += `<line x1="${px}" x2="${f.x + f.w}" y1="${n1(yy)}" y2="${n1(yy)}" stroke="${t.muted}" stroke-opacity="${v === 0 ? 0.5 : 0.18}"/>` +
      `<text x="${px - 10}" y="${n1(yy + 5)}" font-size="15" text-anchor="end" fill="${t.muted}">${int(v)}</text>`;
  }
  body += `<text x="${px - 10}" y="${top - 14}" font-size="14" text-anchor="end" fill="${t.muted}">${eu}</text>`;
  const dMax = distance(totalD, o.units), dStep = niceStep(dMax, 4);
  for (let v = 0; v <= dMax + 1e-9; v += dStep) {
    const xx = px + (dMax > 0 ? v / dMax : 0) * pw;
    body += `<text x="${n1(xx)}" y="${bottom + 26}" font-size="15" text-anchor="${v === 0 ? 'start' : v + dStep > dMax + 1e-9 ? 'end' : 'middle'}" fill="${t.muted}">${int(v)}</text>`;
  }
  body += `<text x="${px + pw}" y="${bottom + 44}" font-size="14" text-anchor="end" fill="${t.muted}">${distanceUnit(o.units)} covered</text>`;
  // Month boundaries along the distance axis (single year only).
  if (year !== null) {
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
  const line = 'M' + pts.map(([d, e]) => `${n1(X(d))},${n1(Y(e))}`).join('L');
  body += `<path d="${line}L${n1(X(totalD))},${bottom}L${px},${bottom}Z" fill="url(#climbfill)"/>` +
    `<path d="${line}" fill="none" stroke="${t.accent}" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round"/>`;
  const topY = Y(totalM);
  body += `<line x1="${px}" x2="${f.x + f.w}" y1="${n1(topY)}" y2="${n1(topY)}" stroke="${t.fg}" stroke-opacity="0.55" stroke-dasharray="6 6"/>` +
    `<circle cx="${n1(X(totalD))}" cy="${n1(topY)}" r="6" fill="${t.accent}"/>` +
    `<text x="${n1(X(totalD) - 12)}" y="${n1(topY - 14)}" font-size="20" font-weight="700" text-anchor="end" fill="${t.fg}">${int(elevation(totalM, o.units))} ${eu}</text>`;

  // Towers: each mountain repeated on top of itself up to the climbing total (the last one is cut off there).
  // With a lot of climbing a single mountain gets too flat to read, so one drawn mountain then stands for
  // several (same vertical scale: it is drawn that many times taller).
  const gap = 14, tw = (towersW - 2 * gap) / 3;
  const tx0 = f.x + f.w - towersW;
  let defs = `<linearGradient id="climbfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.accent}" stop-opacity="0.45"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0.04"/></linearGradient>` +
    `<clipPath id="belowtop"><rect x="${tx0 - 4}" y="${n1(topY)}" width="${towersW + 8}" height="${n1(bottom - topY + 2)}"/></clipPath>`;
  let towers = '';
  counts.forEach(({ mountain: m, count }, i) => {
    const x = tx0 + i * (tw + gap);
    const one = bottom - Y(m.heightM);
    const group = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((g) => one * g >= 30) ?? 1000;
    const mh = one * group;
    const rock = mix(t.bg, colors[i]!, 0.42), edge = mix(t.bg, colors[i]!, 0.9);
    const sw = n1(Math.max(0.4, Math.min(1.6, mh * 0.04)));
    for (let k = 0; k < Math.ceil(count / group); k++) {
      const y = bottom - (k + 1) * mh;
      towers += `<path d="${poly(m.outline, x, y, tw, mh)}" fill="${rock}" stroke="${edge}" stroke-width="${sw}" stroke-linejoin="round"/>`;
      if (mh > 10) towers += `<path d="${poly(m.snow, x, y, tw, mh)}" fill="#ffffff" fill-opacity="0.92"/>`;
    }
    body += `<text x="${n1(x + tw / 2)}" y="${bottom + 26}" font-size="15" font-weight="600" text-anchor="middle" fill="${colors[i]}">${esc(m.name)}</text>`;
    if (group > 1) body += `<text x="${n1(x + tw / 2)}" y="${bottom + 44}" font-size="13" text-anchor="middle" fill="${t.muted}">each = ${group}</text>`;
  });
  body += `<g clip-path="url(#belowtop)">${towers}</g>`;
  return wrapSvg(f, o, body, defs);
}
