import './style.css';
import { append, download, h, table, type Row } from './dom';
import { activityPanel } from './activitylist';
import { TILE_SOURCES, attribution, defaultTileSource, referrerAvailable, routeMap, tileSource } from './map';
import { activityView } from './detail';
import { ZONE_COLORS, zoneRows } from './zonerows';
import { barChart, xyChart, type Bar, type XYSeries } from './charts';
import { activityLoad, bestEffortsBySport, bestPowerCurve, distanceName, durationName, estimateFtp, formLabel, lthrOf, rampRate, trainingLoad, type Thresholds } from './stats/training';
import { CURVE_DURATIONS } from './parse/track';
import { dash, fmt, opt, plural } from './format';
import { fromDrop, fromFileList } from './input';
import { activitiesCsv, exportFilename, periodCsv, sportCsv, statsJson, zonesCsv, type ExportOptions } from './export';
import type { RawInput } from './parse/archive';
import { clusterRoutes, type RouteCluster } from './stats/routes';
import { byPeriod, byWeekday, bySport, filterSport, records, sportsOf, summarize, type Summary } from './stats/summary';
import { selectActivities, type Selection } from './stats/select';
import { findRegions, regionFilter, type Region, type RegionChoice } from './stats/regions';
import { activityZones, hrZones, observedMaxHr, powerZones, zoneTotals, zonesBy, type HrZoneConfig, type Zone, type ZoneRow } from './stats/zones';
import type { Activity, ImportResult, Tz, Units } from './types';
import { distance, distanceUnit, elevation, elevationUnit, formatDuration, formatHours, speed, speedUnit } from './util/units';
import { dayNumber, fromDayNumber, isoWeekKey, parts, ymd } from './util/time';
import { DEFAULT_POSTER, POSTER_TYPES, SIZES, THEMES, renderPoster, type PosterOptions, type PosterType } from './posters';
import { IMAGE_KINDS, svgToImage, type ImageKind } from './posters/raster';
import { EXAMPLE_POSTERS } from './examples';
import { strToU8, zipSync } from 'fflate';
import type { WorkerIn, WorkerOut } from './worker';

interface State {
  result: ImportResult | null;
  sport: string;
  units: Units;
  tz: Tz;
  hr: HrZoneConfig | null;
  ftp: number | null;
  showAll: boolean;
  view: 'stats' | 'posters' | 'activity';
  activityId: string | null;
  query: string;
  sortKey: 'date' | 'distance' | 'time' | 'elevation' | 'speed';
  theme: 'auto' | 'light' | 'dark';
  sheet: boolean;
  /** year shown in the month tables; null = latest year with data */
  monthYear: number | 'all' | null;
  /** the stats row (or repeated route) whose activities are listed below its table; null = none */
  pick: { table: string; key: string; title: string; sel: Selection } | null;
  /** map background tile source id; null = off (no requests leave the browser). On by default (OpenStreetMap). */
  mapTiles: string | null;
  /** what the volume charts measure */
  volMetric: 'distance' | 'time' | 'elevation';
  /** days shown in the fitness chart */
  loadRange: '90' | '365' | 'all';
}

const state: State = { result: null, sport: 'all', units: 'metric', tz: 'local', hr: null, ftp: null, showAll: false, view: 'stats', activityId: null, query: '', sortKey: 'date', theme: 'auto', sheet: false, monthYear: null, pick: null, mapTiles: defaultTileSource().id, volMetric: 'distance', loadRange: '365' };
let animate = true;
const poster = { type: 'facets' as PosterType, ...DEFAULT_POSTER };
const app = document.getElementById('app')!;

/** Scrollable tables must be keyboard-focusable and named: label each with the heading above it. */
function labelScrollables(root: HTMLElement): void {
  let heading = 'Table';
  root.querySelectorAll('h2, h3, summary, .card').forEach((el) => {
    if (/^(H2|H3|SUMMARY)$/.test(el.tagName)) heading = el.textContent?.trim() || heading;
    else if (el.querySelector('table')) {
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'region');
      el.setAttribute('aria-label', `${heading} table`);
    }
  });
}

// ---------- theme ----------

function applyTheme(): void {
  if (state.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
}
try {
  const saved = localStorage.getItem('ride-atlas-theme');
  if (saved === 'light' || saved === 'dark') state.theme = saved;
} catch { /* storage unavailable: stay on auto */ }
applyTheme();
// The map background choice is remembered, including "off". A saved source that cannot work here
// (OpenStreetMap on a page opened from a file) falls back to the default.
try {
  const m = localStorage.getItem('ride-atlas-map');
  if (m === 'off') state.mapTiles = null;
  else if (tileSource(m) && (referrerAvailable() || !tileSource(m)!.needsReferrer)) state.mapTiles = m;
} catch { /* storage unavailable: keep the default */ }
const setMapTiles = (id: string | null) => {
  state.mapTiles = tileSource(id) ? id : null;
  try { localStorage.setItem('ride-atlas-map', state.mapTiles ?? 'off'); } catch { /* ignore */ }
};

function themeToggle(): HTMLElement {
  const btn = (t: State['theme'], label: string) =>
    h('button', { 'aria-pressed': String(state.theme === t), onclick: () => {
      state.theme = t;
      try { if (t === 'auto') localStorage.removeItem('ride-atlas-theme'); else localStorage.setItem('ride-atlas-theme', t); } catch { /* ignore */ }
      applyTheme();
      document.querySelectorAll('.theme-toggle').forEach((el) => el.replaceWith(themeToggle()));
    } }, label);
  return h('div', { class: 'seg theme-toggle', role: 'group', 'aria-label': 'Appearance' }, btn('auto', 'Auto'), btn('light', 'Light'), btn('dark', 'Dark'));
}

// ---------- import ----------

let worker: Worker | null = null;

function startImport(msg: WorkerIn): void {
  worker?.terminate();
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  renderImporting('Starting…', 0, 1);
  worker.onmessage = (e: MessageEvent<WorkerOut>) => {
    const m = e.data;
    if (m.type === 'progress') renderImporting(m.phase, m.done, m.total);
    else if (m.type === 'result') {
      worker?.terminate();
      worker = null;
      state.result = m.result;
      state.sport = 'all';
      state.hr = null;
      state.monthYear = null;
      state.pick = null;
      state.showAll = false;
      state.view = 'stats';
      history.replaceState({ view: 'stats' } satisfies NavEntry, '', location.pathname + location.search);
      animate = true;
      render();
    } else {
      worker?.terminate();
      worker = null;
      renderImport(m.message);
    }
  };
  worker.onerror = (e) => renderImport(`Import failed: ${e.message}`);
  worker.postMessage(msg);
}

const importFiles = (inputs: RawInput[]) => {
  if (!inputs.length) return renderImport('No files were selected.');
  startImport({ type: 'import', inputs });
};

function hero(...children: (Node | null)[]): HTMLElement {
  return h('main', { id: 'main', class: 'hero' },
    h('div', { class: 'hero-top' },
      h('div', { class: 'brand' }, h('h1', {}, 'Ride Atlas'), h('p', {}, 'Your Strava export turned into stats and printable posters, privately in this browser tab.')),
      themeToggle()),
    ...children);
}

function renderImporting(phase: string, done: number, total: number): void {
  app.replaceChildren(hero(
    h('div', { class: 'drop', role: 'status', 'aria-live': 'polite' },
      h('h2', {}, 'Reading your export…'),
      h('p', {}, phase),
      h('progress', { max: total, value: done, 'aria-label': 'Import progress' }),
      h('div', { class: 'row' }, h('button', { id: 'cancel-import', onclick: () => { worker?.terminate(); worker = null; renderImport(); } }, 'Cancel')))));
}

function renderImport(error?: string): void {
  const zipInput = h('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Choose ZIP or files', accept: '.zip,.csv,.gpx,.tcx,.fit,.gz', onchange: () => importFiles(fromFileList(zipInput.files ?? [])) });
  const dirInput = h('input', { type: 'file', hidden: true, webkitdirectory: true, 'aria-label': 'Choose folder', onchange: () => importFiles(fromFileList(dirInput.files ?? [])) });
  const drop = h('section', { class: 'drop', 'aria-labelledby': 'drop-title' },
    h('h2', { id: 'drop-title' }, 'Drop your Strava export here'),
    h('p', {}, 'The ZIP file, the extracted folder, or loose files. Everything is processed in your browser; nothing is uploaded.'),
    error ? h('p', { class: 'warn', role: 'alert' }, error) : null,
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => zipInput.click() }, 'Choose ZIP or files'),
      h('button', { onclick: () => dirInput.click() }, 'Choose folder'),
      h('button', { id: 'demo', onclick: () => startImport({ type: 'demo' }) }, 'Try with demo data')),
    zipInput, dirInput);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer) importFiles(await fromDrop(e.dataTransfer));
  });
  const feature = (title: string, text: string) => h('li', {}, h('b', {}, title), h('span', {}, text));
  app.replaceChildren(hero(
    drop,
    h('h2', {}, 'What you get'),
    h('ul', { class: 'features' },
      feature(`${POSTER_TYPES.length} printable posters`, 'Every route you rode, the metres you climbed, your years as rings, how far around the world you went. Download them as PNG or JPEG (A3 print size) or SVG.'),
      feature('Your stats, all of them', 'Totals by year, month, weekday and sport, records and streaks, time in heart-rate and power zones, and your most repeated routes.'),
      feature('Every activity in detail', 'Map, elevation, speed, heart rate and power charts with a shared hover readout, and splits per kilometre.')),
    h('div', { class: 'examples', 'aria-label': 'Example posters made from the demo data' },
      ...EXAMPLE_POSTERS.map((ex) => h('figure', {},
        h('img', { class: 'poster', src: `examples/${ex.type}.svg`, alt: `Example: ${POSTER_TYPES.find((t) => t.id === ex.type)!.name} poster`, loading: 'lazy', width: 3508, height: 4961 }),
        h('figcaption', {}, ex.caption)))),
    h('h2', {}, 'How it works'),
    h('ol', { class: 'steps' },
      h('li', {}, 'You give it your Strava export (or GPX, TCX and FIT files from any app or device).'),
      h('li', {}, 'Your browser reads the files in a background worker in this tab. There is no server to upload to, no account, no cookies and no tracking.'),
      h('li', {}, 'Stats and posters are worked out on your device. Closing or reloading the tab forgets your activities.')),
    h('h2', { id: 'privacy' }, 'Privacy and safety'),
    h('ul', { class: 'safety' },
      feature('What is read', 'Only activities.csv and the GPX, TCX and FIT activity files. The rest of a Strava export (photos, messages, profile, contacts) is skipped by name and never opened: from a ZIP, only the activity files are read, so a large export with photos loads quickly.'),
      feature('What is kept', 'Nothing from your files. Only two settings are remembered in this browser: light or dark theme, and the map background.'),
      feature('What goes over the network', 'Only map pictures for the activity maps, from OpenStreetMap or OpenTopoMap. Like any web map, that server sees your IP address and which map squares you look at, so roughly where the activity you opened was. Your files and stats are never sent. Set Map background to Off in the filters and the app makes no requests at all; the page’s security policy blocks every other connection.'),
      feature('Before you share a poster', 'Route posters leave out the first and last 200 m of every route by default, so your front door is not on them (adjustable with “Hide route ends”). A poster of many routes can still show your part of town. Other posters show no places.'),
      feature('Files from anyone else', 'Files are treated as data only: nothing in them is ever run, names are shown as plain text, and a file that would unpack to more than 256 MB is refused.')),
    h('h2', {}, 'How to get your Strava export'),
    h('ol', { class: 'steps' },
      h('li', {}, 'On strava.com open Settings → My Account → “Download or Delete Your Account” → “Get Started”.'),
      h('li', {}, 'Choose “Request Your Archive”. Strava emails you a download link (this can take a while).'),
      h('li', {}, 'Download the ZIP and drop it here. You do not need to unpack it.')),
    h('p', {}, 'Not sure yet? Try the demo data: one made-up rider, several years of invented rides, runs and walks.'),
    h('aside', { class: 'card sibling' }, h('b', {}, 'Forgot to record a ride?'), ' ', gpxToFitLink('Make a realistic activity file for it with GPX to FIT'), ', a sister app that also runs in your browser.'),
    h('p', { class: 'muted small' }, 'Ride Atlas is an independent project and is not affiliated with Strava.')));
}

