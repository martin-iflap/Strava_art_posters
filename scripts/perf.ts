/** Timing on a large synthetic export. Usage: npm run perf [-- --density 6.2] */
import { generate } from '../src/demo/generate';
import { expandInputs } from '../src/parse/archive';
import { importExport } from '../src/parse/pipeline';
import { byPeriod, records, summarize } from '../src/stats/summary';
import { clusterRoutes } from '../src/stats/routes';
import { hrZones, zonesBy } from '../src/stats/zones';
import { renderPoster, DEFAULT_POSTER, POSTER_TYPES } from '../src/posters';

const i = process.argv.indexOf('--density');
const density = i >= 0 ? Number(process.argv[i + 1]) : 6.2;
const time = async <T>(label: string, f: () => T | Promise<T>): Promise<T> => {
  const t = performance.now();
  const r = await f();
  console.log(label.padEnd(28), `${Math.round(performance.now() - t)} ms`);
  return r;
};

const { files } = await time('generate export', () => generate({ density }));
console.log(`${files.length} files, ${Math.round(files.reduce((s, f) => s + f.data.length, 0) / 1e6)} MB`);
const res = await time('import (parse everything)', async () => importExport(await expandInputs(files.map((f) => ({ path: f.path, data: f.data })))));
const acts = res.activities;
console.log(`${acts.length} activities`);
await time('summary + records', () => { summarize(acts); records(acts, 'UTC'); });
await time('by week/month/year', () => (['week', 'month', 'year'] as const).forEach((p) => byPeriod(acts, p, 'UTC')));
await time('zones by month', () => zonesBy(acts, 'hr', hrZones({ mode: 'maxHr', value: 190 }), 'month', 'UTC'));
const clusters = await time('route clustering', () => clusterRoutes(acts));
console.log(`${clusters.length} clusters`);
for (const t of POSTER_TYPES) {
  const p = await time(`poster ${t.id}`, () => renderPoster(t.id, acts, { ...DEFAULT_POSTER, units: 'metric', tz: 'UTC', sportLabel: 'All' }));
  console.log(' '.repeat(28), `${Math.round(p.svg.length / 1024)} KB svg`);
}
