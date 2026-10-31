import { svg } from './dom';

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * Shared hover position along an activity, as a fraction of its distance (0..1), or null when nothing
 * is hovered. Every chart and the map of one activity subscribe, so hovering one shows the point on all.
 */
export class Cursor {
  private subs: ((t: number | null) => void)[] = [];
  on(f: (t: number | null) => void): void { this.subs.push(f); }
  set(t: number | null): void { for (const f of this.subs) f(t === null ? null : Math.max(0, Math.min(1, t))); }
}

export interface LineChartOptions {
  values: number[];
  /** x extent in display units (km or mi), shown on the axis */
  xMax: number;
  xUnit: string;
  fmtY: (v: number) => string;
  /** unit appended to the hovered value, e.g. "m" or "bpm" */
  yUnit?: string;
  /** formatter for the hovered value (defaults to fmtY) */
  fmtTip?: (v: number) => string;
  kind: 'speed' | 'hr' | 'power' | 'elevation';
  label: string;
  /** include zero in the y range (speed, power) */
  zeroBased?: boolean;
  cursor?: Cursor;
}

/** Rendered width of an SVG text in its own units (estimated per character when it is not laid out yet). */
export function textWidth(t: SVGTextElement | SVGElement, perChar: number): number {
  try { const w = (t as SVGTextElement).getComputedTextLength(); if (w > 0) return w; } catch { /* not rendered */ }
  return (t.textContent ?? '').length * perChar;
}

/** Linear interpolation of evenly spaced samples at fraction t. */
export function sampleAt(vs: number[], t: number): number {
  if (vs.length === 1) return vs[0]!;
  const x = t * (vs.length - 1), i = Math.min(vs.length - 2, Math.floor(x));
  return vs[i]! + (vs[i + 1]! - vs[i]!) * (x - i);
}