/** Link to the owner's sister app (generates realistic activity files for rides that were not recorded). */
const gpxToFitLink = (text: string) => h('a', { href: 'https://gpx-to-fit.pages.dev', target: '_blank', rel: 'noopener noreferrer' }, text);

// ---------- formatting ----------

const dist = (m: number) => fmt(distance(m, state.units));
const elev = (m: number) => fmt(elevation(m, state.units), 0);
const dateOf = (ms: number) => ymd(parts(ms, state.tz));

/** A labelled select. `on` updates the state, then `after` runs (by default the page is re-rendered). */
function selectControl<T extends string>(label: string, value: T, options: [T, string][], on: (v: T) => void, o: { ariaLabel?: string; after?: (el: HTMLElement) => void } = {}): HTMLElement {
  return h('label', {}, label,
    h('select', { 'aria-label': o.ariaLabel, onchange: (e) => { const el = e.target as HTMLSelectElement; on(el.value as T); (o.after ?? render)(el); } },
      ...options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))));
}

// ---------- results ----------

function currentHrZones(all: Activity[]): Zone[] | null {
  if (!state.hr) {
    const m = observedMaxHr(all);
    if (m === null) return null;
    state.hr = { mode: 'maxHr', value: m };
  }
  return hrZones(state.hr);
}

/** Identify the focused control so it can be re-focused after the DOM is rebuilt (keyboard users keep their place). */
function focusKey(): { idx: number; tag: string; label: string; key: string | null } | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || !app.contains(el) || !/^(SELECT|INPUT|BUTTON|A)$/.test(el.tagName)) return null;
  const all = Array.from(app.querySelectorAll('select, input, button, a'));
  return { idx: all.indexOf(el), tag: el.tagName, label: controlLabel(el), key: el.dataset.key ?? null };
}
function controlLabel(el: Element): string {
  return el.getAttribute('aria-label') || el.closest('label')?.childNodes[0]?.textContent || (el.tagName === 'SELECT' ? '' : el.textContent?.slice(0, 40)) || '';
}
/** Focus a control by its data-key (table rows, repeated routes). */
const focusByKey = (key: string) => app.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
function render(): void {
  const key = focusKey();
  renderNow();
  if (key?.key) focusByKey(key.key);
  else if (key) {
    const el = Array.from(app.querySelectorAll('select, input, button, a'))[key.idx] as HTMLElement | undefined;
    if (el && el.tagName === key.tag && controlLabel(el) === key.label) el.focus({ preventScroll: true });
  }
}

function renderNow(): void {
  if (!state.result) return renderImport();
  const { result } = state;
  const all = result.activities;
  const acts = filterSport(all, state.sport);
  const hz = currentHrZones(all);
  const pz = state.ftp ? powerZones(state.ftp) : null;


  const navBtn = (v: 'stats' | 'posters', label: string, badge?: string) => h('button', { 'aria-current': (state.view === v || (v === 'stats' && state.view === 'activity')) ? 'page' : undefined, onclick: () => setView(v) }, label, badge ? h('span', { class: 'badge', 'aria-label': `${badge} posters` }, badge) : null);
  const sections: [string, string][] = [['overview', 'Overview'], ['training', 'Training load'], ['curve', 'Power and best efforts'], ['records', 'Records'], ['periods', 'Years and months'], ['zones', 'Time in zones'], ['loops', 'Routes'], ['activities', 'Activities'], ['export', 'Export'], ['issues', 'Import report']];
  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Sidebar' },
    h('div', { class: 'brand' }, h('h1', {}, 'Ride Atlas'), h('p', {}, 'Private, in your browser')),
    h('nav', { class: 'nav', 'aria-label': 'Views' }, navBtn('stats', 'Stats'), navBtn('posters', 'Posters', String(POSTER_TYPES.length)),
      ...(state.view === 'stats' && all.length ? sections.map(([id, t]) => h('a', { href: `#${id}` }, t)) : [])),
    h('div', { class: 'filters', role: 'group', 'aria-label': 'Filters', id: 'filters' },
      selectControl('Sport', state.sport, [['all', `All sports (${all.length})`], ...sportsOf(all).map((s): [string, string] => [s, `${s} (${all.filter((a) => a.sport === s).length})`])], (v) => (state.sport = v)),
      selectControl('Units', state.units, [['metric', 'km / m'], ['imperial', 'mi / ft']], (v) => (state.units = v)),
      selectControl('Time zone', state.tz, [['local', 'Local'], ['UTC', 'UTC']], (v) => (state.tz = v)),
      selectControl('Map background', state.mapTiles ?? 'off', [...TILE_SOURCES.filter((t) => referrerAvailable() || !t.needsReferrer).map((t): [string, string] => [t.id, t.name]), ['off', 'Off (fully offline)']], (v) => setMapTiles(v === 'off' ? null : v)),
      h('p', { class: 'hint' }, state.mapTiles ? 'Map images come from OpenStreetMap volunteers’ servers, which see the map areas you view. Your files stay here.' : 'No map images are loaded: nothing leaves this browser.'),
      h('button', { class: 'sheet-close', onclick: () => { state.sheet = false; render(); } }, 'Done')),
    h('div', { class: 'side-foot' }, themeToggle(),
      h('p', { class: 'sibling small' }, 'Forgot to record one? ', gpxToFitLink('GPX to FIT'), ' makes a realistic file.'),
      h('button', { class: 'load', onclick: () => { state.result = null; state.sheet = false; renderImport(); } }, 'Load another export')));

  const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Main tabs' },
    h('button', { 'aria-current': state.view !== 'posters' ? 'page' : undefined, onclick: () => setView('stats') }, 'Stats'),
    h('button', { 'aria-current': state.view === 'posters' ? 'page' : undefined, onclick: () => setView('posters') }, 'Posters'),
    h('button', { 'aria-expanded': String(state.sheet), 'aria-controls': 'filters', onclick: () => { state.sheet = !state.sheet; render(); } }, 'Filters'),
    h('button', { onclick: () => { state.result = null; state.sheet = false; renderImport(); } }, 'New'));

  const main = h('main', { id: 'main', class: animate ? 'content enter' : 'content', tabindex: -1 });
  animate = false;
  const mount = () => {
    labelScrollables(main);
    app.replaceChildren(
      h('a', { class: 'skip', href: '#main' }, 'Skip to content'),
      h('div', { class: state.sheet ? 'layout sheet-open' : 'layout' }, sidebar, main),
      tabbar);
  };

  if (!all.length) {
    main.append(h('div', { class: 'card empty' }, h('h2', {}, 'No activities found'),
      h('p', { class: 'warn', role: 'alert' }, 'Nothing could be read from these files. Make sure you picked the whole Strava export (the ZIP, or the folder containing activities.csv).')), issuesSection(result));
    mount();
    return;
  }

  if (state.view === 'activity') {
    const a = all.find((x) => x.id === state.activityId);
    if (a) {
      main.append(activityView(a, {
        units: state.units, tz: state.tz, hz, pz, all, thresholds: thresholds(),
        list: [...(acts.some((x) => x.id === a.id) ? acts : all)].sort((x, y) => y.startMs - x.startMs),
        open: openActivity, back: closeActivity, clusters: (sport) => clustersFor(all, sport),
        tiles: tileSource(state.mapTiles), setTiles: (id) => { setMapTiles(id); render(); },
      }));
      mount();
      return;
    }
    state.view = 'stats';
  }

  if (state.view === 'posters') {
    main.append(posterSection(acts));
    mount();
    return;
  }

  if (acts.length) main.append(posterPromo(acts, () => setView('posters')));
  main.append(h('h2', { id: 'overview' }, 'Overview'));
  if (!acts.length) {
    main.append(h('div', { class: 'card empty' }, h('h2', {}, 'Nothing here'), h('p', {}, 'There are no activities for this sport. Pick another sport in the filters.')));
  } else {
    const s = summarize(acts);
    main.append(statGrid(s, acts));
    main.append(progressSection(acts));
    main.append(trainingSection(all, acts));
    main.append(curveSection(acts));
    main.append(recordsSection(acts));
    const add = (...els: (Node | null)[]) => append(main, els);
    if (state.sport === 'all') {
      add(h('h2', {}, 'By sport'), h('div', { class: 'card' }, summaryTable('Sport', 'sport', bySport(all).map((x) => ({ label: x.sport, s: x.summary, key: x.sport, sel: { kind: 'sport', value: x.sport } })))), drill('sport', all));
    }
    const yearRows = byPeriod(acts, 'year', state.tz);
    add(h('h2', { id: 'periods' }, 'By year'), h('div', { class: 'card' }, summaryTable('Year', 'year', yearRows.map((r) => ({ label: r.key, s: r.summary, key: r.key, sel: { kind: 'year', value: r.key } })))), drill('year', acts));
    const months = monthRows(byPeriod(acts, 'month', state.tz), acts);
    add(h('div', { class: 'h2row' }, h('h2', {}, 'By month'), yearTabs(acts, 'Year shown in the month table')),
      monthBars(acts, months), h('div', { class: state.monthYear === 'all' ? 'card scroll' : 'card' }, summaryTable('Month', 'month', months.map((r) => ({ label: r.label, s: r.summary, key: r.key, sel: { kind: 'month', value: r.key }, title: monthTitle(r.key) })))), drill('month', acts));
    add(h('h2', {}, 'By weekday'), h('div', { class: 'card' }, summaryTable('Weekday', 'weekday', byWeekday(acts, state.tz).map((r) => ({ label: r.label, s: r.summary, key: String(r.weekday), sel: { kind: 'weekday', value: String(r.weekday) }, title: `Every ${WEEKDAY_NAMES[r.weekday]}` })))), drill('weekday', acts));
    add(h('details', { open: state.pick?.table === 'week' }, h('summary', {}, 'By ISO week'),
      h('div', { class: 'card scroll' }, summaryTable('Week', 'week', byPeriod(acts, 'week', state.tz).map((r): SummaryRow => ({ label: `${r.key} (${r.start})`, s: r.summary, key: r.key, sel: { kind: 'week', value: r.key }, title: `Week ${r.key}, from ${r.start}` })).reverse())), drill('week', acts)));
    main.append(zonesSection(all, acts, hz, pz));
    main.append(loopsSection());
    main.append(activitiesSection(acts, hz));
    main.append(exportSection(acts, hz, pz));
  }
  main.append(issuesSection(result));
  mount();
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The year the month tables show: the chosen one if it has data, else the latest. */
function monthYear(acts: Activity[]): number | 'all' {
  const years = yearsOf(acts);
  return state.monthYear === 'all' ? 'all' : state.monthYear !== null && years.includes(state.monthYear) ? state.monthYear : years[0] ?? 'all';
}

