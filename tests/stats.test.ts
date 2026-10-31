import { describe, expect, it } from 'vitest';
import { byPeriod, byWeekday, bySport, filterSport, median, records, streaks, summarize } from '../src/stats/summary';
import { activityZones, hrZones, paceZones, observedMaxHr, powerZones, secondsInZones, zoneIndex, zoneTotals, zonesBy } from '../src/stats/zones';
import { dayNumber, isoWeekKey, parts } from '../src/util/time';
import { distance, elevation, formatDuration, kmToMi, miToKm, speed } from '../src/util/units';
import { act, utc } from './helpers';

const acts = [
  act({ startMs: utc(2023, 1, 1), distanceM: 10_000, movingS: 2000, elevGainM: 100, avgHr: 140, maxHr: 170, avgPower: 200, maxPower: 500 }), // Sun
  act({ startMs: utc(2023, 1, 2), distanceM: 30_000, movingS: 4000, elevGainM: 400, avgHr: 150, maxHr: 180 }),                                  // Mon
  act({ startMs: utc(2023, 1, 3), distanceM: 20_000, movingS: 4000, elevGainM: 50, sport: 'Run' }),                                               // Tue
  act({ startMs: utc(2023, 3, 15), distanceM: 5_000, movingS: 1000, elevGainM: 10, sport: 'Run' }),
  act({ startMs: utc(2024, 1, 1), distanceM: 40_000, movingS: 5000, elevGainM: 600 }),
];

describe('summarize', () => {
  it('totals, mean, median and weighted averages', () => {
    const s = summarize(acts);
    expect(s.count).toBe(5);
    expect(s.distanceM).toBe(105_000);
    expect(s.movingS).toBe(16_000);
    expect(s.elevGainM).toBe(1160);
    expect(s.avgDistanceM).toBe(21_000);
    expect(s.medianDistanceM).toBe(20_000);
    expect(s.avgSpeedMps).toBeCloseTo(105_000 / 16_000);
    // HR weighted by moving time: (140*2000 + 150*4000) / 6000
    expect(s.avgHr).toBeCloseTo(146.6667, 3);
    expect(s.maxHr).toBe(180);
    expect(s.avgPower).toBe(200);
    expect(s.maxPower).toBe(500);
  });
  it('handles empty input', () => {
    const s = summarize([]);
    expect(s).toMatchObject({ count: 0, distanceM: 0, avgSpeedMps: 0, avgHr: null, medianDistanceM: 0 });
  });
  it('median of even count', () => expect(median([1, 2, 3, 10])).toBe(2.5));
});

describe('grouping', () => {
  it('by year', () => {
    const y = byPeriod(acts, 'year', 'UTC');
    expect(y.map((r) => [r.key, r.summary.count, r.summary.distanceM])).toEqual([['2023', 4, 65_000], ['2024', 1, 40_000]]);
  });
  it('by month fills gaps with zero rows', () => {
    const m = byPeriod(acts, 'month', 'UTC');
    expect(m).toHaveLength(13); // 2023-01 … 2024-01
    expect(m[0]).toMatchObject({ key: '2023-01', start: '2023-01-01' });
    expect(m[0]!.summary.count).toBe(3);
    expect(m[1]!.summary.count).toBe(0);
    expect(m[2]!.summary.distanceM).toBe(5000);
    expect(m[12]!.key).toBe('2024-01');
  });
  it('by ISO week (2023-01-01 is Sunday of 2022-W52)', () => {
    const w = byPeriod(acts, 'week', 'UTC');
    expect(w[0]).toMatchObject({ key: '2022-W52', start: '2022-12-26' });
    expect(w[0]!.summary.count).toBe(1);
    expect(w[1]).toMatchObject({ key: '2023-W01', start: '2023-01-02' });
    expect(w[1]!.summary.distanceM).toBe(50_000);
  });
  it('isoWeekKey edge cases', () => {
    expect(isoWeekKey(parts(utc(2021, 1, 3), 'UTC'))).toBe('2020-W53');
    expect(isoWeekKey(parts(utc(2024, 12, 30), 'UTC'))).toBe('2025-W01');
    expect(isoWeekKey(parts(utc(2024, 2, 29), 'UTC'))).toBe('2024-W09');
  });
  it('by weekday (Monday first)', () => {
    const w = byWeekday(acts, 'UTC');
    expect(w.map((r) => r.summary.count)).toEqual([2, 1, 1, 0, 0, 0, 1]); // Mon 01-02 + 2024-01-01, Tue, Wed 03-15, Sun 01-01
  });
  it('by sport and sport filter', () => {
    const s = bySport(acts);
    expect(s.map((x) => [x.sport, x.summary.count])).toEqual([['Ride', 3], ['Run', 2]]);
    expect(filterSport(acts, 'Run')).toHaveLength(2);
    expect(filterSport(acts, 'all')).toHaveLength(5);
  });
  it('respects the time-zone mode: late-evening UTC stays on its UTC day', () => {
    const a = act({ startMs: Date.UTC(2023, 5, 1, 23, 30) });
    expect(byPeriod([a], 'month', 'UTC')[0]!.key).toBe('2023-06');
  });
});

