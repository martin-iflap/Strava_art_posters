import './style.css';
import { append, download, h, svg, table } from './dom';
import { fromDrop, fromFileList } from './input';
import { activitiesCsv, exportFilename, periodCsv, sportCsv, statsJson, zonesCsv, type ExportOptions } from './export';
import type { RawInput } from './parse/archive';
import { clusterRoutes } from './stats/routes';
import { byPeriod, byWeekday, bySport, filterSport, records, sportsOf, summarize, type Summary } from './stats/summary';
import { activityZones, hrZones, observedMaxHr, powerZones, zoneTotals, zonesBy, type HrZoneConfig, type Zone, type ZoneRow } from './stats/zones';
import type { Activity, ImportResult, Tz, Units } from './types';
import { distance, distanceUnit, elevation, elevationUnit, formatDuration, formatHours, speed, speedUnit } from './util/units';
import { parts, ymd } from './util/time';
import type { WorkerIn, WorkerOut } from './worker';

interface State {
  result: ImportResult | null;
  sport: string;
  units: Units;
  tz: Tz;
  hr: HrZoneConfig | null;
  ftp: number | null;
  showAll: boolean;
}

const state: State = { result: null, sport: 'all', units: 'metric', tz: 'local', hr: null, ftp: null, showAll: false };
const app = document.getElementById('app')!;
const ZONE_COLORS = ['#8e8e93', '#30b0c7', '#34c759', '#ff9f0a', '#ff453a', '#bf5af2', '#ff2d55'];

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
      state.showAll = false;
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

function renderImporting(phase: string, done: number, total: number): void {
  app.replaceChildren(
    h('main', {}, header(),
      h('div', { class: 'drop', role: 'status', 'aria-live': 'polite' },
        h('h2', {}, 'Reading your export…'),
        h('p', {}, phase),
        h('progress', { max: total, value: done, 'aria-label': 'Import progress' }))),
  );
}

