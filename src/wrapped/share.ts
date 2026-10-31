import { esc, FONT } from '../posters/common';
import type { Units } from '../types';
import { distance, distanceUnit, elevation, elevationUnit } from '../util/units';
import { ACCENT, MUTED, TEXT, cumulative, dayTicks, heatYear, heatYears, routesMap } from './charts';
import type { Wrapped } from './data';

/*
 * The summary card as a 1080 × 1920 SVG (a phone story), turned into a PNG by the poster raster code.
 * Same look as the cards: black, one accent, the year's charts. Routes have their ends trimmed (data.ts)
 * and no place names appear.
 */

export const SHARE_W = 1080;
export const SHARE_H = 1920;

const loc = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Place a chart (an <svg> string with a viewBox) at x, y with width w; returns it and its height. */
function place(chart: string, x: number, y: number, w: number): { svg: string; h: number } {
  const m = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(chart)!;
  const h = (w * Number(m[2])) / Number(m[1]);
  return { svg: chart.replace('<svg ', `<svg x="${x}" y="${y}" width="${w}" height="${h.toFixed(1)}" `), h };
}

export function shareSvg(w: Wrapped, units: Units): string {
  const dist = distance(w.summary.distanceM, units);
  const tiles: [string, string][] = [
    [`${loc(dist, dist < 100 ? 1 : 0)} ${distanceUnit(units)}`, 'distance'],
    [`${loc(w.summary.movingS / 3600)} h`, 'moving'],
    [`${loc(elevation(w.summary.elevGainM, units))} ${elevationUnit(units)}`, 'climbed'],
    [loc(w.summary.count), 'activities'],
    [loc(w.activeDays), 'active days'],
    [w.longestStreak ? `${w.longestStreak.days} days` : '–', 'longest streak'],
  ];
  const all = w.period === 'all';
  const heat = place(all ? heatYears(w.daily.map((d) => d.m), w.day0) : heatYear(w.daily.map((d) => d.s), w.day0), 90, 430, 900);
  let s = 0;
  const series = w.daily.map((d) => (s += distance(d.m, units)));
  const ticks = dayTicks(w.day0, w.day1).map((t) => ({ at: t.day - w.day0, label: t.label }));
  const line = place(cumulative(series, { ticks, h: 170 }), 90, 470 + heat.h, 900);
  const gy = 560 + heat.h + line.h;
  const grid = tiles.map(([v, l], i) => {
    const x = 90 + (i % 3) * 310, y = gy + Math.floor(i / 3) * 170;
    return `<text x="${x}" y="${y}" font-size="58" font-weight="700" fill="${TEXT}" letter-spacing="-1">${esc(v)}</text><text x="${x}" y="${y + 44}" font-size="28" fill="${MUTED}">${esc(l)}</text>`;
  }).join('');
  const ry = gy + 300;
  const route = w.longestRoute && ry + 340 < SHARE_H - 140 ? place(routesMap([w.longestRoute], { h: 260, accentFirst: true, width: 2 }), 90, ry, 460).svg
    + `<text x="600" y="${ry + 120}" font-size="28" fill="${MUTED}">Longest</text><text x="600" y="${ry + 180}" font-size="58" font-weight="700" fill="${TEXT}">${esc(`${loc(distance(w.longest!.distanceM, units), 1)} ${distanceUnit(units)}`)}</text>`
    + `<text x="600" y="${ry + 220}" font-size="28" fill="${MUTED}">${esc(w.longest!.sport)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_W}" height="${SHARE_H}" viewBox="0 0 ${SHARE_W} ${SHARE_H}" font-family="${esc(FONT)}">
<rect width="100%" height="100%" fill="#000"/>
<text x="90" y="170" font-size="32" font-weight="600" fill="${MUTED}" letter-spacing="2">SPORT WRAPPED</text>
<text x="90" y="310" font-size="${all ? 130 : 170}" font-weight="700" fill="${TEXT}" letter-spacing="-5">${esc(w.label)}</text>
<text x="90" y="380" font-size="40" font-weight="600" fill="${ACCENT}">${esc(w.archetype.name)}${w.sports[0] ? `<tspan fill="${MUTED}" font-weight="400"> · mostly ${esc(w.sports[0].sport)}</tspan>` : ''}</text>
${heat.svg}
${line.svg}
${grid}
${route}
<line x1="90" x2="990" y1="1790" y2="1790" stroke="#fff" stroke-opacity=".16"/>
<text x="90" y="1846" font-size="26" fill="${MUTED}">Ride Atlas · made in the browser, nothing uploaded</text>
</svg>`;
}
