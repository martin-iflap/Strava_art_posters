import { dash, fmt, opt, plural } from './format';
import { h, table, type Row } from './dom';
import { activityPanel } from './activitylist';
import { Cursor, Zoom, chartBox, lineChart, sampleAt, type XYSeries } from './charts';
import { activityLoad, bestPaceCurve, bestPowerCurve, distanceName, durationName, effectiveLabel, effortDistances, thresholdsAt, type Thresholds } from './stats/training';
import { zoneRows } from './zonerows';
import { TILE_SOURCES, attribution, defaultTileSource, routeMap, type TileSource } from './map';
import type { RouteCluster } from './stats/routes';
import { activityZones, type Zone } from './stats/zones';
import type { Activity, Tz, Units } from './types';
import { clockLabel, dayNumber, fromDayNumber, parts, ymd } from './util/time';
import { distance, distanceUnit, elevation, elevationUnit, formatDuration, speed, speedUnit, KM_PER_MI } from './util/units';

export interface DetailContext {
  units: Units;
  tz: Tz;
  /** heart-rate zones for a sport (Friel's running or cycling table), power zones, pace zones (0.1 m/s) */
  hzFor(sport: string): Zone[] | null;
  pz: Zone[] | null;
  paceZ: Zone[] | null;
  /** every activity (all sports), for rankings */
  all: Activity[];
  /** FTP and threshold HR, for training stress */
  thresholds: Thresholds;
  /** the filtered list used for older/newer navigation */
  list: Activity[];
  open(id: string): void;
  back(): void;
  clusters(sport: string): RouteCluster[];
  /** map background, or null when the user has not turned one on */
  tiles: TileSource | null;
  /** switch the map background (a TILE_SOURCES id) */
  setTiles(id: string): void;
}

