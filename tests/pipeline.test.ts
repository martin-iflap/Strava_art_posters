import { beforeAll, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { generate, type ExportFile, type Truth } from '../src/demo/generate';
import { expandInputs } from '../src/parse/archive';
import { importExport } from '../src/parse/pipeline';
import type { ImportResult } from '../src/types';
import { chamfer, clusterRoutes } from '../src/stats/routes';
import { activitiesCsv, csvField, exportFilename, periodCsv, sportCsv, statsJson, toCsv, zonesCsv } from '../src/export';
import { hrZones, powerZones } from '../src/stats/zones';
import { summarize } from '../src/stats/summary';
import { act, utc } from './helpers';

let files: ExportFile[];
let truth: Truth;
let result: ImportResult;

beforeAll(async () => {
  ({ files, truth } = generate({ seed: 7, density: 0.35 }));
  result = await importExport(await expandInputs(files.map((f) => ({ path: f.path, data: f.data }))));
}, 60_000);

describe('import pipeline (folder form)', () => {
  it('imports every valid row, skips and warns on the deliberately broken ones', () => {
    expect(result.activities).toHaveLength(truth.importable);
    expect(result.skipped).toHaveLength(truth.skipped);
    expect(result.skipped.map((s) => s.reason).join('|')).toMatch(/unrecognised date/);
    expect(result.skipped.map((s) => s.reason).join('|')).toMatch(/missing activity type/);
    expect(result.skipped.map((s) => s.reason).join('|')).toMatch(/duplicate/);
    expect(result.warnings).toHaveLength(truth.warnings);
    expect(result.warnings.map((w) => w.reason).join('|')).toMatch(/not found/);
    expect(result.notes.join(' ')).toMatch(/not listed in activities.csv/);
  });
  it('counts per sport match the generator', () => {
    const c: Record<string, number> = {};
    for (const a of result.activities) c[a.sport] = (c[a.sport] ?? 0) + 1;
    expect(c).toEqual(truth.bySport);
  });
  it('activities are chronological and have streams parsed from FIT/GPX/TCX', () => {
    const t = result.activities.map((a) => a.startMs);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
    const withRoute = result.activities.filter((a) => a.route);
    expect(withRoute.length).toBeGreaterThanOrEqual(truth.withTrack * 0.95);
    expect(result.activities.some((a) => a.hrHist)).toBe(true);
    expect(result.activities.some((a) => a.powerHist)).toBe(true);
    expect(result.activities.some((a) => a.profile)).toBe(true);
    const swim = result.activities.find((a) => a.sport === 'Swim')!;
    expect(swim.route).toBeNull();
    expect(swim.hrHist).toBeNull();
  });
  it('stream-derived distance agrees with the CSV distance', async () => {
    // Re-import with CSV distances ignored: compare file-derived distance to the CSV figure.
    const noCsv = files.filter((f) => f.path !== 'activities.csv' && !f.path.includes('orphan'));
    const fromFiles = await importExport(await expandInputs(noCsv.map((f) => ({ path: f.path, data: f.data }))));
    expect(result.notes.length).toBeGreaterThan(0);
    const byFile = new Map(fromFiles.activities.map((a) => [a.file, a]));
    let checked = 0;
    for (const a of result.activities) {
      const b = a.file ? byFile.get(a.file) : undefined;
      if (!b) continue;
      checked++;
      expect(b.distanceM).toBeGreaterThan(0);
      expect(Math.abs(b.distanceM - a.distanceM) / a.distanceM).toBeLessThan(0.05); // generator adds GPS noise, which inflates track length a little
      expect(Math.abs(b.startMs - a.startMs)).toBeLessThan(1000);
    }
    expect(checked).toBeGreaterThan(50);
  }, 60_000);
  it('survives total garbage', async () => {
    const r = await importExport(await expandInputs([{ path: 'x/activities.csv', data: new TextEncoder().encode('\u0000\u0001garbage') }]));
    expect(r.activities).toHaveLength(0);
    expect(r.skipped.length).toBeGreaterThan(0);
    const r2 = await importExport(await expandInputs([{ path: 'readme.txt', data: new TextEncoder().encode('hi') }]));
    expect(r2.skipped[0]!.reason).toMatch(/no activities.csv/);
  });
});

describe('ZIP input', () => {
  it('gives the same result as the folder, including a wrapping directory and junk entries', async () => {
    const input: Record<string, Uint8Array> = { '__MACOSX/._x': new Uint8Array(3), 'export_123/.DS_Store': new Uint8Array(3) };
    for (const f of files) input[`export_123/${f.path}`] = f.data;
    const zipped = zipSync(input, { level: 0 });
    const r = await importExport(await expandInputs([{ path: 'export_123.zip', data: zipped }]));
    expect(r.activities).toHaveLength(result.activities.length);
    expect(r.skipped).toHaveLength(result.skipped.length);
    expect(r.activities[10]!.distanceM).toBe(result.activities[10]!.distanceM);
    expect(r.activities[10]!.route).toEqual(result.activities[10]!.route);
  }, 60_000);
  it('reads only the activity entries: photos and other personal files are never read', async () => {
    const secret = new TextEncoder().encode('PHOTO-BYTES-'.repeat(5000));
    const input: Record<string, Uint8Array> = {
      'export_1/media/1.jpg': secret, 'export_1/messages.csv': secret, 'export_1/profile.csv': secret,
    };
    for (const f of files.slice(0, 40)) input[`export_1/${f.path}`] = f.data;
    const bytes = zipSync(input, { level: 0 }); // stored, so the photo's bytes appear as-is in the archive
    const blob = new Blob([bytes]);
    const read: Uint8Array[] = [];
    const spy = { size: blob.size, slice: (s: number, e: number) => ({ arrayBuffer: async () => { const b = new Uint8Array(await blob.slice(s, e).arrayBuffer()); read.push(b); return b.buffer; } }) };
    const vfs = await expandInputs([{ path: 'export_1.zip', data: spy as unknown as Blob }]);
    expect(vfs.map((f) => f.path).filter((p) => /media|messages|profile/.test(p))).toEqual([]);
    const r = await importExport(vfs);
    expect(r.activities.length).toBeGreaterThan(0);
    const marker = 'PHOTO-BYTES-PHOTO';
    expect(read.some((b) => new TextDecoder('latin1').decode(b).includes(marker))).toBe(false);
    expect(read.reduce((n, b) => n + b.length, 0)).toBeLessThan(bytes.length - 3 * secret.length + 1000);
  });
  it('unpacks compressed entries and skips loose files it does not use without opening them', async () => {
    const gpx = files.find((f) => f.path.endsWith('.gpx'))!;
    const zipped = zipSync({ [gpx.path]: gpx.data }, { level: 6 });
    const [vf] = await expandInputs([{ path: 'a.zip', data: zipped }]);
    expect(await vf!.read()).toEqual(gpx.data);
    const untouched = { size: 10, slice: () => { throw new Error('read'); } } as unknown as Blob;
    expect(await expandInputs([{ path: 'media/1.jpg', data: untouched }, { path: 'notes.txt', data: untouched }])).toEqual([]);
  });
  it('reads ZIP64 archives (exports over 4 GB or 65,535 files)', async () => {
    const gpx = files.find((f) => f.path.endsWith('.gpx'))!;
    const plain = zipSync({ [gpx.path]: gpx.data }, { level: 6 });
    // replace the end record with a ZIP64 record + locator + an end record whose fields say "see ZIP64"
    const end = plain.length - 22, ev = new DataView(plain.buffer, end);
    const cdSize = ev.getUint32(12, true), cdOff = ev.getUint32(16, true);
    const z = new Uint8Array(end + 56 + 20 + 22), v = new DataView(z.buffer);
    z.set(plain.subarray(0, end));
    v.setUint32(end, 0x06064b50, true); v.setUint32(end + 4, 44, true);
    v.setUint32(end + 24, 1, true); v.setUint32(end + 32, 1, true); v.setUint32(end + 40, cdSize, true); v.setUint32(end + 48, cdOff, true);
    v.setUint32(end + 56, 0x07064b50, true); v.setUint32(end + 64, end, true); v.setUint32(end + 72, 1, true);
    const e = end + 76;
    v.setUint32(e, 0x06054b50, true); v.setUint16(e + 8, 0xffff, true); v.setUint16(e + 10, 0xffff, true);
    v.setUint32(e + 12, 0xffffffff, true); v.setUint32(e + 16, 0xffffffff, true);
    const [vf] = await expandInputs([{ path: 'big.zip', data: new Blob([z]) }]);
    expect(await vf!.read()).toEqual(gpx.data);
  });
  it('rejects a corrupt ZIP with a clear message', async () => {
    const bad = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 6]);
    await expect(expandInputs([{ path: 'a.zip', data: bad }])).rejects.toThrow(/not a readable ZIP/);
  });
});

