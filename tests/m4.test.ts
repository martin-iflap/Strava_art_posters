import { describe, expect, it } from 'vitest';
import { SERIES_POINTS } from '../src/types';
import { parseActivitiesCsv } from '../src/parse/csv';
import { parseCsvDate, clockLabel, hourOf } from '../src/util/time';
import { importExport } from '../src/parse/pipeline';
import { expandInputs } from '../src/parse/archive';
import { parseGpx } from '../src/parse/gpx';
import { summarizeTrack } from '../src/parse/track';
import { splitRows } from '../src/detail';
import { packCircles } from '../src/posters/more';
import { DEFAULT_POSTER, renderPoster, POSTER_TYPES, type PosterOptions } from '../src/posters';
import { plural } from '../src/format';
import { generate } from '../src/demo/generate';
import type { Activity } from '../src/types';
import { act, utc } from './helpers';

const enc = (s: string) => new TextEncoder().encode(s);

describe('CSV audit fixes', () => {
  const head = 'Activity ID,Activity Date,Activity Name,Activity Type,Distance,Elapsed Time,Distance\n';
  it('uses the metres column, falls back to km×1000 only when metres is empty', () => {
    const r = parseActivitiesCsv(head + '1,"Jan 5, 2023, 7:00:00 AM",a,Run,5.0,100,5012.5\n2,"Jan 6, 2023, 7:00:00 AM",b,Run,7.0,100,\n');
    expect(r.rows.map((x) => x.distanceM)).toEqual([5012.5, 7000]);
  });
  it('accepts narrow no-break space before AM/PM (newer ICU date strings)', () => {
    expect(parseCsvDate('Jan 5, 2023, 7:32:10 PM')).toBe(Date.UTC(2023, 0, 5, 19, 32, 10));
  });
  it('time-of-day helpers', () => {
    const ms = Date.UTC(2023, 0, 5, 7, 30);
    expect(clockLabel(ms, 'UTC')).toBe('07:30');
    expect(hourOf(ms, 'UTC')).toBe(7.5);
  });
  it('plural', () => {
    expect(plural(1, 'day')).toBe('1 day');
    expect(plural(2, 'activity', 'activities')).toBe('2 activities');
  });
});

describe('pipeline audit fixes', () => {
  it('accepts a lone renamed CSV', async () => {
    const csv = 'Activity ID,Activity Date,Activity Name,Activity Type,Distance,Moving Time\n1,"Jan 5, 2023, 7:00:00 AM",Run,Run,5000,1500\n';
    const r = await importExport(await expandInputs([{ path: 'activities (1).csv', data: enc(csv) }]));
    expect(r.activities).toHaveLength(1);
    expect(r.activities[0]!.distanceM).toBe(5000);
  });
});

