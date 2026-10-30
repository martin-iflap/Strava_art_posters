import type { Tz } from '../types';

export interface Parts {
  y: number;
  /** 1-12 */
  m: number;
  d: number;
  /** 0 = Monday ... 6 = Sunday */
  wd: number;
}

const DAY = 86_400_000;

export function parts(ms: number, tz: Tz): Parts {
  const dt = new Date(ms);
  const y = tz === 'UTC' ? dt.getUTCFullYear() : dt.getFullYear();
  const m = (tz === 'UTC' ? dt.getUTCMonth() : dt.getMonth()) + 1;
  const d = tz === 'UTC' ? dt.getUTCDate() : dt.getDate();
  return { y, m, d, wd: weekday(y, m, d) };
}

export function weekday(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** Days since 1970-01-01 of the calendar date. Consecutive dates differ by 1. */
export function dayNumber(p: Parts): number {
  return Math.floor(Date.UTC(p.y, p.m - 1, p.d) / DAY);
}

export function fromDayNumber(n: number): Parts {
  const dt = new Date(n * DAY);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return { y, m, d, wd: weekday(y, m, d) };
}

const p2 = (n: number) => String(n).padStart(2, '0');
export const ymd = (p: Parts) => `${p.y}-${p2(p.m)}-${p2(p.d)}`;
export const monthKey = (p: Parts) => `${p.y}-${p2(p.m)}`;
export const yearKey = (p: Parts) => String(p.y);

/** ISO-8601 week key, e.g. "2023-W01" (weeks start on Monday; week 1 contains the first Thursday). */
export function isoWeekKey(p: Parts): string {
  const thursday = dayNumber(p) - p.wd + 3;
  const ty = fromDayNumber(thursday).y;
  const week = Math.floor((thursday - Math.floor(Date.UTC(ty, 0, 1) / DAY)) / 7) + 1;
  return `${ty}-W${p2(week)}`;
}

/** Day number of the Monday of the week containing the given date. */
export const weekStart = (p: Parts) => dayNumber(p) - p.wd;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse the date formats seen in Strava's activities.csv into epoch ms (UTC).
 * Handles "Jan 5, 2023, 7:32:10 AM", ISO-8601 ("2023-01-05T07:32:10Z", "2023-01-05 07:32:10") and
 * "05.01.2023, 07:32:10" / "5/1/2023 07:32". Returns null when unrecognised.
 */
export function parseCsvDate(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1]!.toLowerCase()];
    if (mon) return build(+m[3]!, mon, +m[2]!, +m[4]!, +m[5]!, +(m[6] ?? 0), m[7]);
  }
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) {
    const base = build(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
    return base === null ? null : base - tzOffsetMs(m[7]);
  }
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec(s);
  if (m) return build(+m[3]!, +m[2]!, +m[1]!, +m[4]!, +m[5]!, +(m[6] ?? 0), m[7]);
  return null;
}

function build(y: number, mo: number, d: number, h: number, mi: number, s: number, ampm?: string): number | null {
  if (ampm) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (/p/i.test(ampm) ? 12 : 0);
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function tzOffsetMs(z?: string): number {
  if (!z || z === 'Z') return 0;
  const m = /([+-])(\d{2}):?(\d{2})/.exec(z)!;
  return (m[1] === '-' ? -1 : 1) * (+m[2]! * 60 + +m[3]!) * 60_000;
}

/** Parse an ISO-8601 timestamp from GPX/TCX (a missing offset is treated as UTC). */
export function parseIso(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + 'Z');
  return Number.isFinite(t) ? t : null;
}