const PACE_SPORTS = new Set(['Run', 'Walk', 'Hike', 'Trail Run', 'Virtual Run']);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const durTick = (s: number) => durationName(s).replace(' min', 'm').replace(' s', 's').replace(' h ', 'h').replace(' h', 'h');
function durationTicks(lo: number, hi: number): number[] {
  const cand = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800, 18000, 36000].filter((d) => d >= lo * 0.999 && d <= hi * 1.001);
  const out: number[] = [];
  const gap = Math.log(hi / lo) / 8;
  for (const d of cand) if (!out.length || Math.log(d / out[out.length - 1]!) >= gap * 0.9) out.push(d);
  return out;
}

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
  const headline = h('div', { class: 'grid headline' }, ...tiles);
  const effortHolder = h('div', {});

  // effort: the TrainingPeaks-style numbers, each with a one-line explanation
  const tip = (v: string, l: string, help: string) => h('div', { class: 'stat' }, h('b', {}, v), h('span', {}, l), h('small', {}, help));
  const effort: HTMLElement[] = [];
  const load = activityLoad(a, c.thresholds);
  const paceU = u === 'metric' ? 1000 : KM_PER_MI * 1000;
  if (load) effort.push(tip(fmt(load.tss, 0), load.source === 'power' ? 'training stress (TSS)' : load.source === 'pace' ? 'running stress (rTSS)' : 'training stress (hrTSS)',
    `${load.source === 'hr' ? 'From heart rate. ' : load.source === 'pace' ? 'From normalized graded pace. ' : ''}100 = one hour flat out at threshold.${effectiveLabel(c.thresholds, a.startMs)}`));
  if (load) effort.push(tip(fmt(load.if, 2), 'intensity factor', load.if < 0.75 ? 'Easy (recovery or endurance).' : load.if < 0.9 ? 'Moderate (tempo).' : load.if < 1.05 ? 'Hard (threshold).' : 'Very hard: above threshold, typical of short races.'));
  if (a.ngp && PACE_SPORTS.has(a.sport)) effort.push(tip(`${formatDuration(paceU / a.ngp)} /${du}`, 'normalized graded pace', 'Your pace as if the route were flat and steady: hills and surges count as the effort they cost.'));
  if (a.np !== null) effort.push(tip(`${fmt(a.np, 0)} W`, 'normalized power', 'What the effort cost your body: like average power, but surges count extra.'));
  if (a.np !== null && a.avgPower) effort.push(tip(fmt(a.np / a.avgPower, 2), 'variability index', a.np / a.avgPower < 1.06 ? 'Steady effort.' : 'Surgy effort (hills, groups, intervals).'));
  if (a.avgPower !== null && a.powerHist) {
    const secs = a.powerHist.reduce((x, [, s]) => x + s, 0);
    effort.push(tip(`${fmt((a.avgPower * secs) / 1000, 0)} kJ`, 'work', 'Energy you put into the pedals; roughly the kcal you burned.'));
  }
  if (a.avgHr) {
    if (a.np !== null) effort.push(tip(fmt(a.np / a.avgHr, 2), 'efficiency factor', 'Normalized watts per heartbeat. Rising over months on similar rides = better aerobic fitness.'));
    else if ((a.ngp || avgMps > 0) && PACE_SPORTS.has(a.sport)) effort.push(tip(fmt(((a.ngp ?? avgMps) * 60) / a.avgHr, 2), 'efficiency factor', 'Metres per minute (graded) per heartbeat. Rising over months = better aerobic fitness.'));
  }
  if (a.decoupling !== null) effort.push(tip(`${fmt(a.decoupling, 1)} %`, 'aerobic decoupling', a.decoupling < 5 ? 'Under 5 %: heart rate stayed in step with output. Good endurance.' : 'Heart rate drifted up in the second half for the same output (fatigue, heat or low fitness).'));
  if (effort.length) effortHolder.append(h('h3', {}, 'Effort'), h('div', { class: 'grid' }, ...effort));
  else if (!c.thresholds.ftp && !c.thresholds.lthr && (a.hrHist || a.powerHist)) effortHolder.append(h('p', { class: 'small' }, 'Set your FTP, heart rate or threshold pace in Stats → Training load to see training stress for this activity.'));
  void thresholdsAt;
  void root;

  // route + charts, sharing one hover cursor (fraction of the distance)
  const xMax = distance(a.splits?.endM ?? a.distanceM, u);
  const cursor = new Cursor();
  const zoom = new Zoom();
  const charts: HTMLElement[] = [];
  const addChart = (title: string, el: SVGElement) => charts.push(h('figure', { class: 'card chart-card' }, h('figcaption', {}, title), el));
  const base = { xMax, xUnit: du, cursor, zoom };
  if (a.profile) {
    const ev = a.profile.map((v) => elevation(v, u));
    addChart(`Elevation (${elevationUnit(u)})`, lineChart({ ...base, values: ev, fmtY: (v) => fmt(v, 0), yUnit: elevationUnit(u), kind: 'elevation', label: 'Elevation profile' }));
  }
  if (a.series?.speed) addChart(`Speed (${speedUnit(u)})`, lineChart({ ...base, values: a.series.speed.map((v) => speed(v, u)), fmtY: (v) => fmt(v, 0), fmtTip: (v) => fmt(v, 1), yUnit: speedUnit(u), kind: 'speed', label: 'Speed along the route', zeroBased: true }));
  if (a.series?.hr) addChart('Heart rate (bpm)', lineChart({ ...base, values: a.series.hr, fmtY: (v) => fmt(v, 0), yUnit: 'bpm', kind: 'hr', label: 'Heart rate along the route' }));
  if (a.series?.power) addChart('Power (W)', lineChart({ ...base, values: a.series.power, fmtY: (v) => fmt(v, 0), yUnit: 'W', kind: 'power', label: 'Power along the route', zeroBased: true }));
  const totalM = a.splits?.endM ?? a.distanceM;
  const describe = (t: number) => {
    const bits = [`${fmt(distance(t * totalM, u))} ${du}`];
    if (a.splits) bits.push(formatDuration(timeAt(a.splits, t * a.splits.endM)));
    if (a.profile) bits.push(`${fmt(elevation(sampleAt(a.profile, t), u), 0)} ${elevationUnit(u)}`);
    return bits.join(' · ');
  };
  const mapNote = h('span', { class: 'map-note' }, c.tiles ? attribution(c.tiles)
    : h('button', { class: 'map-on', title: 'Loads map images from OpenStreetMap volunteers’ servers, which then see which area you are looking at. You can change this in the filters.', onclick: () => c.setTiles(defaultTileSource().id) }, 'Show map background'));
  /** The tile server sent nothing usable: say why (as far as we can tell) and offer the other background. */
  const tilesFailed = () => {
    const other = TILE_SOURCES.find((t) => t !== c.tiles && !t.needsReferrer);
    mapNote.replaceChildren(h('span', { class: 'warn', role: 'status' },
      `${c.tiles!.name} sent no map images${c.tiles!.needsReferrer ? ' (it refuses pages opened from a file or with referrers turned off, and you may be offline)' : ' (you may be offline)'}. `),
      ...(other ? [h('button', { class: 'map-on', onclick: () => c.setTiles(other.id) }, `Use ${other.name}`)] : []));
  };
  const routeCard = a.route
    ? h('figure', { class: 'card route-card' }, routeMap(a.route, { tiles: c.tiles, markers: true, label: `Route of ${a.name}`, cursor, describe, interactive: true, onTilesFailed: tilesFailed }),
        h('figcaption', {}, h('span', { class: 'legend' }, h('span', { class: 'dot start' }), ' start  ', h('span', { class: 'dot finish' }), ' finish'), mapNote))
    : h('div', { class: 'card empty' }, h('p', {}, 'This activity has no GPS track (indoor, manual, or the file was missing or unreadable).'));
  const zoomReset = h('button', { class: 'zoom-reset', hidden: true, onclick: () => zoom.set(null) }, 'Reset zoom');
  const zoomNote = h('span', { class: 'zoom-hint' }, 'Drag across a chart to zoom in on part of the activity');
  zoom.on((r) => {
    zoomReset.hidden = !r;
    zoomNote.textContent = r ? `Showing ${fmt(distance(r[0] * totalM, u))}–${fmt(distance(r[1] * totalM, u))} ${du}${a.splits ? ` (${formatDuration(timeAt(a.splits, r[1] * a.splits.endM) - timeAt(a.splits, r[0] * a.splits.endM))})` : ''}` : 'Drag across a chart to zoom in on part of the activity';
  });
  root.append(h('div', { class: 'detail-top' }, routeCard, headline), effortHolder,
    charts.length ? h('div', { class: 'chart-tools detail-tools' }, zoomNote, h('span', { class: 'spacer' }), zoomReset) : '',
    h('div', { class: 'charts detail-charts' }, ...(charts.length ? charts : [h('div', { class: 'card empty' }, h('p', {}, 'No elevation, speed, heart-rate or power data for this activity.'))])));

  // zones
  const paceRange = (z: Zone) => `${z.lower === 0 ? `slower than ${formatDuration(paceU / (z.upper! / 10))}` : z.upper === null ? `faster than ${formatDuration(paceU / (z.lower / 10))}` : `${formatDuration(paceU / (z.upper / 10))}–${formatDuration(paceU / (z.lower / 10))}`} /${du}`;
  const zoneBlock = (title: string, zones: Zone[] | null, stream: 'hr' | 'power' | 'pace') => {
    const sec = h('div', {}, h('h3', {}, title));
    const z = zones ? activityZones(a, stream, zones) : null;
    if (!zones) { sec.append(h('p', {}, stream === 'power' ? 'Enter your FTP in Stats → Training load to see power zones.' : stream === 'pace' ? 'Enter your threshold pace in Stats → Training load to see pace zones.' : 'No heart-rate data in this export.')); return sec; }
    if (!z) { sec.append(h('p', {}, stream === 'hr' ? 'This activity has no heart-rate data.' : stream === 'pace' ? 'This activity has no speed data.' : 'This activity has no power data.')); return sec; }
    sec.append(h('div', { class: 'card' }, zoneRows(zones, z, stream === 'hr' ? 'bpm' : stream === 'power' ? 'W' : '', stream === 'pace' ? paceRange : undefined)));
    return sec;
  };
  const hz = c.hzFor(a.sport);
  if (a.hrHist || a.powerHist || hz) {
    root.append(h('h2', {}, 'Zones'), zoneBlock('Heart rate', hz, 'hr'));
    if (a.powerHist || c.pz) root.append(zoneBlock('Power', c.pz, 'power'));
    if (PACE_SPORTS.has(a.sport) && a.speedHist) root.append(zoneBlock('Pace', c.paceZ, 'pace'));
  }

  // power curve against your all-time best
  if (a.powerCurve && a.powerCurve.length > 2) {
    const best = bestPowerCurve(c.all.filter((x) => x.sport === a.sport && x.powerCurve));
    const series: XYSeries[] = [
      { name: 'This activity', cls: 's-main', points: a.powerCurve, area: true },
      { name: `Your best (${a.sport.toLowerCase()})`, cls: 's-compare', points: best.filter((p) => p.seconds <= a.powerCurve![a.powerCurve!.length - 1]![0]).map((p) => [p.seconds, p.watts]) },
    ];
    const records = a.powerCurve.filter(([s, w]) => best.find((p) => p.seconds === s)?.watts === w && best.find((p) => p.seconds === s)?.activityId === a.id);
    const recNames = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200].filter((d) => records.some(([s]) => s === d));
    const byId = new Map(c.all.map((x) => [x.id, x]));
    root.append(h('h2', {}, 'Power curve'),
      h('figure', { class: 'card chart-card' },
        chartBox({ key: `act-curve-${a.id}`, series, log: true, label: 'Best average power for each duration in this activity, against your best ever', xTicks: durationTicks,
          fmtX: durTick, tipX: (x) => `Best ${durationName(x)}`, fmtY: (v) => `${fmt(v, 0)}`, yZero: true,
          tipExtra: (name, x) => { if (name === 'This activity') return null; const p = best.find((q) => q.seconds === x); return p ? `${byId.get(p.activityId)?.name ?? ''} · ${ymd(parts(p.startMs, c.tz))}` : null; },
          onPick: (x) => { const p = best.find((q) => q.seconds === x); if (p && p.activityId !== a.id) c.open(p.activityId); } })),
      recNames.length ? h('p', { class: 'small' }, `Your best ever ${recNames.map(durationName).join(', ')} power ${recNames.length === 1 ? 'was' : 'were'} set in this activity.`) : h('p', { class: 'small' }, 'Select a point on your best line to open the activity that set it.'));
  }
  // pace curve for runs
  if (PACE_SPORTS.has(a.sport) && a.paceCurve && a.paceCurve.length > 10) {
    const best = bestPaceCurve(c.all.filter((x) => x.sport === a.sport && x.paceCurve));
    const max = a.paceCurve[a.paceCurve.length - 1]![0];
    const series: XYSeries[] = [
      { name: 'This activity', cls: 's-main', points: a.paceCurve.filter(([s]) => s >= 10) },
      { name: `Your best (${a.sport.toLowerCase()})`, cls: 's-compare', points: best.filter((p) => p.seconds >= 10 && p.seconds <= max).map((p) => [p.seconds, p.watts]) },
    ];
    root.append(h('h2', {}, 'Pace curve'), h('figure', { class: 'card chart-card' },
      chartBox({ key: `act-pace-${a.id}`, series, log: true, label: 'Best average pace for each duration in this activity, against your best ever', xTicks: durationTicks, fmtX: durTick, tipX: (x) => `Best ${durationName(x)}`,
        fmtY: (v) => (v > 0.3 ? formatDuration(paceU / v) : dash),
        onPick: (x) => { const p = best.find((q) => q.seconds === x); if (p && p.activityId !== a.id) c.open(p.activityId); } })));
  }

  // best efforts, with where they rank among your activities of this sport
  const wanted = new Set(effortDistances(a.sport).map((m) => Math.round(m)));
  const efforts = (a.bestEfforts ?? []).filter(([m]) => wanted.has(Math.round(m)));
  if (efforts.length) {
    const same = c.all.filter((x) => x.sport === a.sport && x.bestEfforts);
    const unitM = u === 'metric' ? 1000 : KM_PER_MI * 1000;
    const pace = PACE_SPORTS.has(a.sport);
    root.append(h('h2', {}, 'Best efforts'), h('div', { class: 'card scroll' }, table(['Distance', 'Time', pace ? `Pace (/${du})` : `Speed (${speedUnit(u)})`, 'Rank'],
      efforts.map(([m, s]) => {
        const times = same.map((x) => x.bestEfforts!.find(([mm]) => Math.abs(mm - m) < 1)?.[1]).filter((v): v is number => v !== undefined);
        const n = 1 + times.filter((t) => t < s).length;
        return [distanceName(m), h('span', {}, formatDuration(s), n === 1 ? h('span', { class: 'pr' }, 'PR') : n <= 3 ? h('span', { class: 'pr second' }, n === 2 ? '2nd' : '3rd') : null),
          pace ? formatDuration((s / m) * unitM) : fmt(speed(m / s, u)), `#${n} of ${times.length}`];
      }), { numCols: [1, 2, 3] })),
      h('p', { class: 'small' }, `Fastest stretch of each distance inside this activity, ranked against your other ${a.sport.toLowerCase()} activities.`));
  }

  // laps from the device: selecting one zooms the charts to it
  if (a.laps && a.laps.length > 1) {
    const laps = a.laps;
    const pace = PACE_SPORTS.has(a.sport);
    const unitM = u === 'metric' ? 1000 : KM_PER_MI * 1000;
    const secsOf = (l: (typeof laps)[number]) => (l.movingS > 0 ? l.movingS : l.timeS);
    const has = { hr: laps.some((l) => l.avgHr), pw: laps.some((l) => l.avgPower), np: laps.some((l) => l.np), cad: laps.some((l) => l.avgCadence), ele: laps.some((l) => l.elevGainM > 0) };
    const usePower = has.pw && !pace;
    const intensity = (l: (typeof laps)[number]) => (usePower ? l.np ?? l.avgPower ?? 0 : l.distanceM > 0 && secsOf(l) > 0 ? l.distanceM / secsOf(l) : 0);
    const top = Math.max(...laps.map(intensity), 1e-9);
    const ftp = c.thresholds.ftp;
    const heads = ['Lap', 'Time', 'Distance', pace ? `Pace (/${du})` : `Speed (${speedUnit(u)})`, ...(has.hr ? ['Avg HR', 'Max HR'] : []), ...(has.pw ? ['Avg W'] : []), ...(has.np ? ['NP'] : []), ...(has.np && ftp ? ['IF'] : []), ...(has.ele ? [`Climb (${elevationUnit(u)})`] : []), ...(has.cad ? ['Cadence'] : []), ''];
    let picked = -1;
    const body: Row[] = laps.map((l, i) => {
      const bar = h('div', { class: 'splitbar', title: usePower ? `${fmt(intensity(l), 0)} W` : '' });
      bar.style.width = `${Math.max(4, (intensity(l) / top) * 100)}%`;
      const secs = secsOf(l);
      return {
        key: String(i), label: `Zoom the charts to lap ${i + 1}`,
        cells: [String(i + 1), formatDuration(l.timeS), l.distanceM > 0 ? fmt(distance(l.distanceM, u), 2) : dash,
          l.distanceM > 0 && secs > 0 ? (pace ? formatDuration((secs / l.distanceM) * unitM) : fmt(speed(l.distanceM / secs, u))) : dash,
          ...(has.hr ? [l.avgHr ? String(l.avgHr) : dash, l.maxHr ? String(l.maxHr) : dash] : []),
          ...(has.pw ? [l.avgPower !== null ? String(l.avgPower) : dash] : []),
          ...(has.np ? [l.np ? String(Math.round(l.np)) : dash] : []),
          ...(has.np && ftp ? [l.np ? fmt(l.np / ftp, 2) : dash] : []),
          ...(has.ele ? [fmt(elevation(l.elevGainM, u), 0)] : []),
          ...(has.cad ? [l.avgCadence ? String(l.avgCadence) : dash] : []),
          bar],
        onClick: () => {
          lapTable.querySelectorAll('tr.selected').forEach((tr) => tr.classList.remove('selected'));
          if (picked === i || !(totalM > 0)) { picked = -1; zoom.set(null); return; }
          picked = i;
          lapTable.tBodies[0]!.rows[i]!.classList.add('selected');
          zoom.set([l.startM / totalM, Math.min(1, (l.startM + Math.max(l.distanceM, 1)) / totalM)]);
          charts[0]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        },
      };
    });
    const lapTable = table(heads, body, { numFrom: 1 });
    zoom.on((r) => { if (!r && picked >= 0) { picked = -1; lapTable.querySelectorAll('tr.selected').forEach((tr) => tr.classList.remove('selected')); } });
    const manual = laps.filter((l) => l.trigger === 'manual').length;
    const auto = laps.find((l) => l.trigger === 'distance' || l.trigger === 'time');
    root.append(h('h2', {}, `Laps (${laps.length})`), h('div', { class: 'card scroll laps-card' }, lapTable),
      h('p', { class: 'small' }, `From the device${auto ? ` (auto-lap by ${auto.trigger})` : manual > 1 ? ' (lap button)' : ''}. Time is the lap timer; ${pace ? 'pace' : 'speed'} uses moving time. Select a lap to zoom the charts to it, select it again to zoom out. The bar shows ${usePower ? 'normalized power' : pace ? 'pace' : 'speed'} against the strongest lap.`));
  }

  // splits: selecting a row shows that stretch on the map and charts
  const rows = splitRows(a, u);
  if (rows.length) {
    const pace = PACE_SPORTS.has(a.sport);
    const best = Math.min(...rows.filter((r) => r.seconds > 0).map((r) => r.seconds / r.meters));
    const endM = a.splits!.endM;
    let fromM = 0;
    const body: Row[] = rows.map((r, i) => {
      const perM = r.seconds / r.meters;
      const bar = h('div', { class: 'splitbar', title: `${du} ${r.label}: ${formatDuration(r.seconds)}` });
      bar.style.width = `${Math.max(4, Math.min(100, (best / perM) * 100))}%`;
      const mid = (fromM + r.meters / 2) / endM;
      fromM += r.meters;
      return {
        key: String(i), label: `Show ${du} ${r.label} on the map and charts`,
        cells: [r.label, formatDuration(r.seconds), r.seconds > 0 ? (pace ? formatDuration(perM * (u === 'metric' ? 1000 : KM_PER_MI * 1000)) : fmt(speed(r.meters / r.seconds, u))) : dash, bar],
        onClick: () => {
          splits.querySelectorAll('tr.selected').forEach((tr) => tr.classList.remove('selected'));
          splits.tBodies[0]!.rows[i]!.classList.add('selected');
          cursor.set(mid);
        },
      };
    });
    const splits = table([du, 'Time', pace ? `Pace (/${du})` : `Speed (${speedUnit(u)})`, ''], body, { numFrom: 1 });
    root.append(h('h2', {}, `Splits per ${du}`), h('div', { class: 'card scroll' }, splits));
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
    const all = cl.activityIds.map((id) => byId.get(id)!);
    const panelHolder = h('div', {});
    const toggle: HTMLButtonElement = h('button', { 'aria-expanded': 'false', onclick: () => {
      const open = !panelHolder.firstChild;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Hide the list' : `Show all ${cl.count}`;
      panelHolder.replaceChildren(...(open ? [activityPanel('list-route', `This route, done ${cl.count} times`, [...all].sort((x, y) => y.startMs - x.startMs),
        { units: u, tz: c.tz, tiles: c.tiles, open: c.open, close: () => toggle.click() })] : []));
    } }, `Show all ${cl.count}`);
    const byDate = [...times].sort((x, y) => x.startMs - y.startMs);
    const dayOf = (x: Activity) => dayNumber(parts(x.startMs, c.tz));
    const onDay = new Map(byDate.map((x) => [dayOf(x), x]));
    const trend = byDate.length >= 3 ? h('figure', { class: 'card chart-card' }, h('figcaption', {}, 'Moving time on this route, by date (lower is faster)'),
      chartBox({ key: `route-${a.id}`, label: 'Moving time of each activity on this route, by date', height: 180,
        series: [{ name: 'Each time', cls: 's-compare', points: byDate.map((x) => [dayOf(x), Math.round(x.movingS)]) }, { name: 'This one', cls: 's-fatigue', dots: true, points: [[dayOf(a), Math.round(a.movingS)]] }],
        xTicks: (lo, hi) => { const out: number[] = []; const p = fromDayNumber(Math.floor(lo)); const step = hi - lo > 900 ? 12 : hi - lo > 300 ? 3 : 1; for (let y = p.y, m = p.m; ; m++) { if (m > 12) { m = 1; y++; } const d = dayNumber({ y, m, d: 1, wd: 0 }); if (d > hi) break; if (d >= lo && (m - 1) % step === 0) out.push(d); } return out; },
        fmtX: (d) => { const p = fromDayNumber(d); return p.m === 1 ? String(p.y) : MON[p.m - 1]!; }, tipX: (d) => { const p = fromDayNumber(d); return `${p.d} ${MON[p.m - 1]} ${p.y}`; },
        fmtY: (v) => formatDuration(v), tipExtra: (name, x) => (name === 'Each time' ? onDay.get(x)?.name ?? null : null),
        onPick: (x) => { const t = onDay.get(x); if (t && t.id !== a.id) c.open(t.id); } })) : '';
    root.append(h('h2', {}, 'Repeated route'),
      h('p', {}, `You have done this route ${plural(cl.count, 'time')} (best ${formatDuration(cl.bestMovingS)}, average ${formatDuration(cl.avgMovingS)}).${pos ? ` This one is #${pos} fastest of ${times.length}.` : ''} Matching is a heuristic.`), trend,
      h('div', { class: 'card scroll' }, table(['Date', 'Activity', 'Time'], times.slice(0, 8).map((x) => ({
        key: x.id,
        cells: [ymd(parts(x.startMs, c.tz)), x.id === a.id ? `${x.name} (this one)` : h('button', { class: 'link', onclick: () => c.open(x.id) }, x.name), formatDuration(x.movingS)],
      })), { numFrom: 2, selected: a.id })),
      h('p', {}, toggle), panelHolder);
  }
  void opt;
  return root;
}
