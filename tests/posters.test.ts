import { describe, expect, it } from 'vitest';
import { DEFAULT_POSTER, POSTER_TYPES, renderPoster, type PosterOptions } from '../src/posters';
import { esc, mix } from '../src/posters/common';
import { generate } from '../src/demo/generate';
import { expandInputs } from '../src/parse/archive';
import { importExport } from '../src/parse/pipeline';
import type { Activity } from '../src/types';
import { act, utc } from './helpers';
import { sunTimes, workEquivalents, workKj } from '../src/posters/power';

const opts = (o: Partial<PosterOptions> = {}): PosterOptions => ({ ...DEFAULT_POSTER, units: 'metric', tz: 'UTC', sportLabel: 'All activities', ...o });
let acts: Activity[];

async function load() {
  if (!acts) {
    const { files } = generate({ seed: 5, density: 0.2 });
    acts = (await importExport(await expandInputs(files.map((f) => ({ path: f.path, data: f.data }))))).activities;
  }
  return acts;
}
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('posters', () => {
  it('every poster type renders well-formed SVG with no NaN, at each size', async () => {
    const a = await load();
    for (const t of POSTER_TYPES) {
      for (const [size, w, h] of [['a3', 3508, 4961], ['square', 3000, 3000], ['phone', 1290, 2796]] as const) {
        const p = renderPoster(t.id, a, opts({ size, theme: 'ember' }));
        expect(p.width).toBe(w);
        expect(p.height).toBe(h);
        expect(p.svg.startsWith('<svg ')).toBe(true);
        expect(p.svg.endsWith('</svg>')).toBe(true);
        expect(p.svg).not.toMatch(/NaN|undefined|Infinity/);
        expect(p.svg).not.toMatch(/<(?![a-zA-Z/!?])|&(?![a-z]+;|#\d+;|#x[\da-f]+;)/i); // text is escaped
        expect(count(p.svg, /<(?!\/)[a-zA-Z]/g)).toBe(count(p.svg, /<\/[a-zA-Z]+>|\/>/g)); // balanced tags
      }
    }
  });
  it('facets draws one path per GPS route; sorting changes order', async () => {
    const a = await load();
    const p = renderPoster('facets', a, opts({ strip: false }));
    expect(count(p.svg, /<path /g)).toBe(a.filter((x) => x.route).length);
    expect(renderPoster('facets', a, opts({ facetSort: 'distance' })).svg).not.toBe(renderPoster('facets', a, opts()).svg);
  });
  it('calendar has one cell per day of each year shown', async () => {
    const a = [act({ startMs: utc(2023, 5, 1) }), act({ startMs: utc(2024, 5, 1) })];
    const p = renderPoster('calendar', a, opts({ strip: false }));
    expect(count(p.svg, /<rect x=/g)).toBe(365 + 366);
  });
  it('season has 12 bars per chart, honours the year, and escapes labels', () => {
    const a = [act({ startMs: utc(2023, 5, 1), distanceM: 50_000, movingS: 7200 }), act({ startMs: utc(2022, 1, 1) })];
    const p = renderPoster('season', a, opts({ seasonYear: 2023, sportLabel: '<b>"x" & y</b>' }));
    expect(count(p.svg, /<rect x=/g)).toBe(24); // 12 months x 2 charts (empty months are zero-height)
    expect(p.svg).toContain('&lt;b&gt;&quot;x&quot; &amp; y&lt;/b&gt;');
    expect(p.svg).not.toContain('<b>');
    expect(p.svg).toContain('>50<'); // 50 km label
  });
  it('ridgelines selection and count', async () => {
    const a = await load();
    const p = renderPoster('ridgelines', a, opts({ ridgeCount: 15, strip: false }));
    expect(count(p.svg, /fill="none" stroke=/g)).toBe(15);
  });
  it('shows a message instead of an empty poster', () => {
    for (const t of POSTER_TYPES) expect(renderPoster(t.id, [], opts()).svg).toMatch(/No |Not /);
  });
  it('colour helpers', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(esc('<&>')).toBe('&lt;&amp;&gt;');
  });
});

describe('mountains climbed poster', () => {
  it('chains activities: each starts where the previous ended, ending at total distance and gain', async () => {
    const { climbSeries } = await import('../src/posters/climb');
    const a = [
      act({ startMs: utc(2024, 3, 1), distanceM: 20_000, elevGainM: 300 }),
      act({ startMs: utc(2024, 1, 1), distanceM: 10_000, elevGainM: 100, profile: [100, 150, 120, 170] }),
    ];
    const { pts, starts } = climbSeries(a);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([30_000, 400]);
    expect(starts.map((s) => s.d)).toEqual([0, 10_000]); // sorted by date
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]![0]).toBeGreaterThanOrEqual(pts[i - 1]![0]);
      expect(pts[i]![1]).toBeGreaterThanOrEqual(pts[i - 1]![1] - 1e-9);
    }
    // the first activity's gain follows its profile: no rise on the downhill middle third
    const mid = pts.filter(([d]) => d > 10_000 / 3 + 1 && d < (2 * 10_000) / 3 - 1).map(([, e]) => e);
    expect(Math.max(...mid) - Math.min(...mid)).toBeLessThan(1e-6);
  });
  it('counts mountains and states them on the poster', async () => {
    const { mountainCounts } = await import('../src/posters/climb');
    const c = mountainCounts(8849 * 2);
    expect(c.map((x) => x.mountain.name)).toEqual(['Everest', 'Mont Blanc', 'Olympus']);
    expect(c[0]!.count).toBe(2);
    expect(c[2]!.count).toBeCloseTo(17698 / 2918);
    const a = [act({ startMs: utc(2024, 5, 1), distanceM: 50_000, elevGainM: 8849 * 2 }), act({ startMs: utc(2023, 5, 1), elevGainM: 99 })];
    const p = renderPoster('climb', a, opts({ climbYear: 2024 }));
    expect(p.svg).toContain('>2<tspan');
    expect(p.svg).toContain('Everests');
    expect(p.svg).toContain('17,698 m');
    expect(renderPoster('climb', a, opts({ climbYear: 'all' })).svg).toContain('17,797 m');
    expect(renderPoster('climb', a, opts({ climbYear: null })).svg).toContain('2024 ·'); // latest year by default
  });
});

