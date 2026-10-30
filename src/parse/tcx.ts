import { parseIso } from '../util/time';
import { normalizeSport } from './sport';
import { emptyTrack, type ParsedTrack } from './track';
import { attr, tagNumber, tagText } from './xml';

export function parseTcx(xml: string): ParsedTrack {
  const tr = emptyTrack();
  const act = /<Activity\b([^>]*)>/i.exec(xml);
  if (act) {
    const sport = attr(act[1]!, 'Sport');
    if (sport) tr.sport = normalizeSport(sport);
  }
  const re = /<Trackpoint\b[^>]*>([\s\S]*?)<\/Trackpoint>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const body = m[1]!;
    const time = tagText(body, 'Time');
    tr.t.push(time ? (parseIso(time) ?? NaN) : NaN);
    tr.lat.push(tagNumber(body, 'LatitudeDegrees'));
    tr.lon.push(tagNumber(body, 'LongitudeDegrees'));
    tr.ele.push(tagNumber(body, 'AltitudeMeters'));
    tr.dist.push(tagNumber(body, 'DistanceMeters'));
    tr.hr.push(tagNumber(body, 'Value')); // <HeartRateBpm><Value>
    tr.cad.push(tagNumber(body, 'Cadence', 'RunCadence'));
    tr.power.push(tagNumber(body, 'Watts'));
  }
  if (!tr.t.length) throw new Error('TCX contains no trackpoints');
  return tr;
}