/** Month rows (keys "YYYY-MM") for the selected year, Jan to Dec; or every month, newest first. */
function monthRows<T extends { key: string }>(rows: T[], acts: Activity[]): (T & { label: string })[] {
  const y = monthYear(acts);
  if (y === 'all') return rows.map((r) => ({ ...r, label: r.key })).reverse();
  return rows.filter((r) => r.key.startsWith(`${y}-`)).map((r) => ({ ...r, label: MONTH_NAMES[Number(r.key.slice(5)) - 1]! }));
}

/** Segmented year picker for the month tables (shared by all of them). */
function yearTabs(acts: Activity[], label: string): HTMLElement {
  const cur = monthYear(acts);
  const btn = (v: number | 'all', text: string) => h('button', { 'aria-pressed': String(cur === v), onclick: () => { state.monthYear = v; render(); } }, text);
  return h('div', { class: 'seg years', role: 'group', 'aria-label': label }, ...[...yearsOf(acts)].reverse().map((y) => btn(y, String(y))), btn('all', 'All'));
}

function statGrid(s: Summary, acts: Activity[]): HTMLElement {
  const u = state.units;
  const first = Math.min(...acts.map((a) => a.startMs));
  const last = Math.max(...acts.map((a) => a.startMs));
  const stat = (v: string, l: string) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l));
  return h('div', { class: 'grid' },
    stat(String(s.count), `activities (${dateOf(first)} → ${dateOf(last)})`),
    stat(`${dist(s.distanceM)} ${distanceUnit(u)}`, 'distance'),
    stat(formatHours(s.movingS), 'moving time'),
    stat(`${elev(s.elevGainM)} ${elevationUnit(u)}`, 'elevation gain'),
    stat(`${dist(s.avgDistanceM)} ${distanceUnit(u)}`, 'average distance'),
    stat(`${dist(s.medianDistanceM)} ${distanceUnit(u)}`, 'median distance'),
    stat(`${fmt(speed(s.avgSpeedMps, u))} ${speedUnit(u)}`, 'average speed'),
    stat(s.avgHr === null ? dash : `${fmt(s.avgHr, 0)} bpm`, 'average heart rate'),
    stat(s.avgPower === null ? dash : `${fmt(s.avgPower, 0)} W`, 'average power'));
}

function recordsSection(acts: Activity[]): HTMLElement {
  const r = records(acts, state.tz);
  const u = state.units;
  const link = (a: Activity | null): Node | string => (a ? h('span', {}, h('button', { class: 'link', onclick: () => openActivity(a.id) }, a.name), ` (${dateOf(a.startMs)})`) : dash);
  const acts1 = (n: number) => plural(n, 'activity', 'activities');
  // Records of one activity link to it; the others list their activities below the table.
  const rows: (Row | (string | Node)[])[] = [
    ['Longest activity', r.longest ? `${dist(r.longest.distanceM)} ${distanceUnit(u)}` : dash, link(r.longest)],
    ['Biggest climb', r.biggestClimb ? `${elev(r.biggestClimb.elevGainM)} ${elevationUnit(u)}` : dash, link(r.biggestClimb)],
    ['Longest duration', r.longestDuration ? formatDuration(r.longestDuration.movingS) : dash, link(r.longestDuration)],
    ['Fastest average speed (≥ 5 km, ≥ 10 min)', r.fastest ? `${fmt(speed(r.fastest.distanceM / r.fastest.movingS, u))} ${speedUnit(u)}` : dash, link(r.fastest)],
    r.mostActiveDay
      ? pickRow('records', 'day', `Most active day: ${r.mostActiveDay.date}`, { kind: 'day', value: r.mostActiveDay.date }, ['Most active day', `${dist(r.mostActiveDay.distanceM)} ${distanceUnit(u)}`, `${r.mostActiveDay.date} (${acts1(r.mostActiveDay.count)})`])
      : ['Most active day', dash, ''],
    r.mostActiveMonth
      ? pickRow('records', 'month', `Most active month: ${monthTitle(r.mostActiveMonth.key)}`, { kind: 'month', value: r.mostActiveMonth.key }, ['Most active month', `${dist(r.mostActiveMonth.distanceM)} ${distanceUnit(u)}`, `${r.mostActiveMonth.key} (${acts1(r.mostActiveMonth.count)})`])
      : ['Most active month', dash, ''],
    r.longestStreak
      ? pickRow('records', 'streak', `Longest streak: ${r.longestStreak.start} → ${r.longestStreak.end}`, { kind: 'range', value: `${r.longestStreak.start}/${r.longestStreak.end}` }, ['Longest streak', plural(r.longestStreak.days, 'day'), `${r.longestStreak.start} → ${r.longestStreak.end}`])
      : ['Longest streak', dash, ''],
    r.currentStreak
      ? pickRow('records', 'current', `Current streak: ${r.currentStreak.start} → ${r.currentStreak.end}`, { kind: 'range', value: `${r.currentStreak.start}/${r.currentStreak.end}` }, ['Current streak (as of last activity)', plural(r.currentStreak.days, 'day'), `ending ${r.currentStreak.end}`])
      : ['Current streak (as of last activity)', dash, ''],
  ];
  return h('div', {}, h('h2', { id: 'records' }, 'Records'),
    h('div', { class: 'card' }, table(['Record', 'Value', 'Details'], rows, { numCols: [1], id: 'records', selected: selectedIn('records') })),
    drill('records', acts));
}

interface SummaryRow { label: string; s: Summary; key: string; sel: Selection; title?: string }
function summaryTable(label: string, id: string, rows: SummaryRow[]): HTMLElement {
  const u = state.units;
  const maxD = Math.max(1, ...rows.map((r) => r.s.distanceM));
  const bar = (v: string, frac: number) => { const el = h('span', { class: 'databar' }, v); el.style.setProperty('--w', `${Math.round(frac * 100)}%`); return el; };
  return table(
    [label, 'Activities', `Distance (${distanceUnit(u)})`, 'Moving time', `Elevation (${elevationUnit(u)})`, `Avg dist (${distanceUnit(u)})`, `Median (${distanceUnit(u)})`, `Avg speed (${speedUnit(u)})`, 'Avg HR', 'Avg W'],
    rows.map(({ label: k, s, key, sel, title }) => {
      const cells = [k, s.count, bar(dist(s.distanceM), s.distanceM / maxD), formatHours(s.movingS), elev(s.elevGainM), dist(s.avgDistanceM), dist(s.medianDistanceM), fmt(speed(s.avgSpeedMps, u)), opt(s.avgHr), opt(s.avgPower)];
      return s.count ? pickRow(id, key, title ?? k, sel, cells) : cells; // empty periods have nothing to list
    }),
    { id, selected: selectedIn(id) },
  );
}

