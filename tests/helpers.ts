import type { Activity } from '../src/types';

let n = 0;
export function act(p: Partial<Activity> & { startMs: number }): Activity {
  return {
    id: String(++n), name: 'A', sport: 'Ride', distanceM: 10_000, movingS: 1800, elapsedS: 1900, elevGainM: 100, maxSpeedMps: null,
    avgHr: null, maxHr: null, avgPower: null, maxPower: null, avgCadence: null, hrHist: null, powerHist: null, route: null, profile: null, series: null, splits: null, np: null, powerCurve: null, hrCurve: null, paceCurve: null, ngp: null, speedHist: null, bestEfforts: null, decoupling: null,
    ...p,
  };
}
export const utc = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h);
