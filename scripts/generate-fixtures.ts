/** Writes a fake Strava export to fixtures/export/ (folder form) and fixtures/strava-export.zip. Usage: npm run fixtures [-- --density 0.3] */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { zipSync } from 'fflate';
import { generate } from '../src/demo/generate';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const { files, truth } = generate({ seed: arg('seed', 1234), density: arg('density', 1), stepS: arg('step', 15) });

rmSync('fixtures', { recursive: true, force: true });
const zipInput: Record<string, Uint8Array> = {};
for (const f of files) {
  const p = join('fixtures/export', f.path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.data);
  zipInput[f.path] = f.data;
}
writeFileSync('fixtures/strava-export.zip', zipSync(zipInput, { level: 0 }));
console.log(`Wrote ${files.length} files to fixtures/ (gitignored).`, truth);
