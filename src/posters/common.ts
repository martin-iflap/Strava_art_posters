import type { Activity, Tz, Units } from '../types';
import { summarize } from '../stats/summary';
import { distance, distanceUnit, elevation, elevationUnit } from '../util/units';
import { parts } from '../util/time';

export type PosterType = 'facets' | 'overlay' | 'calendar' | 'ridgelines' | 'season' | 'circles' | 'timeofday' | 'punchcard' | 'rings' | 'cumulative' | 'climb' | 'world' | 'todweek';
export const POSTER_TYPES: { id: PosterType; name: string }[] = [
  { id: 'facets', name: 'Route facets' },
  { id: 'overlay', name: 'All routes' },
  { id: 'calendar', name: 'Calendar heatmap' },
  { id: 'ridgelines', name: 'Elevation ridgelines' },
  { id: 'season', name: 'Season overview' },
  { id: 'circles', name: 'Activity bubbles' },
  { id: 'timeofday', name: 'Time-of-day ridges' },
  { id: 'punchcard', name: 'Weekly rhythm' },
  { id: 'rings', name: 'Year rings' },
  { id: 'cumulative', name: 'Year over year' },
  { id: 'climb', name: 'Mountains climbed' },
  { id: 'world', name: 'Around the world' },
  { id: 'todweek', name: 'Time of day by weekday' },
];

export interface Theme { id: string; name: string; bg: string; fg: string; muted: string; accent: string }
export const THEMES: Theme[] = [
  { id: 'light', name: 'Light', bg: '#f7f7f4', fg: '#1d1d1f', muted: '#76767b', accent: '#0a84ff' },
  { id: 'dark', name: 'Dark', bg: '#0b0b0f', fg: '#f5f5f7', muted: '#8e8e93', accent: '#5ac8fa' },
  { id: 'ember', name: 'Ember', bg: '#160a08', fg: '#ffeadd', muted: '#a98473', accent: '#ff6a3d' },
  { id: 'aurora', name: 'Aurora', bg: '#06161b', fg: '#e4fff5', muted: '#6f9a92', accent: '#38e8a8' },
];

/** Output pixel size of the PNG; the SVG viewBox is always 1000 units wide. */
export const SIZES = [
  { id: 'a3', name: 'A3 portrait (3508 × 4961)', px: [3508, 4961] as const },
  { id: 'square', name: 'Square (3000 × 3000)', px: [3000, 3000] as const },
  { id: 'phone', name: 'Phone wallpaper (1290 × 2796)', px: [1290, 2796] as const },
];

export interface PosterOptions {
  theme: string;
  size: string;
  strip: boolean;
  units: Units;
  tz: Tz;
  /** shown as the title, e.g. "All activities" or "Ride" */
  sportLabel: string;
  facetSort: 'date' | 'distance';
  calendarMetric: 'distance' | 'time';
  ridgeSelect: 'recent' | 'longest' | 'climbiest';
  ridgeCount: number;
  /** null = latest year with data */
  seasonYear: number | null;
  circleColor: 'year' | 'sport';
  todRows: 'year' | 'month' | 'weekday';
  punchMetric: 'count' | 'distance';
  /** null = latest year with data, 'all' = every activity as one line, 'overlay' = one line per year */
  climbYear: number | 'all' | 'overlay' | null;
  /** 'all' = every year */
  worldYear: number | 'all';
  /** single year for the weekday time-of-day poster; null = latest */
  todYear: number | null;
}

export const DEFAULT_POSTER: Omit<PosterOptions, 'units' | 'tz' | 'sportLabel'> = {
  theme: 'dark', size: 'a3', strip: true, facetSort: 'date', calendarMetric: 'distance', ridgeSelect: 'recent', ridgeCount: 30, seasonYear: null,
  circleColor: 'year', todRows: 'year', punchMetric: 'count', climbYear: null, worldYear: 'all', todYear: null,
};

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const n1 = (v: number) => (Math.round(v * 10) / 10).toString();
export const int = (v: number) => Math.round(v).toLocaleString('en-US');

const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hex(a), [r2, g2, b2] = hex(b);
  const m = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${m(r1!, r2!)}${m(g1!, g2!)}${m(b1!, b2!)}`;
}

function toHsl(c: string): [number, number, number] {
  const [r, g, b] = hex(c).map((v) => v! / 255) as [number, number, number];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return [0, 0, l];
  const sat = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, sat, l];
}
function fromHsl(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
  return `#${f(0)}${f(8)}${f(4)}`;
}
/** n distinguishable colours spread around the theme accent's hue (about ±100°). */
export function palette(t: Theme, n: number): string[] {
  const [h, s, l] = toHsl(t.accent);
  return Array.from({ length: n }, (_, i) => fromHsl((h + (n === 1 ? 0 : (i / (n - 1) - 0.5) * 200) + 360) % 360, Math.max(0.55, s), Math.min(0.68, Math.max(0.5, l))));
}

