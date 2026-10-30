import type { Activity, Tz } from '../types';
import { isoWeekKey, monthKey, parts, ymd } from '../util/time';

/**
 * A group of activities picked from a stats table (a row, a record or a repeated route).
 * `value` is the row's key: YYYY-MM-DD, YYYY-MM, YYYY, an ISO week key, a weekday 0–6 (Monday first),
 * a sport, a date range "YYYY-MM-DD/YYYY-MM-DD", or a list of activity ids for `ids`.
 */
export type Selection =
  | { kind: 'day' | 'month' | 'year' | 'week' | 'weekday' | 'sport' | 'range'; value: string }
  | { kind: 'ids'; value: string[] };

/** The activities in a selection, newest first. */
export function selectActivities(acts: Activity[], s: Selection, tz: Tz): Activity[] {
  const test = matcher(s, tz);
  return acts.filter(test).sort((a, b) => b.startMs - a.startMs);
}

function matcher(s: Selection, tz: Tz): (a: Activity) => boolean {
  switch (s.kind) {
    case 'ids': { const ids = new Set(s.value); return (a) => ids.has(a.id); }
    case 'sport': return (a) => a.sport === s.value;
    case 'day': return (a) => ymd(parts(a.startMs, tz)) === s.value;
    case 'month': return (a) => monthKey(parts(a.startMs, tz)) === s.value;
    case 'year': return (a) => String(parts(a.startMs, tz).y) === s.value;
    case 'week': return (a) => isoWeekKey(parts(a.startMs, tz)) === s.value;
    case 'weekday': return (a) => String(parts(a.startMs, tz).wd) === s.value;
    case 'range': {
      const [from = '', to = ''] = s.value.split('/');
      return (a) => { const d = ymd(parts(a.startMs, tz)); return d >= from && d <= to; };
    }
  }
}
