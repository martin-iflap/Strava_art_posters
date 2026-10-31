import type { Activity, Tz, Units } from './types';
import { bySport, byPeriod, records, summarize, type Summary } from './stats/summary';
import { activityZones, zonesBy, zoneTotals, type Zone } from './stats/zones';
import { distance, distanceUnit, elevation, elevationUnit, speed, speedUnit } from './util/units';
import { parts, ymd } from './util/time';

/** RFC-4180 field. Text starting with = + - @ gets a leading apostrophe so spreadsheets never run it as a formula. */
export function csvField(v: string | number | boolean | null | undefined, text = false): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return String(v);
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v;
  if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number | boolean | null)[][], textCols: number[] = []): string {
  const lines = [header.map((h) => csvField(h)).join(',')];
  for (const r of rows) lines.push(r.map((v, i) => csvField(v, textCols.includes(i))).join(','));
  return lines.join('\r\n') + '\r\n';
}

const r = (v: number | null, d = 2) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

export interface ExportOptions {
  units: Units;
  tz: Tz;
  hrZones: Zone[] | null;
  powerZones: Zone[] | null;
}

const summaryHeader = (u: Units) => [
  'activities', `distance_${distanceUnit(u)}`, 'moving_time_s', `elevation_gain_${elevationUnit(u)}`,
  `avg_distance_${distanceUnit(u)}`, `median_distance_${distanceUnit(u)}`, `avg_speed_${speedUnit(u).replace('/', '')}`, 'avg_hr', 'avg_power',
];
const summaryRow = (s: Summary, u: Units): (number | null)[] => [
  s.count, r(distance(s.distanceM, u)), Math.round(s.movingS), r(elevation(s.elevGainM, u), 1),
  r(distance(s.avgDistanceM, u)), r(distance(s.medianDistanceM, u)), r(speed(s.avgSpeedMps, u)), r(s.avgHr, 1), r(s.avgPower, 1),
];

export function activitiesCsv(acts: Activity[], o: ExportOptions): string {
  const u = o.units;
  const zh = (o.hrZones ?? []).map((z) => `hr_${z.name.split(' ')[0]!.toLowerCase()}_s`);
  const zp = (o.powerZones ?? []).map((z) => `power_${z.name.split(' ')[0]!.toLowerCase()}_s`);
  const header = [
    'id', 'date', 'start_time_utc', 'name', 'sport', `distance_${distanceUnit(u)}`, 'moving_time_s', 'elapsed_time_s',
    `elevation_gain_${elevationUnit(u)}`, `avg_speed_${speedUnit(u).replace('/', '')}`, 'avg_hr', 'max_hr', 'avg_power', 'max_power', ...zh, ...zp,
  ];
  const rows = acts.map((a) => {
    const hz = o.hrZones ? activityZones(a, 'hr', o.hrZones) : null;
    const pz = o.powerZones ? activityZones(a, 'power', o.powerZones) : null;
    return [
      a.id, ymd(parts(a.startMs, o.tz)), new Date(a.startMs).toISOString(), a.name, a.sport,
      r(distance(a.distanceM, u)), Math.round(a.movingS), Math.round(a.elapsedS), r(elevation(a.elevGainM, u), 1),
      r(speed(a.movingS > 0 ? a.distanceM / a.movingS : 0, u)), r(a.avgHr, 1), a.maxHr, r(a.avgPower, 1), a.maxPower,
      ...(o.hrZones ? o.hrZones.map((_, i) => (hz ? r(hz[i]!, 1) : null)) : []),
      ...(o.powerZones ? o.powerZones.map((_, i) => (pz ? r(pz[i]!, 1) : null)) : []),
    ];
  });
  return toCsv(header, rows, [0, 3, 4]);
}

export function periodCsv(acts: Activity[], period: 'month' | 'year' | 'week', o: ExportOptions): string {
  const rows = byPeriod(acts, period, o.tz).map((p) => [p.key, p.start, ...summaryRow(p.summary, o.units)]);
  return toCsv([period, 'period_start', ...summaryHeader(o.units)], rows);
}

