import { parseIso } from '../util/time';
import { normalizeSport } from './sport';
import { emptyTrack, type ParsedTrack } from './track';
import { attr, tagNumber, tagText } from './xml';

export function parseGpx(xml: string): ParsedTrack {
  const tr = emptyTrack();
  const trkStart = xml.search(/<(?:\w+:)?trk[\s>]/);
  const head = trkStart >= 0 ? xml.slice(trkStart, trkStart + 2000) : xml.slice(0, 2000);
  const type = tagText(head, 'type');
  if (type) tr.sport = normalizeSport(type);
  const name = tagText(head, 'name');
  if (name) tr.name = name;

  const re = /<(?:\w+:)?trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?trkpt>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const lat = Number(attr(m[1]!, 'lat'));
    const lon = Number(attr(m[1]!, 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const body = m[2] ?? '';
    const time = tagText(body, 'time');
    tr.t.push(time ? (parseIso(time) ?? NaN) : NaN);
    tr.lat.push(lat);
    tr.lon.push(lon);
    tr.ele.push(tagNumber(body, 'ele'));
    tr.hr.push(tagNumber(body, 'hr'));
    tr.power.push(tagNumber(body, 'power', 'watts', 'PowerInWatts'));
    tr.cad.push(tagNumber(body, 'cad'));
    tr.dist.push(NaN);
  }
  if (!tr.t.length) throw new Error('GPX contains no track points');
  return tr;
}