// ---------- drill-downs: a row's activities below its table ----------

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const monthTitle = (key: string) => `${MONTH_FULL[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;
const selectedIn = (table: string) => (state.pick?.table === table ? state.pick.key : null);

/** A table row that lists its activities (in a panel below the table) when clicked; clicking again closes it. */
function pickRow(table: string, key: string, title: string, sel: Selection, cells: Row['cells']): Row {
  const on = state.pick?.table === table && state.pick.key === key;
  return { cells, key, expanded: on, onClick: () => { state.pick = on ? null : { table, key, title, sel }; render(); } };
}

/** The open panel for this table, if any. `acts` is the set its rows were counted from. */
function drill(table: string, acts: Activity[]): HTMLElement | null {
  const p = state.pick;
  if (!p || p.table !== table) return null;
  return activityPanel(`list-${table}`, p.title, selectActivities(acts, p.sel, state.tz), {
    units: state.units, tz: state.tz, tiles: tileSource(state.mapTiles), open: openActivity,
    close: () => { state.pick = null; render(); focusByKey(`${p.table}:${p.key}`); },
  });
}

// ---------- volume charts ----------

const MONTH_START_DOY = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const VOL: Record<State['volMetric'], { name: string; of: (s: Summary) => number; fmt: (v: number) => string; unit: () => string; raw: (a: Activity) => number }> = {
  distance: { name: 'Distance', of: (s) => distance(s.distanceM, state.units), fmt: (v) => fmt(v, 0), unit: () => distanceUnit(state.units), raw: (a) => distance(a.distanceM, state.units) },
  time: { name: 'Time', of: (s) => s.movingS / 3600, fmt: (v) => fmt(v, v < 10 ? 1 : 0), unit: () => 'h', raw: (a) => a.movingS / 3600 },
  elevation: { name: 'Elevation', of: (s) => elevation(s.elevGainM, state.units), fmt: (v) => fmt(v, 0), unit: () => elevationUnit(state.units), raw: (a) => elevation(a.elevGainM, state.units) },
};

function metricTabs(label: string): HTMLElement {
  const btn = (v: State['volMetric']) => h('button', { 'aria-pressed': String(state.volMetric === v), onclick: () => { state.volMetric = v; render(); } }, VOL[v].name);
  return h('div', { class: 'seg', role: 'group', 'aria-label': label }, btn('distance'), btn('time'), btn('elevation'));
}

function legendOf(items: [string, string][]): HTMLElement {
  return h('ul', { class: 'chart-legend' }, ...items.map(([name, cls]) => h('li', { class: cls }, h('i', {}), name)));
}

/** Year-to-date lines (one per year, the latest highlighted) and the last 26 weeks as bars, like Strava's progress charts. */
function progressSection(acts: Activity[]): HTMLElement {
  const m = VOL[state.volMetric];
  const u = m.unit();
  const years = yearsOf(acts).slice(0, 5);
  const byYear = new Map<number, number[]>(years.map((y) => [y, new Array<number>(367).fill(0)]));
  for (const a of acts) {
    const p = parts(a.startMs, state.tz);
    const arr = byYear.get(p.y);
    if (!arr) continue;
    arr[dayNumber(p) - dayNumber({ y: p.y, m: 1, d: 1, wd: 0 }) + 1]! += m.raw(a);
  }
  const lastMs = Math.max(...acts.map((a) => a.startMs));
  const lp = parts(lastMs, state.tz);
  const lastDoy = dayNumber(lp) - dayNumber({ y: lp.y, m: 1, d: 1, wd: 0 }) + 1;
  const series: XYSeries[] = years.map((y, i) => {
    const arr = byYear.get(y)!;
    const end = y === lp.y ? lastDoy : 365;
    const pts: [number, number][] = [];
    let acc = 0;
    for (let d = 1; d <= end; d++) { acc += arr[d]!; pts.push([d, acc]); }
    return { name: String(y), cls: i === 0 ? 's-main' : i === 1 ? 's-compare' : 's-faint', points: pts, endLabel: i < 3 };
  });
  // hover follows the longest line, so a part-year still reads against full ones
  const ordered = [...series].sort((a, b) => b.points.length - a.points.length);
  const doyLabel = (d: number) => { const dt = new Date(Date.UTC(2001, 0, d)); return `${dt.getUTCDate()} ${MONTH_NAMES[dt.getUTCMonth()]}`; };
  const ytd = h('figure', { class: 'card chart-card' },
    h('div', { class: 'chart-head' }, h('h3', {}, `${m.name} year to date (${u})`), legendOf(series.map((x) => [x.name, x.cls]))),
    xyChart({ series: ordered, label: `Cumulative ${m.name.toLowerCase()} per year`, xTicks: MONTH_START_DOY.filter((_, i) => i % 2 === 0), fmtX: (d) => MONTH_NAMES[MONTH_START_DOY.indexOf(d)] ?? doyLabel(d), tipX: (d) => `Up to ${doyLabel(d)}`, fmtY: (v) => `${m.fmt(v)}`, yZero: true }));

  const weeks = byPeriod(acts, 'week', state.tz).slice(-26);
  const bars: Bar[] = weeks.map((w) => ({
    label: `${MONTH_NAMES[Number(w.start.slice(5, 7)) - 1]} ${Number(w.start.slice(8))}`,
    value: m.of(w.summary),
    tip: [`${m.fmt(m.of(w.summary))} ${u}`, plural(w.summary.count, 'activity', 'activities'), w.summary.count ? `${dist(w.summary.distanceM)} ${distanceUnit(state.units)} · ${formatHours(w.summary.movingS)}` : 'Rest week'],
    selected: selectedIn('weeks') === w.key,
    onClick: w.summary.count ? () => { state.pick = selectedIn('weeks') === w.key ? null : { table: 'weeks', key: w.key, title: `Week from ${w.start}`, sel: { kind: 'week', value: w.key } }; render(); } : undefined,
  }));
  const recent = weeks.slice(-5, -1).map((w) => m.of(w.summary));
  const thisWeek = weeks.length ? m.of(weeks[weeks.length - 1]!.summary) : 0;
  const avg4 = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const weekly = h('figure', { class: 'card chart-card' },
    h('div', { class: 'chart-head' }, h('h3', {}, `${m.name} per week (${u})`),
      h('span', { class: 'muted small' }, `Last week of the data: ${m.fmt(thisWeek)} ${u} · 4-week average before it: ${m.fmt(avg4)} ${u}`)),
    barChart({ bars, label: `${m.name} per week, last 26 weeks. Select a bar to list its activities`, fmtY: m.fmt, labelEvery: 4 }));
  return h('div', {},
    h('div', { class: 'h2row' }, h('h2', { id: 'progress' }, 'Progress'), metricTabs('Measure shown in the progress charts')),
    h('div', { class: 'charts' }, ytd, weekly), drill('weeks', acts));
}

/** Months of the selected year as bars above the month table; a bar selects the same row. */
function monthBars(acts: Activity[], months: { key: string; label: string; summary: Summary }[]): HTMLElement | null {
  if (!months.length || monthYear(acts) === 'all') return null;
  const m = VOL[state.volMetric];
  return h('figure', { class: 'card chart-card' },
    h('div', { class: 'chart-head' }, h('h3', {}, `${m.name} per month (${m.unit()})`), metricTabs('Measure shown in the month chart')),
    barChart({ label: `${m.name} per month`, fmtY: m.fmt, height: 160, labelEvery: 1,
      bars: months.map((r) => ({ label: r.label, value: m.of(r.summary), selected: selectedIn('month') === r.key,
        tip: [`${m.fmt(m.of(r.summary))} ${m.unit()}`, plural(r.summary.count, 'activity', 'activities')],
        onClick: r.summary.count ? () => { state.pick = selectedIn('month') === r.key ? null : { table: 'month', key: r.key, title: monthTitle(r.key), sel: { kind: 'month', value: r.key } }; render(); } : undefined })) }));
}

// ---------- training load ----------

const thresholds = (): Thresholds => ({ ftp: state.ftp, lthr: lthrOf(state.hr) });

/** Heart-rate and FTP settings, shared by zones, training load and the activity pages. */
function thresholdForm(all: Activity[]): HTMLElement {
  const hrIn = h('input', { type: 'number', min: 100, max: 230, value: state.hr?.value ?? '', 'aria-label': 'Heart-rate value in bpm' });
  const modeSel = h('select', { 'aria-label': 'Zone basis' },
    h('option', { value: 'maxHr', selected: state.hr?.mode === 'maxHr' }, 'Max HR'),
    h('option', { value: 'lthr', selected: state.hr?.mode === 'lthr' }, 'Threshold HR'));
  const ftpIn = h('input', { type: 'number', min: 50, max: 600, value: state.ftp ?? '', placeholder: 'e.g. 250', 'aria-label': 'FTP in watts' });
  const form = h('form', { class: 'row card', 'aria-label': 'Your thresholds', onsubmit: (e) => {
    e.preventDefault();
    const v = Number(hrIn.value);
    if (v >= 100 && v <= 230) state.hr = { mode: modeSel.value as HrZoneConfig['mode'], value: v };
    const f = Number(ftpIn.value);
    state.ftp = f >= 50 && f <= 600 ? f : null;
    render();
  } },
    h('label', {}, 'Heart rate from', modeSel, hrIn, 'bpm'),
    h('label', {}, 'FTP', ftpIn, 'W'), h('button', { type: 'submit' }, 'Apply'));
  const out = h('div', {}, form);
  if (state.hr && observedMaxHr(all) === state.hr.value && state.hr.mode === 'maxHr') {
    out.append(h('p', { class: 'small' }, `Max HR defaults to the highest value in your data (${state.hr.value} bpm). Set your own, or your threshold HR, for more accurate zones and load.`));
  }
  const est = estimateFtp(bestPowerCurve(lastYear(all.filter((a) => a.powerCurve))));
  if (est && est !== state.ftp) {
    out.append(h('p', { class: 'small' }, `Estimated FTP from your best 20 minutes in the last 12 months: ${est} W. `,
      h('button', { class: 'link', onclick: () => { state.ftp = est; render(); } }, `Use ${est} W`)));
  }
  return out;
}

/** Activities in the 365 days up to the last one. */
function lastYear(acts: Activity[]): Activity[] {
  if (!acts.length) return acts;
  const end = Math.max(...acts.map((a) => a.startMs));
  return acts.filter((a) => a.startMs > end - 365 * 86_400_000);
}

const dayLabel = (d: number) => { const p = fromDayNumber(d); return `${p.d} ${MONTH_NAMES[p.m - 1]} ${p.y}`; };

function trainingSection(all: Activity[], acts: Activity[]): HTMLElement {
  const sec = h('div', {}, h('div', { class: 'h2row' }, h('h2', { id: 'training' }, 'Training load')), thresholdForm(all));
  const t = thresholds();
  if (!t.ftp && !t.lthr) {
    sec.append(h('p', {}, 'Set your FTP or heart rate above to see your training stress, fitness, fatigue and form.'));
    return sec;
  }
  const load = trainingLoad(acts, t, state.tz);
  if (!load.days.length) {
    sec.append(h('p', {}, 'None of these activities has power or heart-rate data, so there is no training stress to show.'));
    return sec;
  }
  const last = load.days[load.days.length - 1]!;
  const tomorrowForm = last.ctl - last.atl;
  const fl = formLabel(tomorrowForm);
  const ramp = rampRate(load.days);
  const tile = (v: string, l: string, help: string, pill?: string) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l), pill ? h('span', { class: 'pill' }, pill) : null, h('small', {}, help));
  sec.append(h('p', { class: 'muted small' }, `As of ${dayLabel(last.day)}, the last day in your data.`),
    h('div', { class: 'grid' },
      tile(fmt(last.ctl, 0), 'Fitness (CTL)', 'Your training stress per day, averaged over about 6 weeks. Goes up slowly as you train consistently.'),
      tile(fmt(last.atl, 0), 'Fatigue (ATL)', 'The same over about a week. Rises fast after hard days, falls fast with rest.'),
      tile(`${tomorrowForm > 0 ? '+' : ''}${fmt(tomorrowForm, 0)}`, 'Form (TSB)', fl.advice, fl.label),
      ramp !== null ? tile(`${ramp > 0 ? '+' : ''}${fmt(ramp, 1)}`, 'Fitness change, last 7 days', 'Ramp rate. More than about +8 a week is hard to sustain.') : null));

  const range = state.loadRange === 'all' ? load.days : load.days.slice(-Number(state.loadRange));
  const step = range.length > 400 ? 3 : 1; // keep the path light on long histories
  const pts = (f: (d: typeof last) => number): [number, number][] => range.filter((_, i) => i % step === 0 || i === range.length - 1).map((d) => [d.day, Math.round(f(d) * 10) / 10]);
  const firstDay = range[0]!.day, lastDay = range[range.length - 1]!.day;
  const monthTicks: number[] = [];
  for (let p = fromDayNumber(firstDay), y = p.y, mo = p.m; ; mo === 12 ? (y++, (mo = 1)) : mo++) {
    const d = dayNumber({ y, m: mo, d: 1, wd: 0 });
    if (d > lastDay) break;
    if (d >= firstDay) monthTicks.push(d);
  }
  const every = Math.max(1, Math.ceil(monthTicks.length / 6));
  const rangeBtn = (v: State['loadRange'], text: string) => h('button', { 'aria-pressed': String(state.loadRange === v), onclick: () => { state.loadRange = v; render(); } }, text);
  const tssOn = new Map(range.map((d) => [d.day, d.tss]));
  sec.append(h('figure', { class: 'card chart-card' },
    h('div', { class: 'chart-head' }, h('h3', {}, 'Fitness, fatigue and form'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Period shown in the fitness chart' }, rangeBtn('90', '90 days'), rangeBtn('365', '1 year'), rangeBtn('all', 'All'))),
    legendOf([['Fitness', 's-fitness'], ['Fatigue', 's-fatigue'], ['Form', 's-form']]),
    xyChart({
      label: 'Fitness, fatigue and form per day', height: 240, zeroLine: true,
      series: [
        { name: 'Fitness', cls: 's-fitness', points: pts((d) => d.ctl) },
        { name: 'Fatigue', cls: 's-fatigue', points: pts((d) => d.atl) },
        { name: 'Form', cls: 's-form', points: pts((d) => d.tsb), area: true },
      ],
      xTicks: monthTicks.filter((_, i) => i % every === 0),
      fmtX: (d) => { const p = fromDayNumber(d); return p.m === 1 || every >= 12 ? String(p.y) : MONTH_NAMES[p.m - 1]!; },
      tipX: (d) => `${dayLabel(d)} · ${fmt(tssOn.get(d) ?? 0, 0)} TSS that day`,
      fmtY: (v) => fmt(v, 0),
    })));

  // weekly stress, last 26 weeks
  const weeks = new Map<string, { start: string; tss: number; n: number }>();
  for (const w of byPeriod(acts, 'week', state.tz).slice(-26)) weeks.set(w.key, { start: w.start, tss: 0, n: 0 });
  for (const a of acts) {
    const l = activityLoad(a, t);
    const k = isoWeekOf(a.startMs);
    const w = weeks.get(k);
    if (l && w) { w.tss += l.tss; w.n++; }
  }
  sec.append(h('figure', { class: 'card chart-card' }, h('div', { class: 'chart-head' }, h('h3', {}, 'Training stress per week (TSS)')),
    barChart({ label: 'Training stress per week, last 26 weeks', fmtY: (v) => fmt(v, 0), labelEvery: 4,
      bars: [...weeks.entries()].map(([key, w]) => ({ label: `${MONTH_NAMES[Number(w.start.slice(5, 7)) - 1]} ${Number(w.start.slice(8))}`, value: Math.round(w.tss),
        tip: [`${fmt(w.tss, 0)} TSS`, plural(w.n, 'activity', 'activities') + ' with load'],
        selected: selectedIn('weeks-tss') === key,
        onClick: w.n ? () => { state.pick = selectedIn('weeks-tss') === key ? null : { table: 'weeks-tss', key, title: `Week from ${w.start}`, sel: { kind: 'week', value: key } }; render(); } : undefined })) })),
    drill('weeks-tss', acts) ?? '');

  const parts1: string[] = [];
  if (load.fromPower) parts1.push(`${load.fromPower} from power`);
  if (load.fromHr) parts1.push(`${load.fromHr} estimated from heart rate`);
  sec.append(h('p', { class: 'small' }, `Training stress (TSS) counted for ${parts1.join(' and ')}${load.without ? `; ${plural(load.without, 'activity', 'activities')} without power or heart rate add nothing` : ''}. 100 TSS is about one hour flat out at threshold.${t.lthr && state.hr?.mode === 'maxHr' ? ` Threshold HR is estimated as 90 % of max HR (${t.lthr} bpm).` : ''}`),
    h('details', {}, h('summary', {}, 'How to read this'),
      h('dl', { class: 'explain card' },
        h('dt', {}, 'Training stress (TSS)'), h('dd', {}, 'How hard one activity was, combining duration and intensity. An easy hour is around 40–60, an hour at your limit is 100. With power and an FTP it uses normalized power; otherwise it is estimated from heart rate against your threshold heart rate (hrTSS).'),
        h('dt', {}, 'Fitness'), h('dd', {}, 'A rolling average of your daily TSS over about 42 days. It is the long-term trend: higher means you have been training more.'),
        h('dt', {}, 'Fatigue'), h('dd', {}, 'The same average over about 7 days: what the last week has taken out of you.'),
        h('dt', {}, 'Form'), h('dd', {}, 'Fitness minus fatigue. Between about −10 and −30 you are building; above +5 you are fresh for an event; below −30 you risk overdoing it.'))));
  return sec;
}

const isoWeekOf = (ms: number) => isoWeekKey(parts(ms, state.tz));

// ---------- power curve and best efforts ----------

function curveSection(acts: Activity[]): HTMLElement {
  const sec = h('div', {}, h('h2', { id: 'curve' }, 'Power curve and best efforts'));
  const withPower = acts.filter((a) => a.powerCurve);
  const byId = new Map(acts.map((a) => [a.id, a]));
  const actLink = (id: string) => { const a = byId.get(id)!; return h('button', { class: 'link', onclick: () => openActivity(a.id) }, a.name); };
  if (withPower.length) {
    const allTime = bestPowerCurve(withPower);
    const recent = bestPowerCurve(lastYear(withPower));
    const showRecent = recent.length && withPower.length !== lastYear(withPower).length;
    const series: XYSeries[] = [{ name: 'All time', cls: 's-compare', points: allTime.map((p) => [p.seconds, p.watts]) }];
    if (showRecent) series.unshift({ name: 'Last 12 months', cls: 's-main', points: recent.map((p) => [p.seconds, p.watts]), area: true });
    const curves = [showRecent ? recent : allTime, allTime];
    const ticks = [1, 5, 30, 60, 300, 1200, 3600, 7200, 18000].filter((d) => d <= allTime[allTime.length - 1]!.seconds * 1.01);
    sec.append(h('figure', { class: 'card chart-card' },
      h('div', { class: 'chart-head' }, h('h3', {}, 'Best power for every duration (W)'), series.length > 1 ? legendOf(series.map((x) => [x.name, x.cls])) : null),
      xyChart({ series, log: true, label: 'Power curve: best average power for each duration. Select a point to open the activity that set it', xTicks: ticks, fmtX: (s) => durationName(s).replace(' min', 'm').replace(' s', 's').replace(' h', 'h'), tipX: (s) => `Best ${durationName(s)}`, fmtY: (v) => `${fmt(v, 0)}`, yZero: true,
        tipExtra: (k, j) => { const p = curves[k]?.[j]; return p ? `${dateOf(p.startMs)}` : null; },
        onPick: (i) => { const p = curves[0]![i]; if (p) openActivity(p.activityId); } })),
      h('p', { class: 'small' }, `From ${plural(withPower.length, 'activity', 'activities')} with a power meter. Each point is the highest average power you held for that long in one go.${estimateFtp(recent) ? ` Your best 20 minutes in the last 12 months suggest an FTP of about ${estimateFtp(recent)} W.` : ''}`));
    const keyD = [5, 60, 300, 1200, 3600];
    const rows = keyD.map((d) => ({ d, a: allTime.find((p) => p.seconds === d), r: recent.find((p) => p.seconds === d) })).filter((x) => x.a);
    sec.append(h('div', { class: 'card scroll' }, table(['Duration', 'All time (W)', 'Set on', ...(showRecent ? ['Last 12 months (W)'] : []), ...(state.ftp ? ['% of FTP'] : [])],
      rows.map(({ d, a, r }) => [durationName(d), fmt(a!.watts, 0), h('span', {}, actLink(a!.activityId), ` (${dateOf(a!.startMs)})`), ...(showRecent ? [r ? fmt(r.watts, 0) : dash] : []), ...(state.ftp ? [`${fmt((a!.watts / state.ftp) * 100, 0)} %`] : [])]), { numCols: [1, 3, 4] })));
  } else sec.append(h('p', {}, 'No activities with a power meter, so there is no power curve.'));

  const sports = (state.sport === 'all' ? sportsOf(acts) : [state.sport]).filter((sp) => acts.some((a) => a.sport === sp && a.bestEfforts)).slice(0, 3);
  for (const sp of sports) {
    const rows = bestEffortsBySport(acts, sp);
    if (!rows.length) continue;
    const pace = PACE_SPORTS.has(sp);
    const u = state.units;
    const unitM = u === 'metric' ? 1000 : 1609.344;
    sec.append(h('h3', {}, `Best efforts: ${sp}`),
      h('div', { class: 'card scroll' }, table(['Distance', 'Best time', pace ? `Pace (/${distanceUnit(u)})` : `Speed (${speedUnit(u)})`, 'Activity', '2nd best', '3rd best'],
        rows.map((r) => {
          const b = r.top[0]!;
          return [distanceName(r.meters), formatDuration(b.seconds), pace ? formatDuration((b.seconds / r.meters) * unitM) : fmt(speed(r.meters / b.seconds, u)),
            h('span', {}, actLink(b.activityId), ` (${dateOf(b.startMs)})`), r.top[1] ? formatDuration(r.top[1].seconds) : dash, r.top[2] ? formatDuration(r.top[2].seconds) : dash];
        }), { numCols: [1, 2, 4, 5] })));
  }
  if (sports.length) sec.append(h('p', { class: 'small' }, 'Fastest elapsed time over each distance anywhere inside an activity, from the GPS or sensor distance in the files.'));
  return sec;
}
const PACE_SPORTS = new Set(['Run', 'Walk', 'Hike']);

// ---------- posters ----------

interface Rendered { svg: string; width: number; height: number; url: string }
/** Rendered posters keyed by type; an entry is reused while its settings key is unchanged. */
const posterCache = new Map<PosterType, { key: string; r: Rendered }>();
let posterOwner: unknown = null;
let posterJob = 0;

function posterOpts(acts: Activity[]): PosterOptions {
  const o: PosterOptions = { ...poster, units: state.units, tz: state.tz, sportLabel: state.sport === 'all' ? 'All activities' : state.sport };
  const years = yearsOf(acts);
  if (!o.seasonYear || !years.includes(o.seasonYear)) o.seasonYear = years[0] ?? null;
  if (typeof o.climbYear !== 'string' && (!o.climbYear || !years.includes(o.climbYear))) o.climbYear = years[0] ?? null;
  if (o.worldYear !== 'all' && !years.includes(o.worldYear)) o.worldYear = 'all';
  if (o.circleYear !== 'all' && !years.includes(o.circleYear)) o.circleYear = 'all';
  if (o.spaceYear !== 'all' && !years.includes(o.spaceYear)) o.spaceYear = 'all';
  if (o.facetYear !== 'all' && !years.includes(o.facetYear)) o.facetYear = 'all';
  if (o.overlayYear !== 'all' && !years.includes(o.overlayYear)) o.overlayYear = 'all';
  if (!o.todYear || !years.includes(o.todYear)) o.todYear = years[0] ?? null;
  return o;
}
const yearsOf = (acts: Activity[]) => [...new Set(acts.map((a) => parts(a.startMs, state.tz).y))].sort((a, b) => b - a);

/** Render (or reuse) one poster for the current data and settings. */
function posterFor(type: PosterType, acts: Activity[]): Rendered {
  if (posterOwner !== state.result) { for (const v of posterCache.values()) URL.revokeObjectURL(v.r.url); posterCache.clear(); posterOwner = state.result; }
  const o = posterOpts(acts);
  const key = JSON.stringify([state.sport, o]);
  const hit = posterCache.get(type);
  if (hit && hit.key === key) return hit.r;
  if (hit) URL.revokeObjectURL(hit.r.url);
  const p = renderPoster(type, acts, o);
  const r = { ...p, url: URL.createObjectURL(new Blob([p.svg], { type: 'image/svg+xml' })) };
  posterCache.set(type, { key, r });
  return r;
}

const themeControl = (after?: (el: HTMLElement) => void) => selectControl('Theme', poster.theme, THEMES.map((t): [string, string] => [t.id, t.name]), (v) => (poster.theme = v), { ariaLabel: 'Poster theme', after });
const posterName = (t: PosterType) => POSTER_TYPES.find((x) => x.id === t)!.name;
const posterFile = (acts: Activity[], t: PosterType, ext: string) => exportFilename(acts, state.sport, `poster-${t}`, ext, state.tz);

/** The poster's paper colour, painted under a JPEG (which has no transparency). */
const posterBg = () => (THEMES.find((x) => x.id === poster.theme) ?? THEMES[0]!).bg;

async function rasterOf(acts: Activity[], t: PosterType, kind: ImageKind) {
  const r = posterFor(t, acts);
  return svgToImage(r.svg, r.width, r.height, kind, posterBg());
}

async function downloadImage(acts: Activity[], t: PosterType, kind: ImageKind, status: HTMLElement): Promise<void> {
  const k = IMAGE_KINDS.find((x) => x.id === kind)!;
  status.textContent = `Rendering ${k.label}…`;
  try {
    const img = await rasterOf(acts, t, kind);
    download(posterFile(acts, t, k.ext), img.blob, k.mime);
    status.textContent = `${img.width} × ${img.height} px`;
  } catch (e) { status.textContent = e instanceof Error ? e.message : String(e); }
}

/** Per-poster settings, shown on the poster's card. */
function posterSettings(t: PosterType, acts: Activity[], after?: (el: HTMLElement) => void): HTMLElement[] {
  const pick = <T extends string>(label: string, value: T, options: [T, string][], on: (v: T) => void) =>
    selectControl(label, value, options, on, { ariaLabel: `${posterName(t)}: ${label}`, after });
  const o = posterOpts(acts);
  const years = yearsOf(acts).map((y): [string, string] => [String(y), String(y)]);
  // Shared by both route posters: trims every route so the poster does not show where you start (home).
  const hideEnds = () => pick('Hide route ends', String(poster.hideEnds), [['0', 'Off'], ['200', '200 m'], ['500', '500 m'], ['1000', '1 km']], (v) => (poster.hideEnds = Number(v)));
  switch (t) {
    case 'facets': return [
      pick('Sort by', poster.facetSort, [['date', 'Date'], ['distance', 'Distance']], (v) => (poster.facetSort = v)),
      pick('Period', String(o.facetYear), [['all', 'All time'], ...years], (v) => (poster.facetYear = v === 'all' ? 'all' : Number(v))),
      hideEnds(),
      ...regionControl(t, acts, poster.facetRegions, (c) => (poster.facetRegions = c), after)];
    case 'overlay': return [
      pick('Period', String(o.overlayYear), [['all', 'All time'], ...years], (v) => (poster.overlayYear = v === 'all' ? 'all' : Number(v))),
      hideEnds(),
      ...regionControl(t, acts, poster.overlayRegions, (c) => (poster.overlayRegions = c), after)];
    case 'calendar': case 'rings': case 'cumulative': return [pick('Measure', poster.calendarMetric, [['distance', 'Distance'], ['time', 'Time']], (v) => (poster.calendarMetric = v))];
    case 'circles': return [
      pick('Period', String(o.circleYear), [['all', 'All time'], ...years], (v) => (poster.circleYear = v === 'all' ? 'all' : Number(v))),
      pick('Clusters', poster.circleGroup, [['none', 'One pack'], ['year', 'One per year'], ['sport', 'One per sport']], (v) => (poster.circleGroup = v)),
      pick('Colour by', poster.circleColor, [['year', 'Year'], ['sport', 'Sport']], (v) => (poster.circleColor = v))];
    case 'timeofday': return [pick('Rows', poster.todRows, [['year', 'Years'], ['month', 'Months'], ['weekday', 'Weekdays']], (v) => (poster.todRows = v))];
    case 'punchcard': return [pick('Dot size', poster.punchMetric, [['count', 'Activities'], ['distance', 'Distance']], (v) => (poster.punchMetric = v))];
    case 'ridgelines': return [
      pick('Activities', poster.ridgeSelect, [['recent', 'Most recent'], ['longest', 'Longest'], ['climbiest', 'Biggest climbs']], (v) => (poster.ridgeSelect = v)),
      pick('Count', String(poster.ridgeCount), ['15', '30', '45', '60'].map((c): [string, string] => [c, c]), (v) => (poster.ridgeCount = Number(v)))];
    case 'season': return [pick('Year', String(o.seasonYear), years, (v) => (poster.seasonYear = Number(v)))];
    case 'climb': return [pick('Period', String(o.climbYear), [...years, ['all', 'All time'], ['overlay', 'All years overlaid']], (v) => (poster.climbYear = v === 'all' || v === 'overlay' ? v : Number(v)))];
    case 'world': return [pick('Period', String(o.worldYear), [['all', 'All time'], ...years], (v) => (poster.worldYear = v === 'all' ? 'all' : Number(v)))];
    case 'todweek': return [pick('Year', String(o.todYear), years, (v) => (poster.todYear = Number(v)))];
    case 'landscape': return [
      pick('Activities', poster.landSelect, [['recent', 'Most recent'], ['longest', 'Longest'], ['climbiest', 'Biggest climbs']], (v) => (poster.landSelect = v)),
      pick('Count', String(poster.landCount), ['25', '50', '100', '200'].map((c): [string, string] => [c, c]), (v) => (poster.landCount = Number(v))),
      pick('Height', poster.landHeight, [['relative', 'From the start'], ['absolute', 'Above sea level']], (v) => (poster.landHeight = v))];
    case 'space': return [
      pick('Measure', poster.spaceMetric, [['climb', 'Climbing'], ['distance', 'Distance']], (v) => (poster.spaceMetric = v)),
      pick('Period', String(o.spaceYear), [['all', 'All time'], ...years], (v) => (poster.spaceYear = v === 'all' ? 'all' : Number(v)))];
    default: return [];
  }
}

const regionCache = new Map<string, Region[]>();
let regionOwner: unknown = null;
/** Regions of the current export and sport (cached: the gallery asks for them on every render). */
function regionsFor(acts: Activity[]): Region[] {
  if (regionOwner !== state.result) { regionCache.clear(); regionOwner = state.result; }
  let r = regionCache.get(state.sport);
  if (!r) { r = findRegions(acts); regionCache.set(state.sport, r); }
  return r;
}

/** Which region menu is open (by its label), so it stays open while boxes are ticked and the page redraws. */
let openRegionMenu: string | null = null;

/**
 * Region checklist for the route posters: "Everywhere" plus one box per region. Shown only when the
 * activities are spread over more than one region. At least one region stays ticked.
 */
function regionControl(t: PosterType, acts: Activity[], choice: RegionChoice, set: (c: RegionChoice) => void, after?: (el: HTMLElement) => void): HTMLElement[] {
  const regions = regionsFor(acts);
  if (regions.length < 2) return [];
  const label = `${posterName(t)}: Regions`;
  const picked = new Set(regionFilter(regions, choice).picked.map((r) => r.id));
  const everywhere = picked.size === regions.length;
  const apply = (next: Set<string>, el: HTMLElement) => {
    set(next.size === regions.length ? 'all' : regions.filter((r) => next.has(r.id)).map((r) => r.id));
    (after ?? render)(el);
  };
  const box = (text: string, checked: boolean, aria: string, on: (checked: boolean, el: HTMLInputElement) => void, disabled = false) =>
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, disabled, 'aria-label': aria, onchange: (e) => { const el = e.target as HTMLInputElement; on(el.checked, el); } }), text);
  const summary = everywhere ? 'Everywhere' : picked.size === 1 ? regions.find((r) => picked.has(r.id))!.name : `${picked.size} of ${regions.length}`;
  const menu = h('details', { class: 'regions-pick', open: openRegionMenu === label, ontoggle: (e) => { openRegionMenu = (e.target as HTMLDetailsElement).open ? label : openRegionMenu === label ? null : openRegionMenu; } },
    h('summary', { 'aria-label': `${label}: ${summary}` }, `Regions: ${summary}`),
    h('div', { class: 'regions-list', role: 'group', 'aria-label': label },
      box('Everywhere', everywhere, `${posterName(t)}: Everywhere`, (on, el) => { if (on) set('all'); else set('auto'); (after ?? render)(el); }),
      ...regions.map((r) => box(`${r.name} (${r.count})`, picked.has(r.id), `${posterName(t)}: ${r.name}`, (on, el) => {
        const next = new Set(picked);
        if (on) next.add(r.id); else next.delete(r.id);
        apply(next, el);
      }, picked.size === 1 && picked.has(r.id)))));
  return [h('div', { class: 'regions-wrap' }, menu)];
}

/** Banner at the top of the stats page: the posters are the point of the app, so show some. */
function posterPromo(acts: Activity[], open: () => void): HTMLElement {
  const picks: PosterType[] = ['overlay', 'climb', 'world'];
  const size = SIZES.find((s) => s.id === poster.size) ?? SIZES[0]!;
  const imgs = picks.map((t) => h('img', { class: 'poster', alt: '', width: size.px[0], height: size.px[1] }));
  const job = ++posterJob;
  picks.forEach((t, i) => setTimeout(() => { if (job === posterJob) imgs[i]!.src = posterFor(t, acts).url; }, 0));
  return h('section', { class: 'promo', 'aria-labelledby': 'promo-title' },
    h('div', { class: 'promo-text' },
      h('h2', { id: 'promo-title' }, 'Your activities as art'),
      h('p', {}, `${POSTER_TYPES.length} printable posters made from your data: every route you've done, the mountains you've climbed, how far around the world you've gone, and more.`),
      h('button', { id: 'open-posters', class: 'primary', onclick: open }, 'Open the poster gallery →')),
    h('button', { class: 'promo-thumbs', 'aria-label': 'Open the poster gallery', tabindex: -1, onclick: open }, ...imgs));
}

