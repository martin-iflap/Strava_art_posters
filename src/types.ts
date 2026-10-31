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
  /** Speed (m/s), heart rate and power averaged into SERIES_POINTS bins along the distance. null = not available. */
  series: { speed: number[] | null; hr: number[] | null; power: number[] | null } | null;
  /** Cumulative moving seconds at each full kilometre, plus the end point (metres, seconds). Used for splits. */
  splits: { cum: number[]; endM: number; endS: number } | null;
  /** Normalized power (30 s rolling average, 4th-power mean) in watts. null = no power stream. */
  np: number | null;
  /** Best average power for standard durations, as [seconds, watts] pairs (mean-maximal power). null = no power stream. */
  powerCurve: [number, number][] | null;
  /** Highest average heart rate held for each duration, as [seconds, bpm] pairs. null = no heart-rate stream. */
  hrCurve: [number, number][] | null;
  /** Highest average speed held for each duration (the best-pace curve), as [seconds, m/s] pairs. null = no distance stream. */
  paceCurve: [number, number][] | null;
  /** Normalized graded pace as a speed (m/s): grade-adjusted (Minetti), then 30 s rolling 4th-power mean. For rTSS. */
  ngp: number | null;
  /** Seconds at each speed, as [speed × 10 (0.1 m/s bins), seconds] pairs. For pace zones. null = no speed. */
  speedHist: [number, number][] | null;
  /** Fastest elapsed time over standard distances, as [metres, seconds] pairs. null = no distance/time stream. */
  bestEfforts: [number, number][] | null;
  /**
   * Aerobic decoupling in %: how much output (power, else speed) per heartbeat dropped from the first half
   * of the moving time to the second. Under ~5 % means good endurance. null = no HR or shorter than 20 min.
   */
  decoupling: number | null;
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
export const PROFILE_POINTS = 300;
export const SERIES_POINTS = 300;

export type Tz = 'UTC' | 'local';
export type Units = 'metric' | 'imperial';