function gpxLine(n: number, stepLat: number, secs = 10): string {
  const pts = Array.from({ length: n }, (_, i) => `<trkpt lat="${(50 + i * stepLat).toFixed(6)}" lon="14.0"><ele>${200 + i}</ele><time>${new Date(Date.UTC(2023, 0, 1, 7, 0, i * secs)).toISOString()}</time><extensions><hr>${120 + (i % 10)}</hr></extensions></trkpt>`);
  return `<gpx><trk><type>running</type><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
}

describe('track series and splits', () => {
  // 0.0009° lat ≈ 100 m every 10 s → 10 m/s, 2.5 km in 250 s
  const s = summarizeTrack(parseGpx(gpxLine(26, 0.0009)));
  it('records cumulative moving time at each km', () => {
    expect(s.splits!.cum).toHaveLength(2);
    expect(s.splits!.cum[0]).toBeCloseTo(100, 0);
    expect(s.splits!.cum[1]).toBeCloseTo(200, 0);
    expect(s.splits!.endM).toBeGreaterThan(2490);
    expect(s.splits!.endS).toBeCloseTo(250, 0);
  });
  it('builds speed / hr / elevation series with SERIES_POINTS points', () => {
    expect(s.series!.speed).toHaveLength(SERIES_POINTS);
    expect(s.series!.speed![50]).toBeCloseTo(10, 0);
    expect(s.series!.hr).toHaveLength(SERIES_POINTS);
    expect(s.series!.power).toBeNull();
    expect(s.profile).toHaveLength(SERIES_POINTS);
  });
  it('splitRows: per km with a partial last row, and per mile', () => {
    const a = act({ startMs: 0, sport: 'Run', splits: s.splits });
    const km = splitRows(a, 'metric');
    expect(km.map((r) => r.label)).toEqual(['1', '2', '0.50']);
    expect(km[0]!.seconds).toBeCloseTo(100, 0);
    expect(km[2]!.seconds).toBeCloseTo(50, 0);
    const mi = splitRows(a, 'imperial');
    expect(mi[0]!.label).toBe('1');
    expect(mi[0]!.seconds).toBeCloseTo(160.9, 0); // 1609.344 m at 10 m/s
    expect(splitRows(act({ startMs: 0 }), 'metric')).toEqual([]);
  });
});

describe('packCircles', () => {
  it('never overlaps', () => {
    const radii = Array.from({ length: 150 }, (_, i) => 1 / (1 + i * 0.05));
    const c = packCircles(radii);
    expect(c).toHaveLength(150);
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) {
      expect(Math.hypot(c[i]!.x - c[j]!.x, c[i]!.y - c[j]!.y)).toBeGreaterThanOrEqual(c[i]!.r + c[j]!.r - 1e-9);
    }
  });
});

describe('new posters', () => {
  const opts = (o: Partial<PosterOptions> = {}): PosterOptions => ({ ...DEFAULT_POSTER, units: 'metric', tz: 'UTC', sportLabel: 'All activities', strip: false, ...o });
  const acts: Activity[] = [
    act({ startMs: Date.UTC(2023, 0, 7, 8, 0), distanceM: 40_000, movingS: 5000, sport: 'Ride' }), // Saturday 08:00
    act({ startMs: Date.UTC(2023, 0, 7, 8, 30), distanceM: 10_000, movingS: 3000, sport: 'Run' }),
    act({ startMs: Date.UTC(2024, 5, 3, 18, 0), distanceM: 20_000, movingS: 3600, sport: 'Ride' }),
  ];
  const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
  it('all eighteen posters are listed', () => expect(POSTER_TYPES).toHaveLength(18));
  it('punch card has 168 slots and names the busiest one', () => {
    const p = renderPoster('punchcard', acts, opts());
    expect(count(p.svg, /<circle /g)).toBe(168);
    expect(p.svg).toContain('Busiest slot: Sat 08:00 · 2 activities');
  });
  it('rings: one sector per day of each year, total in the centre', () => {
    const p = renderPoster('rings', acts, opts());
    expect(count(p.svg, /<path /g)).toBe(365 + 366);
    expect(p.svg).toContain('>70<'); // 40+10+20 km
  });
  it('cumulative: one line per year and end labels', () => {
    const p = renderPoster('cumulative', acts, opts());
    expect(count(p.svg, /stroke-linecap="round"/g)).toBe(2);
    expect(p.svg).toContain('2023 · 50 km');
    expect(p.svg).toContain('2024 · 20 km');
  });
  it('time-of-day ridges: rows by year / month / weekday', () => {
    expect(count(renderPoster('timeofday', acts, opts({ todRows: 'year' })).svg, /fill="none" stroke=/g)).toBe(2);
    expect(count(renderPoster('timeofday', acts, opts({ todRows: 'month' })).svg, /fill="none" stroke=/g)).toBe(12);
    expect(count(renderPoster('timeofday', acts, opts({ todRows: 'weekday' })).svg, /fill="none" stroke=/g)).toBe(7);
  });
  it('bubbles: one circle per activity plus legend dots', () => {
    const y = renderPoster('circles', acts, opts());
    expect(count(y.svg, /<circle /g)).toBe(3 + 2); // 2 years
    const s = renderPoster('circles', acts, opts({ circleColor: 'sport' }));
    expect(count(s.svg, /<circle /g)).toBe(3 + 2); // Ride, Run
    expect(s.svg).toContain('>Ride<');
  });
  it('calendar subtitle reflects only the years drawn', () => {
    const many = Array.from({ length: 10 }, (_, i) => act({ startMs: Date.UTC(2010 + i, 5, 1) }));
    const p = renderPoster('calendar', many, opts());
    expect(p.svg).toContain('2012 – 2019');
    expect(p.svg).not.toContain('2010');
  });
});

describe('generated export carries the new fields', () => {
  it('series and splits exist for activities with tracks', async () => {
    const { files } = generate({ seed: 9, density: 0.1 });
    const r = await importExport(await expandInputs(files.map((f) => ({ path: f.path, data: f.data }))));
    const withTrack = r.activities.filter((a) => a.route);
    expect(withTrack.every((a) => a.series && a.splits)).toBe(true);
    const ride = withTrack.find((a) => a.sport === 'Ride' && a.distanceM > 10_000)!;
    expect(ride.splits!.cum.length).toBeGreaterThanOrEqual(Math.floor(ride.distanceM / 1000) - 1);
    // splits are cumulative: strictly non-decreasing
    expect(ride.splits!.cum.every((v, i, arr) => i === 0 || v >= arr[i - 1]!)).toBe(true);
  }, 60_000);
});
