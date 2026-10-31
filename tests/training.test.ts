import { describe, expect, it } from 'vitest';
import { CURVE_DURATIONS, minettiCost, normalizedGradedSpeed } from '../src/parse/track';
import { bestEfforts, decoupling, meanMax, normalizedPower, perSecond, summarizeTrack, emptyTrack } from '../src/parse/track';
import { activityLoad, criticalPower, eddington, thresholdsAt, bestEffortsBySport, bestPowerCurve, estimateFtp, formLabel, lthrOf, rampRate, trainingLoad } from '../src/stats/training';
import { act, utc } from './helpers';

describe('per-second streams', () => {
  it('holds each value until the next sample and drops pauses', () => {
    const t = [0, 2000, 3000, 63000, 64000]; // 60 s gap = pause
    expect(perSecond(t, [100, 200, 300, 400, 500], 0)).toEqual([100, 100, 200, 400]);
  });
  it('mean-max power', () => {
    const w = [100, 100, 400, 400, 100, 100];
    expect(meanMax(w, [1, 2, 3, 10])).toEqual([[1, 400], [2, 400], [3, 300]]);
  });
  it('normalized power equals average power for a steady effort and exceeds it for a surgy one', () => {
    expect(normalizedPower(new Array(600).fill(200))).toBe(200);
    const surgy = Array.from({ length: 1200 }, (_, i) => (Math.floor(i / 60) % 2 ? 350 : 50)); // avg 200
    expect(normalizedPower(surgy)!).toBeGreaterThan(240);
  });
  it('best efforts interpolate inside the window', () => {
    // 5 m/s for 2 km, then 4 m/s
    const cum: number[] = [], t: number[] = [];
    for (let s = 0; s <= 1200; s++) { t.push(s * 1000); cum.push(s <= 400 ? s * 5 : 2000 + (s - 400) * 4); }
    const e = bestEfforts(cum, t, [1000, 5000, 99999]);
    expect(e).toEqual([[1000, 200], [5000, 1150]]);
  });
  it('decoupling is ~0 for steady HR and positive when HR drifts up', () => {
    const out = new Array(3600).fill(200);
    expect(decoupling(out, new Array(3600).fill(140))).toBe(0);
    expect(decoupling(out, Array.from({ length: 3600 }, (_, i) => (i < 1800 ? 140 : 150)))!).toBeCloseTo(6.7, 1);
  });
  it('summarizeTrack fills the new fields from a power file', () => {
    const tr = emptyTrack();
    for (let i = 0; i < 1800; i++) { tr.t.push(i * 1000); tr.lat.push(NaN); tr.lon.push(NaN); tr.ele.push(NaN); tr.hr.push(140); tr.power.push(250); tr.cad.push(NaN); tr.dist.push(i * 8); }
    const s = summarizeTrack(tr);
    expect(s.np).toBe(250);
    expect(s.powerCurve!.find(([d]) => d === 1200)).toEqual([1200, 250]);
    expect(s.bestEfforts!.find(([m]) => m === 10000)).toEqual([10000, 1250]);
    expect(s.decoupling).toBe(0);
  });
});

