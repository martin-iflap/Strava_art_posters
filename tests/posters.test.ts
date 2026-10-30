import { describe, expect, it } from 'vitest';
import { DEFAULT_POSTER, POSTER_TYPES, renderPoster, type PosterOptions } from '../src/posters';
import { esc, mix } from '../src/posters/common';
import { generate } from '../src/demo/generate';
import { expandInputs } from '../src/parse/archive';
import { importExport } from '../src/parse/pipeline';
import type { Activity } from '../src/types';
import { act, utc } from './helpers';

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
