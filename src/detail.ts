import { dash, fmt, opt, plural } from './format';
import { h, table } from './dom';
import { lineChart, routeSvg } from './charts';
import type { RouteCluster } from './stats/routes';
import { activityZones, type Zone } from './stats/zones';
import type { Activity, Tz, Units } from './types';
import { clockLabel, parts, ymd } from './util/time';
import { distance, distanceUnit, elevation, elevationUnit, formatDuration, speed, speedUnit, KM_PER_MI } from './util/units';

export interface DetailContext {
  units: Units;
  tz: Tz;
  hz: Zone[] | null;
  pz: Zone[] | null;
  /** every activity (all sports), for rankings */
  all: Activity[];
  /** the filtered list used for older/newer navigation */
  list: Activity[];
  open(id: string): void;
  back(): void;
  clusters(sport: string): RouteCluster[];
}

const ZONE_COLORS = ['#8e8e93', '#30b0c7', '#34c759', '#ff9f0a', '#ff453a', '#bf5af2', '#ff2d55'];
const PACE_SPORTS = new Set(['Run', 'Walk', 'Hike']);

/** Time (s) at a distance along the activity, interpolated over the km-split table. */
function timeAt(sp: NonNullable<Activity['splits']>, m: number): number {
  const ms = [0, ...sp.cum.map((_, i) => (i + 1) * 1000), sp.endM];
  const ts = [0, ...sp.cum, sp.endS];
  for (let i = 1; i < ms.length; i++) {
    if (m <= ms[i]!) {
      const span = ms[i]! - ms[i - 1]!;
      return span > 0 ? ts[i - 1]! + ((m - ms[i - 1]!) / span) * (ts[i]! - ts[i - 1]!) : ts[i]!;
    }
  }
  return sp.endS;
}

export function splitRows(a: Activity, u: Units): { label: string; seconds: number; meters: number }[] {
  const sp = a.splits;
  if (!sp || sp.endM < 200) return [];
  const unit = u === 'metric' ? 1000 : KM_PER_MI * 1000;
  const rows: { label: string; seconds: number; meters: number }[] = [];
  let prevM = 0;
  for (let k = 1; k * unit <= sp.endM + 0.5; k++) {
    rows.push({ label: String(k), seconds: timeAt(sp, k * unit) - timeAt(sp, prevM), meters: unit });
    prevM = k * unit;
  }
  const rest = sp.endM - prevM;
  if (rest >= unit * 0.05) rows.push({ label: fmt(rest / unit, 2), seconds: sp.endS - timeAt(sp, prevM), meters: rest });
  return rows;
}

const rank = (all: Activity[], a: Activity, pick: (x: Activity) => number): { n: number; of: number } | null => {
  const same = all.filter((x) => x.sport === a.sport && pick(x) > 0);
  if (pick(a) <= 0) return null;
  return { n: 1 + same.filter((x) => pick(x) > pick(a)).length, of: same.length };
};

