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
  // <Lap StartTime="..."><TotalTimeSeconds/><DistanceMeters/>...<Track>: the lap totals sit before its track.
  const lapRe = /<Lap\b([^>]*)>([\s\S]*?)(?:<Track\b|<\/Lap>)/gi;
  const laps: NonNullable<typeof tr.laps> = [];
  while ((m = lapRe.exec(xml))) {
    const at = attr(m[1]!, 'StartTime');
    const ms = at ? parseIso(at) : null;
    if (ms === null || ms === undefined) continue;
    const time = tagNumber(m[2]!, 'TotalTimeSeconds'), d = tagNumber(m[2]!, 'DistanceMeters');
    const trig = tagText(m[2]!, 'TriggerMethod');
    laps.push({ startMs: ms, ...(time > 0 ? { timerS: time } : {}), ...(d >= 0 ? { distanceM: d } : {}), ...(trig ? { trigger: trig.toLowerCase() } : {}) });
  }
  if (laps.length > 1) tr.laps = laps;
  if (!tr.t.length) throw new Error('TCX contains no trackpoints');
  return tr;
}