describe('climb overlay, around the world, weekday time of day', () => {
  const a = [
    act({ startMs: utc(2023, 5, 1), distanceM: 30_000_000, elevGainM: 50_000 }),
    act({ startMs: utc(2024, 2, 1), distanceM: 20_000_000, elevGainM: 60_000 }),
    act({ startMs: utc(2024, 6, 3), distanceM: 10_000_000, elevGainM: 10_000 }), // a Monday
  ];
  it('overlay draws one climb line per year, each labelled with its own total', () => {
    const p = renderPoster('climb', a, opts({ climbYear: 'overlay', strip: false }));
    expect(count(p.svg, /fill="none" stroke="#[0-9a-f]{6}" stroke-width="(4\.5|2\.8)"/g)).toBe(2);
    expect(p.svg).toContain('2023 · 50,000 m');
    expect(p.svg).toContain('2024 · 70,000 m');
    expect(p.svg).not.toContain('url(#climbfill)'); // no area fill any more
  });
  it('names the next milestone straight up', async () => {
    const { upward } = await import('../src/posters/climb');
    expect(upward(65_000)).toMatchObject({ share: 0.65, label: 'of the way to space' });
    expect(upward(204_000)).toMatchObject({ share: 0.5, label: 'of the way to the ISS' });
    expect(upward(816_000).share).toBe(2);
  });
  it('around the world counts laps of the equator and the share of the way to the Moon', () => {
    const p = renderPoster('world', a, opts());
    expect(p.svg).toContain('>1.5<tspan'); // 60,000 km / 40,075 km
    expect(p.svg).toContain('>15.6<tspan'); // % of 384,400 km
    expect(p.svg).toContain('>60,000<tspan');
    expect(renderPoster('world', a, opts({ worldYear: 2023 })).svg).toContain('>0.75<tspan');
  });
  it('time of day by weekday covers one year with a row per weekday', () => {
    const p = renderPoster('todweek', a, opts({ todYear: 2024, strip: false }));
    for (const d of ['Mon', 'Tue', 'Sun']) expect(p.svg).toContain(`>${d}<`);
    expect(p.svg).toContain('2024 · when you start');
  });
});