/** Calendar colour ramp: empty day, then four intensities toward the accent. */
export const ramp = (t: Theme) => [mix(t.bg, t.fg, 0.08), ...[0.3, 0.5, 0.75, 1].map((x) => mix(t.bg, t.accent, x))];

export const WIDTH = 1000;
export const MARGIN = 60;

export interface Frame {
  W: number;
  H: number;
  theme: Theme;
  /** drawing area between header and footer */
  x: number; y: number; w: number; h: number;
  head: string;
  foot: string;
}

export const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Display', Inter, 'Helvetica Neue', Arial, sans-serif`;

export function rangeLabel(acts: Activity[], tz: Tz): string {
  if (!acts.length) return '';
  const ys = acts.map((a) => parts(a.startMs, tz).y);
  const a = Math.min(...ys), b = Math.max(...ys);
  return a === b ? String(a) : `${a} – ${b}`;
}

export function makeFrame(acts: Activity[], o: PosterOptions, kicker: string, subtitle: string, strip: boolean): Frame {
  const size = SIZES.find((s) => s.id === o.size) ?? SIZES[0]!;
  const theme = THEMES.find((t) => t.id === o.theme) ?? THEMES[1]!;
  const W = WIDTH, H = Math.round((WIDTH * size.px[1]) / size.px[0]);
  const head =
    `<text x="${MARGIN}" y="${MARGIN + 14}" font-size="15" letter-spacing="4" fill="${theme.accent}" font-weight="600">${esc(kicker.toUpperCase())}</text>` +
    `<text x="${MARGIN}" y="${MARGIN + 72}" font-size="50" font-weight="700" letter-spacing="-1" fill="${theme.fg}">${esc(o.sportLabel)}</text>` +
    `<text x="${MARGIN}" y="${MARGIN + 106}" font-size="20" fill="${theme.muted}">${esc(subtitle)}</text>`;
  let foot = '';
  let bottom = H - MARGIN;
  if (strip) {
    const s = summarize(acts);
    const top = H - MARGIN - 96;
    bottom = top - 24;
    const items: [string, string][] = [
      [int(s.count), 'activities'],
      [`${int(distance(s.distanceM, o.units))} ${distanceUnit(o.units)}`, 'distance'],
      [`${int(s.movingS / 3600)} h`, 'moving time'],
      [`${int(elevation(s.elevGainM, o.units))} ${elevationUnit(o.units)}`, 'climbing'],
    ];
    const cw = (W - 2 * MARGIN) / items.length;
    foot = `<line x1="${MARGIN}" x2="${W - MARGIN}" y1="${top}" y2="${top}" stroke="${theme.muted}" stroke-opacity="0.4" stroke-width="1.5"/>` +
      items.map(([v, l], i) =>
        `<text x="${MARGIN + i * cw}" y="${top + 52}" font-size="34" font-weight="700" fill="${theme.fg}">${esc(v)}</text>` +
        `<text x="${MARGIN + i * cw}" y="${top + 80}" font-size="14" letter-spacing="2" fill="${theme.muted}">${l.toUpperCase()}</text>`).join('');
  }
  const y = MARGIN + 140;
  return { W, H, theme, x: MARGIN, y, w: W - 2 * MARGIN, h: bottom - y, head, foot };
}

export function wrapSvg(f: Frame, o: PosterOptions, body: string, defs = ''): { svg: string; width: number; height: number } {
  const size = SIZES.find((s) => s.id === o.size) ?? SIZES[0]!;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.px[0]}" height="${size.px[1]}" viewBox="0 0 ${f.W} ${f.H}" font-family="${FONT}">` +
    (defs ? `<defs>${defs}</defs>` : '') +
    `<rect width="${f.W}" height="${f.H}" fill="${f.theme.bg}"/>${f.head}${body}${f.foot}</svg>`;
  return { svg, width: size.px[0], height: size.px[1] };
}

export const emptyMessage = (f: Frame, msg: string) =>
  `<text x="${f.x + f.w / 2}" y="${f.y + f.h / 2}" text-anchor="middle" font-size="22" fill="${f.theme.muted}">${esc(msg)}</text>`;
