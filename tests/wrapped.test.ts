import { describe, expect, it } from 'vitest';
import { generate } from '../src/demo/generate';
import { expandInputs } from '../src/parse/archive';
import { importExport } from '../src/parse/pipeline';
import { summarize } from '../src/stats/summary';
import type { Activity } from '../src/types';
import { parts } from '../src/util/time';
import { archetype, distanceEquivalent, personalRecords, wrappedStats, wrappedYears } from '../src/wrapped/data';
import { shareSvg } from '../src/wrapped/share';
import { act, utc } from './helpers';

let acts: Activity[];
async function load() {
  if (!acts) {
    const { files } = generate({ seed: 5, density: 0.2 });
    acts = (await importExport(await expandInputs(files.map((f) => ({ path: f.path, data: f.data }))))).activities;
  }
  return acts;
}
const opts = { tz: 'UTC' as const, thresholds: null, hideEnds: 200 };

describe('Sport Wrapped', () => {
  it('totals match the stats page for a year and for all time', async () => {
    const a = await load();
    const y = wrappedYears(a, 'UTC')[0]!;
    const w = wrappedStats(a, y, opts);
    const same = a.filter((x) => parts(x.startMs, 'UTC').y === y);
    expect(w.summary).toEqual(summarize(same));
    expect(w.label).toBe(String(y));
    expect(w.cards[0]).toBe('intro');
    expect(w.cards[w.cards.length - 1]).toBe('summary');
    expect(w.weekdays.reduce((s, v) => s + v, 0)).toBe(same.length);
    const all = wrappedStats(a, 'all', opts);
    expect(all.summary.distanceM).toBeCloseTo(summarize(a).distanceM, 3);
    expect(all.cards).not.toContain('fitness'); // no thresholds
    expect(all.cards).toContain('compare'); // biggest year
  });

  it('records list only what beat earlier years', () => {
    const run = (y: number, s5k: number) => act({ startMs: utc(y, 5, 1), sport: 'Run', bestEfforts: [[5000, s5k]], powerCurve: [[300, 250 + y - 2020]] });
    const xs = [run(2021, 1500), run(2022, 1400), run(2023, 1450)];
    expect(personalRecords(xs, 2022, 'UTC').map((p) => [p.kind, p.value, p.before])).toEqual([['power', 252, 251], ['effort', 1400, 1500]]);
    expect(personalRecords(xs, 2023, 'UTC').filter((p) => p.kind === 'effort')).toEqual([]); // slower than 2022
    expect(personalRecords(xs, 2021, 'UTC')).toEqual([]); // nothing earlier to beat
    expect(personalRecords(xs, 'all', 'UTC').find((p) => p.kind === 'effort')?.value).toBe(1400);
  });

  it('types follow the rules', () => {
    const at = (h: number, d = 1, extra: Partial<Activity> = {}) => act({ startMs: Date.UTC(2024, 2, d, h), ...extra });
    expect(archetype(Array.from({ length: 10 }, (_, i) => at(6, i + 1)), 'UTC').id).toBe('early');
    expect(archetype(Array.from({ length: 10 }, (_, i) => at(21, i + 1)), 'UTC').id).toBe('owl');
    // 2 March 2024 was a Saturday
    expect(archetype(Array.from({ length: 10 }, (_, i) => at(11, i % 2 ? 2 : 3)), 'UTC').id).toBe('weekend');
    expect(archetype(Array.from({ length: 10 }, (_, i) => at(11, i * 3 + 4, { elevGainM: 400 })), 'UTC').id).toBe('climber');
    expect(archetype([at(12)], 'UTC').id).toBe('allrounder');
  });

  it('leaves out cards without data', () => {
    const w = wrappedStats([act({ startMs: utc(2024, 3, 1), elevGainM: 0 })], 2024, opts);
    expect(w.cards).toEqual(['intro', 'distance', 'time', 'longest', 'summary']);
    expect(wrappedStats([], 2024, opts).cards).toEqual([]);
  });

  it('finds peak fitness when thresholds are set', async () => {
    const a = await load();
    const y = wrappedYears(a, 'UTC')[0]!;
    const w = wrappedStats(a, y, { ...opts, thresholds: { ftp: 250, lthr: 165 } });
    expect(w.cards).toContain('fitness');
    expect(w.peakCtl!.date.startsWith(String(y))).toBe(true);
    expect(Math.max(...w.ctlSeries)).toBeCloseTo(w.peakCtl!.ctl, 6);
  });

  it('distance equivalents', () => {
    expect(distanceEquivalent(500_000)).toBe('further than London to Paris');
    expect(distanceEquivalent(6_000_000)).toMatch(/^further than London to New York, 15 %/);
    expect(distanceEquivalent(90_000_000)).toBe('2.2 times around the Earth');
    expect(distanceEquivalent(10_000)).toBe('a good start');
  });

  it('share image is a well-formed 1080 × 1920 SVG', async () => {
    const a = await load();
    const svg = shareSvg(wrappedStats(a, 'all', opts), 'metric');
    expect(svg).toMatch(/^<svg [^>]*width="1080" height="1920"/);
    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
  });
});
