/**
 * Fake Strava export generator. Everything here is invented: made-up place, made-up person, random routes.
 * Pure TypeScript with no Node APIs so it runs in the browser (demo button) and in tests/scripts.
 */
import { gzipSync } from 'fflate';
import { FitBaseType, FitEncoder } from 'fit-file-parser/encoder';
import { elevationGain } from '../parse/track';

export interface ExportFile { path: string; data: Uint8Array }

export interface GenOptions {
  seed?: number;
  /** probability multiplier for activity days (1 ≈ 330 activities over 3.7 years) */
  density?: number;
  /** seconds between samples for rides (runs/walks use half) */
  stepS?: number;
  /** include deliberately broken rows and files */
  corrupt?: boolean;
  /** add a few activities far from home (a cycling holiday and virtual rides), so route posters have regions */
  elsewhere?: boolean;
}

export interface Truth {
  /** CSV rows that should import (rows with a usable date and type, minus duplicates) */
  importable: number;
  /** rows that must be skipped (bad date, missing type, duplicate id) */
  skipped: number;
  /** importable rows whose track file is missing or corrupt */
  warnings: number;
  /** importable rows with a track file that parses */
  withTrack: number;
  /** importable rows by sport */
  bySport: Record<string, number>;
}

const HOME_LAT = 45.1;
const HOME_LON = 7.2;
const M_LAT = 111_320;

function rng32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const range = (r: Rng, a: number, b: number) => a + r() * (b - a);
const pick = <T,>(r: Rng, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
const gauss = (r: Rng) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());

type XY = [number, number];
interface Path { pts: XY[]; closed: boolean; cum: number[]; len: number; eleA: number[]; eleP: number[]; eleF: number[] }

function mkPath(pts: XY[], closed: boolean, r: Rng): Path {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const amp = range(r, 20, 140);
  return { pts, closed, cum, len: cum[cum.length - 1]!, eleA: [amp, amp * 0.4], eleP: [range(r, 6000, 15000), range(r, 800, 2500)], eleF: [r() * 6, r() * 6] };
}

function makeLoop(r: Rng, radius: number, cx: number, cy: number): Path {
  const N = 500;
  const ph = [r() * 6.28, r() * 6.28, r() * 6.28];
  const am = [range(r, 0.1, 0.3), range(r, 0.05, 0.2), range(r, 0.02, 0.1)];
  const pts: XY[] = [];
  for (let i = 0; i <= N; i++) {
    const th = (2 * Math.PI * i) / N;
    const rr = radius * (1 + am[0]! * Math.cos(2 * th + ph[0]!) + am[1]! * Math.cos(3 * th + ph[1]!) + am[2]! * Math.cos(5 * th + ph[2]!));
    pts.push([cx + rr * Math.cos(th), cy + rr * Math.sin(th) * 0.8]);
  }
  pts[N] = pts[0]!;
  return mkPath(pts, true, r);
}

function makeWander(r: Rng, lengthM: number): Path {
  let x = range(r, -3000, 3000), y = range(r, -3000, 3000), h = r() * 6.28;
  const pts: XY[] = [[x, y]];
  const step = 120;
  for (let i = 0; i < lengthM / step; i++) {
    h += gauss(r) * 0.14 - (Math.hypot(x, y) > 9000 ? Math.sin(h - Math.atan2(-y, -x)) * 0.5 : 0);
    x += Math.cos(h) * step; y += Math.sin(h) * step;
    pts.push([x, y]);
  }
  return mkPath(pts, false, r);
}

function at(p: Path, s: number): XY {
  const L = p.len;
  s = p.closed ? ((s % L) + L) % L : Math.min(Math.max(s, 0), L);
  let lo = 0, hi = p.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.cum[m]! <= s) lo = m; else hi = m; }
  const f = (s - p.cum[lo]!) / Math.max(1e-9, p.cum[hi]! - p.cum[lo]!);
  return [p.pts[lo]![0] + (p.pts[hi]![0] - p.pts[lo]![0]) * f, p.pts[lo]![1] + (p.pts[hi]![1] - p.pts[lo]![1]) * f];
}