describe('route clustering', () => {
  it('finds the repeated loops and not the one-offs', () => {
    const rides = result.activities.filter((a) => a.sport === 'Ride');
    const clusters = clusterRoutes(rides);
    expect(clusters.length).toBeGreaterThanOrEqual(2);
    expect(clusters.length).toBeLessThanOrEqual(6); // 4 base ride loops (+ rare accidental repeat)
    expect(clusters[0]!.count).toBeGreaterThanOrEqual(clusters[clusters.length - 1]!.count);
    const total = clusters.reduce((s, c) => s + c.count, 0);
    expect(total).toBeGreaterThan(rides.filter((a) => a.route).length * 0.5);
    expect(clusters[0]!.bestMovingS).toBeLessThanOrEqual(clusters[0]!.avgMovingS);
    expect(clusters[0]!.preview.length).toBe(512);
  });
  it('chamfer distance: identical = 0, shifted by 50 m ≈ 50, direction-agnostic', () => {
    const p = [0, 0, 100, 0, 200, 0, 300, 0];
    expect(chamfer(p, p)).toBe(0);
    expect(chamfer(p, [0, 50, 100, 50, 200, 50, 300, 50])).toBeCloseTo(50);
    expect(chamfer(p, [300, 0, 200, 0, 100, 0, 0, 0])).toBe(0);
  });
  it('ignores activities without GPS or too short', () => {
    expect(clusterRoutes([act({ startMs: utc(2023, 1, 1) }), act({ startMs: utc(2023, 1, 2) })])).toEqual([]);
  });
});

