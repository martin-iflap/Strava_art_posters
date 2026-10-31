import { esc, FONT } from '../posters/common';
import type { Units } from '../types';
import { distance, distanceUnit, elevation, elevationUnit } from '../util/units';
import type { Wrapped } from './data';

/*
 * The summary card as a 1080 × 1920 SVG (a phone story), turned into a PNG by the poster raster code.
 * The longest route is drawn with its ends trimmed (see data.ts), and no place names appear.
 */

export const SHARE_W = 1080;
export const SHARE_H = 1920;

const loc = (v: number, d = 0) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

function routePath(route: number[], x: number, y: number, w: number, hgt: number): string {
  const lat: number[] = [], lon: number[] = [];
  for (let i = 0; i < route.length; i += 2) { lat.push(route[i]!); lon.push(route[i + 1]!); }
  const k = Math.cos((((Math.min(...lat) + Math.max(...lat)) / 2) * Math.PI) / 180);
  const xs = lon.map((v) => v * k), ys = lat.map((v) => -v);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), bw = Math.max(...xs) - x0 || 1e-9, bh = Math.max(...ys) - y0 || 1e-9;
  const s = Math.min(w / bw, hgt / bh);
  const ox = x + (w - bw * s) / 2, oy = y + (hgt - bh * s) / 2;
  return 'M' + xs.map((v, i) => `${(ox + (v - x0) * s).toFixed(1)},${(oy + (ys[i]! - y0) * s).toFixed(1)}`).join('L');
}

export function shareSvg(w: Wrapped, units: Units): string {
  const dist = distance(w.summary.distanceM, units);
  const tiles: [string, string][] = [
    [`${loc(dist, dist < 100 ? 1 : 0)} ${distanceUnit(units)}`, 'distance'],
    [`${loc(w.summary.movingS / 3600)} h`, 'moving'],
    [`${loc(elevation(w.summary.elevGainM, units))} ${elevationUnit(units)}`, 'climbed'],
    [loc(w.summary.count), 'activities'],
    [loc(w.activeDays), 'active days'],
    [w.longestStreak ? `${w.longestStreak.days} d` : '–', 'longest streak'],
  ];
  if (w.workKj >= 1) tiles.push([`${loc(w.workKj)} kJ`, 'work done']);
  if (w.prs.length && w.period !== 'all') tiles.push([loc(w.prs.length), 'records broken']);
  const top = w.sports[0]?.sport ?? '';
  const colors = ['#ff6b4a', '#ffd23f', '#3ddc97', '#4cc9f0', '#b388ff', '#ff8fab'];
  let sx = 90;
  const stripes = w.sports.slice(0, 6).map((s, i) => {
    const wd = Math.max(s.share, 0.01) * 900;
    const r = `<rect x="${sx.toFixed(1)}" y="560" width="${wd.toFixed(1)}" height="22" fill="${colors[i]}"/>`;
    sx += wd;
    return r;
  }).join('');
  const grid = tiles.slice(0, 8).map(([v, l], i) => {
    const x = 90 + (i % 2) * 460, y = 720 + Math.floor(i / 2) * 190;
    return `<text x="${x}" y="${y}" font-size="72" font-weight="800" fill="#fff">${esc(v)}</text><text x="${x}" y="${y + 48}" font-size="30" fill="#fff" fill-opacity=".7">${esc(l)}</text>`;
  }).join('');
  const route = w.longestRoute ? `<path d="${routePath(w.longestRoute, 140, 1480, 420, 300)}" fill="none" stroke="#ffd23f" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<text x="620" y="1580" font-size="30" fill="#fff" fill-opacity=".7">Longest</text>
<text x="620" y="1640" font-size="54" font-weight="800" fill="#fff">${esc(`${loc(distance(w.longest!.distanceM, units), 1)} ${distanceUnit(units)}`)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_W}" height="${SHARE_H}" viewBox="0 0 ${SHARE_W} ${SHARE_H}" font-family="${esc(FONT)}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1464"/><stop offset=".55" stop-color="#6a1b9a"/><stop offset="1" stop-color="#e2445c"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<text x="90" y="200" font-size="40" font-weight="700" fill="#fff" fill-opacity=".75" letter-spacing="6">SPORT WRAPPED</text>
<text x="90" y="360" font-size="190" font-weight="900" fill="#fff" letter-spacing="-6">${esc(w.label)}</text>
<text x="90" y="470" font-size="54" font-weight="700" fill="#ffd23f">${esc(w.archetype.name)}</text>
<text x="90" y="530" font-size="30" fill="#fff" fill-opacity=".75">${esc(top ? `Mostly ${top}` : '')}</text>
${stripes}
${grid}
${route}
<text x="90" y="1840" font-size="28" fill="#fff" fill-opacity=".6">Made with Ride Atlas · private, in your browser</text>
</svg>`;
}