const eleAt = (p: Path, s: number) => 300 + p.eleA[0]! * Math.sin((2 * Math.PI * s) / p.eleP[0]! + p.eleF[0]!) + p.eleA[1]! * Math.sin((2 * Math.PI * s) / p.eleP[1]! + p.eleF[1]!);

interface Sample { t: number; lat: number; lon: number; ele: number; hr: number; power: number; cad: number; dist: number }
type Kind = 'ride' | 'run' | 'walk';

function simulate(r: Rng, path: Path, kind: Kind, startMs: number, step: number, withHr: boolean, withPower: boolean, origin: [number, number] = [HOME_LAT, HOME_LON]): Sample[] {
  const dir = path.closed && r() < 0.35 ? -1 : 1;
  const offset = path.closed ? r() * path.len : 0;
  const lateral: XY = [gauss(r) * 8, gauss(r) * 8];
  const base = kind === 'ride' ? range(r, 6.5, 9) : kind === 'run' ? range(r, 2.7, 3.5) : range(r, 1.2, 1.5);
  const total = path.closed ? path.len : path.len;
  const out: Sample[] = [];
  let s = 0, t = startMs, dist = 0, hr = 95, prevEle = eleAt(path, offset);
  let stopLeft = 0;
  const hrMax = range(r, 0.62, 0.82);
  while (s < total && out.length < 20000) {
    const pos = at(path, offset + dir * s);
    const ele = eleAt(path, offset + dir * s) + gauss(r) * 0.4;
    const grade = Math.max(-0.12, Math.min(0.12, (ele - prevEle) / Math.max(1, base * step)));
    prevEle = ele;
    let v = stopLeft > 0 ? 0 : Math.max(0.5, base * (1 - grade * 4) * (1 + gauss(r) * 0.06));
    if (stopLeft > 0) stopLeft--;
    else if (r() < 0.004) stopLeft = Math.floor(range(r, 6, 24) / step) + 1;
    const lat = origin[0] + (pos[1] + lateral[1] + gauss(r) * 1.5) / M_LAT;
    const lon = origin[1] + (pos[0] + lateral[0] + gauss(r) * 1.5) / (M_LAT * Math.cos((origin[0] * Math.PI) / 180));
    const target = 95 + (188 - 95) * Math.min(1, hrMax + grade * 2.5) * (v === 0 ? 0.7 : 1);
    hr += (target - hr) * 0.08 + gauss(r) * 1.2;
    const power = v === 0 ? 0 : Math.max(0, Math.min(900, 110 + 22 * v + 2500 * grade * (v / 8) + gauss(r) * 25));
    out.push({
      t, lat, lon, ele, dist,
      hr: withHr ? Math.round(hr) : NaN,
      power: withPower ? Math.round(power) : NaN,
      cad: kind === 'ride' ? (v === 0 ? 0 : Math.round(85 + gauss(r) * 6)) : kind === 'run' ? Math.round(168 + gauss(r) * 3) : NaN,
    });
    const d = v * step;
    s += d; dist += d;
    t += step * 1000;
    if (kind === 'ride' && r() < 0.0015) t += Math.floor(range(r, 40, 240)) * 1000; // paused recording
  }
  return out;
}

// ---------- writers ----------

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: number) => Number.isFinite(v);
const enc = (s: string) => new TextEncoder().encode(s);

