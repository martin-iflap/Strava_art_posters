import { describe, expect, it } from 'vitest';
import { decodeTraining, encodeTraining, type TrainingSettings } from '../src/settings';

const full: TrainingSettings = {
  hr: { mode: 'lthr', value: 172 }, ftp: 265, restHr: 48, sex: 'f', pace: 1000 / 270, weight: 64.5,
  history: [{ untilMs: Date.UTC(2023, 0, 1), ftp: 240, lthr: null, pace: null }],
  goal: { period: 'month', metric: 'distance', target: 600 },
};

describe('remembered thresholds and goal', () => {
  it('round-trips everything', () => expect(decodeTraining(encodeTraining(full))).toEqual(full));
  it('ignores missing, broken or foreign data', () => {
    expect(decodeTraining(null)).toBeNull();
    expect(decodeTraining('not json')).toBeNull();
    expect(decodeTraining('[1,2]')).toBeNull();
  });
  it('drops values out of range field by field', () => {
    const t = decodeTraining(JSON.stringify({ ...full, ftp: 9000, hr: { mode: 'max', value: 180 }, weight: '70', history: [{ untilMs: 'x' }, { untilMs: 5, ftp: 1 }, full.history[0]], goal: { period: 'decade', metric: 'distance', target: 5 } }))!;
    expect(t.ftp).toBeNull();
    expect(t.hr).toBeNull();
    expect(t.weight).toBeNull();
    expect(t.history).toEqual(full.history);
    expect(t.goal).toBeNull();
    expect(t.restHr).toBe(48);
  });
});
