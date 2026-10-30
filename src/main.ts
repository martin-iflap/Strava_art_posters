import './style.css';
import { append, download, h, table } from './dom';
import { routeSvg } from './charts';
import { activityView } from './detail';
import { dash, fmt, opt, plural } from './format';
import { fromDrop, fromFileList } from './input';
import { activitiesCsv, exportFilename, periodCsv, sportCsv, statsJson, zonesCsv, type ExportOptions } from './export';
import type { RawInput } from './parse/archive';
import { clusterRoutes, type RouteCluster } from './stats/routes';
import { byPeriod, byWeekday, bySport, filterSport, records, sportsOf, summarize, type Summary } from './stats/summary';
import { activityZones, hrZones, observedMaxHr, powerZones, zoneTotals, zonesBy, type HrZoneConfig, type Zone, type ZoneRow } from './stats/zones';
import type { Activity, ImportResult, Tz, Units } from './types';
import { distance, distanceUnit, elevation, elevationUnit, formatDuration, formatHours, speed, speedUnit } from './util/units';
import { parts, ymd } from './util/time';
import { DEFAULT_POSTER, POSTER_TYPES, SIZES, THEMES, renderPoster, type PosterOptions, type PosterType } from './posters';
import { svgToPng } from './posters/raster';
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
  returnView: 'stats' | 'posters';
  returnScroll: number;
  query: string;
  sortKey: 'date' | 'distance' | 'time' | 'elevation' | 'speed';
  theme: 'auto' | 'light' | 'dark';
  sheet: boolean;
  /** year shown in the month tables; null = latest year with data */
  monthYear: number | 'all' | null;
}

const state: State = { result: null, sport: 'all', units: 'metric', tz: 'local', hr: null, ftp: null, showAll: false, view: 'stats', activityId: null, returnView: 'stats', returnScroll: 0, query: '', sortKey: 'date', theme: 'auto', sheet: false, monthYear: null };
let animate = true;
const poster = { type: 'facets' as PosterType, ...DEFAULT_POSTER };
const app = document.getElementById('app')!;
const ZONE_COLORS = ['#8e8e93', '#30b0c7', '#34c759', '#ff9f0a', '#ff453a', '#bf5af2', '#ff2d55'];

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
      state.showAll = false;
      state.view = 'stats';
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
      h('div', { class: 'brand' }, h('h1', {}, 'Ride Atlas'), h('p', {}, 'Your Strava export, analysed privately in this browser tab.')),
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
  app.replaceChildren(hero(
    drop,
    h('h2', {}, 'How to get your Strava export'),
    h('ol', { class: 'steps' },
      h('li', {}, 'On strava.com open Settings → My Account → “Download or Delete Your Account” → “Get Started”.'),
      h('li', {}, 'Choose “Request Your Archive”. Strava emails you a download link (this can take a while).'),
      h('li', {}, 'Download the ZIP and drop it here. You do not need to unpack it.')),
    h('p', {}, 'No account, no upload, no tracking: files are read by your browser and never leave this tab. Not sure yet? Try the demo data, which is entirely made up.'),
    h('p', {}, 'Ride Atlas is an independent project and is not affiliated with Strava.')));
}

// ---------- formatting ----------

