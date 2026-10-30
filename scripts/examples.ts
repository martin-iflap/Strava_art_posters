/**
 * Renders the example posters shown on the import page from the made-up demo data, into public/examples/.
 * Run after changing a poster that is used as an example: `npm run examples`. The files are committed so the
 * import page needs no demo data at start-up.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateExport } from '../src/demo/generate';
import { expandInputs } from '../src/parse/archive';
import { importExport } from '../src/parse/pipeline';
import { DEFAULT_POSTER, renderPoster, type PosterOptions } from '../src/posters';
import { EXAMPLE_POSTERS } from '../src/examples';

const files = await expandInputs(generateExport().map((f) => ({ path: f.path, data: f.data })));
const { activities } = await importExport(files);
const o: PosterOptions = { ...DEFAULT_POSTER, units: 'metric', tz: 'UTC', sportLabel: 'All activities', climbYear: 'overlay' };
mkdirSync('public/examples', { recursive: true });
for (const ex of EXAMPLE_POSTERS) {
  const { svg } = renderPoster(ex.type, activities, o);
  writeFileSync(`public/examples/${ex.type}.svg`, svg);
  console.log(`${ex.type}.svg  ${(svg.length / 1024).toFixed(0)} KB`);
}