describe('route posters: period and regions', () => {
  it('the demo spreads over home, a holiday and Watopia; All routes shows home by default', async () => {
    const a = await load();
    const p = renderPoster('overlay', a, opts());
    expect(p.svg).toContain('Home area');
    const n = (svg: string) => Number(/(\d+) routes/.exec(svg)![1]);
    expect(n(renderPoster('overlay', a, opts({ overlayRegions: 'all' })).svg)).toBeGreaterThan(n(p.svg));
    const y = renderPoster('facets', a, opts({ facetYear: 2022 }));
    expect(y.svg).toContain('>2022 · ');
    expect(n(y.svg)).toBeLessThan(n(renderPoster('facets', a, opts()).svg));
  });
});

describe('map and chart helpers', () => {
  it('web mercator, view fitting and tile placement', async () => {
    const { mercator, fitView, tilesFor } = await import('../src/map');
    expect(mercator(0, 0)).toEqual([128, 128]);
    expect(mercator(0, 180)[0]).toBe(256);
    expect(mercator(85.05, 0)[1]).toBeCloseTo(0, 0);
    // fractional zoom: the longer side of the box exactly fills the padded square
    const v = fitView([[10, 20], [10.256, 20.1]], 512, 32, 19);
    expect(v.cx).toBeCloseTo(10.128);
    expect(v.cy).toBeCloseTo(20.05);
    expect(0.256 * 2 ** v.z).toBeCloseTo(448);
    expect(fitView([[5, 5], [5, 5]], 512, 32, 17).z).toBe(17); // a single point is capped at the max zoom
    // tiles at the view's own zoom are 256 units; at one zoom lower they are scaled to 512
    const t = tilesFor({ cx: 128, cy: 128, z: 2 }, 512, 2);
    expect(t.every((p) => p.size === 256 && p.z === 2)).toBe(true);
    expect(t.length).toBe(4); // the view lines up with tile edges: exactly 2 × 2 tiles
    expect(tilesFor({ cx: 128, cy: 128, z: 2 }, 512, 1).every((p) => p.size === 512)).toBe(true);
    // x wraps around the antimeridian, rows outside the world are skipped
    const edge = tilesFor({ cx: 0, cy: 1, z: 1 }, 256, 1);
    expect(edge.map((p) => p.x).sort()).toEqual([0, 1]);
    expect(edge.every((p) => p.y === 0)).toBe(true);
  });
  it('samples series at a fraction of the distance', async () => {
    const { sampleAt } = await import('../src/charts');
    expect(sampleAt([0, 10, 20], 0)).toBe(0);
    expect(sampleAt([0, 10, 20], 0.75)).toBe(15);
    expect(sampleAt([0, 10, 20], 1)).toBe(20);
    expect(sampleAt([7], 0.3)).toBe(7);
  });
});

