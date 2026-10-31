import { describe, expect, it } from 'vitest';
import { findRegions, regionFilter } from '../src/stats/regions';
import { selectActivities } from '../src/stats/select';
import type { Activity } from '../src/types';

const act = (id: string, lat: number, lon: number, startMs = 0, sport = 'Ride'): Activity => ({
  id, name: id, sport, startMs, distanceM: 1000, movingS: 600, elapsedS: 600, elevGainM: 0, maxSpeedMps: null, avgHr: null, maxHr: null,
  avgPower: null, maxPower: null, avgCadence: null, hrHist: null, powerHist: null, route: [lat, lon, lat + 0.01, lon], profile: null, series: null, splits: null, np: null, powerCurve: null, bestEfforts: null, decoupling: null,
});

describe('regions', () => {
  // home near Turin (three spots up to ~120 km apart, linked in a chain), a Mallorca trip, Watopia
  const acts = [
    ...Array.from({ length: 6 }, (_, i) => act(`h${i}`, 45.1, 7.2 + i * 0.001)),
    act('h-far', 45.9, 8.3), // ~120 km from home: still home (single linkage)
    act('h-chain', 46.6, 9.4), // ~120 km further: joins through h-far
    act('m1', 39.75, 2.85), act('m2', 39.6, 3.0),
    act('z1', -11.64, 166.95, 0, 'Virtual Ride'), act('z2', -11.65, 166.96, 0, 'Virtual Ride'), act('z3', -11.63, 166.94, 0, 'Virtual Ride'),
    { ...act('indoor', 0, 0), route: null },
  ];
  const regions = findRegions(acts);

  it('groups starts by single linkage and names regions relative to home', () => {
    expect(regions.map((r) => r.count)).toEqual([8, 3, 2]);
    expect(regions[0]!.name).toBe('Home area');
    expect(regions[1]!.name).toBe('Watopia (Zwift)');
    expect(regions[2]!.name).toMatch(/^\d[\d,]* km south-west$/);
    expect([...regions[2]!.activityIds].sort()).toEqual(['m1', 'm2']);
    expect(findRegions(acts).map((r) => r.id)).toEqual(regions.map((r) => r.id)); // stable ids
  });

  it('filters by choice, keeping activities without GPS', () => {
    const ids = (c: Parameters<typeof regionFilter>[1]) => acts.filter(regionFilter(regions, c)).map((a) => a.id);
    expect(ids('all')).toHaveLength(acts.length);
    expect(ids('auto')).toEqual(['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h-far', 'h-chain', 'indoor']);
    expect(ids([regions[1]!.id])).toEqual(['z1', 'z2', 'z3', 'indoor']);
    expect(ids(['gone'])).toEqual(ids('auto')); // unknown ids fall back to home
    expect(regionFilter(findRegions([acts[0]!]), 'auto').picked).toHaveLength(1);
  });
});

describe('selections from stats rows', () => {
  const day = Date.UTC(2024, 4, 6, 10); // Monday 2024-05-06
  const acts = [act('a', 0, 0, day), act('b', 0, 0, day + 86_400_000, 'Run'), act('c', 0, 0, Date.UTC(2023, 0, 1, 10))];
  const ids = (s: Parameters<typeof selectActivities>[1]) => selectActivities(acts, s, 'UTC').map((a) => a.id);
  it('picks by period, weekday, sport, range and ids, newest first', () => {
    expect(ids({ kind: 'day', value: '2024-05-06' })).toEqual(['a']);
    expect(ids({ kind: 'month', value: '2024-05' })).toEqual(['b', 'a']);
    expect(ids({ kind: 'year', value: '2023' })).toEqual(['c']);
    expect(ids({ kind: 'week', value: '2024-W19' })).toEqual(['b', 'a']);
    expect(ids({ kind: 'weekday', value: '0' })).toEqual(['a']);
    expect(ids({ kind: 'sport', value: 'Run' })).toEqual(['b']);
    expect(ids({ kind: 'range', value: '2023-01-01/2024-05-06' })).toEqual(['a', 'c']);
    expect(ids({ kind: 'ids', value: ['c', 'a'] })).toEqual(['a', 'c']);
  });
});