describe('streaks and records', () => {
  it('streaks', () => {
    expect(streaks([])).toEqual({ longest: null, current: null });
    const d = (y: number, m: number, dd: number) => dayNumber({ y, m, d: dd, wd: 0 });
    const s = streaks([d(2023, 1, 1), d(2023, 1, 2), d(2023, 1, 3), d(2023, 1, 3), d(2023, 1, 10), d(2023, 1, 11)]);
    expect(s.longest).toEqual({ days: 3, start: '2023-01-01', end: '2023-01-03' });
    expect(s.current).toEqual({ days: 2, start: '2023-01-10', end: '2023-01-11' });
    // tie: first longest wins; month boundary / leap day
    const t = streaks([d(2024, 2, 28), d(2024, 2, 29), d(2024, 3, 1)]);
    expect(t.longest).toEqual({ days: 3, start: '2024-02-28', end: '2024-03-01' });
  });
  it('records', () => {
    const r = records(acts, 'UTC');
    expect(r.longest!.distanceM).toBe(40_000);
    expect(r.biggestClimb!.elevGainM).toBe(600);
    expect(r.longestDuration!.movingS).toBe(5000);
    expect(r.mostActiveDay).toMatchObject({ date: '2024-01-01', distanceM: 40_000, count: 1 });
    expect(r.mostActiveMonth).toMatchObject({ key: '2023-01', distanceM: 60_000, count: 3 });
    expect(r.longestStreak).toMatchObject({ days: 3, start: '2023-01-01', end: '2023-01-03' });
    expect(r.currentStreak).toMatchObject({ days: 1, end: '2024-01-01' });
    // fastest ignores short activities: 40 km/5000 s = 8 m/s vs 10 km/2000 s = 5 m/s vs 30 km/4000 s=7.5
    expect(r.fastest!.distanceM).toBe(40_000);
  });
});

describe('zones', () => {
  it('HR zones from max HR (hand-computed for 190)', () => {
    const z = hrZones({ mode: 'maxHr', value: 190 });
    expect(z.map((x) => x.lower)).toEqual([0, 114, 133, 152, 171]);
    expect(z[0]!.upper).toBe(114);
    expect(z[4]!.upper).toBeNull();
    expect(zoneIndex(113, z)).toBe(0);
    expect(zoneIndex(114, z)).toBe(1);
    expect(zoneIndex(171, z)).toBe(4);
    expect(zoneIndex(250, z)).toBe(4);
  });
  it('HR zones from LTHR 170 (Friel: cycling by default, running for run-like sports)', () => {
    expect(hrZones({ mode: 'lthr', value: 170 }).map((x) => x.lower)).toEqual([0, 138, 153, 160, 170, 175, 182]);
    expect(hrZones({ mode: 'lthr', value: 170 }, 'Run').map((x) => x.lower)).toEqual([0, 145, 153, 162, 170, 175, 182]);
    expect(hrZones({ mode: 'lthr', value: 170 }).map((x) => x.name)).toEqual(['Z1', 'Z2', 'Z3', 'Z4', 'Z5a', 'Z5b', 'Z5c']);
  });
  it('pace zones from a 4:00 /km threshold (Friel, in 0.1 m/s)', () => {
    const z = paceZones(1000 / 240); // 4.1667 m/s
    expect(z.map((x) => x.lower)).toEqual([0, 32.3, 36.5, 39.3, 41.3, 43, 46.3]);
  });
  it('power zones from FTP 200', () => {
    const z = powerZones(200);
    expect(z).toHaveLength(7);
    expect(z.map((x) => x.lower)).toEqual([0, 110, 150, 180, 210, 240, 300]);
  });
  const z = hrZones({ mode: 'maxHr', value: 190 });
  const a1 = act({ startMs: utc(2023, 1, 1), hrHist: [[100, 60], [120, 30], [175, 10]], maxHr: 175 });
  const a2 = act({ startMs: utc(2023, 2, 1), hrHist: [[140, 100]] });
  const a3 = act({ startMs: utc(2024, 1, 1) }); // no HR
  it('seconds in zones', () => {
    expect(secondsInZones(a1.hrHist!, z)).toEqual([60, 30, 0, 0, 10]);
  });
  it('missing stream is null/not zero', () => {
    expect(activityZones(a3, 'hr', z)).toBeNull();
    const all = zoneTotals([a3], 'hr', z);
    expect(all.withData).toBe(0);
    expect(all.count).toBe(1);
  });
  it('aggregates per all-time / year / month', () => {
    const all = zoneTotals([a1, a2, a3], 'hr', z);
    expect(all.seconds).toEqual([60, 30, 100, 0, 10]);
    expect(all.withData).toBe(2);
    expect(all.totalS).toBe(200);
    const y = zonesBy([a1, a2, a3], 'hr', z, 'year', 'UTC');
    expect(y.map((r) => [r.key, r.totalS, r.withData, r.count])).toEqual([['2023', 200, 2, 2], ['2024', 0, 0, 1]]);
    const m = zonesBy([a1, a2, a3], 'hr', z, 'month', 'UTC');
    expect(m.map((r) => r.key)).toEqual(['2023-01', '2023-02', '2024-01']);
  });
  it('observedMaxHr ignores implausible values', () => {
    expect(observedMaxHr([a1, act({ startMs: 0, maxHr: 240 }), a3])).toBe(175);
    expect(observedMaxHr([a3])).toBeNull();
  });
});

describe('units', () => {
  it('converts', () => {
    expect(kmToMi(1.609344)).toBeCloseTo(1);
    expect(miToKm(26.2)).toBeCloseTo(42.1648, 3);
    expect(distance(10_000, 'metric')).toBe(10);
    expect(distance(1609.344, 'imperial')).toBeCloseTo(1);
    expect(elevation(304.8, 'imperial')).toBeCloseTo(1000);
    expect(speed(10, 'metric')).toBeCloseTo(36);
    expect(speed(10, 'imperial')).toBeCloseTo(22.369, 2);
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(65)).toBe('1:05');
  });
});