describe('bubbles, landscape and to space', () => {
  it('bubbles: one period, and one labelled cluster per year or sport', async () => {
    const a = await load();
    const one = renderPoster('circles', a, opts({ strip: false }));
    const byYear = renderPoster('circles', a, opts({ circleGroup: 'year', strip: false }));
    const circlesIn = (s: string) => count(s, /<circle /g);
    expect(circlesIn(byYear.svg)).toBe(circlesIn(one.svg)); // same activities, only rearranged
    for (const y of ['2021', '2022', '2023', '2024']) expect(byYear.svg).toMatch(new RegExp(`>${y}<tspan`));
    expect(renderPoster('circles', a, opts({ circleGroup: 'sport' })).svg).toMatch(/>Ride<tspan/);
    expect(circlesIn(renderPoster('circles', a, opts({ circleYear: 2023, strip: false })).svg)).toBeLessThan(circlesIn(one.svg));
  });
  it('cluster layout: grid keeps the order, packing keeps clusters apart, both inside the box', async () => {
    const { clusterLayout } = await import('../src/posters/more');
    const r = [3, 1, 2, 0.5];
    const grid = clusterLayout(r, 'grid', 800, 600, 40);
    expect(grid[1]!.x).toBeGreaterThan(grid[0]!.x); // reading order
    for (const mode of ['grid', 'pack'] as const) {
      const c = clusterLayout(r, mode, 800, 600, 40);
      c.forEach((p, i) => {
        expect(p.x - r[i]! * p.k).toBeGreaterThanOrEqual(-1e-6);
        expect(p.x + r[i]! * p.k).toBeLessThanOrEqual(800 + 1e-6);
        expect(p.y - r[i]! * p.k).toBeGreaterThanOrEqual(-1e-6);
        c.slice(i + 1).forEach((q, j) => expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual((r[i]! + r[i + 1 + j]!) * p.k - 1e-6));
      });
    }
  });
  it('landscape: one filled profile per picked activity, relative or above sea level', async () => {
    const { pickProfiles } = await import('../src/posters/landscape');
    const a = [
      act({ startMs: utc(2024, 1, 1), distanceM: 5000, profile: [500, 600, 550] }),
      act({ startMs: utc(2024, 2, 1), distanceM: 9000, profile: [100, 140, 120] }),
      act({ startMs: utc(2024, 3, 1), distanceM: 7000, profile: null }),
    ];
    expect(pickProfiles(a, 'longest', 1).map((x) => x.distanceM)).toEqual([9000]);
    expect(pickProfiles(a, 'recent', 5).map((x) => x.startMs)).toEqual([utc(2024, 1, 1), utc(2024, 2, 1)]); // oldest first
    const rel = renderPoster('landscape', a, opts({ strip: false }));
    expect(count(rel.svg, /fill-opacity=/g)).toBe(2);
    expect(rel.svg).toContain('+100 m · 2024-01-01'); // tallest from its own start
    const abs = renderPoster('landscape', a, opts({ landHeight: 'absolute', strip: false }));
    expect(abs.svg).toContain('600 m · 2024-01-01');
    expect(abs.svg).not.toContain('NaN');
  });
  it('to space: altitude marks and the share of the way to the next one', async () => {
    const { altitudeMarks } = await import('../src/posters/space');
    expect(altitudeMarks(5_000)).toMatchObject({ passed: null, next: { name: 'Everest' } });
    expect(altitudeMarks(450_000)).toMatchObject({ passed: { name: 'International Space Station' }, next: { name: 'GPS satellites' } });
    expect(altitudeMarks(400_000_000)).toMatchObject({ passed: { name: 'The Moon' }, next: null });
    const a = [act({ startMs: utc(2023, 5, 1), distanceM: 300_000, elevGainM: 30_000 }), act({ startMs: utc(2024, 5, 1), distanceM: 300_000, elevGainM: 20_000 })];
    const climb = renderPoster('space', a, opts());
    expect(climb.svg).toContain('>50<tspan'); // km climbed
    expect(climb.svg).toContain('>50<tspan font-size="26" font-weight="600" dx="3" fill="#5ac8fa">%'); // half way to the Kármán line
    expect(climb.svg).toContain('>2024<');
    const dist = renderPoster('space', a, opts({ spaceMetric: 'distance', spaceYear: 2024 }));
    expect(dist.svg).toContain('>300<tspan');
    expect(dist.svg).toContain('Kármán line');
  });
});

describe('privacy', () => {
  it('trims the start and end of routes on the route posters', async () => {
    const { trimRoute } = await import('../src/posters');
    const route = Array.from({ length: 11 }, (_, i) => [50 + i * 0.001, 14]).flat(); // 11 points over 1 km
    expect(trimRoute(route, 1000, 0)).toBe(route);
    const t = trimRoute(route, 1000, 200)!;
    expect(t.length / 2).toBe(7);
    expect(t[0]).toBeCloseTo(50.002);
    expect(trimRoute(route, 1000, 500)).toBeNull(); // nothing would be left
    expect(trimRoute(null, 1000, 200)).toBeNull();
    const a = [act({ startMs: utc(2024, 1, 1), distanceM: 1000, route })];
    const points = (svg: string) => count(/<path d="[^"]*"/.exec(svg)![0], /L/g) + 1;
    // the overlay draws every second point: 11 → 6, trimmed 7 → 4
    expect(points(renderPoster('overlay', a, opts({ hideEnds: 0 })).svg)).toBe(6);
    expect(points(renderPoster('overlay', a, opts({ hideEnds: 200 })).svg)).toBe(4);
  });
});