export function sportCsv(acts: Activity[], o: ExportOptions): string {
  const rows = bySport(acts).map((s) => [s.sport, ...summaryRow(s.summary, o.units)]);
  return toCsv(['sport', ...summaryHeader(o.units)], rows, [0]);
}

/** Long format: one row per (stream, scope, period, zone). Empty seconds + has_data=false when the stream is missing. */
export function zonesCsv(acts: Activity[], o: ExportOptions): string {
  const rows: (string | number | boolean | null)[][] = [];
  const emit = (stream: 'hr' | 'power', zones: Zone[]) => {
    const groups = [
      { scope: 'all', rows: [{ ...zoneTotals(acts, stream, zones), key: 'all' }] },
      { scope: 'year', rows: zonesBy(acts, stream, zones, 'year', o.tz) },
      { scope: 'month', rows: zonesBy(acts, stream, zones, 'month', o.tz) },
    ];
    for (const g of groups) {
      for (const row of g.rows) {
        zones.forEach((z, i) => {
          const has = row.withData > 0;
          rows.push([stream, g.scope, row.key, z.name, z.lower, z.upper, has ? r(row.seconds[i]!, 1) : null, has, row.withData, row.count]);
        });
      }
    }
  };
  if (o.hrZones) emit('hr', o.hrZones);
  if (o.powerZones) emit('power', o.powerZones);
  return toCsv(['stream', 'scope', 'period', 'zone', 'lower', 'upper', 'seconds', 'has_data', 'activities_with_data', 'activities'], rows, [3]);
}

export function statsJson(acts: Activity[], o: ExportOptions): string {
  const rec = records(acts, o.tz);
  const slim = (a: Activity | null) => (a ? { id: a.id, name: a.name, date: ymd(parts(a.startMs, o.tz)), distanceM: a.distanceM, elevGainM: a.elevGainM, movingS: a.movingS } : null);
  const zoneBlock = (stream: 'hr' | 'power', zones: Zone[] | null) =>
    zones && {
      zones,
      all: zoneTotals(acts, stream, zones),
      byYear: zonesBy(acts, stream, zones, 'year', o.tz),
      byMonth: zonesBy(acts, stream, zones, 'month', o.tz),
    };
  return JSON.stringify(
    {
      generatedBy: 'Ride Atlas',
      units: 'SI (metres, seconds, m/s) unless a key says otherwise',
      timezone: o.tz,
      allTime: summarize(acts),
      bySport: bySport(acts),
      byYear: byPeriod(acts, 'year', o.tz),
      byMonth: byPeriod(acts, 'month', o.tz),
      byWeek: byPeriod(acts, 'week', o.tz),
      records: {
        longest: slim(rec.longest), biggestClimb: slim(rec.biggestClimb), fastest: slim(rec.fastest), longestDuration: slim(rec.longestDuration),
        mostActiveDay: rec.mostActiveDay, mostActiveMonth: rec.mostActiveMonth, longestStreak: rec.longestStreak, currentStreak: rec.currentStreak,
      },
      heartRateZones: zoneBlock('hr', o.hrZones),
      powerZones: zoneBlock('power', o.powerZones),
      activities: acts.map((a) => ({
        id: a.id, name: a.name, sport: a.sport, startUtc: new Date(a.startMs).toISOString(), distanceM: a.distanceM, movingS: a.movingS,
        elapsedS: a.elapsedS, elevGainM: a.elevGainM, avgHr: a.avgHr, maxHr: a.maxHr, avgPower: a.avgPower, maxPower: a.maxPower,
      })),
    },
    null,
    1,
  );
}

/** e.g. ride-atlas_Ride_2021-03-04_2024-11-30_monthly.csv */
export function exportFilename(acts: Activity[], sport: string, what: string, ext: string, tz: Tz): string {
  const safe = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
  if (!acts.length) return `ride-atlas_${safe(sport)}_${what}.${ext}`;
  const from = ymd(parts(acts.reduce((m, a) => Math.min(m, a.startMs), Infinity), tz));
  const to = ymd(parts(acts.reduce((m, a) => Math.max(m, a.startMs), -Infinity), tz));
  return `ride-atlas_${safe(sport)}_${from}_${to}_${what}.${ext}`;
}

