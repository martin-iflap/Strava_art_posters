import type { Activity } from '../types';
import { parts } from '../util/time';
import { distance, distanceUnit } from '../util/units';
import { emptyMessage, esc, fmtCount, int, mix, n1, palette, wrapSvg, type Frame, type Poster, type PosterOptions } from './common';


/** Equatorial circumference and mean Earth–Moon distance, metres. */
export const EARTH_M = 40_075_000;
export const MOON_M = 384_400_000;

/** Arc along a circle (clockwise from 12 o'clock), angles in laps (0..1). Splits arcs over half a lap. */
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => `${n1(cx + r * Math.sin(a * 2 * Math.PI))},${n1(cy - r * Math.cos(a * 2 * Math.PI))}`;
  let d = `M${p(a0)}`;
  for (let a = a0; a < a1 - 1e-9;) {
    const b = Math.min(a1, a + 0.5);
    d += `A${n1(r)},${n1(r)} 0 0 1 ${p(b)}`;
    a = b;
  }
  return d;
}

/**
 * Laps around the equator: the distance is wound clockwise around a line-art globe, one ring per
 * 40,075 km, rings growing outward; segments are coloured by year.
 */
export function world(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  const sel = acts.filter((a) => a.distanceM > 0).sort((a, b) => a.startMs - b.startMs);
  const total = sel.reduce((s, a) => s + a.distanceM, 0);
  if (!total) return wrapSvg(f, o, emptyMessage(f, 'No distance in this selection'));
  const t = f.theme;
  const laps = total / EARTH_M;
  const du = distanceUnit(o.units);
  // Square and landscape frames put the numbers in a column beside the globe; tall ones keep them in a row
  // above it. Either way the globe gets all the remaining room.
  const side = f.h < f.w * 1.1;
  const years = [...new Set(sel.map((a) => parts(a.startMs, o.tz).y))].sort((a, b) => a - b);
  const colors = palette(t, years.length);
  const moon = total / MOON_M;
  const stats: [string, string, string, string][] = [
    [fmtCount(laps), '×', 'around the world', `EQUATOR · ${int(distance(EARTH_M, o.units))} ${du.toUpperCase()}`],
    [moon >= 1 ? fmtCount(moon) : String(Math.round(moon * 1000) / 10), moon >= 1 ? '×' : '%', moon >= 1 ? 'the way to the Moon' : 'of the way to the Moon', `${int(distance(MOON_M, o.units))} ${du.toUpperCase()} AWAY`],
    [int(distance(total, o.units)), du, 'in total', `${int(sel.length)} ACTIVITIES`],
  ];
  const stat = (x: number, y: number, [big, unit, label, detail]: [string, string, string, string]) =>
    `<text x="${n1(x)}" y="${n1(y + 46)}" font-size="46" font-weight="700" letter-spacing="-2" fill="${t.fg}">${esc(big)}<tspan font-size="26" font-weight="600" dx="3" fill="${t.accent}">${unit}</tspan></text>` +
    `<text x="${n1(x)}" y="${n1(y + 74)}" font-size="17" font-weight="600" fill="${t.fg}">${esc(label)}</text>` +
    `<text x="${n1(x)}" y="${n1(y + 95)}" font-size="12" letter-spacing="1" fill="${t.muted}">${esc(detail)}</text>`;
  const legendItem = (x: number, y: number, i: number) =>
    `<circle cx="${n1(x + 8)}" cy="${n1(y - 6)}" r="7" fill="${colors[i]}"/><text x="${n1(x + 22)}" y="${n1(y)}" font-size="17" fill="${t.fg}">${years[i]}</text>`;
  let body = `<text x="${f.x}" y="${f.y + 18}" font-size="16" letter-spacing="3" fill="${t.muted}">YOU WENT</text>`;
  let area: { x: number; y: number; w: number; h: number };
  if (side) {
    const colW = Math.min(300, f.w * 0.34);
    stats.forEach((st, i) => (body += stat(f.x, f.y + 28 + i * 112, st)));
    // legend in up to two columns under the numbers
    const ly = f.y + 28 + stats.length * 112 + 24, rows = Math.ceil(years.length / 2);
    if (years.length > 1) years.forEach((_, i) => (body += legendItem(f.x + (i >= rows ? colW / 2 : 0), ly + (i % rows) * 28, i)));
    area = { x: f.x + colW, y: f.y, w: f.w - colW, h: f.h };
  } else {
    const cw = f.w / 3;
    stats.forEach((st, i) => (body += stat(f.x + i * cw, f.y + 26, st)));
    const legendH = years.length > 1 ? 40 : 0;
    if (legendH) {
      const lw = Math.min(150, f.w / years.length), lx = f.x + (f.w - lw * years.length) / 2;
      years.forEach((_, i) => (body += legendItem(lx + i * lw, f.y + f.h - 8, i)));
    }
    area = { x: f.x, y: f.y + 140, w: f.w, h: f.h - 140 - legendH };
  }
  const size = Math.min(area.w, area.h);
  const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
  const R = size / 2 - 36; // room for the quarter labels
  const rings = Math.max(1, Math.ceil(laps));
  const rg = R * (rings === 1 ? 0.8 : rings === 2 ? 0.62 : rings <= 6 ? 0.5 : 0.4); // globe radius
  const r0 = rg + Math.max(14, R * 0.06);
  const gap = rings > 1 ? (R - r0) / (rings - 1) : 0;
  const ringR = (k: number) => r0 + k * gap;
  const sw = n1(Math.max(1.2, Math.min(9, gap * 0.55 || 9)));

  // Globe: outline, parallels and meridians (orthographic, no tilt), equator in the accent colour.
  const grid = mix(t.bg, t.fg, 0.28);
  body += `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(rg)}" fill="${mix(t.bg, t.accent, 0.08)}" stroke="${grid}" stroke-width="1.4"/>`;
  for (const lat of [-60, -30, 30, 60]) {
    const y = cy - rg * Math.sin((lat * Math.PI) / 180), hw = rg * Math.cos((lat * Math.PI) / 180);
    body += `<line x1="${n1(cx - hw)}" x2="${n1(cx + hw)}" y1="${n1(y)}" y2="${n1(y)}" stroke="${grid}" stroke-width="1"/>`;
  }
  for (const lon of [30, 60]) {
    const rx = rg * Math.sin((lon * Math.PI) / 180);
    body += `<ellipse cx="${n1(cx)}" cy="${n1(cy)}" rx="${n1(rx)}" ry="${n1(rg)}" fill="none" stroke="${grid}" stroke-width="1"/>`;
  }
  body += `<line x1="${n1(cx)}" x2="${n1(cx)}" y1="${n1(cy - rg)}" y2="${n1(cy + rg)}" stroke="${grid}" stroke-width="1"/>` +
    `<line x1="${n1(cx - rg)}" x2="${n1(cx + rg)}" y1="${n1(cy)}" y2="${n1(cy)}" stroke="${t.accent}" stroke-width="2.4"/>`;

  // Faint full track for every ring, then the distance wound on top, segment per year.
  for (let k = 0; k < rings; k++) body += `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(ringR(k))}" fill="none" stroke="${t.muted}" stroke-opacity="0.16" stroke-width="${sw}"/>`;
  let acc = 0;
  years.forEach((y, yi) => {
    const len = sel.filter((a) => parts(a.startMs, o.tz).y === y).reduce((s, a) => s + a.distanceM, 0);
    let a = acc / EARTH_M;
    const b = (acc + len) / EARTH_M;
    let d = '';
    while (a < b - 1e-9) {
      const k = Math.floor(a + 1e-9), e = Math.min(b, k + 1);
      d += arc(cx, cy, ringR(k), a - k, e - k);
      a = e;
    }
    body += `<path d="${d}" fill="none" stroke="${colors[yi]}" stroke-width="${sw}" stroke-linecap="butt"/>`;
    acc += len;
  });
  // Quarter-lap markers outside the outermost ring.
  const ro = ringR(rings - 1) + Number(sw) / 2 + 8;
  for (const [q, label] of [[0.25, '¼'], [0.5, '½'], [0.75, '¾']] as const) {
    const sx = Math.sin(q * 2 * Math.PI), sy = -Math.cos(q * 2 * Math.PI);
    body += `<line x1="${n1(cx + sx * (ro - 4))}" y1="${n1(cy + sy * (ro - 4))}" x2="${n1(cx + sx * (ro + 4))}" y2="${n1(cy + sy * (ro + 4))}" stroke="${t.muted}" stroke-width="1.5"/>` +
      `<text x="${n1(cx + sx * (ro + 20))}" y="${n1(cy + sy * (ro + 20) + 6)}" font-size="17" text-anchor="middle" fill="${t.muted}">${label}</text>`;
  }
  // Start tick and lap numbers at 12 o'clock.
  body += `<line x1="${n1(cx)}" x2="${n1(cx)}" y1="${n1(cy - r0 + 10)}" y2="${n1(cy - ringR(rings - 1) - 10)}" stroke="${t.fg}" stroke-opacity="0.5" stroke-width="1.2"/>`;
  const every = Math.max(gap >= 16 || rings === 1 ? 1 : Math.ceil(16 / Math.max(gap, 1e-9)), Math.ceil(Math.floor(laps) / 10));
  for (let k = 0; k < Math.floor(laps); k += every) {
    body += `<text x="${n1(cx - 6)}" y="${n1(cy - ringR(k) + 4)}" font-size="${n1(Math.min(13, Math.max(9, gap * 0.6)))}" text-anchor="end" fill="${t.muted}">${k + 1}</text>`;
  }
  // End marker
  const endA = laps - Math.min(rings - 1, Math.floor(laps - 1e-9));
  const er = ringR(Math.min(rings - 1, Math.floor(laps - 1e-9)));
  body += `<circle cx="${n1(cx + er * Math.sin(endA * 2 * Math.PI))}" cy="${n1(cy - er * Math.cos(endA * 2 * Math.PI))}" r="${n1(Math.max(5, Number(sw) * 0.9))}" fill="${t.fg}"/>`;

  return wrapSvg(f, o, body);
}
