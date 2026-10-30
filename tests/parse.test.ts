import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { parseActivitiesCsv, parseCsv } from '../src/parse/csv';
import { parseGpx } from '../src/parse/gpx';
import { parseTcx } from '../src/parse/tcx';
import { parseFit } from '../src/parse/fit';
import { parseTrackFile, detectFormat } from '../src/parse/pipeline';
import { elevationGain, sampleDurations, summarizeTrack } from '../src/parse/track';
import { parseCsvDate, parseIso } from '../src/util/time';
import { normalizeSport } from '../src/parse/sport';
import { FitBaseType, FitEncoder } from 'fit-file-parser/encoder';

describe('parseCsv', () => {
  it('handles quotes, embedded newlines/commas, CRLF and BOM', () => {
    const t = '﻿a,b,c\r\n1,"x, y","he said ""hi""\nsecond"\r\n2,,\r\n';
    expect(parseCsv(t)).toEqual([['a', 'b', 'c'], ['1', 'x, y', 'he said "hi"\nsecond'], ['2', '', '']]);
  });
  it('sniffs semicolon delimiter', () => {
    expect(parseCsv('a;b\n1;2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('dates', () => {
  it('parses Strava CSV date formats as UTC', () => {
    expect(parseCsvDate('Jan 5, 2023, 7:32:10 AM')).toBe(Date.UTC(2023, 0, 5, 7, 32, 10));
    expect(parseCsvDate('Dec 31, 2022, 12:00:00 AM')).toBe(Date.UTC(2022, 11, 31, 0, 0, 0));
    expect(parseCsvDate('Dec 31, 2022, 12:30:00 PM')).toBe(Date.UTC(2022, 11, 31, 12, 30, 0));
    expect(parseCsvDate('2023-01-05 07:32:10')).toBe(Date.UTC(2023, 0, 5, 7, 32, 10));
    expect(parseCsvDate('2023-01-05T07:32:10+02:00')).toBe(Date.UTC(2023, 0, 5, 5, 32, 10));
    expect(parseCsvDate('05.01.2023, 07:32:10')).toBe(Date.UTC(2023, 0, 5, 7, 32, 10));
    expect(parseCsvDate('garbage')).toBeNull();
    expect(parseCsvDate('Feb 40, 2023, 1:00:00 AM')).toBeNull();
  });
  it('parseIso treats missing offset as UTC', () => {
    expect(parseIso('2023-01-05T07:32:10')).toBe(Date.UTC(2023, 0, 5, 7, 32, 10));
    expect(parseIso('')).toBeNull();
  });
});

describe('activities.csv', () => {
  const header = 'Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Elapsed Time,Moving Time,Distance,Elevation Gain,Max Heart Rate,Average Heart Rate,Average Watts';
  it('reads duplicate columns (km then metres), skips bad rows, normalises sports', () => {
    const csv = [
      header,
      '1,"Jan 5, 2023, 7:00:00 AM",Morning,Ride,3700,25.0,activities/1.fit.gz,3700,3600,25012.5,310.5,171,140.5,180',
      '2,nonsense,Bad,Ride,1,1,,1,1,1,0,,,',
      '3,"Jan 6, 2023, 7:00:00 AM",NoType,,1,1,,1,1,1,0,,,',
      '4,"Jan 7, 2023, 8:00:00 AM",Lauf,Run,1800,5.0,,1800,1700,5000,20,500,,',
    ].join('\n');
    const r = parseActivitiesCsv(csv);
    expect(r.rows).toHaveLength(2);
    expect(r.skipped).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ id: '1', sport: 'Ride', movingS: 3600, distanceM: 25012.5, elevGainM: 310.5, avgHr: 140.5, maxHr: 171, avgPower: 180, filename: 'activities/1.fit.gz', startMs: Date.UTC(2023, 0, 5, 7) });
    expect(r.rows[1]!.maxHr).toBeNull(); // 500 bpm is implausible
  });
  it('falls back to km→m guess with a single distance column', () => {
    const r = parseActivitiesCsv('Activity ID,Activity Date,Activity Name,Activity Type,Distance\n1,"Jan 5, 2023, 7:00:00 AM",a,Run,5.2\n');
    expect(r.rows[0]!.distanceM).toBeCloseTo(5200);
  });
  it('reports unusable files instead of throwing', () => {
    expect(parseActivitiesCsv('').skipped).toHaveLength(1);
    expect(parseActivitiesCsv('foo,bar\n1,2\n').skipped[0]!.reason).toMatch(/date and type/);
  });
});

describe('sport names', () => {
  it('maps variants', () => {
    expect(normalizeSport('cycling')).toBe('Ride');
    expect(normalizeSport('Jízda na kole')).toBe('Ride');
    expect(normalizeSport('Kayaking')).toBe('Kayaking');
    expect(normalizeSport('')).toBe('Other');
  });
});

const GPX = `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="x"><trk><name>Fun &amp; games</name><type>running</type><trkseg>
<trkpt lat="50.0" lon="14.0"><ele>200</ele><time>2023-01-05T07:00:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr><gpxtpx:cad>80</gpxtpx:cad></gpxtpx:TrackPointExtension><power>150</power></extensions></trkpt>
<trkpt lat="50.001" lon="14.0"><ele>205</ele><time>2023-01-05T07:00:10Z</time></trkpt>
<trkpt lat="bad" lon="14.0"><ele>1</ele></trkpt>
</trkseg></trk></gpx>`;

describe('GPX', () => {
  it('extracts points, streams, name and type; ignores invalid points', () => {
    const t = parseGpx(GPX);
    expect(t.sport).toBe('Run');
    expect(t.name).toBe('Fun & games');
    expect(t.t).toEqual([Date.UTC(2023, 0, 5, 7), Date.UTC(2023, 0, 5, 7, 0, 10)]);
    expect(t.hr[0]).toBe(120);
    expect(t.hr[1]).toBeNaN();
    expect(t.cad[0]).toBe(80);
    expect(t.power[0]).toBe(150);
    expect(t.ele).toEqual([200, 205]);
  });
  it('rejects a GPX without points', () => {
    expect(() => parseGpx('<gpx></gpx>')).toThrow(/no track points/);
  });
});

describe('TCX', () => {
  const TCX = `<TrainingCenterDatabase><Activities><Activity Sport="Biking"><Id>2023-01-05T07:00:00Z</Id><Lap><Track>
<Trackpoint><Time>2023-01-05T07:00:00Z</Time><Position><LatitudeDegrees>50.0</LatitudeDegrees><LongitudeDegrees>14.0</LongitudeDegrees></Position><AltitudeMeters>200</AltitudeMeters><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>133</Value></HeartRateBpm><Cadence>90</Cadence><Extensions><TPX><Watts>210</Watts></TPX></Extensions></Trackpoint>
<Trackpoint><Time>2023-01-05T07:00:05Z</Time><DistanceMeters>40.5</DistanceMeters></Trackpoint>
</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
  it('extracts streams', () => {
    const t = parseTcx(TCX);
    expect(t.sport).toBe('Ride');
    expect(t.hr[0]).toBe(133);
    expect(t.power[0]).toBe(210);
    expect(t.cad[0]).toBe(90);
    expect(t.dist).toEqual([0, 40.5]);
    expect(t.lat[1]).toBeNaN();
  });
});

describe('FIT', () => {
  it('round-trips records written with the FIT encoder', async () => {
    const e = new FitEncoder();
    const t0 = Date.UTC(2023, 0, 5, 7);
    const semi = 2 ** 31 / 180;
    for (let i = 0; i < 3; i++) {
      e.writeMessage(20, [
        { number: 253, size: 4, baseType: FitBaseType.Uint32, value: FitEncoder.toFitTimestamp(new Date(t0 + i * 1000)) },
        { number: 0, size: 4, baseType: FitBaseType.Sint32, value: Math.round((50 + i * 0.001) * semi) },
        { number: 1, size: 4, baseType: FitBaseType.Sint32, value: Math.round(14 * semi) },
        { number: 2, size: 2, baseType: FitBaseType.Uint16, value: (200 + i + 500) * 5 },
        { number: 3, size: 1, baseType: FitBaseType.Uint8, value: 140 + i },
        { number: 7, size: 2, baseType: FitBaseType.Uint16, value: 200 },
      ], 1);
    }
    e.writeMessage(18, [{ number: 5, size: 1, baseType: FitBaseType.Enum, value: 1 }], 2);
    const bytes = e.close();
    expect(detectFormat(bytes)).toBe('fit');
    const t = await parseFit(bytes);
    expect(t.t).toHaveLength(3);
    expect(t.hr).toEqual([140, 141, 142]);
    expect(t.power[0]).toBe(200);
    expect(t.lat[2]).toBeCloseTo(50.002, 4);
    expect(t.ele[1]).toBeCloseTo(201, 0);
    expect(t.t[1]! - t.t[0]!).toBe(1000);
    expect(t.sport).toBe('Run');
  });
  it('throws on garbage', async () => {
    await expect(parseFit(new Uint8Array(40))).rejects.toBeTruthy();
  });
});

describe('format sniffing and gzip', () => {
  it('detects by content and unzips', async () => {
    const gz = gzipSync(new TextEncoder().encode(GPX));
    const t = await parseTrackFile(gz);
    expect(t.lat).toHaveLength(2);
    await expect(parseTrackFile(new TextEncoder().encode('hello'))).rejects.toThrow(/unrecognised/);
    await expect(parseTrackFile(gz.subarray(0, 20))).rejects.toBeTruthy();
  });
});

describe('track summary', () => {
  it('sampleDurations treats gaps > 30 s as pauses', () => {
    expect(sampleDurations([0, 1000, 2000, 100_000, 101_000])).toEqual([1, 1, 0, 1, 0]);
    expect(sampleDurations([NaN, NaN])).toEqual([1, 1]);
  });
  it('elevationGain uses hysteresis (hand-computed)', () => {
    // 0→3 (+3, ref 3), 3→4 ignored (<2), 4→1 (ref 1), 1→5 (+4)  => 7
    expect(elevationGain([0, 3, 4, 1, 5])).toBe(7);
    expect(elevationGain([0, 1, 0, 1, 0])).toBe(0);
  });
  it('computes distance, moving time and HR/power histograms', () => {
    const t = parseGpx(GPX);
    // two valid points 111.2 m apart (0.001° lat) 10 s apart → 11.1 m/s
    const s = summarizeTrack(t);
    expect(s.distanceM).toBeCloseTo(111.2, 0);
    expect(s.elapsedS).toBe(10);
    expect(s.movingS).toBe(10);
    expect(s.hrHist).toEqual([[120, 10]]);
    expect(s.avgHr).toBe(120);
    expect(s.maxPower).toBe(150);
    expect(s.route).toHaveLength(512);
  });
  it('excludes stopped time from moving time and returns null for missing streams', () => {
    const tr = parseGpx(GPX.replace(/<trkpt lat="bad"[\s\S]*?<\/trkpt>/, '<trkpt lat="50.001" lon="14.0"><time>2023-01-05T07:00:20Z</time></trkpt>'));
    const s = summarizeTrack(tr);
    expect(s.elapsedS).toBe(20);
    expect(s.movingS).toBe(10); // second 10 s: no movement
    const bare = parseGpx(GPX.replace(/<extensions>[\s\S]*?<\/extensions>/, ''));
    const s2 = summarizeTrack(bare);
    expect(s2.hrHist).toBeNull();
    expect(s2.powerHist).toBeNull();
  });
});
