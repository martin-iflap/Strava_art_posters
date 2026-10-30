import { fmt, plural } from './format';
import { h } from './dom';
import { attribution, routeMap, type TileSource } from './map';
import type { Activity, Tz, Units } from './types';
import { clockLabel, parts, ymd } from './util/time';
import { distance, distanceUnit, elevation, elevationUnit, formatDuration, formatHours } from './util/units';

export interface ListContext {
  units: Units;
  tz: Tz;
  tiles: TileSource | null;
  open(id: string): void;
  close(): void;
}

/** Cards are added in pages, so a year with hundreds of activities stays quick (and polite to tile servers). */
const PAGE = 12;

/**
 * A closable panel listing a group of activities as cards (mini map, name, date, numbers), in the same
 * layout as the repeated-route cards. Selecting a card opens the activity.
 */
export function activityPanel(id: string, title: string, acts: Activity[], c: ListContext): HTMLElement {
  const u = c.units;
  const total = acts.reduce((t, a) => ({ d: t.d + a.distanceM, s: t.s + a.movingS, e: t.e + a.elevGainM }), { d: 0, s: 0, e: 0 });
  const summary = acts.length
    ? `${plural(acts.length, 'activity', 'activities')} · ${fmt(distance(total.d, u))} ${distanceUnit(u)} · ${formatHours(total.s)} · ${fmt(elevation(total.e, u), 0)} ${elevationUnit(u)}`
    : 'No activities here for the current filters.';
  const grid = h('div', { class: 'loops act-list' });
  const more = h('button', { class: 'more', onclick: () => { addPage(); more.focus(); } });
  let shown = 0;
  const addPage = () => {
    for (const a of acts.slice(shown, shown + PAGE)) grid.append(card(a, c));
    shown = Math.min(acts.length, shown + PAGE);
    more.textContent = `Show ${Math.min(PAGE, acts.length - shown)} more (${acts.length - shown} left)`;
    more.hidden = shown >= acts.length;
  };
  addPage();
  return h('section', { class: 'drill', id, 'aria-label': `Activities: ${title}` },
    h('div', { class: 'drill-head' },
      h('div', {}, h('h3', {}, title), h('p', { class: 'small', role: 'status' }, summary)),
      h('button', { class: 'drill-close', 'aria-label': `Close the list: ${title}`, onclick: c.close }, 'Close')),
    grid, more,
    c.tiles && acts.some((a) => a.route) ? attribution(c.tiles) : null);
}

function card(a: Activity, c: ListContext): HTMLElement {
  const u = c.units;
  const map = a.route
    ? routeMap(a.route, { tiles: c.tiles, size: 192, label: '' })
    : h('div', { class: 'map no-gps', 'aria-hidden': 'true' }, h('span', {}, 'No GPS'));
  map.querySelector('svg')?.setAttribute('aria-hidden', 'true');
  const rows: [string, string][] = [['Date', ymd(parts(a.startMs, c.tz))], ['Start', clockLabel(a.startMs, c.tz)]];
  if (a.distanceM > 0) rows.push(['Distance', `${fmt(distance(a.distanceM, u))} ${distanceUnit(u)}`]);
  rows.push(['Time', formatDuration(a.movingS)]);
  if (a.elevGainM > 0) rows.push(['Climb', `${fmt(elevation(a.elevGainM, u), 0)} ${elevationUnit(u)}`]);
  // The name is the card's button; CSS stretches its click area over the whole card.
  return h('div', { class: 'loop act-card' }, map,
    h('div', { class: 'act-text' },
      h('button', { class: 'link stretch act-name', onclick: () => c.open(a.id) }, a.name), h('span', { class: 'act-sport' }, a.sport),
      h('dl', {}, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))));
}
