/** Flat [lat0, lon0, lat1, lon1, ...] in degrees. */
export type Route = number[];

export interface Activity {
  id: string;
  name: string;
  /** Normalised sport name: Ride, Run, Walk, Swim, Hike, ... (unknown types keep their original text). */
  sport: string;
  /** Start instant, epoch milliseconds (UTC). */
  startMs: number;
  distanceM: number;
  movingS: number;
  elapsedS: number;
  elevGainM: number;
  maxSpeedMps: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgCadence: number | null;
  /** Seconds spent at each integer bpm, as [bpm, seconds] pairs. null = no heart-rate stream. */
  hrHist: [number, number][] | null;
  /** Seconds spent at each watt value, as [watts, seconds] pairs. null = no power stream. */
  powerHist: [number, number][] | null;
  /** GPS track resampled to ROUTE_POINTS points evenly spaced by distance. null = no GPS. */
  route: Route | null;
  /** Elevation (m) resampled to PROFILE_POINTS points evenly spaced by distance. null = no elevation stream. */
  profile: number[] | null;
  /** Source file inside the export, if one was read. */
  file?: string;
}

export interface Issue {
  /** Activity id, name or file path the issue refers to. */
  subject: string;
  reason: string;
}

export interface ImportResult {
  activities: Activity[];
  /** Activities that could not be used at all. */
  skipped: Issue[];
  /** Activities that were kept but without stream data (missing/corrupt file). */
  warnings: Issue[];
  notes: string[];
}

export const ROUTE_POINTS = 256;
export const PROFILE_POINTS = 100;

export type Tz = 'UTC' | 'local';
export type Units = 'metric' | 'imperial';
