import type { Units } from '../types';

export const KM_PER_MI = 1.609344;
export const M_PER_FT = 0.3048;

export const kmToMi = (km: number) => km / KM_PER_MI;
export const miToKm = (mi: number) => mi * KM_PER_MI;

/** Distance in the display unit (km or mi) from metres. */
export const distance = (m: number, u: Units) => (u === 'metric' ? m / 1000 : m / 1000 / KM_PER_MI);
/** Elevation in the display unit (m or ft) from metres. */
export const elevation = (m: number, u: Units) => (u === 'metric' ? m : m / M_PER_FT);
/** Speed in km/h or mph from m/s. */
export const speed = (mps: number, u: Units) => (u === 'metric' ? mps * 3.6 : (mps * 3.6) / KM_PER_MI);

export const distanceUnit = (u: Units) => (u === 'metric' ? 'km' : 'mi');
export const elevationUnit = (u: Units) => (u === 'metric' ? 'm' : 'ft');
export const speedUnit = (u: Units) => (u === 'metric' ? 'km/h' : 'mph');

/** "1:02:03" or "45:07" from seconds. */
export function formatDuration(totalS: number): string {
  const s = Math.round(totalS);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

/** "123 h 05 m" style for long totals. */
export function formatHours(totalS: number): string {
  const m = Math.round(totalS / 60);
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
}