function toGpx(name: string, type: string, sm: Sample[]): string {
  const pts = sm.map((p) => {
    let ext = '';
    if (num(p.hr) || num(p.cad)) ext += `<gpxtpx:TrackPointExtension>${num(p.hr) ? `<gpxtpx:hr>${p.hr}</gpxtpx:hr>` : ''}${num(p.cad) ? `<gpxtpx:cad>${p.cad}</gpxtpx:cad>` : ''}</gpxtpx:TrackPointExtension>`;
    if (num(p.power)) ext += `<power>${p.power}</power>`;
    return `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele.toFixed(1)}</ele><time>${new Date(p.t).toISOString()}</time>${ext ? `<extensions>${ext}</extensions>` : ''}</trkpt>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx creator="Fake" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">\n<metadata><time>${new Date(sm[0]!.t).toISOString()}</time></metadata>\n<trk><name>${esc(name)}</name><type>${type}</type><trkseg>\n${pts.join('\n')}\n</trkseg></trk></gpx>\n`;
}

function toTcx(sport: string, sm: Sample[]): string {
  const pts = sm.map((p) =>
    `<Trackpoint><Time>${new Date(p.t).toISOString()}</Time><Position><LatitudeDegrees>${p.lat.toFixed(6)}</LatitudeDegrees><LongitudeDegrees>${p.lon.toFixed(6)}</LongitudeDegrees></Position><AltitudeMeters>${p.ele.toFixed(1)}</AltitudeMeters><DistanceMeters>${p.dist.toFixed(1)}</DistanceMeters>${num(p.hr) ? `<HeartRateBpm><Value>${p.hr}</Value></HeartRateBpm>` : ''}${num(p.cad) ? `<Cadence>${p.cad}</Cadence>` : ''}${num(p.power) ? `<Extensions><TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><Watts>${p.power}</Watts></TPX></Extensions>` : ''}</Trackpoint>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="${sport}"><Id>${new Date(sm[0]!.t).toISOString()}</Id><Lap StartTime="${new Date(sm[0]!.t).toISOString()}"><Track>\n${pts.join('\n')}\n</Track></Lap></Activity></Activities></TrainingCenterDatabase>\n`;
}

const SEMI = 2 ** 31 / 180;
function toFit(sport: number, sm: Sample[]): Uint8Array {
  const e = new FitEncoder();
  const ts = (ms: number) => FitEncoder.toFitTimestamp(new Date(ms));
  e.writeMessage(0, [
    { number: 0, size: 1, baseType: FitBaseType.Enum, value: 4 },
    { number: 1, size: 2, baseType: FitBaseType.Uint16, value: 255 },
    { number: 4, size: 4, baseType: FitBaseType.Uint32, value: ts(sm[0]!.t) },
  ], 0);
  for (const p of sm) {
    e.writeMessage(20, [
      { number: 253, size: 4, baseType: FitBaseType.Uint32, value: ts(p.t) },
      { number: 0, size: 4, baseType: FitBaseType.Sint32, value: Math.round(p.lat * SEMI) },
      { number: 1, size: 4, baseType: FitBaseType.Sint32, value: Math.round(p.lon * SEMI) },
      { number: 2, size: 2, baseType: FitBaseType.Uint16, value: Math.round((p.ele + 500) * 5) },
      { number: 5, size: 4, baseType: FitBaseType.Uint32, value: Math.round(p.dist * 100) },
      { number: 3, size: 1, baseType: FitBaseType.Uint8, value: num(p.hr) ? p.hr : 255 },
      { number: 4, size: 1, baseType: FitBaseType.Uint8, value: num(p.cad) ? p.cad : 255 },
      { number: 7, size: 2, baseType: FitBaseType.Uint16, value: num(p.power) ? p.power : 65535 },
    ], 1);
  }
  const last = sm[sm.length - 1]!;
  e.writeMessage(18, [
    { number: 253, size: 4, baseType: FitBaseType.Uint32, value: ts(last.t) },
    { number: 2, size: 4, baseType: FitBaseType.Uint32, value: ts(sm[0]!.t) },
    { number: 5, size: 1, baseType: FitBaseType.Enum, value: sport },
  ], 2);
  return e.close();
}

// ---------- the export ----------

const HEADER = [
  'Activity ID', 'Activity Date', 'Activity Name', 'Activity Type', 'Activity Description', 'Elapsed Time', 'Distance', 'Max Heart Rate',
  'Relative Effort', 'Commute', 'Activity Private Note', 'Activity Gear', 'Filename', 'Athlete Weight', 'Bike Weight', 'Elapsed Time',
  'Moving Time', 'Distance', 'Max Speed', 'Average Speed', 'Elevation Gain', 'Elevation Loss', 'Elevation Low', 'Elevation High',
  'Max Grade', 'Average Grade', 'Average Positive Grade', 'Average Negative Grade', 'Max Cadence', 'Average Cadence', 'Max Heart Rate',
  'Average Heart Rate', 'Max Watts', 'Average Watts', 'Calories',
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function csvDate(ms: number): string {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${h % 12 || 12}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
}
const q = (s: string | number) => {
  const t = String(s);
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

interface Row {
  id: string; ms: number; name: string; type: string; file: string; elapsed: number; moving: number; dist: number; gain: number;
  maxHr?: number; avgHr?: number; maxW?: number; avgW?: number; maxSpeed?: number; dateText?: string;
}

function csvRow(x: Row): string {
  const c = new Array<string | number>(HEADER.length).fill('');
  c[0] = x.id; c[1] = x.dateText ?? csvDate(x.ms); c[2] = x.name; c[3] = x.type; c[5] = Math.round(x.elapsed); c[6] = (x.dist / 1000).toFixed(2);
  c[12] = x.file; c[15] = Math.round(x.elapsed); c[16] = Math.round(x.moving); c[17] = x.dist.toFixed(1);
  if (x.maxSpeed) c[18] = x.maxSpeed.toFixed(1);
  c[19] = (x.moving > 0 ? x.dist / x.moving : 0).toFixed(3); c[20] = x.gain.toFixed(1);
  if (x.maxHr) { c[7] = x.maxHr; c[30] = x.maxHr; c[31] = x.avgHr!.toFixed(1); }
  if (x.maxW) { c[32] = x.maxW; c[33] = x.avgW!.toFixed(1); }
  return c.map(q).join(',');
}

const NAMES: Record<Kind, string[]> = {
  ride: ['Morning Ride', 'Lunch Ride', 'Evening Ride', 'Weekend Spin', 'Hill Repeats', 'Coffee Ride', 'Long Ride'],
  run: ['Morning Run', 'Lunch Run', 'Evening Run', 'Easy Run', 'Tempo Run'],
  walk: ['Evening Walk', 'Lunch Walk', 'Dog Walk'],
};
const FIT_SPORT: Record<Kind, number> = { ride: 2, run: 1, walk: 11 };
const GPX_TYPE: Record<Kind, string> = { ride: 'cycling', run: 'running', walk: 'walking' };
const TCX_SPORT: Record<Kind, string> = { ride: 'Biking', run: 'Running', walk: 'Other' };
const CSV_TYPE: Record<Kind, string> = { ride: 'Ride', run: 'Run', walk: 'Walk' };

export function generate(opts: GenOptions = {}): { files: ExportFile[]; truth: Truth } {
  const r = rng32(opts.seed ?? 1234);
  const density = opts.density ?? 1;
  const step = opts.stepS ?? 15;
  const corrupt = opts.corrupt ?? true;

  const rideLoops = [makeLoop(r, 5200, 0, 0), makeLoop(r, 8500, 800, -600), makeLoop(r, 3800, -1200, 900), makeLoop(r, 11000, 0, 400)];
  const runLoops = [makeLoop(r, 900, 100, 100), makeLoop(r, 1500, -300, 200), makeLoop(r, 650, 0, -500)];
  const walkLoops = [makeLoop(r, 350, 50, 50), makeLoop(r, 500, -100, 0)];

  const files: ExportFile[] = [];
  const rows: string[] = [];
  const truth: Truth = { importable: 0, skipped: 0, warnings: 0, withTrack: 0, bySport: {} };
  const start = Date.UTC(2021, 2, 1);
  const end = Date.UTC(2024, 9, 31);
  let n = 0;
  let idCounter = 7_000_000_000;

  for (let day = start; day <= end; day += 86_400_000) {
    const d = new Date(day);
    const season = 0.55 + 0.45 * Math.sin(((d.getUTCMonth() - 2) / 12) * 2 * Math.PI);
    const wd = (d.getUTCDay() + 6) % 7;
    const weekend = wd >= 5;
    const todays: Kind[] = [];
    if (r() < (weekend ? 0.55 : 0.2) * season * density) todays.push('ride');
    if (r() < 0.14 * (1.1 - season * 0.4) * density) todays.push('run');
    if (r() < 0.05 * density) todays.push('walk');
    if (d.getUTCFullYear() === 2022 && d.getUTCMonth() === 7 && d.getUTCDate() <= 6) todays.push('ride'); // a streak
    for (const kind of todays) {
      n++;
      const id = String(idCounter++);
      const startMs = day + Math.floor(range(r, 5.5, 19) * 3600_000);
      const loops = kind === 'ride' ? rideLoops : kind === 'run' ? runLoops : walkLoops;
      const oneOff = r() < (kind === 'ride' ? 0.3 : 0.15);
      const path = oneOff ? makeWander(r, kind === 'ride' ? range(r, 20_000, 90_000) : range(r, 3000, 12_000)) : pick(r, loops);
      const hasPower = kind === 'ride' && d.getUTCFullYear() >= 2022 && r() < 0.7;
      const hasHr = r() < 0.85;
      const sm = simulate(r, path, kind, startMs, kind === 'ride' ? step : Math.max(2, step / 2), hasHr, hasPower);
      const dist = sm[sm.length - 1]!.dist;
      const elapsed = (sm[sm.length - 1]!.t - sm[0]!.t) / 1000;
      let moving = 0;
      for (let i = 1; i < sm.length; i++) {
        const dt = (sm[i]!.t - sm[i - 1]!.t) / 1000;
        if (dt <= 30 && (sm[i]!.dist - sm[i - 1]!.dist) / dt >= 0.5) moving += dt;
      }
      const hrs = sm.map((s) => s.hr).filter(num);
      const ws = sm.map((s) => s.power).filter(num);
      const name = pick(r, NAMES[kind]);
      const fmtR = r();
      const base = `activities/${id}`;
      let file: string;
      let payload: Uint8Array;
      if (kind === 'ride' && fmtR < 0.6 || fmtR < 0.4) { payload = toFit(FIT_SPORT[kind], sm); file = `${base}.fit.gz`; payload = gzipSync(payload); }
      else if (fmtR < 0.7) { payload = enc(toGpx(name, GPX_TYPE[kind], sm)); file = `${base}.gpx`; }
      else if (fmtR < 0.85) { payload = gzipSync(enc(toGpx(name, GPX_TYPE[kind], sm))); file = `${base}.gpx.gz`; }
      else { payload = enc(toTcx(TCX_SPORT[kind], sm)); file = `${base}.tcx`; }

      let rowName = name;
      let warn = false;
      let dropFile = false;
      if (corrupt) {
        if (n === 20) { payload = payload.subarray(0, Math.floor(payload.length / 2)); warn = true; } // truncated
        else if (n === 41) { payload = enc('this is not a track file'); file = `${base}.gpx`; warn = true; }
        else if (n === 62) { dropFile = true; warn = true; } // row points at a file that is not in the export
        else if (n === 83) { rowName = '=HYPERLINK("http://example.invalid","click")'; }
        else if (n === 104) { rowName = 'Tour "Alpha", day 1\nsecond line'; }
        if (n === 125) { files.push({ path: 'activities/orphan-9999.gpx', data: enc(toGpx('Orphan', 'cycling', sm.slice(0, 40))) }); }
      }
      if (!dropFile) files.push({ path: file, data: payload });
      rows.push(csvRow({
        id, ms: startMs, name: rowName, type: CSV_TYPE[kind], file, elapsed, moving, dist, gain: elevationGain(sm.map((s) => s.ele)),
        maxHr: hrs.length ? Math.max(...hrs) : undefined, avgHr: hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : undefined,
        maxW: ws.length ? Math.max(...ws) : undefined, avgW: ws.length ? ws.reduce((a, b) => a + b, 0) / ws.length : undefined,
        maxSpeed: undefined,
      }));
      truth.importable++;
      truth.bySport[CSV_TYPE[kind]] = (truth.bySport[CSV_TYPE[kind]] ?? 0) + 1;
      if (warn) truth.warnings++; else truth.withTrack++;
    }

    // Pool swims: CSV row only (no file), plus the occasional gym workout.
    if (r() < 0.03 * density) {
      const id = String(idCounter++);
      const startMs = day + Math.floor(range(r, 6, 20) * 3600_000);
      const dist = Math.round(range(r, 600, 1800));
      rows.push(csvRow({ id, ms: startMs, name: 'Pool Swim', type: 'Swim', file: '', elapsed: dist * 2.1, moving: dist * 1.9, dist, gain: 0 }));
      truth.importable++;
      truth.bySport['Swim'] = (truth.bySport['Swim'] ?? 0) + 1;
    }
  }

  // Far from home, from a separate random stream so the activities above stay the same: a spring cycling
  // holiday on Mallorca and winter rides in Zwift's Watopia (virtual coordinates in the Pacific, as Zwift exports them).
  if (opts.elsewhere ?? true) {
    const r2 = rng32((opts.seed ?? 1234) + 99);
    const trips: { type: string; name: string; origin: [number, number]; days: number[] }[] = [
      { type: 'Ride', name: 'Mallorca ride', origin: [39.75, 2.85], days: [0, 1, 2, 4, 5].map((k) => Date.UTC(2023, 3, 10 + k)) },
      { type: 'Virtual Ride', name: 'Zwift - Watopia', origin: [-11.64, 166.95], days: [0, 9, 17, 30, 44, 58, 71, 85].map((k) => Date.UTC(2023, 11, 1) + k * 86_400_000) },
    ];
    for (const trip of trips) {
      for (const day of trip.days) {
        const id = String(idCounter++);
        const startMs = day + Math.floor(range(r2, 8, 18) * 3600_000);
        const sm = simulate(r2, makeWander(r2, range(r2, 25_000, 70_000)), 'ride', startMs, step, true, trip.type !== 'Ride', trip.origin);
        const last = sm[sm.length - 1]!;
        const file = `activities/${id}.gpx`;
        files.push({ path: file, data: enc(toGpx(trip.name, 'cycling', sm)) });
        const elapsed = (last.t - sm[0]!.t) / 1000;
        rows.push(csvRow({ id, ms: startMs, name: trip.name, type: trip.type, file, elapsed, moving: elapsed * 0.95, dist: last.dist, gain: elevationGain(sm.map((x) => x.ele)) }));
        truth.importable++;
        truth.withTrack++;
        truth.bySport[trip.type] = (truth.bySport[trip.type] ?? 0) + 1;
      }
    }
  }

  if (corrupt) {
    rows.push(csvRow({ id: '7999999001', ms: 0, name: 'Bad date', type: 'Ride', file: '', elapsed: 1, moving: 1, dist: 1, gain: 0, dateText: 'sometime last week' }));
    rows.push(csvRow({ id: '7999999002', ms: Date.UTC(2023, 5, 1, 10), name: 'No type', type: '', file: '', elapsed: 1, moving: 1, dist: 1, gain: 0 }));
    rows.push(rows[0]!); // duplicate id
    truth.skipped = 3;
  }

  const csv = [HEADER.map(q).join(','), ...rows].join('\n') + '\n';
  files.unshift({ path: 'activities.csv', data: enc(csv) });
  return { files, truth };
}

export const generateExport = (opts?: GenOptions): ExportFile[] => generate(opts).files;
