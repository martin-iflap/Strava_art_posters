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
  if (!tr.t.length) throw new Error('FIT contains no record messages');
  return tr;
}