function posterSection(acts: Activity[]): HTMLElement {
  const sec = h('div', {}, h('h2', { id: 'posters' }, 'Posters'));
  if (!acts.length) return h('div', {}, sec, h('div', { class: 'card empty' }, h('h2', {}, 'Nothing to draw'), h('p', {}, 'There are no activities for this sport. Pick another sport in the filters.')));
  const allStatus = h('span', { class: 'muted', role: 'status' });
  const zipAll = async (kind: ImageKind | 'svg', btn: HTMLButtonElement) => {
    const ext = kind === 'jpeg' ? 'jpg' : kind;
    btn.disabled = true;
    const entries: Record<string, Uint8Array> = {};
    try {
      for (const [i, t] of POSTER_TYPES.entries()) {
        allStatus.textContent = `Rendering ${i + 1} of ${POSTER_TYPES.length}: ${t.name}…`;
        await new Promise((ok) => setTimeout(ok, 0)); // let the status paint
        const r = posterFor(t.id, acts);
        entries[posterFile(acts, t.id, ext)] = kind === 'svg' ? strToU8(r.svg) : new Uint8Array(await (await svgToImage(r.svg, r.width, r.height, kind, posterBg())).blob.arrayBuffer());
      }
      download(exportFilename(acts, state.sport, `posters-${kind}`, 'zip', state.tz), new Blob([zipSync(entries, { level: 0 })], { type: 'application/zip' }), 'application/zip');
      allStatus.textContent = `${POSTER_TYPES.length} posters saved.`;
    } catch (e) { allStatus.textContent = e instanceof Error ? e.message : String(e); }
    btn.disabled = false;
  };
  const pngAll: HTMLButtonElement = h('button', { id: 'dl-all-png', class: 'primary', onclick: () => zipAll('png', pngAll) }, 'Download all (PNG)');
  const jpgAll: HTMLButtonElement = h('button', { id: 'dl-all-jpeg', onclick: () => zipAll('jpeg', jpgAll) }, 'All as JPEG');
  const svgAll: HTMLButtonElement = h('button', { id: 'dl-all-svg', onclick: () => zipAll('svg', svgAll) }, 'All as SVG');
  const controls = h('div', { class: 'row card controls', role: 'group', 'aria-label': 'Poster settings' },
    themeControl(),
    selectControl('Size', poster.size, SIZES.map((s): [string, string] => [s.id, s.name]), (v) => (poster.size = v)),
    h('label', {}, h('input', { type: 'checkbox', checked: poster.strip, onchange: (e) => { poster.strip = (e.target as HTMLInputElement).checked; render(); } }), 'Stats strip'),
    h('div', { class: 'row grow-end' }, pngAll, jpgAll, svgAll));

  const size = SIZES.find((s) => s.id === poster.size) ?? SIZES[0]!;
  const imgs: [PosterType, HTMLImageElement][] = [];
  const cards = POSTER_TYPES.map((t, i) => {
    const img = h('img', { class: 'poster', id: `poster-${t.id}`, alt: `${t.name} poster`, width: size.px[0], height: size.px[1] });
    imgs.push([t.id, img]);
    const status = h('span', { class: 'muted small', role: 'status' });
    return h('article', { class: 'pcard', 'aria-label': t.name },
      h('button', { class: 'thumb', 'aria-label': `View ${t.name} full screen`, onclick: () => openLightbox(acts, i) }, img),
      h('div', { class: 'pcard-body' },
        h('h3', {}, t.name),
        h('div', { class: 'row controls' }, ...posterSettings(t.id, acts)),
        h('div', { class: 'row' },
          h('button', { id: `dl-png-${t.id}`, class: 'primary', onclick: () => downloadImage(acts, t.id, 'png', status) }, 'PNG'),
          h('button', { id: `dl-jpeg-${t.id}`, onclick: () => downloadImage(acts, t.id, 'jpeg', status) }, 'JPEG'),
          h('button', { id: `dl-svg-${t.id}`, onclick: () => { const r = posterFor(t.id, acts); download(posterFile(acts, t.id, 'svg'), r.svg, 'image/svg+xml'); } }, 'SVG'),
          status)));
  });
  // Render one poster per task so a big export never freezes the page; cached posters appear at once.
  const job = ++posterJob;
  const next = (k: number) => {
    if (job !== posterJob || k >= imgs.length) return;
    const [t, img] = imgs[k]!;
    img.src = posterFor(t, acts).url;
    setTimeout(() => next(k + 1), 0);
  };
  setTimeout(() => next(0), 0);
  return h('div', {}, sec,
    h('p', {}, 'Every poster from your data. Select one to view it full screen and flip through them with the arrow keys. Theme and size apply to all of them.'),
    h('p', { class: 'muted small' }, 'Before you share a poster online: the two route posters leave out the first and last 200 m of every route by default (“Hide route ends”), so your front door is not on them. A poster of many routes can still show which part of town you live in. The other posters show no places.'),
    controls, allStatus, h('div', { class: 'gallery' }, ...cards));
}