export function activityView(a: Activity, c: DetailContext): HTMLElement {
  const u = c.units;
  const du = distanceUnit(u);
  const d = (m: number) => fmt(distance(m, u));
  const stat = (v: string, l: string) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l));
  const idx = c.list.findIndex((x) => x.id === a.id);
  const newer = idx > 0 ? c.list[idx - 1] : undefined;
  const older = idx >= 0 && idx < c.list.length - 1 ? c.list[idx + 1] : undefined;
  const root = h('div', { class: 'detail' });

  root.append(h('div', { class: 'row detail-nav' },
    h('button', { id: 'back', onclick: c.back }, '← Back to stats'),
    h('span', { class: 'spacer' }),
    older ? h('button', { 'aria-label': `Older activity: ${older.name}`, onclick: () => c.open(older.id) }, '← Older') : null,
    newer ? h('button', { 'aria-label': `Newer activity: ${newer.name}`, onclick: () => c.open(newer.id) }, 'Newer →') : null));
  root.append(h('h2', { id: 'activity-title' }, a.name),
    h('p', { class: 'sub' }, `${a.sport} · ${ymd(parts(a.startMs, c.tz))} ${clockLabel(a.startMs, c.tz)}${c.tz === 'UTC' ? ' UTC' : ''}`));

  // headline numbers (only those the activity actually has)
  const avgMps = a.movingS > 0 ? a.distanceM / a.movingS : 0;
  const tiles: HTMLElement[] = [];
  if (a.distanceM > 0) tiles.push(stat(`${d(a.distanceM)} ${du}`, 'distance'));
  tiles.push(stat(formatDuration(a.movingS), 'moving time'));
  if (a.elapsedS - a.movingS > 60) tiles.push(stat(formatDuration(a.elapsedS - a.movingS), 'stopped time'));
  if (a.elevGainM > 0) tiles.push(stat(`${fmt(elevation(a.elevGainM, u), 0)} ${elevationUnit(u)}`, 'elevation gain'));
  if (avgMps > 0) {
    if (PACE_SPORTS.has(a.sport)) tiles.push(stat(`${formatDuration((u === 'metric' ? 1000 : KM_PER_MI * 1000) / avgMps)} /${du}`, 'average pace'));
    else tiles.push(stat(`${fmt(speed(avgMps, u))} ${speedUnit(u)}`, 'average speed'));
  }
  if (a.maxSpeedMps) tiles.push(stat(`${fmt(speed(a.maxSpeedMps, u))} ${speedUnit(u)}`, 'max speed'));
  if (a.avgHr !== null) tiles.push(stat(`${fmt(a.avgHr, 0)} bpm`, 'average heart rate'));
  if (a.maxHr !== null) tiles.push(stat(`${fmt(a.maxHr, 0)} bpm`, 'max heart rate'));
  if (a.avgPower !== null) tiles.push(stat(`${fmt(a.avgPower, 0)} W`, 'average power'));
  if (a.maxPower !== null) tiles.push(stat(`${fmt(a.maxPower, 0)} W`, 'max power'));
  if (a.avgCadence !== null) tiles.push(stat(`${fmt(a.avgCadence, 0)} rpm`, a.sport === 'Run' ? 'cadence (steps/min)' : 'average cadence'));
  root.append(h('div', { class: 'grid' }, ...tiles));

  // route + charts
  const xMax = distance(a.splits?.endM ?? a.distanceM, u);
  const charts: HTMLElement[] = [];
  const addChart = (title: string, el: SVGElement) => charts.push(h('figure', { class: 'card chart-card' }, h('figcaption', {}, title), el));
  if (a.profile) {
    const ev = a.profile.map((v) => elevation(v, u));
    addChart(`Elevation (${elevationUnit(u)})`, lineChart({ values: ev, xMax, xUnit: du, fmtY: (v) => fmt(v, 0), kind: 'elevation', label: 'Elevation profile' }));
  }
  if (a.series?.speed) addChart(`Speed (${speedUnit(u)})`, lineChart({ values: a.series.speed.map((v) => speed(v, u)), xMax, xUnit: du, fmtY: (v) => fmt(v, 0), kind: 'speed', label: 'Speed along the route', zeroBased: true }));
  if (a.series?.hr) addChart('Heart rate (bpm)', lineChart({ values: a.series.hr, xMax, xUnit: du, fmtY: (v) => fmt(v, 0), kind: 'hr', label: 'Heart rate along the route' }));
  if (a.series?.power) addChart('Power (W)', lineChart({ values: a.series.power, xMax, xUnit: du, fmtY: (v) => fmt(v, 0), kind: 'power', label: 'Power along the route', zeroBased: true }));
  const routeCard = a.route
    ? h('figure', { class: 'card route-card' }, routeSvg(a.route, { markers: true, label: `Route of ${a.name}` }),
        h('figcaption', {}, h('span', { class: 'dot start' }), ' start  ', h('span', { class: 'dot finish' }), ' finish'))
    : h('div', { class: 'card empty' }, h('p', {}, 'This activity has no GPS track (indoor, manual, or the file was missing or unreadable).'));
  root.append(h('div', { class: 'detail-grid' }, routeCard, h('div', { class: 'charts' }, ...(charts.length ? charts : [h('div', { class: 'card empty' }, h('p', {}, 'No elevation, speed, heart-rate or power data for this activity.'))]))));

  // zones
  const zoneBlock = (title: string, zones: Zone[] | null, stream: 'hr' | 'power') => {
    const sec = h('div', {}, h('h3', {}, title));
    const z = zones ? activityZones(a, stream, zones) : null;
    if (!zones) { sec.append(h('p', {}, stream === 'power' ? 'Enter your FTP in Stats → Time in zones to see power zones.' : 'No heart-rate data in this export.')); return sec; }
    if (!z) { sec.append(h('p', {}, stream === 'hr' ? 'This activity has no heart-rate data.' : 'This activity has no power data.')); return sec; }
    const total = z.reduce((x, y) => x + y, 0) || 1;
    const bar = h('div', { class: 'zbar', role: 'img', 'aria-label': `${title} zone distribution` }, ...z.map((s, i) => {
      const el = h('i', {});
      el.style.width = `${(s / total) * 100}%`;
      el.style.background = ZONE_COLORS[i % ZONE_COLORS.length]!;
      return el;
    }));
    sec.append(h('div', { class: 'card' }, bar, table(['Zone', 'Range', 'Time', 'Share'], zones.map((zn, i) => [
      zn.name, `${zn.lower}${zn.upper === null ? '+' : '–' + (zn.upper - 1)}`, formatDuration(z[i]!), `${fmt((z[i]! / total) * 100, 0)} %`]), { numFrom: 2 })));
    return sec;
  };
  if (a.hrHist || a.powerHist || c.hz) {
    root.append(h('h2', {}, 'Zones'), zoneBlock('Heart rate', c.hz, 'hr'));
    if (a.powerHist || c.pz) root.append(zoneBlock('Power', c.pz, 'power'));
  }

  // splits
  const rows = splitRows(a, u);
  if (rows.length) {
    const pace = PACE_SPORTS.has(a.sport);
    const best = Math.min(...rows.filter((r) => r.seconds > 0).map((r) => r.seconds / r.meters));
    root.append(h('h2', {}, `Splits per ${du}`), h('div', { class: 'card scroll' }, table(
      [du, 'Time', pace ? `Pace (/${du})` : `Speed (${speedUnit(u)})`, ''],
      rows.map((r) => {
        const perM = r.seconds / r.meters;
        const bar = h('div', { class: 'splitbar' });
        bar.style.width = `${Math.max(4, Math.min(100, (best / perM) * 100))}%`;
        return [r.label, formatDuration(r.seconds), r.seconds > 0 ? (pace ? formatDuration(perM * (u === 'metric' ? 1000 : KM_PER_MI * 1000)) : fmt(speed(r.meters / r.seconds, u))) : dash, bar];
      }), { numFrom: 1 })));
  }

  // how it compares
  const comps: [string, ReturnType<typeof rank>][] = [
    ['distance', rank(c.all, a, (x) => x.distanceM)],
    ['elevation gain', rank(c.all, a, (x) => x.elevGainM)],
    ['moving time', rank(c.all, a, (x) => x.movingS)],
    ['average speed', rank(c.all, a, (x) => (x.movingS > 0 && x.distanceM >= 1000 ? x.distanceM / x.movingS : 0))],
  ];
  const shown = comps.filter(([, r]) => r !== null) as [string, { n: number; of: number }][];
  if (shown.length) {
    root.append(h('h2', {}, `Among your ${a.sport.toLowerCase()} activities`), h('div', { class: 'grid' }, ...shown.map(([l, r]) => stat(`#${r.n} of ${r.of}`, l))));
  }
  const cl = a.route ? c.clusters(a.sport).find((k) => k.activityIds.includes(a.id)) : undefined;
  if (cl) {
    const byId = new Map(c.all.map((x) => [x.id, x]));
    const times = cl.activityIds.map((id) => byId.get(id)!).filter((x) => x.movingS > 0).sort((x, y) => x.movingS - y.movingS);
    const pos = times.findIndex((x) => x.id === a.id) + 1;
    root.append(h('h2', {}, 'Repeated route'),
      h('p', {}, `You have done this route ${plural(cl.count, 'time')} (best ${formatDuration(cl.bestMovingS)}, average ${formatDuration(cl.avgMovingS)}).${pos ? ` This one is #${pos} fastest of ${times.length}.` : ''} Matching is a heuristic.`),
      h('div', { class: 'card scroll' }, table(['Date', 'Activity', 'Time'], times.slice(0, 8).map((x) => [
        ymd(parts(x.startMs, c.tz)),
        x.id === a.id ? `${x.name} (this one)` : h('button', { class: 'link', onclick: () => c.open(x.id) }, x.name),
        formatDuration(x.movingS)]), { numFrom: 2 })));
  }
  void opt;
  return root;
}