/** Simple responsive line/area chart as SVG. Colours come from CSS classes (theme aware). */
export function lineChart(o: LineChartOptions): SVGElement {
  const W = 640, H = 170, L = 52, R = 10, T = 10, B = 26;
  const vs = o.values;
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (o.zeroBased) lo = Math.min(0, lo);
  if (hi - lo < 1e-9) { hi = lo + 1; }
  const pad = (hi - lo) * 0.06;
  if (!o.zeroBased) lo -= pad;
  hi += pad;
  const X = (i: number) => L + (i / (vs.length - 1)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const els: SVGElement[] = [];
  for (const t of [0, 0.5, 1]) {
    const v = lo + (hi - lo) * t;
    els.push(svg('line', { class: 'gridline', x1: L, x2: W - R, y1: f1(Y(v)), y2: f1(Y(v)) }));
    els.push(Object.assign(svg('text', { class: 'tick', x: L - 6, y: f1(Y(v) + 4), 'text-anchor': 'end' }), { textContent: o.fmtY(v) }));
  }
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    els.push(Object.assign(svg('text', { class: 'tick', x: f1(L + t * (W - L - R)), y: H - 6, 'text-anchor': t === 0 ? 'start' : t === 1 ? 'end' : 'middle' }), { textContent: `${f1(o.xMax * t)}${t === 1 ? ' ' + o.xUnit : ''}` }));
  }
  const line = vs.map((v, i) => `${f1(X(i))},${f1(Y(v))}`).join('L');
  els.push(svg('path', { class: 'area', d: `M${X(0)},${f1(Y(lo))}L${line}L${f1(X(vs.length - 1))},${f1(Y(lo))}Z` }));
  els.push(svg('path', { class: 'line', d: `M${line}` }));

  // Hover cursor: vertical line, dot on the curve and a value bubble.
  const cLine = svg('line', { class: 'cursor', y1: T, y2: H - B });
  const cDot = svg('circle', { class: 'cursor-dot', r: 4 });
  const bubbleBg = svg('rect', { class: 'bubble', rx: 6, height: 22 });
  const bubbleText = svg('text', { class: 'bubble-text' });
  const hover = svg('g', { class: 'hover', visibility: 'hidden', 'pointer-events': 'none' }, cLine, cDot, bubbleBg, bubbleText);
  els.push(hover);
  const el = svg('svg', { class: `chart chart-${o.kind}`, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${o.label}. Hover, or focus and use the arrow keys, to read values.`, tabindex: 0 }, ...els);
  const cursor = o.cursor ?? new Cursor();
  let cur: number | null = null;
  cursor.on((t) => {
    cur = t;
    if (t === null) { hover.setAttribute('visibility', 'hidden'); return; }
    const v = sampleAt(vs, t);
    const x = L + t * (W - L - R), y = Y(v);
    for (const [k, val] of [['x1', x], ['x2', x]] as const) cLine.setAttribute(k, f1(val));
    cDot.setAttribute('cx', f1(x)); cDot.setAttribute('cy', f1(y));
    bubbleText.textContent = `${f1(o.xMax * t)} ${o.xUnit} · ${(o.fmtTip ?? o.fmtY)(v)}${o.yUnit ? ' ' + o.yUnit : ''}`;
    const bw = textWidth(bubbleText, 6.6) + 16;
    const bx = x + 10 + bw > W - R ? x - 10 - bw : x + 10;
    const by = Math.max(T, Math.min(H - B - 22, y - 30));
    bubbleBg.setAttribute('x', f1(bx)); bubbleBg.setAttribute('y', f1(by)); bubbleBg.setAttribute('width', f1(bw));
    bubbleText.setAttribute('x', f1(bx + 8)); bubbleText.setAttribute('y', f1(by + 15));
    hover.setAttribute('visibility', 'visible');
  });
  const fromEvent = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    return (vx - L) / (W - L - R);
  };
  el.addEventListener('pointermove', (e) => cursor.set(fromEvent(e)));
  el.addEventListener('pointerdown', (e) => cursor.set(fromEvent(e)));
  el.addEventListener('pointerleave', () => cursor.set(null));
  el.addEventListener('blur', () => cursor.set(null));
  el.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); cursor.set((cur ?? (e.key === 'ArrowRight' ? -step : 1 + step)) + (e.key === 'ArrowRight' ? step : -step)); }
    else if (e.key === 'Home') { e.preventDefault(); cursor.set(0); }
    else if (e.key === 'End') { e.preventDefault(); cursor.set(1); }
    else if (e.key === 'Escape') cursor.set(null);
  });
  return el;
}

/** About `n` round tick values from at or below lo to at or above hi (1, 2, 2.5 or 5 × a power of ten apart). */
export function niceTicks(lo: number, hi: number, n = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  const end = Math.ceil(hi / step - 1e-9) * step;
  for (let v = Math.floor(lo / step + 1e-9) * step; v <= end + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6 || 0);
  return out;
}

/** Multi-line hover bubble inside an SVG chart. */
function bubble(): { g: SVGElement; show(x: number, y: number, lines: string[], W: number, top: number, bottom: number): void; hide(): void } {
  const bg = svg('rect', { class: 'bubble', rx: 6 });
  const text = svg('text', { class: 'bubble-text' });
  const g = svg('g', { 'pointer-events': 'none', visibility: 'hidden' }, bg, text);
  return {
    g,
    show(x, y, lines, W, top, bottom) {
      text.replaceChildren(...lines.map((l, i) => Object.assign(svg('tspan', { x: 0, dy: i ? 16 : 0, class: i ? '' : 'bubble-head' }), { textContent: l })));
      const bw = Math.max(...lines.map((l) => l.length)) * 6.6 + 18;
      const bh = 10 + lines.length * 16;
      const bx = x + 12 + bw > W ? x - 12 - bw : x + 12;
      const by = Math.max(top, Math.min(bottom - bh, y - bh / 2));
      bg.setAttribute('x', f1(bx)); bg.setAttribute('y', f1(by)); bg.setAttribute('width', f1(bw)); bg.setAttribute('height', f1(bh));
      text.setAttribute('transform', `translate(${f1(bx + 9)},${f1(by + 17)})`);
      text.querySelectorAll('tspan').forEach((t) => t.setAttribute('x', '0'));
      g.setAttribute('visibility', 'visible');
    },
    hide() { g.setAttribute('visibility', 'hidden'); },
  };
}

export interface XYSeries {
  name: string;
  /** CSS class giving the colour (s-fitness, s-fatigue, s-form, s-main, s-compare, s-faint) */
  cls: string;
  points: [number, number][];
  /** draw a translucent area down to zero under the line */
  area?: boolean;
  /** label the line's last point with its name */
  endLabel?: boolean;
}

export interface XYChartOptions {
  series: XYSeries[];
  label: string;
  log?: boolean;
  xTicks: number[];
  fmtX: (x: number) => string;
  fmtY: (y: number) => string;
  /** heading of the hover bubble (defaults to fmtX) */
  tipX?: (x: number) => string;
  /** extra bubble line for a series' point (e.g. the date it was set) */
  tipExtra?: (series: number, index: number) => string | null;
  yZero?: boolean;
  /** draw a zero line (for values that go negative) */
  zeroLine?: boolean;
  height?: number;
  /** a click on the chart picks the nearest point of series 0 */
  onPick?: (index: number) => void;
}

/** Line chart over a numeric (optionally logarithmic) x axis, with one shared y axis and a hover readout. */
export function xyChart(o: XYChartOptions): SVGElement {
  const W = 640, H = o.height ?? 220, L = 48, R = o.series.some((s) => s.endLabel) ? 44 : 12, T = 12, B = 26;
  const all = o.series.flatMap((s) => s.points);
  const tx = (x: number) => (o.log ? Math.log(Math.max(x, 1e-9)) : x);
  const xs = all.map((p) => tx(p[0]));
  const x0 = Math.min(...xs, ...o.xTicks.map(tx)), x1 = Math.max(...xs, ...o.xTicks.map(tx));
  let lo = Math.min(...all.map((p) => p[1])), hi = Math.max(...all.map((p) => p[1]));
  if (o.yZero || o.zeroLine) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  if (!(hi > lo)) hi = lo + 1;
  const ticks = niceTicks(lo, hi);
  lo = Math.min(lo, ticks[0]!); hi = Math.max(hi, ticks[ticks.length - 1]!);
  const X = (x: number) => L + ((tx(x) - x0) / (x1 - x0 || 1)) * (W - L - R);
  const Y = (y: number) => T + (1 - (y - lo) / (hi - lo)) * (H - T - B);
  const els: SVGElement[] = [];
  for (const v of ticks) {
    els.push(svg('line', { class: v === 0 && o.zeroLine ? 'zeroline' : 'gridline', x1: L, x2: W - R, y1: f1(Y(v)), y2: f1(Y(v)) }));
    els.push(Object.assign(svg('text', { class: 'tick', x: L - 6, y: f1(Y(v) + 4), 'text-anchor': 'end' }), { textContent: o.fmtY(v) }));
  }
  o.xTicks.forEach((v, i) => els.push(Object.assign(svg('text', { class: 'tick', x: f1(X(v)), y: H - 6, 'text-anchor': i === 0 && X(v) < L + 20 ? 'start' : 'middle' }), { textContent: o.fmtX(v) })));
  for (const s of o.series) {
    if (s.points.length < 1) continue;
    const d = s.points.map((p) => `${f1(X(p[0]))},${f1(Y(p[1]))}`).join('L');
    if (s.area) els.push(svg('path', { class: `xy-area ${s.cls}`, d: `M${f1(X(s.points[0]![0]))},${f1(Y(Math.max(lo, 0)))}L${d}L${f1(X(s.points[s.points.length - 1]![0]))},${f1(Y(Math.max(lo, 0)))}Z` }));
    els.push(svg('path', { class: `xy-line ${s.cls}`, d: `M${d}` }));
  }
  // end-of-line labels, pushed apart so they never overlap (at least 13 px between baselines)
  const labels = o.series.filter((s) => s.endLabel && s.points.length).map((s) => { const p = s.points[s.points.length - 1]!; return { s, x: X(p[0]) + 5, y: Y(p[1]) + 4 }; }).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i]!.y - labels[i - 1]!.y < 13 && Math.abs(labels[i]!.x - labels[i - 1]!.x) < 40) labels[i]!.y = labels[i - 1]!.y + 13;
  for (const l of labels) els.push(Object.assign(svg('text', { class: 'end-label', x: f1(l.x), y: f1(l.y) }), { textContent: l.s.name }));
  const cLine = svg('line', { class: 'cursor', y1: T, y2: H - B });
  const dots = o.series.map((s) => svg('circle', { class: `cursor-dot ${s.cls}`, r: 4 }));
  const tip = bubble();
  const hover = svg('g', { visibility: 'hidden', 'pointer-events': 'none' }, cLine, ...dots);
  els.push(hover, tip.g);
  const el = svg('svg', { class: 'chart xy', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${o.label}. Hover, or focus and use the arrow keys, to read values.`, tabindex: 0 }, ...els);
  // nearest point of each series to pixel x
  const nearest = (s: XYSeries, px: number) => {
    let bi = -1, bd = Infinity;
    s.points.forEach((p, i) => { const d = Math.abs(X(p[0]) - px); if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  const ref = o.series[0]!;
  let cur: number | null = null;
  const show = (i: number | null) => {
    cur = i;
    if (i === null || !ref.points[i]) { hover.setAttribute('visibility', 'hidden'); tip.hide(); return; }
    const px = X(ref.points[i]![0]);
    cLine.setAttribute('x1', f1(px)); cLine.setAttribute('x2', f1(px));
    const lines = [(o.tipX ?? o.fmtX)(ref.points[i]![0])];
    o.series.forEach((s, k) => {
      const j = nearest(s, px);
      const p = j >= 0 && Math.abs(X(s.points[j]![0]) - px) < 3 ? s.points[j]! : null;
      dots[k]!.setAttribute('visibility', p ? 'visible' : 'hidden');
      if (!p) return;
      dots[k]!.setAttribute('cx', f1(px)); dots[k]!.setAttribute('cy', f1(Y(p[1])));
      lines.push(`${s.name}: ${o.fmtY(p[1])}`);
      const extra = o.tipExtra?.(k, j);
      if (extra) lines.push(`  ${extra}`);
    });
    hover.setAttribute('visibility', 'visible');
    tip.show(px, Y(ref.points[i]![1]), lines, W - R, T, H - B);
  };
  const fromEvent = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return nearest(ref, ((e.clientX - r.left) / r.width) * W);
  };
  el.addEventListener('pointermove', (e) => show(fromEvent(e)));
  el.addEventListener('pointerleave', () => show(null));
  el.addEventListener('blur', () => show(null));
  if (o.onPick) { el.classList.add('pickable'); el.addEventListener('click', (e) => { const i = fromEvent(e); if (i >= 0) o.onPick!(i); }); }
  el.addEventListener('keydown', (e) => {
    const n = ref.points.length;
    const step = e.shiftKey ? Math.max(1, Math.round(n / 10)) : 1;
    if (e.key === 'ArrowRight') { e.preventDefault(); show(Math.min(n - 1, (cur ?? -1) + step)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(Math.max(0, (cur ?? n) - step)); }
    else if (e.key === 'Enter' && cur !== null && o.onPick) o.onPick(cur);
    else if (e.key === 'Escape') show(null);
  });
  return el;
}

export interface Bar { label: string; value: number; tip: string[]; onClick?: () => void; selected?: boolean }

/** Vertical bar chart (one series) with a hover readout per bar. Bars with onClick are clickable. */
export function barChart(o: { bars: Bar[]; label: string; fmtY: (v: number) => string; height?: number; cls?: string; labelEvery?: number }): SVGElement {
  const W = 640, H = o.height ?? 180, L = 48, R = 8, T = 12, B = 24;
  const n = o.bars.length;
  const hi0 = Math.max(0, ...o.bars.map((b) => b.value));
  const ticks = niceTicks(0, hi0 > 0 ? hi0 : 1);
  const hi = ticks[ticks.length - 1]!;
  const Y = (v: number) => T + (1 - v / hi) * (H - T - B);
  const slot = (W - L - R) / Math.max(1, n);
  const bw = Math.max(1, Math.min(36, slot - 2)); // 2 px surface gap between neighbours
  const els: SVGElement[] = [];
  for (const v of ticks) {
    els.push(svg('line', { class: 'gridline', x1: L, x2: W - R, y1: f1(Y(v)), y2: f1(Y(v)) }));
    els.push(Object.assign(svg('text', { class: 'tick', x: L - 6, y: f1(Y(v) + 4), 'text-anchor': 'end' }), { textContent: o.fmtY(v) }));
  }
  const every = o.labelEvery ?? Math.max(1, Math.ceil(n / 12));
  const rects: SVGElement[] = [];
  o.bars.forEach((b, i) => {
    const x = L + i * slot + (slot - bw) / 2;
    const y = Y(b.value), hgt = Math.max(0, H - B - y);
    const r = Math.min(4, bw / 2, hgt);
    // rounded top, square base anchored on the axis
    const d = hgt > 0 ? `M${f1(x)},${f1(H - B)}V${f1(y + r)}Q${f1(x)},${f1(y)} ${f1(x + r)},${f1(y)}H${f1(x + bw - r)}Q${f1(x + bw)},${f1(y)} ${f1(x + bw)},${f1(y + r)}V${f1(H - B)}Z` : '';
    const rect = svg('path', { class: `bar ${o.cls ?? ''}${b.selected ? ' selected' : ''}`, d });
    rects.push(rect);
    els.push(rect);
    if (i % every === 0) els.push(Object.assign(svg('text', { class: 'tick', x: f1(x + bw / 2), y: H - 6, 'text-anchor': 'middle' }), { textContent: b.label }));
  });
  const tip = bubble();
  els.push(tip.g);
  const el = svg('svg', { class: 'chart bars', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${o.label}. Hover, or focus and use the arrow keys, to read values.`, tabindex: 0 }, ...els);
  let cur: number | null = null;
  const show = (i: number | null) => {
    if (cur !== null) rects[cur]?.classList.remove('hot');
    cur = i;
    if (i === null) { tip.hide(); return; }
    rects[i]!.classList.add('hot');
    const b = o.bars[i]!;
    tip.show(L + i * slot + slot / 2, Math.min(Y(b.value), H - B - 20), [b.label, ...b.tip], W - R, T, H - B);
  };
  const fromEvent = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    const i = Math.floor((((e.clientX - r.left) / r.width) * W - L) / slot);
    return i >= 0 && i < n ? i : null;
  };
  el.addEventListener('pointermove', (e) => show(fromEvent(e)));
  el.addEventListener('pointerleave', () => show(null));
  el.addEventListener('blur', () => show(null));
  if (o.bars.some((b) => b.onClick)) {
    el.classList.add('pickable');
    el.addEventListener('click', (e) => { const i = fromEvent(e); if (i !== null) o.bars[i]!.onClick?.(); });
  }
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); show(Math.min(n - 1, (cur ?? -1) + 1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(Math.max(0, (cur ?? n) - 1)); }
    else if (e.key === 'Enter' && cur !== null) o.bars[cur]!.onClick?.();
    else if (e.key === 'Escape') show(null);
  });
  return el;
}