// ---------- full-screen poster viewer ----------

function openLightbox(acts: Activity[], start: number): void {
  let i = start;
  const img = h('img', { class: 'lb-img', alt: '' });
  const title = h('h2', { id: 'lb-title' });
  const counter = h('span', { class: 'lb-count', 'aria-live': 'polite' });
  const status = h('span', { class: 'muted small', role: 'status' });
  const settings = h('div', { class: 'row lb-settings', role: 'group', 'aria-label': 'Poster options' });
  /** A setting changed: redraw the poster here and the gallery behind, and keep focus on the control. */
  const changed = (el: HTMLElement) => {
    const label = el.getAttribute('aria-label');
    render();
    show(i);
    if (label) settings.querySelector<HTMLElement>(`[aria-label="${CSS.escape(label)}"]`)?.focus();
  };
  const show = (k: number) => {
    i = (k + POSTER_TYPES.length) % POSTER_TYPES.length;
    const t = POSTER_TYPES[i]!;
    const r = posterFor(t.id, acts);
    img.src = r.url;
    img.alt = `${t.name} poster`;
    title.textContent = t.name;
    counter.textContent = `${i + 1} / ${POSTER_TYPES.length}`;
    status.textContent = '';
    settings.replaceChildren(...posterSettings(t.id, acts, changed), themeControl(changed));
  };
  // The viewer is a history entry, so the browser's Back button (or a phone's back gesture) closes it.
  const teardown = () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('popstate', teardown);
    box.remove();
    document.body.classList.remove('lb-open');
    // Back on the gallery at the poster last shown (the gallery may have been re-rendered meanwhile).
    document.getElementById(`poster-${POSTER_TYPES[i]!.id}`)?.closest('button')?.focus();
  };
  const close = () => { if (navEntry().lightbox) history.back(); else teardown(); };
  const onKey = (e: KeyboardEvent) => {
    const inSelect = (e.target as Element | null)?.tagName === 'SELECT'; // arrows there change the option
    if (e.key === 'Escape') close();
    else if (inSelect) return;
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'ArrowRight') show(i + 1);
    else if (e.key === 'Tab') { // keep focus inside the viewer
      const f = Array.from(box.querySelectorAll<HTMLElement>('button, select, summary, input:not([disabled])')).filter((el) => el.offsetParent !== null);
      const first = f[0]!, last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  const closeBtn = h('button', { class: 'lb-close', 'aria-label': 'Close', onclick: close }, '✕');
  const stage = h('div', { class: 'lb-stage' },
    h('button', { class: 'lb-nav lb-prev', 'aria-label': 'Previous poster', onclick: () => show(i - 1) }, '‹'),
    img,
    h('button', { class: 'lb-nav lb-next', 'aria-label': 'Next poster', onclick: () => show(i + 1) }, '›'));
  // Swipe left/right on touch screens.
  let x0: number | null = null;
  stage.addEventListener('touchstart', (e) => { x0 = e.touches[0]?.clientX ?? null; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    const x1 = e.changedTouches[0]?.clientX;
    if (x0 !== null && x1 !== undefined && Math.abs(x1 - x0) > 50) show(x1 < x0 ? i + 1 : i - 1);
    x0 = null;
  });
  const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lb-title', onclick: (e) => { if (e.target === box || e.target === stage) close(); } },
    h('div', { class: 'lb-bar' }, h('div', {}, title, counter), settings,
      h('div', { class: 'row' },
        h('button', { id: 'lb-png', class: 'primary', onclick: () => downloadImage(acts, POSTER_TYPES[i]!.id, 'png', status) }, 'PNG'),
        h('button', { id: 'lb-jpeg', onclick: () => downloadImage(acts, POSTER_TYPES[i]!.id, 'jpeg', status) }, 'JPEG'),
        h('button', { onclick: () => { const t = POSTER_TYPES[i]!.id; download(posterFile(acts, t, 'svg'), posterFor(t, acts).svg, 'image/svg+xml'); } }, 'SVG'),
        status, closeBtn)),
    stage);
  show(start);
  document.body.append(box);
  document.body.classList.add('lb-open');
  document.addEventListener('keydown', onKey);
  history.pushState({ ...navEntry(), lightbox: true } satisfies NavEntry, '');
  window.addEventListener('popstate', teardown);
  closeBtn.focus();
}

