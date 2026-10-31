import './style.css';
import { append, download, h, table, type Row } from './dom';
import { activityPanel } from './activitylist';
import { TILE_SOURCES, attribution, defaultTileSource, referrerAvailable, routeMap, tileSource } from './map';
import { activityView } from './detail';
import { ZONE_COLORS, zoneRows } from './zonerows';
import { barChart, chartBox, chartView, resetChartViews, setChartView, xyChart, type Bar, type XYSeries } from './charts';
import { activityLoad, bestEffortsBySport, bestHrCurve, bestPaceCurve, bestPowerCurve, criticalPower, distanceName, durationName, eddington, efficiencyFactor, estimateFtp, estimateThresholdPace, formLabel, lthrOf, peaksBy, rampRate, trainingLoad, type CurvePoint, type ThresholdChange, type Thresholds } from './stats/training';
import { dash, fmt, opt, plural } from './format';
import { fromDrop, fromFileList } from './input';
import { CURVE_DURATIONS } from './parse/track';
import { activitiesCsv, exportFilename, periodCsv, sportCsv, statsJson, zonesCsv, type ExportOptions } from './export';
import type { RawInput } from './parse/archive';
import { clusterRoutes, type RouteCluster } from './stats/routes';
import { byPeriod, byWeekday, bySport, filterSport, records, sportsOf, summarize, type Summary } from './stats/summary';
import { selectActivities, type Selection } from './stats/select';
import { findRegions, regionFilter, type Region, type RegionChoice } from './stats/regions';
import { TRAINING_KEY, decodeTraining, encodeTraining } from './settings';
import { RUN_LIKE, activityZones, hrZones, observedMaxHr, paceZones, powerZones, zoneTotals, zonesBy, type HrZoneConfig, type Zone, type ZoneRow } from './stats/zones';
import type { Activity, ImportResult, Tz, Units } from './types';
import { distance, distanceUnit, elevation, elevationUnit, formatDuration, formatHours, speed, speedUnit } from './util/units';
import { dayNumber, fromDayNumber, isoWeekKey, monthKey, parts, weekStart, ymd } from './util/time';
import { DEFAULT_POSTER, POSTER_TYPES, SIZES, THEMES, renderPoster, type PosterOptions, type PosterType } from './posters';
import { IMAGE_KINDS, svgToImage, type ImageKind } from './posters/raster';
import { EXAMPLE_POSTERS } from './examples';
import { openWrapped } from './wrapped/player';
import { wrappedSeason, wrappedYears } from './wrapped/data';
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
  /** weeks shown by the weekly charts and the week table: 'recent' (last 26), 'YYYY-H1' / 'YYYY-H2', or 'all' */
  weekSpan: string;
  /** period of the zone summaries: 'all', 'recent' (last 12 months) or a year */
  zoneSpan: string;
  /** sidebar folded away (wide screens) */
  sideHidden: boolean;
  /** heart-rate stress model inputs, threshold pace (m/s), body weight (kg) */
  restHr: number | null;
  sex: 'm' | 'f';
  pace: number | null;
  weight: number | null;
  /** earlier threshold values, newest last */
  history: ThresholdChange[];
  /** month shown in the training calendar ('YYYY-MM'); null = latest */
  calMonth: string | null;
  /** a target for the current week, month or year */
  goal: { period: 'week' | 'month' | 'year'; metric: 'distance' | 'time' | 'elevation'; target: number } | null;
  /** which mean-maximal curve is shown, its sport (pace), and the point picked on it */
  curveKind: 'power' | 'hr' | 'pace';
  curveSport: string | null;
  curvePick: { kind: State['curveKind']; x: number } | null;
  /** heart-rate setting typed in by the user (not the max taken from the data), so it is worth remembering */
  hrByUser: boolean;
  /** keep thresholds and the goal in this browser ("Remember on this device") */
  remember: boolean;
}