function renderImport(error?: string): void {
  const zipInput = h('input', { type: 'file', multiple: true, hidden: true, accept: '.zip,.csv,.gpx,.tcx,.fit,.gz', onchange: () => importFiles(fromFileList(zipInput.files ?? [])) });
  const dirInput = h('input', { type: 'file', hidden: true, webkitdirectory: true, onchange: () => importFiles(fromFileList(dirInput.files ?? [])) });
  const drop = h('div', { class: 'drop', tabindex: 0, role: 'group', 'aria-label': 'Drop your Strava export here' },
    h('h2', {}, 'Drop your Strava export here'),
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
  app.replaceChildren(
    h('main', {}, header(), drop,
      h('h2', {}, 'How to get your Strava export'),
      h('ol', {},
        h('li', {}, 'On strava.com open Settings → My Account → “Download or Delete Your Account” → “Get Started”.'),
        h('li', {}, 'Choose “Request Your Archive”. Strava emails you a download link (can take a while).'),
        h('li', {}, 'Download the ZIP and drop it here. You do not need to unpack it.')),
      h('p', {}, 'Ride Atlas is an independent project and is not affiliated with Strava.')),
  );
}

function header(): HTMLElement {
  return h('header', {}, h('h1', {}, 'Ride Atlas'), h('p', { class: 'sub' }, 'Your Strava export, analysed privately in this browser tab.'));
}

// ---------- formatting ----------

const fmt = (v: number, d = 1) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const dist = (m: number) => fmt(distance(m, state.units));
const elev = (m: number) => fmt(elevation(m, state.units), 0);
const dash = '–';
const opt = (v: number | null, d = 0) => (v === null ? dash : fmt(v, d));
const dateOf = (ms: number) => ymd(parts(ms, state.tz));

// ---------- results ----------

function exportOptions(acts: Activity[]): ExportOptions {
  return { units: state.units, tz: state.tz, hrZones: currentHrZones(acts), powerZones: state.ftp ? powerZones(state.ftp) : null };
}

function currentHrZones(all: Activity[]): Zone[] | null {
  if (!state.hr) {
    const m = observedMaxHr(all);
    if (m === null) return null;
    state.hr = { mode: 'maxHr', value: m };
  }
  return hrZones(state.hr);
}

function render(): void {
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

  const toolbar = h('div', { class: 'toolbar row', role: 'toolbar', 'aria-label': 'Filters' },
    select('Sport', state.sport, [['all', `All sports (${all.length})`], ...sportsOf(all).map((s): [string, string] => [s, `${s} (${all.filter((a) => a.sport === s).length})`])], (v) => (state.sport = v)),
    select('Units', state.units, [['metric', 'km / m'], ['imperial', 'mi / ft']], (v) => (state.units = v)),
    select('Time zone', state.tz, [['local', 'Local'], ['UTC', 'UTC']], (v) => (state.tz = v)),
    h('button', { onclick: () => { state.result = null; renderImport(); } }, 'Load another export'));

  const main = h('main', {}, header(), toolbar);

  if (!all.length) {
    main.append(h('p', { class: 'warn', role: 'alert' }, 'No activities could be read from this export.'), issuesSection(result));
    app.replaceChildren(main);
    return;
  }

  main.append(h('h2', { id: 'overview' }, 'Overview'));
  if (!acts.length) {
    main.append(h('p', {}, 'No activities for this sport.'));
  } else {
    const s = summarize(acts);
    main.append(statGrid(s, acts));
    main.append(recordsSection(acts));
    if (state.sport === 'all') {
      main.append(h('h2', {}, 'By sport'), h('div', { class: 'card' }, summaryTable('Sport', bySport(all).map((x): [string, Summary] => [x.sport, x.summary]))));
    }
    const yearRows = byPeriod(acts, 'year', state.tz);
    main.append(h('h2', {}, 'By year'), h('div', { class: 'card' }, summaryTable('Year', yearRows.map((r): [string, Summary] => [r.key, r.summary]))));
    main.append(h('h2', {}, 'By month'), h('div', { class: 'card scroll' }, summaryTable('Month', byPeriod(acts, 'month', state.tz).map((r): [string, Summary] => [r.key, r.summary]).reverse())));
    main.append(h('h2', {}, 'By weekday'), h('div', { class: 'card' }, summaryTable('Weekday', byWeekday(acts, state.tz).map((r): [string, Summary] => [r.label, r.summary]))));
    main.append(h('details', {}, h('summary', {}, 'By ISO week'), h('div', { class: 'card scroll' }, summaryTable('Week', byPeriod(acts, 'week', state.tz).map((r): [string, Summary] => [`${r.key} (${r.start})`, r.summary]).reverse()))));
    main.append(zonesSection(all, acts, hz, pz));
    main.append(loopsSection(acts));
    main.append(activitiesSection(acts, hz));
    main.append(exportSection(acts, hz, pz));
  }
  main.append(issuesSection(result));
  app.replaceChildren(main);
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
  const link = (a: Activity | null, _what: string) => (a ? `${a.name} (${dateOf(a.startMs)})` : dash);
  const rows: (string | null)[][] = [
    ['Longest activity', r.longest ? `${dist(r.longest.distanceM)} ${distanceUnit(u)}` : dash, link(r.longest, '')],
    ['Biggest climb', r.biggestClimb ? `${elev(r.biggestClimb.elevGainM)} ${elevationUnit(u)}` : dash, link(r.biggestClimb, '')],
    ['Longest duration', r.longestDuration ? formatDuration(r.longestDuration.movingS) : dash, link(r.longestDuration, '')],
    ['Fastest average speed (≥ 5 km, ≥ 10 min)', r.fastest ? `${fmt(speed(r.fastest.distanceM / r.fastest.movingS, u))} ${speedUnit(u)}` : dash, link(r.fastest, '')],
    ['Most active day', r.mostActiveDay ? `${dist(r.mostActiveDay.distanceM)} ${distanceUnit(u)}` : dash, r.mostActiveDay ? `${r.mostActiveDay.date} (${r.mostActiveDay.count} activities)` : ''],
    ['Most active month', r.mostActiveMonth ? `${dist(r.mostActiveMonth.distanceM)} ${distanceUnit(u)}` : dash, r.mostActiveMonth ? `${r.mostActiveMonth.key} (${r.mostActiveMonth.count} activities)` : ''],
    ['Longest streak', r.longestStreak ? `${r.longestStreak.days} days` : dash, r.longestStreak ? `${r.longestStreak.start} → ${r.longestStreak.end}` : ''],
    ['Current streak (as of last activity)', r.currentStreak ? `${r.currentStreak.days} days` : dash, r.currentStreak ? `ending ${r.currentStreak.end}` : ''],
  ];
  return h('div', {}, h('h2', {}, 'Records'), h('div', { class: 'card' }, table(['Record', 'Value', 'Details'], rows.map((x) => x.map((c) => c ?? '')), { numFrom: 1 })));
}

function summaryTable(label: string, rows: [string, Summary][]): HTMLElement {
  const u = state.units;
  return table(
    [label, 'Activities', `Distance (${distanceUnit(u)})`, 'Moving time', `Elevation (${elevationUnit(u)})`, `Avg dist (${distanceUnit(u)})`, `Median (${distanceUnit(u)})`, `Avg speed (${speedUnit(u)})`, 'Avg HR', 'Avg W'],
    rows.map(([k, s]) => [k, s.count, dist(s.distanceM), formatHours(s.movingS), elev(s.elevGainM), dist(s.avgDistanceM), dist(s.medianDistanceM), fmt(speed(s.avgSpeedMps, u)), opt(s.avgHr), opt(s.avgPower)]),
  );
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
  const apply = h('button', {
    onclick: () => {
      const v = Number(hrIn.value);
      if (v >= 100 && v <= 230) state.hr = { mode: modeSel.value as HrZoneConfig['mode'], value: v };
      const f = Number(ftpIn.value);
      state.ftp = f >= 50 && f <= 600 ? f : null;
      render();
    },
  }, 'Apply');
  sec.append(h('div', { class: 'row card' },
    h('label', {}, 'Heart-rate zones from', modeSel, hrIn, 'bpm'),
    h('label', {}, 'FTP', ftpIn, 'W'), apply));
  sec.append(h('p', {}, state.hr && observedMaxHr(all) === state.hr.value && state.hr.mode === 'maxHr'
    ? 'Max HR defaults to the highest value recorded in your data. Set your own for better zones.' : ''));

  const block = (stream: 'hr' | 'power', zones: Zone[] | null, noun: string, hint: string) => {
    sec.append(h('h3', {}, stream === 'hr' ? 'Heart rate' : 'Power'));
    const total = zoneTotals(acts, stream, zones ?? []);
    if (!zones) { sec.append(h('p', {}, hint)); return; }
    if (!total.withData) { sec.append(h('p', {}, `None of these activities has ${noun} data, so there is nothing to show.`)); return; }
    sec.append(h('div', { class: 'card' }, h('p', {}, zones.map((z) => `${z.name}: ${z.lower}${z.upper === null ? '+' : '–' + (z.upper - 1)}`).join('  ·  ')),
      zoneTable('Scope', zones, [{ ...total, key: 'All time' }], noun)));
    sec.append(h('div', { class: 'card' }, zoneTable('Year', zones, zonesBy(acts, stream, zones, 'year', state.tz), noun)));
    sec.append(h('details', {}, h('summary', {}, 'By month'), h('div', { class: 'card scroll' }, zoneTable('Month', zones, zonesBy(acts, stream, zones, 'month', state.tz).reverse(), noun))));
  };
  block('hr', hz, 'heart-rate', 'No heart-rate data found in this export.');
  block('power', pz, 'power', 'Enter your FTP above to see power zones (only activities with a power stream are counted).');
  return sec;
}

// ---------- loops ----------

function loopsSection(acts: Activity[]): HTMLElement {
  const sec = h('div', {}, h('h2', { id: 'loops' }, 'Most ridden routes'),
    h('p', {}, 'A heuristic: GPS tracks of similar length that stay within about 80 m of each other on average are grouped, in either direction. Close calls can land on either side.'));
  const clusters = clusterRoutes(acts).slice(0, 12);
  if (!clusters.length) { sec.append(h('p', {}, 'No repeated routes found (needs at least two GPS activities that follow the same path).')); return sec; }
  const u = state.units;
  sec.append(h('div', { class: 'loops' }, ...clusters.map((c) => h('div', { class: 'loop' }, routePreview(c.preview),
    h('dl', {},
      h('dt', {}, 'Times ridden'), h('dd', {}, String(c.count)),
      h('dt', {}, 'Distance'), h('dd', {}, `${dist(c.avgDistanceM)} ${distanceUnit(u)}`),
      h('dt', {}, 'Avg time'), h('dd', {}, formatDuration(c.avgMovingS)),
      h('dt', {}, 'Best time'), h('dd', {}, formatDuration(c.bestMovingS)))))));
  return sec;
}

function routePreview(route: number[]): SVGElement {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < route.length; i += 2) {
    minLat = Math.min(minLat, route[i]!); maxLat = Math.max(maxLat, route[i]!);
    minLon = Math.min(minLon, route[i + 1]!); maxLon = Math.max(maxLon, route[i + 1]!);
  }
  const k = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const w = (maxLon - minLon) * k || 1e-6, hh = maxLat - minLat || 1e-6;
  const scale = 92 / Math.max(w, hh);
  const ox = (100 - w * scale) / 2, oy = (100 - hh * scale) / 2;
  const pts: string[] = [];
  for (let i = 0; i < route.length; i += 2) pts.push(`${(ox + (route[i + 1]! - minLon) * k * scale).toFixed(1)},${(oy + (maxLat - route[i]!) * scale).toFixed(1)}`);
  return svg('svg', { viewBox: '0 0 100 100', role: 'img', 'aria-label': 'Route preview' }, svg('polyline', { points: pts.join(' ') }));
}

