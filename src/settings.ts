import type { ThresholdChange } from './stats/training';
import type { HrZoneConfig } from './stats/zones';

/**
 * Thresholds and the goal, saved in this browser only when the user turns on "Remember on this device".
 * Nothing from the activity files is stored: just these few numbers. Everything read back is checked,
 * because storage can be edited by hand or left by an older version.
 */
export interface TrainingSettings {
  hr: HrZoneConfig | null;
  ftp: number | null;
  restHr: number | null;
  sex: 'm' | 'f';
  /** threshold pace as a speed, m/s */
  pace: number | null;
  weight: number | null;
  history: ThresholdChange[];
  goal: { period: 'week' | 'month' | 'year'; metric: 'distance' | 'time' | 'elevation'; target: number } | null;
}

export const TRAINING_KEY = 'ride-atlas-training';

const inRange = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const PACE_MIN = 1000 / 1200, PACE_MAX = 1609.344 / 120;

export function encodeTraining(s: TrainingSettings): string {
  return JSON.stringify({ v: 1, ...s });
}

/** The saved settings, or null when there are none or they cannot be read. Bad fields are dropped one by one. */
export function decodeTraining(text: string | null): TrainingSettings | null {
  if (!text) return null;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const hrRaw = o.hr as { mode?: unknown; value?: unknown } | null | undefined;
  const hrVal = hrRaw && typeof hrRaw === 'object' ? inRange(hrRaw.value, 100, 230) : null;
  const hr: HrZoneConfig | null = hrVal !== null && (hrRaw!.mode === 'maxHr' || hrRaw!.mode === 'lthr') ? { mode: hrRaw!.mode, value: hrVal } : null;
  const history: ThresholdChange[] = Array.isArray(o.history)
    ? o.history.flatMap((c: unknown): ThresholdChange[] => {
      if (!c || typeof c !== 'object') return [];
      const x = c as Record<string, unknown>;
      const untilMs = inRange(x.untilMs, 0, 8.64e15);
      if (untilMs === null) return [];
      const ch: ThresholdChange = { untilMs, ftp: inRange(x.ftp, 50, 600), lthr: inRange(x.lthr, 100, 230), pace: inRange(x.pace, PACE_MIN, PACE_MAX) };
      return ch.ftp || ch.lthr || ch.pace ? [ch] : [];
    }).slice(0, 100)
    : [];
  const g = o.goal as Record<string, unknown> | null | undefined;
  const goal = g && typeof g === 'object' && ['week', 'month', 'year'].includes(g.period as string) && ['distance', 'time', 'elevation'].includes(g.metric as string) && inRange(g.target, 0.001, 1e7)
    ? { period: g.period as 'week', metric: g.metric as 'distance', target: g.target as number }
    : null;
  return {
    hr,
    ftp: inRange(o.ftp, 50, 600),
    restHr: inRange(o.restHr, 30, 100),
    sex: o.sex === 'f' ? 'f' : 'm',
    pace: inRange(o.pace, PACE_MIN, PACE_MAX),
    weight: inRange(o.weight, 30, 200),
    history,
    goal,
  };
}