describe('export', () => {
  const o = { units: 'metric' as const, tz: 'UTC' as const, hrZones: hrZones({ mode: 'maxHr', value: 190 }), powerZones: powerZones(250) };
  it('csvField quoting and formula-injection guard', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('l1\nl2')).toBe('"l1\nl2"');
    expect(csvField('=1+1', true)).toBe("'=1+1");
    expect(csvField('=1+1')).toBe('=1+1');
    expect(csvField(-5)).toBe('-5');
    expect(csvField(NaN)).toBe('');
    expect(csvField(null)).toBe('');
    expect(toCsv(['a', 'b'], [[1, null], ['x', 2]])).toBe('a,b\r\n1,\r\nx,2\r\n');
  });
  it('activities CSV round-trips through a CSV parser with the right shape', async () => {
    const { parseCsv } = await import('../src/parse/csv');
    const csv = activitiesCsv(result.activities, o);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(result.activities.length + 1);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
    expect(rows[0]!.slice(0, 8)).toEqual(['id', 'date', 'start_time_utc', 'name', 'sport', 'distance_km', 'moving_time_s', 'elapsed_time_s']);
    expect(rows[0]).toContain('hr_z5_s');
    expect(rows[0]).toContain('power_z7_s');
    const names = rows.map((r) => r[3]);
    expect(names).toContain(`'=HYPERLINK("http://example.invalid","click")`);
    expect(names).toContain('Tour "Alpha", day 1\nsecond line');
  });
  it('hand-checked monthly / sport / zone CSV', async () => {
    const acts = [
      act({ startMs: utc(2023, 1, 1), distanceM: 10_000, movingS: 2000, elevGainM: 100, avgHr: 120, hrHist: [[120, 60]] }),
      act({ startMs: utc(2023, 1, 9), distanceM: 20_000, movingS: 4000, elevGainM: 50, sport: 'Run' }),
    ];
    expect(periodCsv(acts, 'month', o)).toBe(
      'month,period_start,activities,distance_km,moving_time_s,elevation_gain_m,avg_distance_km,median_distance_km,avg_speed_kmh,avg_hr,avg_power\r\n' +
        '2023-01,2023-01-01,2,30,6000,150,15,15,18,120,\r\n',
    );
    expect(sportCsv(acts, o)).toContain('Ride,1,10,2000,100,10,10,18,120,\r\n');
    const z = (await import('../src/parse/csv')).parseCsv(zonesCsv(acts, o));
    const hrAll = z.filter((r) => r[0] === 'hr' && r[1] === 'all');
    expect(hrAll).toHaveLength(5);
    expect(hrAll[1]).toEqual(['hr', 'all', 'all', 'Z2', '114', '133', '60', 'true', '1', '2']);
    const pw = z.find((r) => r[0] === 'power' && r[1] === 'all')!;
    expect(pw.slice(6, 8)).toEqual(['', 'false']); // no power stream → empty, not zero
  });
  it('imperial headers and values', () => {
    const csv = periodCsv([act({ startMs: utc(2023, 1, 1), distanceM: 1609.344 })], 'year', { ...o, units: 'imperial' });
    expect(csv.split('\r\n')[0]).toContain('distance_mi');
    expect(csv.split('\r\n')[1]).toContain('2023,2023-01-01,1,1,');
  });
  it('JSON export parses and matches summary', () => {
    const j = JSON.parse(statsJson(result.activities, o));
    expect(j.allTime.count).toBe(summarize(result.activities).count);
    expect(j.activities).toHaveLength(result.activities.length);
    expect(j.heartRateZones.zones).toHaveLength(5);
    expect(Object.keys(j)).toEqual(expect.arrayContaining(['bySport', 'byYear', 'byMonth', 'records', 'powerZones']));
  });
  it('filenames carry sport and date range', () => {
    const a = [act({ startMs: utc(2022, 3, 4) }), act({ startMs: utc(2023, 11, 30) })];
    expect(exportFilename(a, 'Ride', 'monthly', 'csv', 'UTC')).toBe('ride-atlas_Ride_2022-03-04_2023-11-30_monthly.csv');
    expect(exportFilename(a, 'all', 'stats', 'json', 'UTC')).toBe('ride-atlas_all_2022-03-04_2023-11-30_stats.json');
    expect(exportFilename([], 'Virtual Ride', 'x', 'csv', 'UTC')).toBe('ride-atlas_Virtual-Ride_x.csv');
  });
});