describe('training load', () => {
  const hour = (w: number) => ({ np: w, powerHist: [[w, 3600]] as [number, number][] });
  it('one hour at FTP is 100 TSS; hrTSS at threshold HR is 100 too', () => {
    expect(activityLoad(act({ startMs: 0, ...hour(250) }), { ftp: 250, lthr: null })!.tss).toBeCloseTo(100);
    const l = activityLoad(act({ startMs: 0, hrHist: [[160, 3600]] }), { ftp: null, lthr: 160 })!;
    expect(l.tss).toBeCloseTo(100);
    expect(l.source).toBe('hr');
    expect(activityLoad(act({ startMs: 0 }), { ftp: 250, lthr: 160 })).toBeNull();
  });
  it('hrTSS: easy hours score far below 100, hard ones above (TRIMP-weighted)', () => {
    const t = { ftp: null, lthr: 160, maxHr: 185, restHr: 50 };
    const easy = activityLoad(act({ startMs: 0, hrHist: [[120, 3600]] }), t)!.tss;
    const hard = activityLoad(act({ startMs: 0, hrHist: [[170, 3600]] }), t)!.tss;
    expect(easy).toBeGreaterThan(25);
    expect(easy).toBeLessThan(50);
    expect(hard).toBeGreaterThan(110);
    expect(activityLoad(act({ startMs: 0, hrHist: [[160, 1800]] }), t)!.tss).toBeCloseTo(50);
  });
  it('rTSS from normalized graded pace and threshold pace', () => {
    const run = act({ startMs: 0, sport: 'Run', movingS: 3600, ngp: 4, hrHist: [[150, 3600]] });
    const l = activityLoad(run, { ftp: null, lthr: 160, pace: 4 })!;
    expect(l.source).toBe('pace');
    expect(l.tss).toBeCloseTo(100);
    expect(activityLoad(run, { ftp: null, lthr: 160, pace: 5 })!.tss).toBeCloseTo(64);
  });
  it('dated thresholds: older activities use the FTP of their day', () => {
    const t = { ftp: 250, lthr: null, history: [{ untilMs: utc(2024, 1, 1), ftp: 200 }] };
    expect(thresholdsAt(t, utc(2023, 6, 1)).ftp).toBe(200);
    expect(thresholdsAt(t, utc(2024, 6, 1)).ftp).toBe(250);
    expect(activityLoad(act({ startMs: utc(2023, 6, 1), ...hour(200) }), t)!.tss).toBeCloseTo(100);
  });
  it('critical power fits W = CP·t + W′', () => {
    const curve = [180, 300, 600, 1200].map((s) => ({ seconds: s, watts: 250 + 20000 / s, activityId: 'x', startMs: 0 }));
    expect(criticalPower(curve)).toEqual({ cp: 250, wPrime: 20000 });
  });
  it('Eddington number', () => {
    const days = [12, 11, 10, 9, 3, 2].map((km, i) => act({ startMs: utc(2024, 1, i + 1), distanceM: km * 1000 }));
    expect(eddington(days, 1000, (a) => a.startMs)).toEqual({ e: 4, next: 1 });
  });
  it('power wins over heart rate', () => {
    expect(activityLoad(act({ startMs: 0, ...hour(200), hrHist: [[150, 3600]] }), { ftp: 250, lthr: 160 })!.source).toBe('power');
  });
  it('fitness and fatigue follow the 42/7-day averages, form is yesterday\'s difference', () => {
    const acts = [act({ startMs: utc(2024, 1, 1), ...hour(250) }), act({ startMs: utc(2024, 1, 3), ...hour(250) })];
    const l = trainingLoad(acts, { ftp: 250, lthr: null }, 'UTC');
    expect(l.days.map((d) => d.date)).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
    expect(l.days[0]!.ctl).toBeCloseTo(100 / 42);
    expect(l.days[0]!.atl).toBeCloseTo(100 / 7);
    expect(l.days[0]!.tsb).toBe(0);
    expect(l.days[1]!.tsb).toBeCloseTo(100 / 42 - 100 / 7);
    expect(l.fromPower).toBe(2);
  });
  it('form labels and ramp rate', () => {
    expect(formLabel(10).label).toBe('Fresh');
    expect(formLabel(-20).label).toBe('Productive training');
    expect(formLabel(-40).label).toBe('Overreaching');
    expect(rampRate([])).toBeNull();
    expect(lthrOf({ mode: 'maxHr', value: 190 })).toBe(171);
    expect(lthrOf({ mode: 'lthr', value: 165 })).toBe(165);
  });
  it('best power curve, FTP estimate and best efforts per sport', () => {
    const a = act({ startMs: 1, powerCurve: [[60, 400], [1200, 280]] });
    const b = act({ startMs: 2, powerCurve: [[60, 450], [1200, 260]] });
    const c = bestPowerCurve([a, b]);
    expect(c.map((p) => [p.seconds, p.watts, p.activityId])).toEqual([[60, 450, b.id], [1200, 280, a.id]]);
    expect(estimateFtp(c)).toBe(266);
    const r1 = act({ startMs: 1, sport: 'Run', bestEfforts: [[1000, 250], [5000, 1400]] });
    const r2 = act({ startMs: 2, sport: 'Run', bestEfforts: [[1000, 240]] });
    const rows = bestEffortsBySport([r1, r2, act({ startMs: 3, bestEfforts: [[1000, 80]] })], 'Run');
    expect(rows.map((r) => [r.meters, r.top.map((e) => e.seconds)])).toEqual([[1000, [240, 250]], [5000, [1400]]]);
  });
});

describe('normalized graded pace', () => {
  it('equals the speed on the flat and rises uphill', () => {
    const n = 600;
    const dist = Array.from({ length: n }, (_, i) => i * 4);
    expect(normalizedGradedSpeed(dist, dist.map(() => 100))).toBeCloseTo(4, 1);
    const up = normalizedGradedSpeed(dist, dist.map((d) => 100 + d * 0.05))!;
    expect(up).toBeGreaterThan(4 * 1.25);
    expect(minettiCost(0)).toBeCloseTo(3.6);
  });
  it('dense curve durations include the classic points', () => {
    for (const d of [1, 5, 60, 300, 1200, 1800, 3600, 7200]) expect(CURVE_DURATIONS).toContain(d);
    expect(CURVE_DURATIONS.length).toBeGreaterThan(100);
  });
});