// ---------- zones ----------

/** Hours and minutes, "12:05", for zone tables (thousands of minutes are hard to read). */
const hm = (s: number) => { const m = Math.round(s / 60); return s > 0 && m === 0 ? '0:01' : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`; };


function zoneBar(seconds: number[], zones?: Zone[]): HTMLElement {
  const total = seconds.reduce((a, b) => a + b, 0) || 1;
  return h('div', { class: 'zbar', role: 'img', 'aria-label': `Zone distribution: ${seconds.map((s, i) => `${zones?.[i]?.name.split(' ')[0] ?? `Z${i + 1}`} ${fmt((s / total) * 100, 0)} %`).join(', ')}` }, ...seconds.map((s, i) => {
    const el = h('i', { title: `${zones?.[i]?.name ?? `Zone ${i + 1}`}: ${hm(s)} (${fmt((s / total) * 100, 0)} %)` });
    el.style.width = `${(s / total) * 100}%`;
    el.style.background = ZONE_COLORS[i % ZONE_COLORS.length]!;
    return el;
  }));
}

/** Zone minutes per period. With an `id`, rows list their activities (period = 'year' or 'month' keys). */
function zoneTable(title: string, zones: Zone[], rows: (ZoneRow & { label?: string })[], noun: string, pick?: { id: string; kind: 'year' | 'month' }): HTMLElement {
  const head = [title, ...zones.map((z) => z.name.split(' ')[0]!), 'Total', 'Share', 'Coverage'];
  const body = rows.map((r) => {
    const label = r.label ?? r.key;
    const cells = r.withData
      ? [label, ...r.seconds.map(hm), hm(r.totalS), zoneBar(r.seconds, zones), `${r.withData} / ${r.count}`]
      : [label, ...zones.map(() => dash), dash, `No ${noun} data`, `0 / ${r.count}`];
    return pick && r.count ? pickRow(pick.id, r.key, pick.kind === 'month' ? monthTitle(r.key) : r.key, { kind: pick.kind, value: r.key }, cells) : cells;
  });
  return table(head, body, { numFrom: 1, id: pick?.id, selected: pick ? selectedIn(pick.id) : null });
}

function zonesSection(all: Activity[], acts: Activity[], hz: Zone[] | null, pz: Zone[] | null): HTMLElement {
  const sec = h('div', {}, h('h2', { id: 'zones' }, 'Time in zones'),
    h('p', {}, 'Zones come from the heart rate and FTP set under ', h('a', { href: '#training' }, 'Training load'), '.'));
  void all;

  const block = (stream: 'hr' | 'power', zones: Zone[] | null, noun: string, hint: string) => {
    sec.append(h('h3', {}, stream === 'hr' ? 'Heart rate' : 'Power'));
    const total = zoneTotals(acts, stream, zones ?? []);
    if (!zones) { sec.append(h('p', {}, hint)); return; }
    if (!total.withData) { sec.append(h('p', {}, `None of these activities has ${noun} data, so there is nothing to show.`)); return; }
    sec.append(h('div', { class: 'card' }, zoneRows(zones, total.seconds, stream === 'hr' ? 'bpm' : 'W'),
      h('p', { class: 'small' }, `All time, from ${total.withData} of ${plural(total.count, 'activity', 'activities')} (the others have no ${noun} data).`)));
    append(sec, [h('div', { class: 'card' }, zoneTable('Year', zones, zonesBy(acts, stream, zones, 'year', state.tz), noun, { id: `${stream}-year`, kind: 'year' })), drill(`${stream}-year`, acts)]);
    const months = monthRows(zonesBy(acts, stream, zones, 'month', state.tz), acts);
    sec.append(h('details', { open: state.pick?.table === `${stream}-month` }, h('summary', {}, 'By month'), h('div', { class: 'row' }, yearTabs(acts, `Year shown in the ${noun} month table`)),
      h('div', { class: state.monthYear === 'all' ? 'card scroll' : 'card' }, zoneTable('Month', zones, months, noun, { id: `${stream}-month`, kind: 'month' })), drill(`${stream}-month`, acts)));
  };
  block('hr', hz, 'heart-rate', 'No heart-rate data found in this export.');
  block('power', pz, 'power', 'Enter your FTP above to see power zones (only activities with a power stream are counted).');
  return sec;
}

// ---------- loops ----------

const clusterCache = new Map<string, RouteCluster[]>();
let clusterOwner: unknown = null;
/** Route clusters for one sport (or all), cached until a new export is loaded. */
function clustersFor(all: Activity[], sport: string): RouteCluster[] {
  if (clusterOwner !== state.result) { clusterCache.clear(); clusterOwner = state.result; }
  let v = clusterCache.get(sport);
  if (!v) { v = clusterRoutes(filterSport(all, sport)); clusterCache.set(sport, v); }
  return v;
}

function loopsSection(): HTMLElement {
  const sec = h('div', {}, h('h2', { id: 'loops' }, 'Most repeated routes'),
    h('p', {}, 'A heuristic: GPS tracks of similar length that stay within about 80 m of each other on average are grouped, in either direction. Close calls can land on either side. Select a route to list every activity on it.'));
  const all = state.result!.activities;
  const clusters = clustersFor(all, state.sport).slice(0, 12);
  if (!clusters.length) { sec.append(h('p', {}, 'No repeated routes found (needs at least two GPS activities that follow the same path).')); return sec; }
  const u = state.units;
  const tiles = tileSource(state.mapTiles);
  const card = (c: RouteCluster) => {
    const key = String(c.id);
    const on = selectedIn('loops') === key;
    const title = `Route done ${c.count} times (${dist(c.avgDistanceM)} ${distanceUnit(u)})`;
    const open = () => { state.pick = on ? null : { table: 'loops', key, title, sel: { kind: 'ids', value: c.activityIds } }; render(); };
    return h('div', { class: on ? 'loop selected' : 'loop' }, routeMap(c.preview, { tiles, size: 192, label: `Route done ${c.count} times` }),
      h('div', { class: 'loop-text' },
        h('dl', {},
          h('dt', {}, 'Times done'), h('dd', {}, String(c.count)),
          h('dt', {}, 'Distance'), h('dd', {}, `${dist(c.avgDistanceM)} ${distanceUnit(u)}`),
          h('dt', {}, 'Avg time'), h('dd', {}, formatDuration(c.avgMovingS)),
          h('dt', {}, 'Best time'), h('dd', {}, formatDuration(c.bestMovingS))),
        h('button', { class: 'link stretch small', 'data-key': `loops:${key}`, 'aria-expanded': String(on), 'aria-label': `${on ? 'Hide' : 'Show'} the ${c.count} activities on this route (${dist(c.avgDistanceM)} ${distanceUnit(u)})`, onclick: open }, on ? 'Hide activities' : 'Show activities')));
  };
  append(sec, [h('div', { class: 'loops' }, ...clusters.map(card)), tiles ? attribution(tiles) : null, drill('loops', all)]);
  return sec;
}

// ---------- activities ----------

const SORTS: Record<State['sortKey'], [string, (a: Activity) => number]> = {
  date: ['Date (newest first)', (a) => a.startMs],
  distance: ['Distance', (a) => a.distanceM],
  time: ['Moving time', (a) => a.movingS],
  elevation: ['Elevation gain', (a) => a.elevGainM],
  speed: ['Average speed', (a) => (a.movingS > 0 ? a.distanceM / a.movingS : 0)],
};

function activitiesSection(acts: Activity[], hz: Zone[] | null): HTMLElement {
  const u = state.units;
  const holder = h('div', { class: 'card scroll' });
  const status = h('p', { class: 'muted', role: 'status' });
  const moreBtn = h('button', { onclick: () => { state.showAll = true; fill(); } }, '');
  const t = thresholds();
  const showLoad = !!(t.ftp || t.lthr);
  const head = ['Date', 'Name', 'Sport', `Distance (${distanceUnit(u)})`, 'Time', `Elev (${elevationUnit(u)})`, 'Avg HR', 'Avg W', ...(showLoad ? ['TSS'] : []), ...(hz ? ['HR zones'] : [])];
  // Only the table is rebuilt while typing, so the search box keeps focus and caret.
  const fill = () => {
    const q = state.query.trim().toLowerCase();
    const key = SORTS[state.sortKey][1];
    const matches = acts
      .filter((a) => !q || `${a.name} ${a.sport} ${dateOf(a.startMs)}`.toLowerCase().includes(q))
      .sort((a, b) => key(b) - key(a));
    const shown = state.showAll ? matches : matches.slice(0, 100);
    const rows = shown.map((a) => {
      const z = hz ? activityZones(a, 'hr', hz) : null;
      const l = showLoad ? activityLoad(a, t) : null;
      const cells = [dateOf(a.startMs), h('button', { class: 'link name', title: a.name, onclick: () => openActivity(a.id) }, a.name), a.sport, dist(a.distanceM), formatDuration(a.movingS), elev(a.elevGainM), opt(a.avgHr), opt(a.avgPower),
        ...(showLoad ? [l ? `${fmt(l.tss, 0)}${l.source === 'hr' ? '*' : ''}` : dash] : []), ...(hz ? [z ? zoneBar(z, hz) : dash] : [])];
      return { cells, key: a.id };
    });
    // The row of the activity opened last stays shaded, so you can see where you were.
    holder.replaceChildren(rows.length ? table(head, rows, { numFrom: 3, selected: state.activityId }) : h('p', {}, 'No activities match your search.'));
    status.textContent = `Showing ${shown.length} of ${matches.length}${q ? ' matching' : ''} activities. Select a row to see its details.${showLoad ? ' TSS marked * is estimated from heart rate.' : ''}`;
    moreBtn.textContent = `Show all ${matches.length}`;
    moreBtn.hidden = shown.length >= matches.length;
  };
  fill();
  const search = h('input', { type: 'search', id: 'activity-search', placeholder: 'Search name, sport or date', value: state.query, 'aria-label': 'Search activities', oninput: (e) => { state.query = (e.target as HTMLInputElement).value; state.showAll = false; fill(); } });
  const sort = h('label', {}, 'Sort by', h('select', { onchange: (e) => { state.sortKey = (e.target as HTMLSelectElement).value as State['sortKey']; fill(); } },
    ...(Object.entries(SORTS) as [State['sortKey'], [string, unknown]][]).map(([k, [t]]) => h('option', { value: k, selected: k === state.sortKey }, t))));
  return h('div', {}, h('h2', { id: 'activities' }, 'Activities'), h('div', { class: 'row card controls' }, search, sort), status, holder, h('p', {}, moreBtn));
}

// ---------- history ----------

type View = State['view'];
/**
 * What a browser history entry shows. Every view change pushes an entry, so Back and Forward move between
 * Stats, Posters and activities; the poster viewer pushes one too, so Back closes it. `depth` counts stacked
 * activity entries (opening the next activity from an activity), `scroll` is where the page was when left.
 */
interface NavEntry { view: View; activity?: string; depth?: number; lightbox?: true; scroll?: number }
/** In-page anchors (#records …) create entries without state: those belong to the stats page. */
const navEntry = (): NavEntry => (history.state as NavEntry | null) ?? { view: 'stats' };

/** Remember the scroll position in the current entry, then add a new one on top. */
function pushNav(entry: NavEntry, hash: string): void {
  history.replaceState({ ...navEntry(), scroll: window.scrollY }, '');
  history.pushState(entry, '', hash);
}

/** Show what an entry describes. */
function showEntry(entry: NavEntry): void {
  state.view = entry.view === 'activity' && !entry.activity ? 'stats' : entry.view;
  if (entry.activity) state.activityId = entry.activity;
  state.sheet = false;
  animate = true;
  render();
  window.scrollTo(0, entry.scroll ?? 0);
}

function setView(v: 'stats' | 'posters'): void {
  if (state.view === v) { state.sheet = false; render(); window.scrollTo(0, 0); return; }
  const entry: NavEntry = { view: v };
  pushNav(entry, `#${v}`);
  showEntry(entry);
}