const dist = (m: number) => fmt(distance(m, state.units));
const elev = (m: number) => fmt(elevation(m, state.units), 0);
const dateOf = (ms: number) => ymd(parts(ms, state.tz));

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
function focusKey(): { idx: number; tag: string; label: string } | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || !app.contains(el) || !/^(SELECT|INPUT|BUTTON|A)$/.test(el.tagName)) return null;
  const all = Array.from(app.querySelectorAll('select, input, button, a'));
  return { idx: all.indexOf(el), tag: el.tagName, label: controlLabel(el) };
}
function controlLabel(el: Element): string {
  return el.getAttribute('aria-label') || el.closest('label')?.childNodes[0]?.textContent || (el.tagName === 'SELECT' ? '' : el.textContent?.slice(0, 40)) || '';
}
function render(): void {
  const key = focusKey();
  renderNow();
  if (key) {
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

  const select = <T extends string>(label: string, value: T, options: [T, string][], on: (v: T) => void) =>
    h('label', {}, label,
      h('select', { onchange: (e) => { on((e.target as HTMLSelectElement).value as T); render(); } },
        ...options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))));

  const setView = (v: 'stats' | 'posters') => { state.view = v; state.sheet = false; animate = true; render(); window.scrollTo(0, 0); };
  const navBtn = (v: 'stats' | 'posters', label: string) => h('button', { 'aria-current': (state.view === v || (v === 'stats' && state.view === 'activity')) ? 'page' : undefined, onclick: () => setView(v) }, label);
  const sections: [string, string][] = [['overview', 'Overview'], ['records', 'Records'], ['periods', 'Years and months'], ['zones', 'Time in zones'], ['loops', 'Routes'], ['activities', 'Activities'], ['export', 'Export'], ['issues', 'Import report']];
  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Sidebar' },
    h('div', { class: 'brand' }, h('h1', {}, 'Ride Atlas'), h('p', {}, 'Private, in your browser')),
    h('nav', { class: 'nav', 'aria-label': 'Views' }, navBtn('stats', 'Stats'), navBtn('posters', 'Posters'),
      ...(state.view === 'stats' && all.length ? sections.map(([id, t]) => h('a', { href: `#${id}` }, t)) : [])),
    h('div', { class: 'filters', role: 'group', 'aria-label': 'Filters', id: 'filters' },
      select('Sport', state.sport, [['all', `All sports (${all.length})`], ...sportsOf(all).map((s): [string, string] => [s, `${s} (${all.filter((a) => a.sport === s).length})`])], (v) => (state.sport = v)),
      select('Units', state.units, [['metric', 'km / m'], ['imperial', 'mi / ft']], (v) => (state.units = v)),
      select('Time zone', state.tz, [['local', 'Local'], ['UTC', 'UTC']], (v) => (state.tz = v)),
      h('button', { class: 'sheet-close', onclick: () => { state.sheet = false; render(); } }, 'Done')),
    h('div', { class: 'side-foot' }, themeToggle(),
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
        units: state.units, tz: state.tz, hz, pz, all,
        list: [...(acts.some((x) => x.id === a.id) ? acts : all)].sort((x, y) => y.startMs - x.startMs),
        open: openActivity, back: () => closeActivity(), clusters: (sport) => clustersFor(all, sport),
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

  main.append(h('h2', { id: 'overview' }, 'Overview'));
  if (!acts.length) {
    main.append(h('div', { class: 'card empty' }, h('h2', {}, 'Nothing here'), h('p', {}, 'There are no activities for this sport. Pick another sport in the filters.')));
  } else {
    const s = summarize(acts);
    main.append(statGrid(s, acts));
    main.append(recordsSection(acts));
    if (state.sport === 'all') {
      main.append(h('h2', {}, 'By sport'), h('div', { class: 'card' }, summaryTable('Sport', bySport(all).map((x): [string, Summary] => [x.sport, x.summary]))));
    }
    const yearRows = byPeriod(acts, 'year', state.tz);
    main.append(h('h2', { id: 'periods' }, 'By year'), h('div', { class: 'card' }, summaryTable('Year', yearRows.map((r): [string, Summary] => [r.key, r.summary]))));
    const months = monthRows(byPeriod(acts, 'month', state.tz), acts);
    main.append(h('div', { class: 'h2row' }, h('h2', {}, 'By month'), yearTabs(acts, 'Year shown in the month table')),
      h('div', { class: state.monthYear === 'all' ? 'card scroll' : 'card' }, summaryTable('Month', months.map((r): [string, Summary] => [r.label, r.summary]))));
    main.append(h('h2', {}, 'By weekday'), h('div', { class: 'card' }, summaryTable('Weekday', byWeekday(acts, state.tz).map((r): [string, Summary] => [r.label, r.summary]))));
    main.append(h('details', {}, h('summary', {}, 'By ISO week'), h('div', { class: 'card scroll' }, summaryTable('Week', byPeriod(acts, 'week', state.tz).map((r): [string, Summary] => [`${r.key} (${r.start})`, r.summary]).reverse()))));
    main.append(zonesSection(all, acts, hz, pz));
    main.append(loopsSection(acts));
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
  const rows: (string | Node | null)[][] = [
    ['Longest activity', r.longest ? `${dist(r.longest.distanceM)} ${distanceUnit(u)}` : dash, link(r.longest)],
    ['Biggest climb', r.biggestClimb ? `${elev(r.biggestClimb.elevGainM)} ${elevationUnit(u)}` : dash, link(r.biggestClimb)],
    ['Longest duration', r.longestDuration ? formatDuration(r.longestDuration.movingS) : dash, link(r.longestDuration)],
    ['Fastest average speed (≥ 5 km, ≥ 10 min)', r.fastest ? `${fmt(speed(r.fastest.distanceM / r.fastest.movingS, u))} ${speedUnit(u)}` : dash, link(r.fastest)],
    ['Most active day', r.mostActiveDay ? `${dist(r.mostActiveDay.distanceM)} ${distanceUnit(u)}` : dash, r.mostActiveDay ? `${r.mostActiveDay.date} (${plural(r.mostActiveDay.count, 'activity', 'activities')})` : ''],
    ['Most active month', r.mostActiveMonth ? `${dist(r.mostActiveMonth.distanceM)} ${distanceUnit(u)}` : dash, r.mostActiveMonth ? `${r.mostActiveMonth.key} (${plural(r.mostActiveMonth.count, 'activity', 'activities')})` : ''],
    ['Longest streak', r.longestStreak ? plural(r.longestStreak.days, 'day') : dash, r.longestStreak ? `${r.longestStreak.start} → ${r.longestStreak.end}` : ''],
    ['Current streak (as of last activity)', r.currentStreak ? plural(r.currentStreak.days, 'day') : dash, r.currentStreak ? `ending ${r.currentStreak.end}` : ''],
  ];
  return h('div', {}, h('h2', { id: 'records' }, 'Records'), h('div', { class: 'card' }, table(['Record', 'Value', 'Details'], rows.map((x) => x.map((c) => c ?? '')), { numCols: [1] })));
}

function summaryTable(label: string, rows: [string, Summary][]): HTMLElement {
  const u = state.units;
  return table(
    [label, 'Activities', `Distance (${distanceUnit(u)})`, 'Moving time', `Elevation (${elevationUnit(u)})`, `Avg dist (${distanceUnit(u)})`, `Median (${distanceUnit(u)})`, `Avg speed (${speedUnit(u)})`, 'Avg HR', 'Avg W'],
    rows.map(([k, s]) => [k, s.count, dist(s.distanceM), formatHours(s.movingS), elev(s.elevGainM), dist(s.avgDistanceM), dist(s.medianDistanceM), fmt(speed(s.avgSpeedMps, u)), opt(s.avgHr), opt(s.avgPower)]),
  );
}

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
  if (o.climbYear !== 'all' && (!o.climbYear || !years.includes(o.climbYear))) o.climbYear = years[0] ?? null;
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

const posterName = (t: PosterType) => POSTER_TYPES.find((x) => x.id === t)!.name;
const posterFile = (acts: Activity[], t: PosterType, ext: string) => exportFilename(acts, state.sport, `poster-${t}`, ext, state.tz);

async function downloadPng(acts: Activity[], t: PosterType, status: HTMLElement): Promise<void> {
  status.textContent = 'Rendering PNG…';
  try {
    const r = posterFor(t, acts);
    const png = await svgToPng(r.svg, r.width, r.height);
    download(posterFile(acts, t, 'png'), png.blob, 'image/png');
    status.textContent = `${png.width} × ${png.height} px`;
  } catch (e) { status.textContent = e instanceof Error ? e.message : String(e); }
}

/** Per-poster settings, shown on the poster's card. */
function posterSettings(t: PosterType, acts: Activity[]): HTMLElement[] {
  const pick = <T extends string>(label: string, value: T, options: [T, string][], on: (v: T) => void) =>
    h('label', {}, label, h('select', { 'aria-label': `${posterName(t)}: ${label}`, onchange: (e) => { on((e.target as HTMLSelectElement).value as T); render(); } },
      ...options.map(([v, x]) => h('option', { value: v, selected: v === value }, x))));
  const o = posterOpts(acts);
  const years = yearsOf(acts).map((y): [string, string] => [String(y), String(y)]);
  switch (t) {
    case 'facets': return [pick('Sort by', poster.facetSort, [['date', 'Date'], ['distance', 'Distance']], (v) => (poster.facetSort = v))];
    case 'calendar': case 'rings': case 'cumulative': return [pick('Measure', poster.calendarMetric, [['distance', 'Distance'], ['time', 'Time']], (v) => (poster.calendarMetric = v))];
    case 'circles': return [pick('Colour by', poster.circleColor, [['year', 'Year'], ['sport', 'Sport']], (v) => (poster.circleColor = v))];
    case 'timeofday': return [pick('Rows', poster.todRows, [['year', 'Years'], ['month', 'Months'], ['weekday', 'Weekdays']], (v) => (poster.todRows = v))];
    case 'punchcard': return [pick('Dot size', poster.punchMetric, [['count', 'Activities'], ['distance', 'Distance']], (v) => (poster.punchMetric = v))];
    case 'ridgelines': return [
      pick('Activities', poster.ridgeSelect, [['recent', 'Most recent'], ['longest', 'Longest'], ['climbiest', 'Biggest climbs']], (v) => (poster.ridgeSelect = v)),
      pick('Count', String(poster.ridgeCount), ['15', '30', '45', '60'].map((c): [string, string] => [c, c]), (v) => (poster.ridgeCount = Number(v)))];
    case 'season': return [pick('Year', String(o.seasonYear), years, (v) => (poster.seasonYear = Number(v)))];
    case 'climb': return [pick('Period', String(o.climbYear), [...years, ['all', 'All time']], (v) => (poster.climbYear = v === 'all' ? 'all' : Number(v)))];
    default: return [];
  }
}

function posterSection(acts: Activity[]): HTMLElement {
  const sec = h('div', {}, h('h2', { id: 'posters' }, 'Posters'));
  if (!acts.length) return h('div', {}, sec, h('div', { class: 'card empty' }, h('h2', {}, 'Nothing to draw'), h('p', {}, 'There are no activities for this sport. Pick another sport in the filters.')));
  const pick = <T extends string>(label: string, value: T, options: [T, string][], on: (v: T) => void) =>
    h('label', {}, label, h('select', { onchange: (e) => { on((e.target as HTMLSelectElement).value as T); render(); } },
      ...options.map(([v, t]) => h('option', { value: v, selected: v === value }, t))));
  const allStatus = h('span', { class: 'muted', role: 'status' });
  const zipAll = async (kind: 'png' | 'svg', btn: HTMLButtonElement) => {
    btn.disabled = true;
    const entries: Record<string, Uint8Array> = {};
    try {
      for (const [i, t] of POSTER_TYPES.entries()) {
        allStatus.textContent = `Rendering ${i + 1} of ${POSTER_TYPES.length}: ${t.name}…`;
        await new Promise((ok) => setTimeout(ok, 0)); // let the status paint
        const r = posterFor(t.id, acts);
        entries[posterFile(acts, t.id, kind)] = kind === 'svg' ? strToU8(r.svg) : new Uint8Array(await (await svgToPng(r.svg, r.width, r.height)).blob.arrayBuffer());
      }
      download(exportFilename(acts, state.sport, `posters-${kind}`, 'zip', state.tz), new Blob([zipSync(entries, { level: 0 })], { type: 'application/zip' }), 'application/zip');
      allStatus.textContent = `${POSTER_TYPES.length} posters saved.`;
    } catch (e) { allStatus.textContent = e instanceof Error ? e.message : String(e); }
    btn.disabled = false;
  };
  const pngAll: HTMLButtonElement = h('button', { id: 'dl-all-png', class: 'primary', onclick: () => zipAll('png', pngAll) }, 'Download all (PNG)');
  const svgAll: HTMLButtonElement = h('button', { id: 'dl-all-svg', onclick: () => zipAll('svg', svgAll) }, 'All as SVG');
  const controls = h('div', { class: 'row card controls', role: 'group', 'aria-label': 'Poster settings' },
    pick('Theme', poster.theme, THEMES.map((t): [string, string] => [t.id, t.name]), (v) => (poster.theme = v)),
    pick('Size', poster.size, SIZES.map((s): [string, string] => [s.id, s.name]), (v) => (poster.size = v)),
    h('label', {}, h('input', { type: 'checkbox', checked: poster.strip, onchange: (e) => { poster.strip = (e.target as HTMLInputElement).checked; render(); } }), 'Stats strip'),
    h('div', { class: 'row grow-end' }, pngAll, svgAll));

  const size = SIZES.find((s) => s.id === poster.size) ?? SIZES[0]!;
  const imgs: [PosterType, HTMLImageElement][] = [];
  const cards = POSTER_TYPES.map((t, i) => {
    const img = h('img', { class: 'poster', id: `poster-${t.id}`, alt: `${t.name} poster`, width: size.px[0], height: size.px[1] });
    imgs.push([t.id, img]);
    const status = h('span', { class: 'muted small', role: 'status' });
    return h('article', { class: 'pcard', 'aria-label': t.name },
      h('button', { class: 'thumb', 'aria-label': `View ${t.name} full screen`, onclick: (e) => openLightbox(acts, i, e.currentTarget as HTMLElement) }, img),
      h('div', { class: 'pcard-body' },
        h('h3', {}, t.name),
        h('div', { class: 'row controls' }, ...posterSettings(t.id, acts)),
        h('div', { class: 'row' },
          h('button', { id: `dl-png-${t.id}`, class: 'primary', onclick: () => downloadPng(acts, t.id, status) }, 'PNG'),
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
    controls, allStatus, h('div', { class: 'gallery' }, ...cards));
}

// ---------- full-screen poster viewer ----------

function openLightbox(acts: Activity[], start: number, opener: HTMLElement): void {
  let i = start;
  const img = h('img', { class: 'lb-img', alt: '' });
  const title = h('h2', { id: 'lb-title' });
  const counter = h('span', { class: 'lb-count', 'aria-live': 'polite' });
  const status = h('span', { class: 'muted small', role: 'status' });
  const show = (k: number) => {
    i = (k + POSTER_TYPES.length) % POSTER_TYPES.length;
    const t = POSTER_TYPES[i]!;
    const r = posterFor(t.id, acts);
    img.src = r.url;
    img.alt = `${t.name} poster`;
    title.textContent = t.name;
    counter.textContent = `${i + 1} / ${POSTER_TYPES.length}`;
    status.textContent = '';
  };
  const close = () => { document.removeEventListener('keydown', onKey); box.remove(); document.body.classList.remove('lb-open'); opener.focus({ preventScroll: true }); };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') show(i - 1);
    else if (e.key === 'ArrowRight') show(i + 1);
    else if (e.key === 'Tab') { // keep focus inside the viewer
      const f = Array.from(box.querySelectorAll('button')) as HTMLElement[];
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
    h('div', { class: 'lb-bar' }, h('div', {}, title, counter),
      h('div', { class: 'row' },
        h('button', { id: 'lb-png', class: 'primary', onclick: () => downloadPng(acts, POSTER_TYPES[i]!.id, status) }, 'PNG'),
        h('button', { onclick: () => { const t = POSTER_TYPES[i]!.id; download(posterFile(acts, t, 'svg'), posterFor(t, acts).svg, 'image/svg+xml'); } }, 'SVG'),
        status, closeBtn)),
    stage);
  show(start);
  document.body.append(box);
  document.body.classList.add('lb-open');
  document.addEventListener('keydown', onKey);
  closeBtn.focus();
}

// ---------- zones ----------

function zoneBar(seconds: number[]): HTMLElement {
  const total = seconds.reduce((a, b) => a + b, 0) || 1;
  return h('div', { class: 'zbar', role: 'img', 'aria-label': 'Zone distribution' }, ...seconds.map((s, i) => {
    const el = h('i', {});
    el.style.width = `${(s / total) * 100}%`;
    el.style.background = ZONE_COLORS[i % ZONE_COLORS.length]!;
    return el;
  }));
}

function zoneTable(title: string, zones: Zone[], rows: ZoneRow[], noun: string): HTMLElement {
  const head = [title, ...zones.map((z) => `${z.name} (min)`), 'Share', 'Coverage'];
  const body = rows.map((r) => {
    if (!r.withData) return [r.key, ...zones.map(() => dash), `No ${noun} data`, `0 / ${r.count}`];
    return [r.key, ...r.seconds.map((s) => fmt(s / 60, 0)), zoneBar(r.seconds), `${r.withData} / ${r.count}`];
  });
  return table(head, body, { numFrom: 1 });
}

function zonesSection(all: Activity[], acts: Activity[], hz: Zone[] | null, pz: Zone[] | null): HTMLElement {
  const sec = h('div', {}, h('h2', { id: 'zones' }, 'Time in zones'));
  const hrIn = h('input', { type: 'number', min: 100, max: 230, value: state.hr?.value ?? '', 'aria-label': 'Heart-rate value in bpm' });
  const modeSel = h('select', { 'aria-label': 'Zone basis' },
    h('option', { value: 'maxHr', selected: state.hr?.mode === 'maxHr' }, 'Max HR'),
    h('option', { value: 'lthr', selected: state.hr?.mode === 'lthr' }, 'Threshold HR'));
  const ftpIn = h('input', { type: 'number', min: 50, max: 600, value: state.ftp ?? '', placeholder: 'e.g. 250', 'aria-label': 'FTP in watts' });
  const apply = h('button', { type: 'submit' }, 'Apply');
  const form = h('form', { class: 'row card', 'aria-label': 'Zone settings', onsubmit: (e) => {
    e.preventDefault();
    const v = Number(hrIn.value);
    if (v >= 100 && v <= 230) state.hr = { mode: modeSel.value as HrZoneConfig['mode'], value: v };
    const f = Number(ftpIn.value);
    state.ftp = f >= 50 && f <= 600 ? f : null;
    render();
  } },
    h('label', {}, 'Heart-rate zones from', modeSel, hrIn, 'bpm'),
    h('label', {}, 'FTP', ftpIn, 'W'), apply);
  sec.append(form);
  if (state.hr && observedMaxHr(all) === state.hr.value && state.hr.mode === 'maxHr') {
    sec.append(h('p', {}, 'Max HR defaults to the highest value recorded in your data. Set your own for better zones.'));
  }

  const block = (stream: 'hr' | 'power', zones: Zone[] | null, noun: string, hint: string) => {
    sec.append(h('h3', {}, stream === 'hr' ? 'Heart rate' : 'Power'));
    const total = zoneTotals(acts, stream, zones ?? []);
    if (!zones) { sec.append(h('p', {}, hint)); return; }
    if (!total.withData) { sec.append(h('p', {}, `None of these activities has ${noun} data, so there is nothing to show.`)); return; }
    sec.append(h('div', { class: 'card' }, h('p', {}, zones.map((z) => `${z.name}: ${z.lower}${z.upper === null ? '+' : '–' + (z.upper - 1)}`).join('  ·  ')),
      zoneTable('Scope', zones, [{ ...total, key: 'All time' }], noun)));
    sec.append(h('div', { class: 'card' }, zoneTable('Year', zones, zonesBy(acts, stream, zones, 'year', state.tz), noun)));
    const months = monthRows(zonesBy(acts, stream, zones, 'month', state.tz), acts).map((r) => ({ ...r, key: r.label }));
    sec.append(h('details', {}, h('summary', {}, 'By month'), h('div', { class: 'row' }, yearTabs(acts, `Year shown in the ${noun} month table`)),
      h('div', { class: state.monthYear === 'all' ? 'card scroll' : 'card' }, zoneTable('Month', zones, months, noun))));
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

function loopsSection(acts: Activity[]): HTMLElement {
  const sec = h('div', {}, h('h2', { id: 'loops' }, 'Most repeated routes'),
    h('p', {}, 'A heuristic: GPS tracks of similar length that stay within about 80 m of each other on average are grouped, in either direction. Close calls can land on either side.'));
  const clusters = clustersFor(state.result!.activities, state.sport).slice(0, 12);
  if (!clusters.length) { sec.append(h('p', {}, 'No repeated routes found (needs at least two GPS activities that follow the same path).')); return sec; }
  const u = state.units;
  sec.append(h('div', { class: 'loops' }, ...clusters.map((c) => h('div', { class: 'loop' }, routeSvg(c.preview),
    h('dl', {},
      h('dt', {}, 'Times done'), h('dd', {}, String(c.count)),
      h('dt', {}, 'Distance'), h('dd', {}, `${dist(c.avgDistanceM)} ${distanceUnit(u)}`),
      h('dt', {}, 'Avg time'), h('dd', {}, formatDuration(c.avgMovingS)),
      h('dt', {}, 'Best time'), h('dd', {}, formatDuration(c.bestMovingS)))))));
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
  const head = ['Date', 'Name', 'Sport', `Distance (${distanceUnit(u)})`, 'Time', `Elev (${elevationUnit(u)})`, 'Avg HR', 'Avg W', ...(hz ?? []).map((z) => `${z.name} min`)];
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
      return [dateOf(a.startMs), h('button', { class: 'link name', title: a.name, onclick: () => openActivity(a.id) }, a.name), a.sport, dist(a.distanceM), formatDuration(a.movingS), elev(a.elevGainM), opt(a.avgHr), opt(a.avgPower), ...(hz ?? []).map((_, i) => (z ? fmt(z[i]! / 60, 0) : dash))];
    });
    holder.replaceChildren(rows.length ? table(head, rows, { numFrom: 3 }) : h('p', {}, 'No activities match your search.'));
    status.textContent = `Showing ${shown.length} of ${matches.length}${q ? ' matching' : ''} activities. Select a name to see its details.`;
    moreBtn.textContent = `Show all ${matches.length}`;
    moreBtn.hidden = shown.length >= matches.length;
  };
  fill();
  const search = h('input', { type: 'search', id: 'activity-search', placeholder: 'Search name, sport or date', value: state.query, 'aria-label': 'Search activities', oninput: (e) => { state.query = (e.target as HTMLInputElement).value; state.showAll = false; fill(); } });
  const sort = h('label', {}, 'Sort by', h('select', { onchange: (e) => { state.sortKey = (e.target as HTMLSelectElement).value as State['sortKey']; fill(); } },
    ...(Object.entries(SORTS) as [State['sortKey'], [string, unknown]][]).map(([k, [t]]) => h('option', { value: k, selected: k === state.sortKey }, t))));
  return h('div', {}, h('h2', { id: 'activities' }, 'Activities'), h('div', { class: 'row card controls' }, search, sort), status, holder, h('p', {}, moreBtn));
}

// ---------- single activity ----------

function openActivity(id: string): void {
  if (state.view !== 'activity') {
    state.returnView = state.view === 'posters' ? 'posters' : 'stats';
    state.returnScroll = window.scrollY;
  }
  state.activityId = id;
  state.view = 'activity';
  state.sheet = false;
  animate = true;
  const depth = ((history.state as { depth?: number } | null)?.depth ?? 0) + 1; // activity entries stacked on the stats page
  history.pushState({ activity: id, depth }, '', '#activity');
  render();
  window.scrollTo(0, 0);
}

function closeActivity(fromHistory = false): void {
  if (state.view !== 'activity') return;
  const depth = (history.state as { depth?: number } | null)?.depth ?? 0;
  if (!fromHistory && depth > 0) { history.go(-depth); return; } // popstate handler finishes the job
  state.view = state.returnView;
  animate = true;
  render();
  window.scrollTo(0, state.returnScroll);
}

window.addEventListener('popstate', (e) => {
  const id = (e.state as { activity?: string } | null)?.activity;
  if (id && state.result) {
    if (state.view !== 'activity') { state.returnView = state.view === 'posters' ? 'posters' : 'stats'; state.returnScroll = window.scrollY; }
    state.activityId = id;
    state.view = 'activity';
    animate = true;
    render();
    window.scrollTo(0, 0);
  } else if (state.view === 'activity') closeActivity(true);
});

// ---------- export / issues ----------

function exportSection(acts: Activity[], hz: Zone[] | null, pz: Zone[] | null): HTMLElement {
  const o: ExportOptions = { units: state.units, tz: state.tz, hrZones: hz, powerZones: pz };
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