const state: State = { result: null, sport: 'all', units: 'metric', tz: 'local', hr: null, ftp: null, showAll: false, view: 'stats', activityId: null, query: '', sortKey: 'date', theme: 'auto', sheet: false, monthYear: null, pick: null, mapTiles: defaultTileSource().id, volMetric: 'distance', weekSpan: 'recent', zoneSpan: 'all', sideHidden: false, restHr: null, sex: 'm', pace: null, weight: null, history: [], calMonth: null, goal: null, curveKind: 'power', curveSport: null, curvePick: null, hrByUser: false, remember: false };
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
// Thresholds and the goal, only if the user asked for them to be remembered.
try {
  const t = decodeTraining(localStorage.getItem(TRAINING_KEY));
  if (t) {
    Object.assign(state, { ftp: t.ftp, restHr: t.restHr, sex: t.sex, pace: t.pace, weight: t.weight, history: t.history, goal: t.goal, remember: true });
    if (t.hr) { state.hr = t.hr; state.hrByUser = true; }
  }
} catch { /* storage unavailable: nothing remembered */ }
let savedTraining: string | null = null;
/** Write the remembered settings when they changed (called on every render), or forget them when switched off. */
function saveTraining(): void {
  try {
    if (!state.remember) { if (savedTraining !== '') localStorage.removeItem(TRAINING_KEY); savedTraining = ''; return; }
    const text = encodeTraining({ hr: state.hrByUser ? state.hr : null, ftp: state.ftp, restHr: state.restHr, sex: state.sex, pace: state.pace, weight: state.weight, history: state.history, goal: state.goal });
    if (text !== savedTraining) { localStorage.setItem(TRAINING_KEY, text); savedTraining = text; }
  } catch { /* storage full or blocked: settings last until the tab closes */ }
}
/** The "Remember on this device" switch; shown with the thresholds and with the goal (one setting). */
function rememberToggle(): HTMLElement {
  return h('label', { class: 'remember small', title: 'Saves your thresholds, earlier thresholds and goal in this browser (never your activities). Turn off to delete them.' },
    h('input', { type: 'checkbox', checked: state.remember, onchange: (e) => { state.remember = (e.target as HTMLInputElement).checked; render(); } }),
    ' Remember on this device');
}
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
      if (!state.hrByUser) state.hr = null;
      state.monthYear = null;
      state.pick = null;
      state.showAll = false;
      state.calMonth = null;
      state.curvePick = null;
      state.weekSpan = 'recent';
      state.zoneSpan = 'all';
      resetChartViews();
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
    h('h2', { id: 'drop-title' }, 'Drop your Strava or Garmin export here'),
    h('p', {}, 'The ZIP file as you downloaded it, the extracted folder, or loose GPX, TCX and FIT files. Everything is processed in your browser; nothing is uploaded.'),
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
  const ext = (href: string, text: string) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const source = (id: string, title: string, sub: string, ...body: (Node | string)[]) =>
    h('details', { class: 'card source', id }, h('summary', {}, h('b', {}, title), h('span', { class: 'muted small' }, sub)), ...body);
  const sources = h('section', { 'aria-labelledby': 'get-title' },
    h('h2', { id: 'get-title' }, 'Get all your activities in one go'),
    h('p', {}, 'Both services give you every activity you ever recorded as one download. Pick yours for the exact steps.'),
    h('div', { class: 'sources' },
      source('from-strava', 'From Strava', 'Names, sports and every original file. Usually ready within a few hours.',
        h('ol', { class: 'steps' },
          h('li', {}, 'In a web browser (not the phone app), sign in at ', ext('https://www.strava.com/account', 'strava.com'), '.'),
          h('li', {}, 'Open the menu under your profile picture → ', h('b', {}, 'Settings'), ' → ', h('b', {}, 'My Account'), '.'),
          h('li', {}, 'Under ', h('b', {}, 'Download or Delete Your Account'), ' select ', h('b', {}, 'Get Started'), '.'),
          h('li', {}, 'In step 2, ', h('b', {}, 'Download Request'), ', select ', h('b', {}, 'Request Your Archive'), '. Do not continue to step 3: that one deletes your account.'),
          h('li', {}, 'Strava e-mails you a link when the archive is ready (often within a few hours, sometimes longer). Download the ZIP, named like ', h('code', {}, 'export_12345678.zip'), '.'),
          h('li', {}, 'Drop the ZIP on the box above, without unpacking it. Only ', h('code', {}, 'activities.csv'), ' and the files in ', h('code', {}, 'activities/'), ' are read.'))),
      source('from-garmin', 'From Garmin Connect', 'Every original FIT file, with laps. Can take a day or more.',
        h('ol', { class: 'steps' },
          h('li', {}, 'In a web browser, sign in to your Garmin account at ', ext('https://www.garmin.com/account/datamanagement/', 'garmin.com/account'), '.'),
          h('li', {}, 'Open ', h('b', {}, 'Data Management'), ' → ', h('b', {}, 'Export Your Data'), ', and select ', h('b', {}, 'Request Data Export'), '.'),
          h('li', {}, 'Garmin e-mails you a download link when the export is ready. This usually takes a day or two and can take longer for big accounts.'),
          h('li', {}, 'Download the ZIP and drop it on the box above as it is. The activities are the FIT files Garmin keeps in ', h('code', {}, 'DI_CONNECT/DI-Connect-Uploaded-Files'), ' (inside ', h('code', {}, 'UploadedFiles_…zip'), ' archives, which are opened for you). Health, sleep and profile data are skipped unread.'),
          h('li', {}, 'Garmin’s export has no activity names, so activities are named by time of day (“Morning Ride”). If your Garmin syncs to Strava, the Strava export has your own names.')),
        h('p', { class: 'small' }, 'Just one activity? In Garmin Connect open it, select the gear icon → ', h('b', {}, 'Export Original'), ', and drop the downloaded file here.'))));
  app.replaceChildren(hero(
    drop,
    sources,
    h('h2', {}, 'What you get'),
    h('ul', { class: 'features' },
      feature(`${POSTER_TYPES.length} printable posters`, 'Every route you rode, the metres you climbed, your years as rings, how far around the world you went. Download them as PNG or JPEG (A3 print size) or SVG.'),
      feature('Your stats, all of them', 'Totals by year, month, weekday and sport, records and streaks, time in heart-rate and power zones, and your most repeated routes.'),
      feature('Every activity in detail', 'Map, elevation, speed, heart rate and power charts with a shared hover readout and zoom, the laps from your device, and splits per kilometre.')),
    h('div', { class: 'examples', 'aria-label': 'Example posters made from the demo data' },
      ...EXAMPLE_POSTERS.map((ex) => h('figure', {},
        h('img', { class: 'poster', src: `examples/${ex.type}.svg`, alt: `Example: ${POSTER_TYPES.find((t) => t.id === ex.type)!.name} poster`, loading: 'lazy', width: 3508, height: 4961 }),
        h('figcaption', {}, ex.caption)))),
    h('h2', {}, 'How it works'),
    h('ol', { class: 'steps' },
      h('li', {}, 'You give it your Strava or Garmin export (or GPX, TCX and FIT files from any app or device).'),
      h('li', {}, 'Your browser reads the files in a background worker in this tab. There is no server to upload to, no account, no cookies and no tracking.'),
      h('li', {}, 'Stats and posters are worked out on your device. Closing or reloading the tab forgets your activities.')),
    h('h2', { id: 'privacy' }, 'Privacy and safety'),
    h('ul', { class: 'safety' },
      feature('What is read', 'Only activities.csv and the GPX, TCX and FIT activity files. The rest of an export (photos, messages, profile, contacts, Garmin health and sleep data) is skipped by name and never opened: from a ZIP, only the activity files are read, so a large export with photos loads quickly.'),
      feature('What is kept', 'Nothing from your files. Two settings are remembered in this browser: light or dark theme, and the map background. Your thresholds (FTP, heart rate, pace, weight) and goal are kept only if you tick “Remember on this device”, and are deleted when you untick it.'),
      feature('What goes over the network', 'Only map pictures for the activity maps, from OpenStreetMap or OpenTopoMap. Like any web map, that server sees your IP address and which map squares you look at, so roughly where the activity you opened was. Your files and stats are never sent. Set Map background to Off in the filters and the app makes no requests at all; the page’s security policy blocks every other connection.'),
      feature('Before you share a poster', 'Route posters leave out the first and last 200 m of every route by default, so your front door is not on them (adjustable with “Hide route ends”). A poster of many routes can still show your part of town. Other posters show no places.'),
      feature('Files from anyone else', 'Files are treated as data only: nothing in them is ever run, names are shown as plain text, and a file that would unpack to more than 256 MB is refused.')),
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
  return hrZones(state.hr, state.sport);
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
  saveTraining();
  if (!state.result) return renderImport();
  const { result } = state;
  const all = result.activities;
  const acts = filterSport(all, state.sport);
  const hz = currentHrZones(all);
  const pz = state.ftp ? powerZones(state.ftp) : null;


  const navBtn = (v: 'stats' | 'posters', label: string, badge?: string) => h('button', { 'aria-current': (state.view === v || (v === 'stats' && state.view === 'activity')) ? 'page' : undefined, onclick: () => setView(v) }, label, badge ? h('span', { class: 'badge', 'aria-label': `${badge} posters` }, badge) : null);
  const sections: [string, string][] = [['overview', 'Overview'], ['progress', 'Progress and goal'], ['calendar', 'Calendar'], ['records', 'Records'], ['periods', 'Years and months'], ['training', 'Training load'], ['zones', 'Time in zones'], ['curve', 'Curves and efforts'], ['loops', 'Routes'], ['activities', 'Activities'], ['export', 'Export'], ['issues', 'Import report']];
  const toggleSide = () => { state.sideHidden = !state.sideHidden; render(); (document.querySelector<HTMLElement>(state.sideHidden ? '.side-show' : '.side-hide'))?.focus(); };
  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Sidebar', id: 'sidebar' },
    h('div', { class: 'brand side-top' }, h('div', {}, h('h1', {}, 'Ride Atlas'), h('p', {}, 'Private, in your browser')),
      h('button', { class: 'side-hide', 'aria-label': 'Hide the sidebar', 'aria-controls': 'sidebar', 'aria-expanded': 'true', title: 'Hide the sidebar for more room', onclick: toggleSide }, '«')),
    h('nav', { class: 'nav', 'aria-label': 'Views' }, navBtn('stats', 'Stats'), navBtn('posters', 'Posters', String(POSTER_TYPES.length)),
      all.length ? h('button', { class: 'nav-wrapped', onclick: () => startWrapped(acts) }, 'Sport Wrapped') : null,
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
      h('div', { class: `layout${state.sheet ? ' sheet-open' : ''}${state.sideHidden ? ' side-hidden' : ''}` }, sidebar, main),
      ...(state.sideHidden ? [h('button', { class: 'side-show', 'aria-label': 'Show the sidebar', 'aria-controls': 'sidebar', 'aria-expanded': 'false', onclick: toggleSide }, '» Menu')] : []),
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
        units: state.units, tz: state.tz, hzFor: (sp) => (hz && state.hr ? hrZones(state.hr, sp) : null), pz, paceZ: state.pace ? paceZones(state.pace) : null, all, thresholds: thresholds(),
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

  const season = wrappedSeason(new Date());
  if (acts.length && season !== null) main.append(wrappedPromo(acts, season));
  if (acts.length) main.append(posterPromo(acts, () => setView('posters')));
  main.append(h('h2', { id: 'overview' }, 'Overview'));
  if (!acts.length) {
    main.append(h('div', { class: 'card empty' }, h('h2', {}, 'Nothing here'), h('p', {}, 'There are no activities for this sport. Pick another sport in the filters.')));
  } else {
    const s = summarize(acts);
    main.append(statGrid(s, acts));
    // Order: how much and when (volume, calendar, highlights, tables), then how hard (load, zones,
    // curves, which share the thresholds), then where (routes) and the full list.
    main.append(progressSection(acts));
    main.append(calendarSection(acts, thresholds()));
    main.append(recordsSection(acts));
    const add = (...els: (Node | null)[]) => append(main, els);
    if (state.sport === 'all') {
      add(h('h2', { id: 'periods' }, 'By sport'), h('div', { class: 'card' }, summaryTable('Sport', 'sport', bySport(all).map((x) => ({ label: x.sport, s: x.summary, key: x.sport, sel: { kind: 'sport', value: x.sport } })))), drill('sport', all));
    }
    const yearRows = byPeriod(acts, 'year', state.tz);
    add(h('h2', { id: state.sport === 'all' ? undefined : 'periods' }, 'By year'), h('div', { class: 'card' }, summaryTable('Year', 'year', yearRows.map((r) => ({ label: r.key, s: r.summary, key: r.key, sel: { kind: 'year', value: r.key } })))), drill('year', acts));
    const months = monthRows(byPeriod(acts, 'month', state.tz), acts);
    add(h('div', { class: 'h2row' }, h('h2', {}, 'By month'), yearTabs(acts, 'Year shown in the month table')),
      monthBars(acts, months), h('div', { class: state.monthYear === 'all' ? 'card scroll' : 'card' }, summaryTable('Month', 'month', months.map((r) => ({ label: r.label, s: r.summary, key: r.key, sel: { kind: 'month', value: r.key }, title: monthTitle(r.key) })))), drill('month', acts));
    add(h('h2', {}, 'By weekday'), h('div', { class: 'card' }, summaryTable('Weekday', 'weekday', byWeekday(acts, state.tz).map((r) => ({ label: r.label, s: r.summary, key: String(r.weekday), sel: { kind: 'weekday', value: String(r.weekday) }, title: `Every ${WEEKDAY_NAMES[r.weekday]}` })))), drill('weekday', acts));
    const spanKeys = new Set(weeksOf(acts, curSpan(acts)).map(weekKeyOf));
    const weekStartOf = (start: string) => dayNumber({ y: Number(start.slice(0, 4)), m: Number(start.slice(5, 7)), d: Number(start.slice(8, 10)), wd: 0 });
    add(h('details', { open: state.pick?.table === 'week' }, h('summary', {}, 'By week'),
      h('div', { class: 'row' }, weekSpanControl(acts, 'Weeks shown in the week table')),
      h('div', { class: 'card scroll' }, summaryTable('Week', 'week', byPeriod(acts, 'week', state.tz).filter((r) => spanKeys.has(r.key)).map((r): SummaryRow => ({ label: `${r.key.slice(5)} · ${weekRange(weekStartOf(r.start))}`, s: r.summary, key: r.key, sel: { kind: 'week', value: r.key }, title: `Week ${weekRange(weekStartOf(r.start))}` })).reverse())), drill('week', acts)));
    main.append(trainingSection(all, acts));
    main.append(zonesSection(all, acts, hz, pz));
    main.append(curveSection(acts));
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
  const edd = eddington(acts.filter((a) => a.distanceM > 0), u === 'metric' ? 1000 : 1609.344, (a) => dayNumber(parts(a.startMs, state.tz)));
  if (edd.e > 0) rows.push(['Eddington number', String(edd.e), `${edd.e} days of at least ${edd.e} ${distanceUnit(u)}; ${plural(edd.next, 'more day')} of ${edd.e + 1}+ ${distanceUnit(u)} for ${edd.e + 1}`]);
  return h('div', {}, h('div', { class: 'h2row', id: 'records' }, h('h2', {}, 'Records'),
    h('button', { id: 'open-wrapped', class: 'wrapped-link', onclick: () => startWrapped(acts) }, 'Your year as a story')),
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


// ---------- week spans ----------

/** Weeks (Monday day numbers) of a span: the last 26 weeks, one half-year, or everything. */
function weeksOf(acts: Activity[], span: string): number[] {
  if (!acts.length) return [];
  const days = acts.map((a) => weekStart(parts(a.startMs, state.tz)));
  const first = Math.min(...days), last = Math.max(...days);
  let a = first, b = last;
  const m = /^(\d{4})-H([12])$/.exec(span);
  if (m) {
    const y = Number(m[1]), h1 = m[2] === '1';
    a = weekStart(fromDayNumber(dayNumber({ y, m: h1 ? 1 : 7, d: 1, wd: 0 })));
    b = weekStart(fromDayNumber(dayNumber({ y, m: h1 ? 6 : 12, d: h1 ? 30 : 31, wd: 0 })));
  } else if (span !== 'all') a = Math.max(first, last - 25 * 7);
  const out: number[] = [];
  for (let d = a; d <= b; d += 7) out.push(d);
  return out;
}

/** The span choices: last 26 weeks, each half-year with activities (newest first), all. */
function weekSpanOptions(acts: Activity[]): [string, string][] {
  const halves = new Set<string>();
  for (const a of acts) { const p = parts(a.startMs, state.tz); halves.add(`${p.y}-H${p.m <= 6 ? 1 : 2}`); }
  return [['recent', 'Last 26 weeks'], ...[...halves].sort().reverse().map((k): [string, string] => [k, `${k.slice(0, 4)} ${k.endsWith('1') ? 'Jan – Jun' : 'Jul – Dec'}`]), ['all', 'All weeks']];
}

const curSpan = (acts: Activity[]) => (weekSpanOptions(acts).some(([k]) => k === state.weekSpan) ? state.weekSpan : 'recent');

/** ‹ span › picker shared by every weekly chart and the week table. */
function weekSpanControl(acts: Activity[], label: string): HTMLElement {
  const opts = weekSpanOptions(acts);
  const cur = curSpan(acts);
  const i = opts.findIndex(([k]) => k === cur);
  const go = (k: number) => { state.weekSpan = opts[k]![0]; render(); };
  return h('div', { class: 'span-pick', role: 'group', 'aria-label': label },
    h('button', { 'aria-label': 'Earlier weeks', disabled: i >= opts.length - 2, onclick: () => go(i + 1) }, '‹'),
    h('select', { 'aria-label': label, onchange: (e) => { state.weekSpan = (e.target as HTMLSelectElement).value; render(); } }, ...opts.map(([k, t]) => h('option', { value: k, selected: k === cur }, t))),
    h('button', { 'aria-label': 'Later weeks', disabled: i <= 0 || cur === 'all', onclick: () => go(i === 1 ? 0 : i - 1) }, '›'));
}

const weekLabel = (d: number) => { const p = fromDayNumber(d); return `${p.d} ${MONTH_NAMES[p.m - 1]}`; };
const weekRange = (d: number) => { const a = fromDayNumber(d), b = fromDayNumber(d + 6); return `${a.d} ${MONTH_NAMES[a.m - 1]}${a.y !== b.y ? ` ${a.y}` : ''} – ${b.d} ${MONTH_NAMES[b.m - 1]} ${b.y}`; };
const weekKeyOf = (d: number) => isoWeekKey(fromDayNumber(d));

/** Activities grouped by the Monday of their week. */
function byWeekStart(acts: Activity[]): Map<number, Activity[]> {
  const m = new Map<number, Activity[]>();
  for (const a of acts) { const d = weekStart(parts(a.startMs, state.tz)); (m.get(d) ?? m.set(d, []).get(d)!).push(a); }
  return m;
}

/** Adaptive date ticks (day numbers) for a visible range: weeks, months, quarters or years. */
function dayTicks(lo: number, hi: number): number[] {
  const span = hi - lo, out: number[] = [];
  if (span <= 120) {
    const every = Math.max(1, Math.ceil(span / 7 / 8));
    let k = 0;
    for (let d = weekStart(fromDayNumber(Math.ceil(lo))); d <= hi; d += 7) if (d >= lo && k++ % every === 0) out.push(d);
    return out;
  }
  const months = span <= 400 ? 1 : span <= 1100 ? 3 : 12;
  const p = fromDayNumber(Math.floor(lo));
  for (let y = p.y, m = p.m; ; ) {
    const d = dayNumber({ y, m, d: 1, wd: 0 });
    if (d > hi) break;
    if (d >= lo && (m - 1) % months === 0) out.push(d);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
const dayTick = (d: number) => { const p = fromDayNumber(d); return p.d !== 1 ? `${p.d} ${MONTH_NAMES[p.m - 1]}` : p.m === 1 ? String(p.y) : MONTH_NAMES[p.m - 1]!; };

/** Year-to-date lines (one per year, the latest highlighted) and weekly bars, like Strava's progress charts. */
function progressSection(acts: Activity[]): HTMLElement {
  const m = VOL[state.volMetric];
  const u = m.unit();
  const years = yearsOf(acts).slice(0, 6);
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
  const doyLabel = (d: number) => { const dt = new Date(Date.UTC(2001, 0, d)); return `${dt.getUTCDate()} ${MONTH_NAMES[dt.getUTCMonth()]}`; };
  const doyTicks = (lo: number, hi: number) => { const ms = MONTH_START_DOY.filter((d) => d >= lo && d <= hi); return hi - lo > 200 ? ms.filter((_, i) => i % 2 === 0) : ms.length >= 3 ? ms : [lo, (lo + hi) / 2, hi].map(Math.round); };
  const ytd = h('figure', { class: 'card chart-card' },
    h('div', { class: 'chart-head' }, h('h3', {}, `${m.name} year to date (${u})`)),
    chartBox({ key: `ytd-${state.volMetric}`, series, hidden: years.slice(3).map(String), label: `Cumulative ${m.name.toLowerCase()} per year`, xTicks: doyTicks, fmtX: (d) => (MONTH_START_DOY.includes(d) ? MONTH_NAMES[MONTH_START_DOY.indexOf(d)]! : doyLabel(d)), tipX: (d) => `Up to ${doyLabel(d)}`, fmtY: (v) => `${m.fmt(v)}`, yZero: true }));

  const span = curSpan(acts);
  const weeks = weeksOf(acts, span);
  const grouped = byWeekStart(acts);
  const val = (d: number) => (grouped.get(d) ?? []).reduce((x, a) => x + m.raw(a), 0);
  const bars: Bar[] = weeks.map((d) => {
    const w = grouped.get(d) ?? [];
    const key = weekKeyOf(d);
    const dsum = w.reduce((x, a) => x + a.distanceM, 0), tsum = w.reduce((x, a) => x + a.movingS, 0);
    return {
      label: weekLabel(d), value: val(d),
      tip: [weekRange(d), `${m.fmt(val(d))} ${u}`, w.length ? `${plural(w.length, 'activity', 'activities')} · ${dist(dsum)} ${distanceUnit(state.units)} · ${formatHours(tsum)}` : 'Rest week'],
      selected: selectedIn('weeks') === key,
      onClick: w.length ? () => { state.pick = selectedIn('weeks') === key ? null : { table: 'weeks', key, title: `Week ${weekRange(d)}`, sel: { kind: 'week', value: key } }; render(); } : undefined,
    };
  });
  const vals = weeks.map(val);
  const total = vals.reduce((a, b) => a + b, 0);
  const note = span === 'recent' && vals.length > 1
    ? `Last week of the data: ${m.fmt(vals[vals.length - 1]!)} ${u} · 4-week average before it: ${m.fmt(vals.slice(-5, -1).reduce((a, b) => a + b, 0) / Math.max(1, vals.slice(-5, -1).length))} ${u}`
    : `${m.fmt(total)} ${u} in ${weeks.length} weeks · ${m.fmt(total / Math.max(1, weeks.length))} ${u} a week on average`;
  const weekly = h('figure', { class: 'card chart-card' },
    h('div', { class: 'chart-head' }, h('h3', {}, `${m.name} per week (${u})`), weekSpanControl(acts, 'Weeks shown')),
    h('p', { class: 'muted small' }, note),
    barChart({ bars, label: `${m.name} per week. Select a bar to list its activities`, fmtY: m.fmt, labelEvery: Math.max(1, Math.ceil(weeks.length / 9)) }));
  return h('div', {},
    h('h2', { id: 'progress' }, 'Progress'),
    goalCard(acts),
    h('div', { class: 'row measure-row' }, h('span', { class: 'muted small' }, 'Charts show'), metricTabs('Measure shown in the progress charts')),
    h('div', { class: 'charts' }, ytd, weekly), drill('weeks', acts));
}

// ---------- goals ----------

/** A distance, time or climbing target for the current week, month or year, with a progress bar. */
function goalCard(acts: Activity[]): HTMLElement {
  const g = state.goal;
  const periodSel = h('select', { 'aria-label': 'Goal period' }, ...(['week', 'month', 'year'] as const).map((p) => h('option', { value: p, selected: g?.period === p }, `This ${p}`)));
  const metricSel = h('select', { 'aria-label': 'Goal measure' }, ...(['distance', 'time', 'elevation'] as const).map((k) => h('option', { value: k, selected: (g?.metric ?? 'distance') === k }, VOL[k].name)));
  const targetIn = h('input', { type: 'number', min: 1, step: 'any', value: g?.target ?? '', placeholder: 'target', 'aria-label': 'Goal target' });
  const form = h('form', { class: 'row', 'aria-label': 'Set a goal', onsubmit: (e) => {
    e.preventDefault();
    const t = Number(targetIn.value);
    state.goal = t > 0 ? { period: periodSel.value as 'week', metric: metricSel.value as 'distance', target: t } : null;
    render();
  } }, h('b', {}, 'Goal'), periodSel, metricSel, targetIn, h('span', { class: 'muted small' }, g ? VOL[g.metric].unit() : ''), h('button', { type: 'submit' }, g ? 'Update' : 'Set'),
    g ? h('button', { type: 'button', class: 'link', onclick: () => { state.goal = null; render(); } }, 'Clear') : null);
  const card = h('div', { class: 'card goal' }, form);
  form.append(rememberToggle());
  if (!g) { card.append(h('p', { class: 'muted small' }, `Set a target for this week, month or year (as of your last activity). ${state.remember ? 'It is saved in this browser.' : 'It is kept until you close the tab, unless you tick Remember on this device.'}`)); return card; }
  const m = VOL[g.metric];
  const lp = parts(Math.max(...acts.map((a) => a.startMs)), state.tz);
  const today = dayNumber(lp);
  const start = g.period === 'week' ? weekStart(lp) : g.period === 'month' ? dayNumber({ ...lp, d: 1 }) : dayNumber({ y: lp.y, m: 1, d: 1, wd: 0 });
  const end = g.period === 'week' ? start + 7 : g.period === 'month' ? dayNumber(lp.m === 12 ? { y: lp.y + 1, m: 1, d: 1, wd: 0 } : { y: lp.y, m: lp.m + 1, d: 1, wd: 0 }) : dayNumber({ y: lp.y + 1, m: 1, d: 1, wd: 0 });
  const done = acts.filter((a) => { const d = dayNumber(parts(a.startMs, state.tz)); return d >= start && d < end; }).reduce((x, a) => x + m.raw(a), 0);
  const elapsed = (today - start + 1) / (end - start);
  const frac = Math.min(1, done / g.target);
  const bar = h('div', { class: 'goal-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': g.target, 'aria-valuenow': Math.round(done), 'aria-label': `Goal progress` }, h('i', {}), h('b', { class: 'goal-mark', title: 'Where you would be on an even pace' }));
  (bar.firstChild as HTMLElement).style.setProperty('--w', `${frac * 100}%`);
  (bar.lastChild as HTMLElement).style.setProperty('--x', `${Math.min(1, elapsed) * 100}%`);
  const ahead = done - g.target * elapsed;
  card.append(bar, h('p', { class: 'small' }, `${m.fmt(done)} of ${m.fmt(g.target)} ${m.unit()} (${fmt(frac * 100, 0)} %) · ${fmt(elapsed * 100, 0)} % of the ${g.period} gone · ${done >= g.target ? 'Done!' : ahead >= 0 ? `${m.fmt(ahead)} ${m.unit()} ahead of an even pace` : `${m.fmt(-ahead)} ${m.unit()} behind an even pace; ${m.fmt((g.target - done) / Math.max(1, end - today - 1))} ${m.unit()} a day to finish`}`));
  return card;
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

/** Distance of one pace unit (km or mile) in metres. */
const paceUnitM = () => (state.units === 'metric' ? 1000 : 1609.344);
/** "4:30" (per km or mile) from a speed in m/s. */
const paceOf = (mps: number) => formatDuration(paceUnitM() / mps);
/** Speed (m/s) from "4:30" or "4:30:00"-style text per km/mile; null if unreadable. */
function parsePace(text: string): number | null {
  const m = /^\s*(\d{1,2}):([0-5]\d)\s*$/.exec(text);
  if (!m) return null;
  const secs = Number(m[1]) * 60 + Number(m[2]);
  return secs >= 120 && secs <= 1200 ? paceUnitM() / secs : null;
}

const thresholds = (): Thresholds => {
  const all = state.result?.activities ?? [];
  return {
    ftp: state.ftp, lthr: lthrOf(state.hr), pace: state.pace,
    maxHr: state.hr?.mode === 'maxHr' ? state.hr.value : observedMaxHr(all),
    restHr: state.restHr, trimpK: state.sex === 'f' ? 1.67 : 1.92, history: state.history,
  };
};

/** Heart-rate, FTP, pace and weight settings, shared by zones, training load and the activity pages. */
function thresholdForm(all: Activity[]): HTMLElement {
  const num = (attrs: Record<string, string | number>, value: number | null | undefined, label: string) =>
    h('input', { type: 'number', ...attrs, value: value ?? '', 'aria-label': label });
  const hrIn = num({ min: 100, max: 230 }, state.hr?.value, 'Heart-rate value in bpm');
  const modeSel = h('select', { 'aria-label': 'Zone basis' },
    h('option', { value: 'maxHr', selected: state.hr?.mode === 'maxHr' }, 'Max HR'),
    h('option', { value: 'lthr', selected: state.hr?.mode === 'lthr' }, 'Threshold HR'));
  const restIn = num({ min: 30, max: 100, placeholder: '60' }, state.restHr, 'Resting heart rate in bpm');
  const sexSel = h('select', { 'aria-label': 'Heart-rate model' },
    h('option', { value: 'm', selected: state.sex === 'm' }, 'Male'), h('option', { value: 'f', selected: state.sex === 'f' }, 'Female'));
  const ftpIn = num({ min: 50, max: 600, placeholder: 'e.g. 250' }, state.ftp, 'FTP in watts');
  const paceIn = h('input', { type: 'text', inputmode: 'numeric', size: 5, placeholder: '4:30', value: state.pace ? paceOf(state.pace) : '', 'aria-label': `Threshold pace in minutes per ${distanceUnit(state.units)}` });
  const kgIn = num({ min: 30, max: 200, step: 0.1, placeholder: 'kg' }, state.weight, 'Body weight in kg');
  const msg = h('p', { class: 'small warn', role: 'status' });
  const form = h('form', { class: 'card thresholds', 'aria-label': 'Your thresholds', onsubmit: (e) => {
    e.preventDefault();
    const v = Number(hrIn.value);
    if (v >= 100 && v <= 230) {
      const next = { mode: modeSel.value as HrZoneConfig['mode'], value: v };
      if (state.hrByUser || next.mode !== state.hr?.mode || next.value !== state.hr?.value) state.hrByUser = true;
      state.hr = next;
    }
    const f = Number(ftpIn.value);
    state.ftp = f >= 50 && f <= 600 ? f : null;
    const r = Number(restIn.value);
    state.restHr = r >= 30 && r <= 100 ? r : null;
    state.sex = sexSel.value === 'f' ? 'f' : 'm';
    const k = Number(kgIn.value);
    state.weight = k >= 30 && k <= 200 ? k : null;
    if (paceIn.value.trim() && !parsePace(paceIn.value)) { msg.textContent = 'Write the threshold pace as minutes:seconds, e.g. 4:30.'; return; }
    state.pace = paceIn.value.trim() ? parsePace(paceIn.value) : null;
    render();
  } },
    h('div', { class: 'row' },
      h('label', {}, 'Heart rate from', modeSel, hrIn, 'bpm'),
      h('label', {}, 'Resting HR', restIn, 'bpm'),
      h('label', {}, 'HR model', sexSel)),
    h('div', { class: 'row' },
      h('label', {}, 'FTP', ftpIn, 'W'),
      h('label', {}, 'Threshold pace', paceIn, `/${distanceUnit(state.units)}`),
      h('label', {}, 'Weight', kgIn, 'kg'),
      h('button', { type: 'submit', class: 'primary' }, 'Apply')),
    h('div', { class: 'row' }, rememberToggle(), h('span', { class: 'muted small' }, state.remember ? 'Saved in this browser; turn off to delete.' : 'Kept until you close the tab.')), msg);
  const out = h('div', {}, form);
  const notes: (Node | string)[] = [];
  if (state.hr && observedMaxHr(all) === state.hr.value && state.hr.mode === 'maxHr') notes.push(`Max HR defaults to the highest value in your data (${state.hr.value} bpm). Set your own, or your threshold HR, for more accurate zones and load. `);
  const est = estimateFtp(bestPowerCurve(lastYear(all.filter((a) => a.powerCurve))));
  if (est && est !== state.ftp) notes.push(`Estimated FTP (95 % of your best 20 minutes, last 12 months): ${est} W. `, h('button', { type: 'button', class: 'link', onclick: () => { state.ftp = est; render(); } }, `Use ${est} W`), ' ');
  const runs = lastYear(all.filter((a) => RUN_LIKE.has(a.sport) && a.sport !== 'Walk' && a.paceCurve));
  const estPace = estimateThresholdPace(bestPaceCurve(runs));
  if (estPace && (!state.pace || Math.abs(estPace - state.pace) > 0.01)) notes.push(`Estimated threshold pace (your best 30 minutes running, last 12 months): ${paceOf(estPace)} /${distanceUnit(state.units)}. `, h('button', { type: 'button', class: 'link', onclick: () => { state.pace = estPace; render(); } }, `Use ${paceOf(estPace)}`));
  if (notes.length) out.append(h('p', { class: 'small' }, ...notes));
  out.append(historyForm());
  return out;
}

/** Earlier thresholds, so older activities are scored with the FTP, threshold HR and pace of their day. */
function historyForm(): HTMLElement {
  const rows = [...state.history].sort((a, b) => b.untilMs - a.untilMs);
  const dateIn = h('input', { type: 'date', 'aria-label': 'Until this date' });
  const ftpIn = h('input', { type: 'number', min: 50, max: 600, placeholder: 'W', 'aria-label': 'Earlier FTP in watts' });
  const hrIn = h('input', { type: 'number', min: 100, max: 230, placeholder: 'bpm', 'aria-label': 'Earlier threshold HR in bpm' });
  const paceIn = h('input', { type: 'text', size: 5, placeholder: '4:45', 'aria-label': `Earlier threshold pace per ${distanceUnit(state.units)}` });
  const add = h('form', { class: 'row', 'aria-label': 'Add an earlier threshold', onsubmit: (e) => {
    e.preventDefault();
    const ms = Date.parse(`${dateIn.value}T00:00:00Z`);
    if (!Number.isFinite(ms)) return;
    const f = Number(ftpIn.value), l = Number(hrIn.value), pc = parsePace(paceIn.value);
    const c: ThresholdChange = { untilMs: ms, ftp: f >= 50 && f <= 600 ? f : null, lthr: l >= 100 && l <= 230 ? l : null, pace: pc };
    if (!c.ftp && !c.lthr && !c.pace) return;
    state.history = [...state.history.filter((x) => x.untilMs !== ms), c];
    render();
  } }, h('label', {}, 'Before', dateIn), h('label', {}, 'FTP', ftpIn), h('label', {}, 'Threshold HR', hrIn), h('label', {}, 'Pace', paceIn), h('button', { type: 'submit' }, 'Add'));
  return h('details', { class: 'history', open: rows.length > 0 }, h('summary', {}, `Earlier thresholds${rows.length ? ` (${rows.length})` : ''}`),
    h('p', { class: 'small' }, 'Like TrainingPeaks, training stress uses the thresholds of each activity’s day. Add the values you had before a date; everything after the newest entry uses the ones above. Zones always use the current values.'),
    rows.length ? h('div', { class: 'card scroll' }, table(['Before', 'FTP', 'Threshold HR', 'Threshold pace', ''], rows.map((c) => [ymd(parts(c.untilMs, 'UTC')), c.ftp ? `${c.ftp} W` : dash, c.lthr ? `${c.lthr} bpm` : dash, c.pace ? `${paceOf(c.pace)} /${distanceUnit(state.units)}` : dash,
      h('button', { class: 'link', 'aria-label': `Remove the entry before ${ymd(parts(c.untilMs, 'UTC'))}`, onclick: () => { state.history = state.history.filter((x) => x !== c); render(); } }, 'Remove')]), { numCols: [1, 2, 3] })) : null,
    add);
}

/** Activities in the 365 days up to the last one. */
function lastYear(acts: Activity[]): Activity[] {
  if (!acts.length) return acts;
  const end = Math.max(...acts.map((a) => a.startMs));
  return acts.filter((a) => a.startMs > end - 365 * 86_400_000);
}

const dayLabel = (d: number) => { const p = fromDayNumber(d); return `${p.d} ${MONTH_NAMES[p.m - 1]} ${p.y}`; };

/** Sport colours (categorical series tokens c0…c5), stable per sport across charts. */
const sportClass = (sports: string[], sp: string) => `c${Math.max(0, sports.indexOf(sp)) % 6}`;

/** Estimated FTP, critical power, W′ and W/kg from the power curves: shown under fitness and fatigue. */
function powerTiles(acts: Activity[]): HTMLElement | null {
  const withPower = acts.filter((a) => a.powerCurve);
  if (!withPower.length) return null;
  const recent = bestPowerCurve(lastYear(withPower));
  const curve = recent.length ? recent : bestPowerCurve(withPower);
  const est = estimateFtp(curve), cp = criticalPower(curve);
  const tile = (v: string, l: string, help: string) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l), h('small', {}, help));
  const tiles = [
    est ? tile(`${est} W`, 'Estimated FTP', '95 % of your best 20 minutes (last 12 months).') : null,
    cp ? tile(`${cp.cp} W`, 'Critical power (CP)', 'From your best 3 to 20 minute efforts: the power you could hold for a long time. Usually a little above FTP.') : null,
    cp ? tile(`${fmt(cp.wPrime / 1000, 1)} kJ`, 'W′ (anaerobic capacity)', 'The energy you can spend above CP before you have to back off.') : null,
    state.weight && (state.ftp || est) ? tile(`${fmt((state.ftp ?? est!) / state.weight, 2)} W/kg`, 'FTP per kilogram', 'What decides how fast you climb.') : null,
  ].filter((x) => x);
  return tiles.length ? h('div', { class: 'grid power-tiles' }, ...tiles) : null;
}

function trainingSection(all: Activity[], acts: Activity[]): HTMLElement {
  const sec = h('div', {}, h('div', { class: 'h2row' }, h('h2', { id: 'training' }, 'Training load')), thresholdForm(all));
  const t = thresholds();
  if (!t.ftp && !t.lthr && !t.pace) {
    sec.append(h('p', {}, 'Set your FTP, heart rate or threshold pace above to see your training stress, fitness, fatigue and form.'), powerTiles(acts) ?? '');
    return sec;
  }
  const load = trainingLoad(acts, t, state.tz);
  if (!load.days.length) {
    sec.append(h('p', {}, 'None of these activities has power, pace or heart-rate data that can be scored, so there is no training stress to show.'), powerTiles(acts) ?? '');
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
      ramp !== null ? tile(`${ramp > 0 ? '+' : ''}${fmt(ramp, 1)}`, 'Fitness change, last 7 days', 'Ramp rate. More than about +8 a week is hard to sustain.') : null),
    powerTiles(acts) ?? '');

  // fitness by sport (each sport's own 42-day average), when more than one sport carries load
  const sports = sportsOf(acts);
  const bySport = sports.map((sp) => { const l = trainingLoad(acts.filter((a) => a.sport === sp), t, state.tz); const d = l.days[l.days.length - 1]; return { sp, ctl: d && d.day === last.day ? d.ctl : d ? d.ctl * Math.pow(41 / 42, last.day - d.day) : 0 }; }).filter((x) => x.ctl >= 0.5);
  if (bySport.length > 1) {
    sec.append(h('p', { class: 'small' }, 'Fitness by sport: ', ...bySport.flatMap((x, i) => [i ? ' · ' : '', h('span', { class: `sport-dot ${sportClass(sports, x.sp)}` }), ` ${x.sp} ${fmt(x.ctl, 0)}`])));
  }

  // performance management chart: everything is drawn, the period buttons and dragging pick the view
  const firstDay = load.days[0]!.day, lastDay = last.day;
  const preset = (n: number | 'all'): [number, number] | null => (n === 'all' || lastDay - n + 1 <= firstDay ? null : [lastDay - n + 1, lastDay]);
  const same = (a: [number, number] | null, b: [number, number] | null) => (a === null ? b === null : b !== null && a[0] === b[0] && a[1] === b[1]);
  const rangeBtns: [HTMLButtonElement, number | 'all'][] = [];
  const rangeBtn = (n: number | 'all', text: string) => { const b = h('button', { 'aria-pressed': String(same(chartView('pmc'), preset(n))), onclick: () => { setChartView('pmc', preset(n)); render(); } }, text); rangeBtns.push([b, n]); return b; };
  const pts = (f: (d: typeof last) => number): [number, number][] => load.days.map((d) => [d.day, Math.round(f(d) * 10) / 10]);
  const tssOn = new Map(load.days.map((d) => [d.day, d.tss]));
  const inView = h('p', { class: 'muted small', 'aria-live': 'polite' });
  const describeView = (dom: [number, number] | null) => {
    for (const [b, n] of rangeBtns) b.setAttribute('aria-pressed', String(same(dom, preset(n))));
    const ds = load.days.filter((d) => !dom || (d.day >= dom[0] && d.day <= dom[1]));
    if (!ds.length) { inView.textContent = ''; return; }
    const tss = ds.reduce((x, d) => x + d.tss, 0);
    const a = ds[0]!, b = ds[ds.length - 1]!;
    inView.textContent = `${dayLabel(a.day)} – ${dayLabel(b.day)}: ${fmt(tss, 0)} TSS in ${plural(ds.filter((d) => d.tss > 0).length, 'training day')} (${fmt((tss / ds.length) * 7, 0)} a week) · fitness ${fmt(a.ctl, 0)} → ${fmt(b.ctl, 0)} · lowest form ${fmt(Math.min(...ds.map((d) => d.tsb)), 0)}`;
  };
  if (!pmcInit.has(state.result!)) { pmcInit.add(state.result!); setChartView('pmc', preset(365)); }
  const pmcView = chartView('pmc');
  sec.append(h('figure', { class: 'card chart-card' },
    h('div', { class: 'chart-head' }, h('h3', {}, 'Fitness, fatigue and form'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Period shown in the fitness chart' }, rangeBtn(42, '6 weeks'), rangeBtn(90, '90 days'), rangeBtn(365, '1 year'), rangeBtn('all', 'All'))),
    chartBox({
      key: 'pmc', label: 'Fitness, fatigue and form per day', height: 240, zeroLine: true, xDomain: pmcView, hidden: ['Daily TSS'],
      series: [
        { name: 'Fitness', cls: 's-fitness', points: pts((d) => d.ctl) },
        { name: 'Fatigue', cls: 's-fatigue', points: pts((d) => d.atl) },
        { name: 'Form', cls: 's-form', points: pts((d) => d.tsb), area: true },
        { name: 'Daily TSS', cls: 's-faint', points: load.days.filter((d) => d.tss > 0).map((d) => [d.day, Math.round(d.tss)]), dots: true },
      ],
      xTicks: dayTicks, fmtX: dayTick,
      tipX: (d) => `${dayLabel(d)} · ${fmt(tssOn.get(d) ?? 0, 0)} TSS that day`,
      fmtY: (v) => fmt(v, 0),
      onView: describeView,
    }), inView));

  // weekly stress, stacked by sport
  const span = curSpan(acts);
  const weeks = weeksOf(acts, span);
  const grouped = byWeekStart(acts);
  const loadSports = sports.filter((sp) => acts.some((a) => a.sport === sp && activityLoad(a, t)));
  const bars: Bar[] = weeks.map((d) => {
    const w = (grouped.get(d) ?? []).map((a) => ({ a, l: activityLoad(a, t) })).filter((x) => x.l);
    const per = loadSports.map((sp) => w.filter((x) => x.a.sport === sp).reduce((s, x) => s + x.l!.tss, 0));
    const total = per.reduce((a, b) => a + b, 0);
    const key = weekKeyOf(d);
    return { label: weekLabel(d), value: Math.round(total), parts: loadSports.length > 1 ? per.map((v, i) => ({ value: v, cls: sportClass(sports, loadSports[i]!) })) : undefined,
      tip: [weekRange(d), `${fmt(total, 0)} TSS`, ...loadSports.map((sp, i) => (per[i]! > 0 ? `${sp}: ${fmt(per[i]!, 0)}` : '')).filter(Boolean), plural(w.length, 'activity', 'activities') + ' with load'],
      selected: selectedIn('weeks-tss') === key,
      onClick: w.length ? () => { state.pick = selectedIn('weeks-tss') === key ? null : { table: 'weeks-tss', key, title: `Week ${weekRange(d)}`, sel: { kind: 'week', value: key } }; render(); } : undefined };
  });
  sec.append(h('figure', { class: 'card chart-card' }, h('div', { class: 'chart-head' }, h('h3', {}, 'Training stress per week (TSS)'), weekSpanControl(acts, 'Weeks shown')),
    loadSports.length > 1 ? h('ul', { class: 'chart-legend static' }, ...loadSports.map((sp) => h('li', { class: sportClass(sports, sp) }, h('i', {}), sp))) : null,
    barChart({ label: 'Training stress per week', fmtY: (v) => fmt(v, 0), labelEvery: Math.max(1, Math.ceil(weeks.length / 9)), bars })),
  drill('weeks-tss', acts) ?? '');

  const src: string[] = [];
  if (load.fromPower) src.push(`${load.fromPower} from power`);
  if (load.fromPace) src.push(`${load.fromPace} from pace (rTSS)`);
  if (load.fromHr) src.push(`${load.fromHr} from heart rate (hrTSS)`);
  sec.append(h('p', { class: 'small' }, `Training stress counted for ${src.join(', ')}${load.without ? `; ${plural(load.without, 'activity', 'activities')} without usable data add nothing` : ''}. 100 TSS is about one hour flat out at threshold.${t.lthr && state.hr?.mode === 'maxHr' ? ` Threshold HR is estimated as 90 % of max HR (${t.lthr} bpm).` : ''}${!state.restHr && load.fromHr ? ' Resting HR is taken as 60 bpm until you set yours.' : ''}`));

  sec.append(efficiencySection(acts));
  sec.append(h('details', {}, h('summary', {}, 'How to read this, and how it is worked out'),
    h('dl', { class: 'explain card' },
      h('dt', {}, 'Training stress (TSS)'), h('dd', {}, 'How hard one activity was, combining duration and intensity: hours × intensity factor² × 100, so an hour at threshold is 100 and an easy hour 40–60. With power and an FTP the intensity factor is normalized power ÷ FTP (TrainingPeaks TSS). Runs without power use normalized graded pace ÷ threshold pace (rTSS): every second’s speed is adjusted for the gradient with Minetti’s energy cost of running, then averaged like normalized power. Otherwise it comes from heart rate (hrTSS): TrainingPeaks does not publish its heart-rate table, so this uses the TRIMP-based score of intervals.icu and Golden Cheetah, which weights each second exponentially by heart-rate reserve (needs resting and max HR) and gives 100 for an hour at threshold heart rate.'),
      h('dt', {}, 'Fitness (CTL)'), h('dd', {}, 'An exponentially weighted average of your daily TSS with a 42-day time constant, rest days counted as 0: each day, fitness moves 1/42 of the way toward that day’s TSS. It is the long-term trend.'),
      h('dt', {}, 'Fatigue (ATL)'), h('dd', {}, 'The same with a 7-day time constant: what the last week or two has taken out of you.'),
      h('dt', {}, 'Form (TSB)'), h('dd', {}, 'Yesterday’s fitness minus yesterday’s fatigue (the TrainingPeaks convention). Between about −10 and −30 you are building; above +5 you are fresh for an event; below −30 you risk overdoing it.'),
      h('dt', {}, 'Zooming'), h('dd', {}, 'Drag across a chart to zoom into that stretch, or focus it and press + and −. Names above a chart show and hide their lines; “Daily TSS” adds each day’s stress as dots.'))));
  return sec;
}
const pmcInit = new WeakSet<object>();

/** Efficiency factor over time (TrainingPeaks' EF trend): rising output per heartbeat = better aerobic fitness. */
function efficiencySection(acts: Activity[]): HTMLElement | string {
  const pts = acts.map((a) => ({ a, e: efficiencyFactor(a) })).filter((x) => x.e);
  if (pts.length < 5) return '';
  const kinds = (['power', 'pace'] as const).filter((k) => pts.filter((x) => x.e!.kind === k).length >= 5);
  const charts = kinds.map((k) => {
    const mine = pts.filter((x) => x.e!.kind === k).sort((x, y) => x.a.startMs - y.a.startMs);
    const dots: [number, number][] = mine.map((x) => [dayNumber(parts(x.a.startMs, state.tz)), Math.round(x.e!.ef * 100) / 100]);
    // monthly median, drawn at mid-month
    const months = new Map<string, number[]>();
    for (const x of mine) { const key = monthKey(parts(x.a.startMs, state.tz)); (months.get(key) ?? months.set(key, []).get(key)!).push(x.e!.ef); }
    const med: [number, number][] = [...months.entries()].sort().map(([key, v]) => { const s = [...v].sort((p, q) => p - q); return [dayNumber({ y: Number(key.slice(0, 4)), m: Number(key.slice(5)), d: 15, wd: 0 }), Math.round(s[s.length >> 1]! * 100) / 100]; });
    const byDay = new Map(mine.map((x) => [dayNumber(parts(x.a.startMs, state.tz)), x.a]));
    return h('figure', { class: 'card chart-card' },
      h('div', { class: 'chart-head' }, h('h3', {}, k === 'power' ? 'Efficiency factor: normalized watts per heartbeat' : `Efficiency factor: metres per minute (graded) per heartbeat`)),
      chartBox({ key: `ef-${k}-${state.sport}`, label: `Efficiency factor of each ${k === 'power' ? 'ride with power' : 'run'}, and the monthly median`,
        series: [{ name: 'Monthly median', cls: 's-main', points: med }, { name: k === 'power' ? 'Each activity' : 'Each run', cls: 's-faint', points: dots, dots: true }],
        xTicks: dayTicks, fmtX: dayTick, tipX: dayLabel, fmtY: (v) => fmt(v, 2),
        tipExtra: (name, x) => (name.startsWith('Each') ? byDay.get(x)?.name ?? null : null),
        onPick: (x) => { const a = byDay.get(x); if (a) openActivity(a.id); } }));
  });
  return h('div', {}, h('h3', {}, 'Aerobic efficiency'),
    h('p', { class: 'small' }, 'Efficiency factor (TrainingPeaks): output per heartbeat for activities of 20 minutes or more. On similar easy sessions, a rising line means your aerobic fitness is improving. Hard intervals and heat make single points jump, so watch the monthly median.'),
    h('div', { class: 'charts' }, ...charts));
}

// ---------- training calendar ----------

function calendarSection(acts: Activity[], t: Thresholds): HTMLElement {
  const months = [...new Set(acts.map((a) => monthKey(parts(a.startMs, state.tz))))].sort();
  const cur = state.calMonth && months.includes(state.calMonth) ? state.calMonth : months[months.length - 1]!;
  const i = months.indexOf(cur);
  const y = Number(cur.slice(0, 4)), m = Number(cur.slice(5));
  const first = dayNumber({ y, m, d: 1, wd: 0 });
  const next = dayNumber(m === 12 ? { y: y + 1, m: 1, d: 1, wd: 0 } : { y, m: m + 1, d: 1, wd: 0 });
  const byDay = new Map<number, Activity[]>();
  for (const a of acts) { const d = dayNumber(parts(a.startMs, state.tz)); if (d >= first - 7 && d < next + 7) (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(a); }
  const u = state.units;
  const go = (k: number) => { state.calMonth = months[k]!; render(); document.getElementById('calendar')?.scrollIntoView({ block: 'nearest' }); };
  const head = h('div', { class: 'h2row' }, h('h2', { id: 'calendar' }, 'Calendar'),
    h('div', { class: 'span-pick', role: 'group', 'aria-label': 'Month shown' },
      h('button', { 'aria-label': 'Previous month with activities', disabled: i <= 0, onclick: () => go(i - 1) }, '‹'),
      h('select', { 'aria-label': 'Month shown', onchange: (e) => { state.calMonth = (e.target as HTMLSelectElement).value; render(); } }, ...[...months].reverse().map((k) => h('option', { value: k, selected: k === cur }, monthTitle(k)))),
      h('button', { 'aria-label': 'Next month with activities', disabled: i >= months.length - 1, onclick: () => go(i + 1) }, '›')));
  const grid = h('div', { class: 'cal', role: 'table', 'aria-label': `Training calendar, ${monthTitle(cur)}` });
  grid.append(h('div', { class: 'cal-row cal-head', role: 'row' }, ...['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Week'].map((d) => h('span', { role: 'columnheader' }, d))));
  const maxTss = 200;
  for (let w = weekStart(fromDayNumber(first)); w < next; w += 7) {
    const row = h('div', { class: 'cal-row', role: 'row' });
    let wd = 0, ws = 0, wt = 0;
    for (let d = w; d < w + 7; d++) {
      const p = fromDayNumber(d);
      const list = byDay.get(d) ?? [];
      const tss = list.reduce((x, a) => x + (activityLoad(a, t)?.tss ?? 0), 0);
      wd += list.reduce((x, a) => x + a.distanceM, 0); ws += list.reduce((x, a) => x + a.movingS, 0); wt += tss;
      const cell = h('div', { class: `cal-day${d < first || d >= next ? ' out' : ''}${list.length ? ' has' : ''}`, role: 'cell' },
        h('span', { class: 'cal-date' }, String(p.d)),
        ...list.map((a) => { const l = activityLoad(a, t); return h('button', { class: `cal-act ${sportClass(sportsOf(acts), a.sport)}`, title: `${a.name} · ${dateOf(a.startMs)}`, onclick: () => openActivity(a.id) },
          h('b', {}, a.distanceM > 0 ? `${dist(a.distanceM)} ${distanceUnit(u)}` : formatDuration(a.movingS)), l ? h('span', { class: 'cal-tss' }, ` ${fmt(l.tss, 0)}`) : '', h('span', { class: 'sr-only' }, ` ${a.sport}`)); }));
      if (tss > 0) cell.style.setProperty('--load', String(Math.min(1, tss / maxTss)));
      row.append(cell);
    }
    row.append(h('div', { class: 'cal-week', role: 'cell' }, wd ? h('b', {}, `${dist(wd)} ${distanceUnit(u)}`) : '', ws ? h('span', {}, formatHours(ws)) : '', wt ? h('span', {}, `${fmt(wt, 0)} TSS`) : ''));
    grid.append(row);
  }
  return h('div', {}, head, h('div', { class: 'card cal-card' }, grid), h('p', { class: 'muted small' }, 'Each activity shows its distance (or time) and training stress; darker days carried more stress. Select one to open it.'));
}

const isoWeekOf = (ms: number) => isoWeekKey(parts(ms, state.tz));
void isoWeekOf;

// ---------- mean-maximal curves and best efforts ----------

/** Log-axis duration ticks for a visible range: up to about 8 round durations. */
function durationTicks(lo: number, hi: number): number[] {
  const cand = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800, 18000, 36000].filter((d) => d >= lo * 0.999 && d <= hi * 1.001);
  const out: number[] = [];
  const gap = Math.log(hi / lo) / 8;
  for (const d of cand) if (!out.length || Math.log(d / out[out.length - 1]!) >= gap * 0.9) out.push(d);
  return out;
}
const durTick = (s: number) => durationName(s).replace(' min', 'm').replace(' s', 's').replace(' h ', 'h').replace(' h', 'h');

const CURVES: Record<State['curveKind'], { name: string; best: (acts: Activity[]) => CurvePoint[]; has: (a: Activity) => boolean; fmt: (v: number) => string; unit: () => string }> = {
  power: { name: 'Power', best: (a) => bestPowerCurve(a), has: (a) => !!a.powerCurve, fmt: (v) => fmt(v, 0), unit: () => 'W' },
  hr: { name: 'Heart rate', best: bestHrCurve, has: (a) => !!a.hrCurve, fmt: (v) => fmt(v, 0), unit: () => 'bpm' },
  pace: { name: 'Pace', best: bestPaceCurve, has: (a) => !!a.paceCurve && RUN_LIKE.has(a.sport), fmt: (v) => (v > 0.3 ? paceOf(v) : dash), unit: () => `/${distanceUnit(state.units)}` },
};

function curveSection(acts: Activity[]): HTMLElement {
  const sec = h('div', {}, h('h2', { id: 'curve' }, 'Curves and best efforts'));
  const byId = new Map(acts.map((a) => [a.id, a]));
  const actLink = (id: string) => { const a = byId.get(id)!; return h('button', { class: 'link', onclick: () => openActivity(a.id) }, a.name); };
  const kinds = (Object.keys(CURVES) as State['curveKind'][]).filter((k) => acts.some(CURVES[k].has));
  if (kinds.length) {
    const kind = kinds.includes(state.curveKind) ? state.curveKind : kinds[0]!;
    const c = CURVES[kind];
    let subset = acts.filter(c.has);
    let sportPick: HTMLElement | null = null;
    if (kind === 'pace') {
      const sps = sportsOf(subset);
      const sp = state.curveSport && sps.includes(state.curveSport) ? state.curveSport : sps[0]!;
      subset = subset.filter((a) => a.sport === sp);
      if (sps.length > 1) sportPick = selectControl('Sport', sp, sps.map((x): [string, string] => [x, x]), (v) => { state.curveSport = v; state.curvePick = null; });
    }
    const allTime = c.best(subset), recentActs = lastYear(subset), recent = c.best(recentActs);
    const showRecent = recent.length > 0 && subset.length !== recentActs.length;
    const curves = new Map<string, CurvePoint[]>([['All time', allTime]]);
    const series: XYSeries[] = [{ name: 'All time', cls: 's-compare', points: allTime.map((p) => [p.seconds, p.watts]) }];
    if (showRecent) { series.unshift({ name: 'Last 12 months', cls: 's-main', points: recent.map((p) => [p.seconds, p.watts]), area: kind === 'power' }); curves.set('Last 12 months', recent); }
    const cp = kind === 'power' ? criticalPower(showRecent ? recent : allTime) : null;
    if (cp) series.push({ name: 'CP model', cls: 's-faint', dash: true, points: CURVE_POINTS.filter((d) => d >= 120 && d <= allTime[allTime.length - 1]!.seconds).map((d) => [d, Math.round(cp.cp + cp.wPrime / d)]) });
    const maxS = allTime[allTime.length - 1]!.seconds;
    const tabs = h('div', { class: 'seg', role: 'group', 'aria-label': 'Curve shown' }, ...kinds.map((k) => h('button', { 'aria-pressed': String(k === kind), onclick: () => { state.curveKind = k; state.curvePick = null; render(); } }, CURVES[k].name)));
    const pointAt = (name: string, x: number) => curves.get(name)?.find((p) => p.seconds === x);
    sec.append(h('figure', { class: 'card chart-card' },
      h('div', { class: 'chart-head' }, h('h3', {}, kind === 'pace' ? `Best pace for every duration (${c.unit()})` : `Best ${c.name.toLowerCase()} for every duration (${c.unit()})`), h('div', { class: 'row' }, sportPick, tabs)),
      chartBox({ key: `curve-${kind}-${state.sport}`, series, log: true, label: `${c.name} curve: best average for each duration. Select a point to see the activity that set it`, xTicks: durationTicks, fmtX: durTick, tipX: (s) => `Best ${durationName(s)}`,
        fmtY: c.fmt, yZero: kind === 'power',
        tipExtra: (name, x) => { const p = pointAt(name, x); return p ? `${byId.get(p.activityId)?.name ?? ''} · ${dateOf(p.startMs)}` : null; },
        onPick: (x) => { state.curvePick = { kind, x }; render(); document.getElementById('list-curve')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } }),
      h('p', { class: 'small' }, `From ${plural(subset.length, 'activity', 'activities')}. Each point is the highest average you held for that long in one go${kind === 'hr' ? ' (heart rate lags effort, so short durations read low)' : ''}. Drag across the chart to zoom in; select a point to see the activity behind it.`)));
    const pick = state.curvePick?.kind === kind ? state.curvePick : null;
    if (pick) {
      const found = [...curves.entries()].map(([name, cv]) => ({ name, p: cv.find((q) => q.seconds === pick.x) })).filter((x) => x.p);
      const ids = [...new Set(found.map((x) => x.p!.activityId))];
      const title = `Best ${durationName(pick.x)}: ${found.map((x) => `${c.fmt(x.p!.watts)} ${c.unit()} ${found.length > 1 ? `(${x.name.toLowerCase()})` : ''}`.trim()).join(', ')}`;
      sec.append(activityPanel('list-curve', title, ids.map((id) => byId.get(id)!).filter(Boolean), {
        units: state.units, tz: state.tz, tiles: tileSource(state.mapTiles), open: openActivity,
        close: () => { state.curvePick = null; render(); },
      }));
    }
    const keyD = kind === 'pace' ? [60, 300, 1200, 1800, 3600] : kind === 'hr' ? [60, 300, 1200, 3600] : [5, 60, 300, 1200, 3600];
    const rows = keyD.map((d) => ({ d, a: allTime.find((p) => p.seconds === d), r: recent.find((p) => p.seconds === d) })).filter((x) => x.a);
    const wkg = kind === 'power' && state.weight;
    const pctOf = kind === 'power' ? state.ftp : kind === 'hr' ? thresholds().lthr : null;
    sec.append(h('div', { class: 'card scroll' }, table(['Duration', `All time (${c.unit()})`, 'Set on', ...(showRecent ? [`Last 12 months (${c.unit()})`] : []), ...(wkg ? ['W/kg'] : []), ...(pctOf ? [kind === 'power' ? '% of FTP' : '% of threshold HR'] : [])],
      rows.map(({ d, a, r }) => [durationName(d), c.fmt(a!.watts), h('span', {}, actLink(a!.activityId), ` (${dateOf(a!.startMs)})`), ...(showRecent ? [r ? c.fmt(r.watts) : dash] : []), ...(wkg ? [fmt(a!.watts / state.weight!, 2)] : []), ...(pctOf ? [`${fmt((a!.watts / pctOf) * 100, 0)} %`] : [])]), { numCols: [1, 3, 4, 5] })));
    if (kind === 'power') {
      const peakD = [5, 60, 300, 1200, 3600];
      const peaks = peaksBy(subset, (a) => String(parts(a.startMs, state.tz).y), peakD);
      if (peaks.length > 1) {
        const bestCol = peakD.map((_, i) => Math.max(...peaks.map((p) => p.best[i]?.watts ?? 0)));
        sec.append(h('h3', {}, 'Peak power by year'), h('div', { class: 'card scroll' }, table(['Year', ...peakD.map(durationName)],
          peaks.map((p) => [p.key, ...p.best.map((b, i) => (b ? h('span', { class: b.watts === bestCol[i] ? 'best' : '', title: `${byId.get(b.activityId)?.name ?? ''} (${dateOf(b.startMs)})` }, `${fmt(b.watts, 0)} W`) : dash))]), { numFrom: 1 })),
        h('p', { class: 'muted small' }, 'Your best power for each duration in each year, like TrainingPeaks’ peak-power table; the best year for each is bold.'));
      }
    }
  } else sec.append(h('p', {}, 'No power, heart-rate or pace streams, so there are no curves.'));

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
const PACE_SPORTS = new Set(['Run', 'Walk', 'Hike', 'Trail Run', 'Virtual Run']);
const CURVE_POINTS = CURVE_DURATIONS;

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
  if (o.bloomYear !== 'all' && !years.includes(o.bloomYear)) o.bloomYear = 'all';
  if (o.workYear !== 'all' && !years.includes(o.workYear)) o.workYear = 'all';
  if (o.clockYear !== 'all' && !years.includes(o.clockYear)) o.clockYear = 'all';
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
    case 'bloom': return [
      pick('Period', String(o.bloomYear), [['all', 'All time'], ...years], (v) => (poster.bloomYear = v === 'all' ? 'all' : Number(v))),
      pick('Symmetry', String(poster.bloomSymmetry), [['1', 'None'], ['3', '3-fold'], ['6', '6-fold'], ['8', '8-fold']], (v) => (poster.bloomSymmetry = Number(v)))];
    case 'calendar': case 'rings': case 'cumulative': case 'stream': case 'spiral': return [pick('Measure', poster.calendarMetric, [['distance', 'Distance'], ['time', 'Time']], (v) => (poster.calendarMetric = v))];
    case 'work': return [pick('Period', String(o.workYear), [['all', 'All time'], ...years], (v) => (poster.workYear = v === 'all' ? 'all' : Number(v)))];
    case 'sunrise': return [pick('Period', String(o.clockYear), [['all', 'All time'], ...years], (v) => (poster.clockYear = v === 'all' ? 'all' : Number(v)))];
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
// ---------- Sport Wrapped ----------

function startWrapped(acts: Activity[], period?: number | 'all'): void {
  openWrapped({ all: acts.length ? acts : state.result?.activities ?? [], tz: state.tz, units: state.units, thresholds: thresholds(), hideEnds: poster.hideEnds, period });
}

/** The banner at the top of the stats page, shown only around the turn of the year (see wrappedSeason). */
function wrappedPromo(acts: Activity[], season: number): HTMLElement {
  const years = wrappedYears(acts, state.tz);
  const latest = years.includes(season) ? season : years[0];
  return h('section', { class: 'wrapped-promo', 'aria-labelledby': 'wrapped-title' },
    h('div', {}, h('h2', { id: 'wrapped-title' }, 'Sport Wrapped'),
      h('p', {}, `Your ${latest ?? 'year'} as a story: distance, climbing, records, your rhythm and your sporting type${state.sport === 'all' ? '' : ` (${state.sport} only)`}.`)),
    h('button', { id: 'open-wrapped-banner', onclick: () => startWrapped(acts, latest) }, `Play ${latest ?? 'your year'}`));
}

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

/** Periods for the zone summaries: all time, the last 12 months, each year. */
function zoneSpanControl(acts: Activity[]): HTMLElement {
  const years = yearsOf(acts);
  const cur = zoneSpanOf(acts);
  const btn = (v: string, text: string) => h('button', { 'aria-pressed': String(cur === v), onclick: () => { state.zoneSpan = v; render(); } }, text);
  return h('div', { class: 'seg years', role: 'group', 'aria-label': 'Period of the zone summaries' }, btn('all', 'All time'), btn('recent', 'Last 12 months'), ...years.map((y) => btn(String(y), String(y))));
}
const zoneSpanOf = (acts: Activity[]) => (state.zoneSpan === 'all' || state.zoneSpan === 'recent' || yearsOf(acts).includes(Number(state.zoneSpan)) ? state.zoneSpan : 'all');
function inZoneSpan(acts: Activity[]): { acts: Activity[]; label: string } {
  const sp = zoneSpanOf(acts);
  if (sp === 'all') return { acts, label: 'All time' };
  if (sp === 'recent') return { acts: lastYear(acts), label: 'Last 12 months of the data' };
  return { acts: acts.filter((a) => parts(a.startMs, state.tz).y === Number(sp)), label: sp };
}

/** Low / moderate / high split of time (Seiler's three zones), as intervals.icu and TrainingPeaks summarise polarisation. */
function intensitySplit(seconds: number[], zones: Zone[]): HTMLElement {
  const n = zones.length;
  // Seiler's low / moderate / high. 5 max-HR zones: Z1-3 (<80 %) | Z4 | Z5 (>=90 %);
  // 7 Friel or Coggan zones: Z1-2 (below 90 % LTHR / 75 % FTP) | Z3-4 | Z5 and up
  const lowEnd = n === 5 ? 3 : 2, midEnd = n === 5 ? 4 : 4;
  const sum = (a: number, b: number) => seconds.slice(a, b).reduce((x, y) => x + y, 0);
  const parts3 = [sum(0, lowEnd), sum(lowEnd, midEnd), sum(midEnd, n)];
  const total = parts3.reduce((x, y) => x + y, 0) || 1;
  const names = ['Low', 'Moderate', 'High'];
  const bar = h('div', { class: 'zbar split', role: 'img', 'aria-label': `Intensity distribution: ${parts3.map((v, i) => `${names[i]} ${fmt((v / total) * 100, 0)} %`).join(', ')}` },
    ...parts3.map((v, i) => { const el = h('i', { title: `${names[i]}: ${hm(v)} (${fmt((v / total) * 100, 0)} %)` }); el.style.width = `${(v / total) * 100}%`; el.style.background = ZONE_COLORS[[1, 3, 4][i]!]!; return el; }));
  const share = (i: number) => fmt((parts3[i]! / total) * 100, 0);
  return h('div', { class: 'split-row' }, h('span', { class: 'small' }, h('b', {}, 'Intensity mix '), `Low ${share(0)} % · Moderate ${share(1)} % · High ${share(2)} %`), bar,
    h('span', { class: 'muted small' }, mixAdvice(parts3[0]! / total, parts3[1]! / total, parts3[2]! / total)));
}
function mixAdvice(low: number, mid: number, high: number): string {
  if (low >= 0.7 && high >= mid) return 'Polarised: mostly easy with some hard work, the mix most endurance coaches aim for (about 80 % easy).';
  if (low >= 0.7) return 'Pyramidal: mostly easy, then less moderate, then least hard. A common, sound mix.';
  if (high > 0.4) return 'Mostly hard. Plenty of intensity; more easy time usually builds endurance with less fatigue.';
  return 'A lot of moderate (“grey zone”) time: tiring, but less effective than clearly easy or clearly hard sessions.';
}

function zonesSection(all: Activity[], acts: Activity[], hz: Zone[] | null, pz: Zone[] | null): HTMLElement {
  const sec = h('div', {}, h('div', { class: 'h2row' }, h('h2', { id: 'zones' }, 'Time in zones'), zoneSpanControl(acts)),
    h('p', {}, 'Zones come from the heart rate, FTP and threshold pace set under ', h('a', { href: '#training' }, 'Training load'), '.',
      state.hr?.mode === 'lthr' ? ` Heart-rate zones are Joe Friel’s seven zones from threshold HR (${RUN_LIKE.has(state.sport) ? 'running' : 'cycling'} table), as TrainingPeaks uses them.` : ''));
  void all;
  const span = inZoneSpan(acts);
  const paceZ = state.pace ? paceZones(state.pace) : null;
  const block = (stream: 'hr' | 'power' | 'pace', zones: Zone[] | null, noun: string, hint: string) => {
    sec.append(h('h3', {}, stream === 'hr' ? 'Heart rate' : stream === 'power' ? 'Power' : 'Pace (runs)'));
    const pool = stream === 'pace' ? acts.filter((a) => RUN_LIKE.has(a.sport)) : acts;
    const spanPool = stream === 'pace' ? span.acts.filter((a) => RUN_LIKE.has(a.sport)) : span.acts;
    if (!zones) { sec.append(h('p', {}, hint)); return; }
    const total = zoneTotals(spanPool, stream, zones);
    if (!zoneTotals(pool, stream, zones).withData) { sec.append(h('p', {}, `None of these activities has ${noun} data, so there is nothing to show.`)); return; }
    const unit = stream === 'hr' ? 'bpm' : stream === 'power' ? 'W' : '';
    const range = stream === 'pace' ? (z: Zone) => `${z.lower === 0 ? `slower than ${paceOf(z.upper! / 10)}` : z.upper === null ? `faster than ${paceOf(z.lower / 10)}` : `${paceOf(z.upper / 10)}–${paceOf(z.lower / 10)}`} /${distanceUnit(state.units)}` : undefined;
    sec.append(h('div', { class: 'card' }, total.withData ? zoneRows(zones, total.seconds, unit, range) : h('p', {}, `No ${noun} data in this period.`),
      total.withData && stream !== 'pace' ? intensitySplit(total.seconds, zones) : null,
      h('p', { class: 'small' }, `${span.label}, from ${total.withData} of ${plural(total.count, stream === 'pace' ? 'run' : 'activity', stream === 'pace' ? 'runs' : 'activities')} (the others have no ${noun} data).`)));
    if (stream === 'pace') return;
    append(sec, [h('div', { class: 'card' }, zoneTable('Year', zones, zonesBy(acts, stream, zones, 'year', state.tz), noun, { id: `${stream}-year`, kind: 'year' })), drill(`${stream}-year`, acts)]);
    const months = monthRows(zonesBy(acts, stream, zones, 'month', state.tz), acts);
    sec.append(h('details', { open: state.pick?.table === `${stream}-month` }, h('summary', {}, 'By month'), h('div', { class: 'row' }, yearTabs(acts, `Year shown in the ${noun} month table`)),
      h('div', { class: state.monthYear === 'all' ? 'card scroll' : 'card' }, zoneTable('Month', zones, months, noun, { id: `${stream}-month`, kind: 'month' })), drill(`${stream}-month`, acts)));
  };
  block('hr', hz, 'heart-rate', 'No heart-rate data found in this export.');
  block('power', pz, 'power', 'Enter your FTP under Training load to see power zones (only activities with a power stream are counted).');
  if (acts.some((a) => RUN_LIKE.has(a.sport) && a.speedHist)) block('pace', paceZ, 'pace', 'Enter your threshold pace under Training load to see Joe Friel’s pace zones for your runs.');
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
