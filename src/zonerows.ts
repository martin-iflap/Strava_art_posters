import { fmt } from './format';
import { h } from './dom';
import type { Zone } from './stats/zones';
import { formatHours } from './util/units';

export const ZONE_COLORS = ['#8e8e93', '#30b0c7', '#34c759', '#ff9f0a', '#ff453a', '#bf5af2', '#ff2d55'];

/** "12 h 05 m", "36 m", "45 s": one style for every zone row. */
const short = (s: number) => (s >= 3600 ? formatHours(s) : s >= 60 ? `${Math.round(s / 60)} m` : `${Math.round(s)} s`);

/** One row per zone: name, range, a bar as long as its share, time and percentage (as Strava and TrainingPeaks show it). */
export function zoneRows(zones: Zone[], seconds: number[], unit: string): HTMLElement {
  const total = seconds.reduce((a, b) => a + b, 0) || 1;
  const max = Math.max(...seconds) || 1;
  const grid = h('div', { class: 'zone-rows' });
  zones.forEach((z, i) => {
    const bar = h('div', { class: 'zr-bar' });
    bar.style.width = `${(seconds[i]! / max) * 100}%`;
    bar.style.background = ZONE_COLORS[i % ZONE_COLORS.length]!;
    grid.append(h('div', { class: 'zr-row' },
      h('span', { class: 'zr-name' }, z.name),
      h('span', { class: 'zr-range' }, `${z.lower}${z.upper === null ? '+' : '–' + (z.upper - 1)} ${unit}`),
      h('span', { class: 'zr-track', 'aria-hidden': 'true' }, bar),
      h('span', { class: 'zr-time' }, short(seconds[i]!)),
      h('span', { class: 'zr-pct' }, `${fmt((seconds[i]! / total) * 100, 0)} %`)));
  });
  return grid;
}
