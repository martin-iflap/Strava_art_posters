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