// ---------- activities ----------

function activitiesSection(acts: Activity[], hz: Zone[] | null): HTMLElement {
  const u = state.units;
  const sorted = [...acts].sort((a, b) => b.startMs - a.startMs);
  const shown = state.showAll ? sorted : sorted.slice(0, 100);
  const head = ['Date', 'Name', 'Sport', `Distance (${distanceUnit(u)})`, 'Time', `Elev (${elevationUnit(u)})`, 'Avg HR', 'Avg W', ...(hz ?? []).map((z) => `${z.name} min`)];
  const rows = shown.map((a) => {
    const z = hz ? activityZones(a, 'hr', hz) : null;
    return [dateOf(a.startMs), a.name, a.sport, dist(a.distanceM), formatDuration(a.movingS), elev(a.elevGainM), opt(a.avgHr), opt(a.avgPower), ...(hz ?? []).map((_, i) => (z ? fmt(z[i]! / 60, 0) : dash))];
  });
  const sec = h('div', {}, h('h2', { id: 'activities' }, 'Activities'), h('div', { class: 'card scroll' }, table(head, rows, { numFrom: 3 })));
  if (sorted.length > shown.length) sec.append(h('p', {}, h('button', { onclick: () => { state.showAll = true; render(); } }, `Show all ${sorted.length}`)));
  return sec;
}

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

renderImport();