function openActivity(id: string): void {
  const cur = navEntry();
  const entry: NavEntry = { view: 'activity', activity: id, depth: cur.view === 'activity' ? (cur.depth ?? 1) + 1 : 1 };
  pushNav(entry, '#activity');
  showEntry(entry);
}

/** Leave the activity view for the page it was opened from (going back past stacked activities). */
function closeActivity(): void {
  const depth = navEntry().depth ?? 0;
  if (depth > 0) history.go(-depth); // the popstate handler shows the page
  else showEntry({ view: 'stats' });
}

window.addEventListener('popstate', (e) => {
  if (!state.result) return;
  const entry = (e.state as NavEntry | null) ?? { view: 'stats' };
  // Same page as now (the poster viewer closed, or an in-page anchor): nothing to re-render.
  if (entry.view === state.view && (entry.view !== 'activity' || entry.activity === state.activityId)) return;
  showEntry(entry);
});

// ---------- export / issues ----------

function exportSection(acts: Activity[], hz: Zone[] | null, pz: Zone[] | null): HTMLElement {
  const o: ExportOptions = { units: state.units, tz: state.tz, hrZones: hz, powerZones: pz, thresholds: thresholds() };
  const sport = state.sport;
  const btn = (label: string, what: string, ext: string, make: () => string, mime: string) =>
    h('button', { onclick: () => download(exportFilename(acts, sport, what, ext, state.tz), make(), mime) }, label);
  const csv = 'text/csv;charset=utf-8';
  return h('div', {}, h('h2', { id: 'export' }, 'Export'),
    h('p', {}, 'Files follow the current sport filter, units and time zone. Text that could be run as a spreadsheet formula is prefixed with an apostrophe.'),
    h('div', { class: 'row' },
      btn('Activities CSV', 'activities', 'csv', () => activitiesCsv(acts, o), csv),
      btn('Monthly CSV', 'monthly', 'csv', () => periodCsv(acts, 'month', o), csv),
      btn('Yearly CSV', 'yearly', 'csv', () => periodCsv(acts, 'year', o), csv),
      btn('Sports CSV', 'sports', 'csv', () => sportCsv(acts, o), csv),
      btn('Zones CSV', 'zones', 'csv', () => zonesCsv(acts, o), csv),
      btn('Everything (JSON)', 'stats', 'json', () => statsJson(acts, o), 'application/json')));
}

function issuesSection(r: ImportResult): HTMLElement {
  const list = (items: { subject: string; reason: string }[]) =>
    h('div', { class: 'card scroll' }, table(['Item', 'Reason'], items.map((i) => [i.subject, i.reason]), { numFrom: 99 }));
  const sec = h('div', {}, h('h2', { id: 'issues' }, 'Import report'),
    h('p', {}, `${r.activities.length} activities loaded, ${r.skipped.length} skipped, ${r.warnings.length} loaded without track data.`));
  append(sec, r.notes.map((n) => h('p', {}, n)));
  if (r.skipped.length) sec.append(h('details', {}, h('summary', {}, `${r.skipped.length} activities skipped`), list(r.skipped)));
  if (r.warnings.length) sec.append(h('details', {}, h('summary', {}, `${r.warnings.length} activities without track data (summary numbers from the CSV are still counted)`), list(r.warnings)));
  return sec;
}

// A file dropped outside the drop zone must not navigate the tab away to the file.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  if (!worker && !state.result && e.dataTransfer && !(e.target as Element | null)?.closest?.('.drop')) importFiles(await fromDrop(e.dataTransfer));
});

renderImport();
