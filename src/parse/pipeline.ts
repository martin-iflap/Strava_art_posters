import { maybeGunzip, normPath, type VFile } from './archive';
import { parseActivitiesCsv, type CsvActivity } from './csv';
import { parseFit } from './fit';
import { parseGpx } from './gpx';
import { parseTcx } from './tcx';
import { summarizeTrack, type ParsedTrack } from './track';
import type { Activity, ImportResult, Issue } from '../types';

export type Progress = (done: number, total: number, phase: string) => void;

type Format = 'fit' | 'gpx' | 'tcx';

/** Identify the file format from its content (extensions are not trusted). */
export function detectFormat(b: Uint8Array): Format | null {
  if (b.length > 12 && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === '.FIT') return 'fit';
  const head = new TextDecoder().decode(b.subarray(0, 4096));
  if (/<gpx[\s>]/i.test(head)) return 'gpx';
  if (/<TrainingCenterDatabase[\s>]/i.test(head)) return 'tcx';
  return null;
}

export async function parseTrackFile(bytes: Uint8Array): Promise<ParsedTrack> {
  const raw = maybeGunzip(bytes);
  const fmt = detectFormat(raw);
  if (!fmt) throw new Error('unrecognised file format (not FIT, GPX or TCX)');
  if (fmt === 'fit') return parseFit(raw);
  const xml = new TextDecoder().decode(raw);
  return fmt === 'gpx' ? parseGpx(xml) : parseTcx(xml);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function buildActivity(row: CsvActivity | null, tr: ParsedTrack | null, file: string | undefined): Activity | { error: string } {
  const s = tr ? summarizeTrack(tr) : null;
  const startMs = row?.startMs ?? s?.startMs ?? null;
  if (startMs === null) return { error: 'no start time in CSV or file' };
  // CSV values (as shown on strava.com) win; the file fills the gaps.
  const distanceM = row?.distanceM ?? s?.distanceM ?? 0;
  const movingS = row?.movingS ?? s?.movingS ?? row?.elapsedS ?? 0;
  const elapsedS = row?.elapsedS ?? s?.elapsedS ?? movingS;
  if (!row && !(distanceM > 0 || movingS > 0)) return { error: 'file contains no distance or time' };
  return {
    id: row?.id ?? `file-${file}`,
    name: row?.name ?? tr?.name ?? file?.split('/').pop() ?? 'Activity',
    sport: row?.sport ?? tr?.sport ?? 'Other',
    startMs,
    distanceM,
    movingS,
    elapsedS,
    elevGainM: row?.elevGainM ?? s?.elevGainM ?? 0,
    maxSpeedMps: s?.maxSpeedMps ?? row?.maxSpeedMps ?? null,
    avgHr: row?.avgHr ?? s?.avgHr ?? null,
    maxHr: row?.maxHr ?? s?.maxHr ?? null,
    avgPower: row?.avgPower ?? s?.avgPower ?? null,
    maxPower: row?.maxPower ?? s?.maxPower ?? null,
    avgCadence: row?.avgCadence ?? s?.avgCadence ?? null,
    hrHist: s?.hrHist ?? null,
    powerHist: s?.powerHist ?? null,
    route: s?.route ?? null,
    profile: s?.profile ?? null,
    series: s?.series ?? null,
    splits: s?.splits ?? null,
    file,
  };
}

export async function importExport(files: VFile[], onProgress: Progress = () => {}): Promise<ImportResult> {
  const skipped: Issue[] = [];
  const warnings: Issue[] = [];
  const notes: string[] = [];
  const activities: Activity[] = [];

  const csvs = files.filter((f) => /\.csv$/i.test(f.path));
  // Prefer the stock name; otherwise accept a lone CSV (e.g. a browser-renamed "activities (1).csv").
  const csvFile =
    csvs.filter((f) => /(^|\/)activities\.csv$/i.test(f.path)).sort((a, b) => a.path.length - b.path.length)[0] ??
    (csvs.length === 1 ? csvs[0] : undefined);
  const trackFiles = files.filter((f) => /\.(fit|gpx|tcx)(\.gz)?$/i.test(f.path));

  // Lookup by full path suffix and by basename.
  const byPath = new Map<string, VFile>();
  const byBase = new Map<string, VFile>();
  for (const f of files) {
    byPath.set(f.path.toLowerCase(), f);
    byBase.set(f.path.split('/').pop()!.toLowerCase(), f);
  }
  const find = (name: string): VFile | undefined => {
    const n = normPath(name).toLowerCase();
    if (byPath.has(n)) return byPath.get(n);
    for (const f of trackFiles) if (f.path.toLowerCase().endsWith('/' + n)) return f;
    return byBase.get(n.split('/').pop()!);
  };

  const used = new Set<VFile>();
  if (csvFile) {
    onProgress(0, 1, 'Reading activities.csv');
    const csv = parseActivitiesCsv(new TextDecoder().decode(await csvFile.read()));
    skipped.push(...csv.skipped);
    const seen = new Set<string>();
    const rows = csv.rows.filter((r) => {
      if (seen.has(r.id)) { skipped.push({ subject: `activity ${r.id}`, reason: 'duplicate activity id' }); return false; }
      seen.add(r.id);
      return true;
    });
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (i % 25 === 0) onProgress(i, rows.length, 'Reading activities');
      let tr: ParsedTrack | null = null;
      let file: string | undefined;
      if (row.filename) {
        const vf = find(row.filename);
        if (!vf) warnings.push({ subject: `${row.name} (${row.id})`, reason: `file ${row.filename} not found in export` });
        else {
          used.add(vf);
          file = vf.path;
          try {
            tr = await parseTrackFile(await vf.read());
          } catch (e) {
            warnings.push({ subject: `${row.name} (${row.id})`, reason: `${vf.path}: ${errText(e)}` });
          }
        }
      }
      const a = buildActivity(row, tr, file);
      if ('error' in a) skipped.push({ subject: `${row.name} (${row.id})`, reason: a.error });
      else activities.push(a);
    }
    const orphans = trackFiles.filter((f) => !used.has(f)).length;
    if (orphans) notes.push(`${orphans} track file(s) not listed in activities.csv were ignored.`);
  } else {
    notes.push('No activities.csv found: activities were built from the track files alone, so names and some totals may be missing.');
    for (let i = 0; i < trackFiles.length; i++) {
      const vf = trackFiles[i]!;
      if (i % 25 === 0) onProgress(i, trackFiles.length, 'Reading activities');
      try {
        const a = buildActivity(null, await parseTrackFile(await vf.read()), vf.path);
        if ('error' in a) skipped.push({ subject: vf.path, reason: a.error });
        else activities.push(a);
      } catch (e) {
        skipped.push({ subject: vf.path, reason: errText(e) });
      }
    }
    if (!trackFiles.length) skipped.push({ subject: 'export', reason: 'no activities.csv and no GPX/TCX/FIT files found' });
  }
  activities.sort((a, b) => a.startMs - b.startMs);
  onProgress(1, 1, 'Done');
  return { activities, skipped, warnings, notes };
}