describe('art posters', () => {
  it('bloom draws one petal per route, repeated by the symmetry', async () => {
    const a = await load();
    const routes = a.filter((x) => x.route && x.route.length >= 8).length;
    const one = renderPoster('bloom', a, opts({ strip: false }));
    expect(count(one.svg, /<path d=/g)).toBeLessThanOrEqual(routes);
    expect(count(one.svg, /<path d=/g)).toBeGreaterThan(routes * 0.8);
    const three = renderPoster('bloom', a, opts({ strip: false, bloomSymmetry: 3 }));
    expect(count(three.svg, /<path d=/g) % 3).toBe(0);
  });
  it('spiral draws one stroke per active day; stream one ribbon per sport', async () => {
    const a = await load();
    const days = new Set(a.map((x) => Math.floor(x.startMs / 86_400_000))).size;
    expect(count(renderPoster('spiral', a, opts({ strip: false })).svg, /<line /g)).toBe(days);
    const sports = new Set(a.map((x) => x.sport)).size;
    expect(count(renderPoster('stream', a, opts({ strip: false })).svg, /fill-opacity="0.88"/g)).toBe(Math.min(6, sports));
  });
  it('strata draws a layer per activity with heart rate, one year label per year', async () => {
    const a = await load();
    const withHr = a.filter((x) => x.series?.hr && x.series.hr.length > 2);
    const svg = renderPoster('strata', a, opts({ strip: false })).svg;
    const years = new Set(withHr.map((x) => new Date(x.startMs).getUTCFullYear())).size;
    expect(count(svg, /<line /g)).toBe(years);
    expect(count(svg, /class="stratum"/g)).toBeGreaterThanOrEqual(3);
    expect(count(svg, /M[\d.]+ [\d.]+h/g)).toBeGreaterThanOrEqual(Math.min(400, withHr.length));
    expect(renderPoster('strata', a.map((x) => ({ ...x, series: null })), opts({ strip: false })).svg).toMatch(/No heart-rate data/);
  });
  it('work done fills squares for the total energy, and the equivalents are right', async () => {
    const a = await load();
    const total = a.reduce((s, x) => s + workKj(x), 0);
    expect(total).toBeGreaterThan(0);
    const svg = renderPoster('work', a, opts({ strip: false })).svg;
    const unit = Number(/each square ([\d,]+) kJ/.exec(svg)![1]!.replace(/,/g, ''));
    expect(count(svg, /<rect x=/g)).toBeGreaterThanOrEqual(Math.ceil(total / unit));
    expect(workKj(act({ startMs: 0, powerHist: [[200, 3600]] }))).toBe(720);
    expect(workKj(act({ startMs: 0, avgPower: 100, movingS: 1000 }))).toBe(100);
    const eq = workEquivalents(3600);
    expect(eq[3]!.value).toBeCloseTo(100 / 24, 5); // 1 kWh runs a 10 W bulb for 100 h
    expect(eq[2]!.value).toBeCloseTo(3600 / 334.88, 3);
    expect(renderPoster('work', a.map((x) => ({ ...x, powerHist: null, avgPower: null })), opts()).svg).toMatch(/No power data/);
  });
  it('power fingerprint draws one bold line per year', async () => {
    const a = await load();
    const years = new Set(a.filter((x) => x.powerCurve).map((x) => new Date(x.startMs).getUTCFullYear())).size;
    const svg = renderPoster('fingerprint', a, opts({ strip: false })).svg;
    expect(count(svg, /class="year"/g)).toBe(Math.min(8, years));
    expect(svg).toMatch(/ESTIMATED FTP/);
  });
  it('sunrise clock draws an arc per activity, and daylight from the sunrise equation', async () => {
    const a = await load();
    const svg = renderPoster('sunrise', a, opts({ strip: false })).svg;
    expect(count(svg, /A[\d.]+,[\d.]+ 0 [01] 1 /g)).toBe(a.length + 1); // the activities, plus the outer edge of daylight
    expect(svg).toMatch(/class="daylight"/);
    // London, 21 June 2024: sunrise 03:43 UTC, sunset 20:21 UTC (to within a few minutes)
    const d = Math.floor(Date.UTC(2024, 5, 21) / 86_400_000);
    const s = sunTimes(d, 51.5, -0.13);
    const hm = (ms: number) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes();
    expect(Math.abs(hm(s.rise) - (3 * 60 + 43))).toBeLessThan(4);
    expect(Math.abs(hm(s.set) - (20 * 60 + 21))).toBeLessThan(4);
    const polar = sunTimes(d, 78, 15);
    expect(polar.set - polar.rise).toBeGreaterThan(86_000_000);
  });
});
