import FitParser from 'fit-file-parser';
import { normalizeSport } from './sport';
import { emptyTrack, type ParsedTrack } from './track';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

export async function parseFit(bytes: Uint8Array): Promise<ParsedTrack> {
  const parser = new FitParser({ mode: 'list', speedUnit: 'm/s', lengthUnit: 'm' } as never);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const data = (await parser.parseAsync(ab)) as unknown as {
    records?: Record<string, unknown>[];
    sessions?: Record<string, unknown>[];
    laps?: Record<string, unknown>[];
  };
  const tr = emptyTrack();
  const sport = data.sessions?.[0]?.sport;
  if (typeof sport === 'string') tr.sport = normalizeSport(sport);
  for (const r of data.records ?? []) {
    const ts = r.timestamp instanceof Date ? r.timestamp.getTime() : NaN;
    tr.t.push(ts);
    tr.lat.push(num(r.position_lat));
    tr.lon.push(num(r.position_long));
    tr.ele.push(num(r.enhanced_altitude ?? r.altitude));
    tr.dist.push(num(r.distance));
    tr.hr.push(num(r.heart_rate));
    tr.cad.push(num(r.cadence));
    tr.power.push(num(r.power));
  }
  const laps = (data.laps ?? []).map((l) => {
    const at = l.start_time instanceof Date ? l.start_time.getTime() : NaN;
    const el = num(l.total_elapsed_time), tm = num(l.total_timer_time), d = num(l.total_distance);
    return { startMs: at, ...(el > 0 ? { elapsedS: el } : {}), ...(tm > 0 ? { timerS: tm } : {}), ...(d >= 0 ? { distanceM: d } : {}), ...(typeof l.lap_trigger === 'string' ? { trigger: l.lap_trigger } : {}) };
  }).filter((l) => Number.isFinite(l.startMs));
  if (laps.length > 1) tr.laps = laps;
  // FIT stores running cadence as strides per minute (one foot); Strava shows steps per minute.
  if (tr.sport === 'Run') tr.cad = tr.cad.map((c) => c * 2);
  if (!tr.t.length) throw new Error('FIT contains no record messages');
  return tr;
}
