import { h, svg } from './dom';

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

/**
 * Shared zoom of one activity's charts, as a fraction range [from, to] of its distance. Dragging across
 * any chart zooms all of them; null = the whole activity.
 */
export class Zoom {
  private subs: ((r: [number, number] | null) => void)[] = [];
  range: [number, number] | null = null;
  on(f: (r: [number, number] | null) => void): void { this.subs.push(f); }
  set(r: [number, number] | null): void {
    this.range = r && r[1] - r[0] > 0.004 && (r[0] > 0.0001 || r[1] < 0.9999) ? [Math.max(0, r[0]), Math.min(1, r[1])] : null;
    for (const f of this.subs) f(this.range);
  }
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
  zoom?: Zoom;
}

/**
 * Phones: charts scale to the screen width, so a 640–900-unit drawing would shrink its 11 px labels to 4–6 px.
 * Below 600 px the drawings are narrower, which keeps the labels readable.
 */
const narrow = () => typeof innerWidth === 'number' && innerWidth < 600;

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

/** Selection band shown while dragging across a chart, and the drag/click logic shared by all charts. */
function dragZoom(el: SVGElement, W: number, top: number, bottom: number, left: number, right: number, done: (px0: number, px1: number) => void, click: (e: PointerEvent) => void): SVGElement {
  const band = svg('rect', { class: 'zoom-band', y: top, height: bottom - top, visibility: 'hidden' });
  let start: number | null = null, moved = false;
  const px = (e: PointerEvent) => { const r = el.getBoundingClientRect(); return Math.max(left, Math.min(W - right, ((e.clientX - r.left) / r.width) * W)); };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.pointerType === 'mouse') e.preventDefault(); // no text selection while dragging
    start = px(e); moved = false;
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  });
  el.addEventListener('pointermove', (e) => {
    if (start === null) return;
    const x = px(e);
    if (Math.abs(x - start) > 6) moved = true;
    if (!moved) return;
    band.setAttribute('x', f1(Math.min(start, x))); band.setAttribute('width', f1(Math.abs(x - start)));
    band.setAttribute('visibility', 'visible');
  });
  const end = (e: PointerEvent) => {
    if (start === null) return;
    const s0 = start; start = null;
    band.setAttribute('visibility', 'hidden');
    if (moved) { const x = px(e); if (Math.abs(x - s0) > 8) done(Math.min(s0, x), Math.max(s0, x)); }
    else click(e);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { start = null; band.setAttribute('visibility', 'hidden'); });
  return band;
}

/** Responsive line/area chart of one activity stream, sharing hover and zoom with the others. */
export function lineChart(o: LineChartOptions): SVGElement {
  const W = narrow() ? 400 : 900, H = narrow() ? 170 : 190, L = 52, R = 14, T = 12, B = 26;
  const vs = o.values;
  const cursor = o.cursor ?? new Cursor();
  const zoom = o.zoom ?? new Zoom();
  const plot = svg('g');
  const cLine = svg('line', { class: 'cursor', y1: T, y2: H - B });
  const cDot = svg('circle', { class: 'cursor-dot', r: 4 });
  const bubbleBg = svg('rect', { class: 'bubble', rx: 6, height: 22 });
  const bubbleText = svg('text', { class: 'bubble-text' });
  const hover = svg('g', { class: 'hover', visibility: 'hidden', 'pointer-events': 'none' }, cLine, cDot, bubbleBg, bubbleText);
  const el = svg('svg', { class: `chart chart-${o.kind}`, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${o.label}. Hover, or focus and use the arrow keys, to read values. Drag across, or press + and −, to zoom.`, tabindex: 0 }, plot);
  let a0 = 0, a1 = 1, lo = 0, hi = 1;
  const X = (t: number) => L + ((t - a0) / (a1 - a0)) * (W - L - R);
  const Y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const draw = () => {
    [a0, a1] = zoom.range ?? [0, 1];
    const n = vs.length;
    const i0 = Math.max(0, Math.floor(a0 * (n - 1))), i1 = Math.min(n - 1, Math.ceil(a1 * (n - 1)));
    const seen = vs.slice(i0, i1 + 1);
    lo = Math.min(...seen); hi = Math.max(...seen);
    if (o.zeroBased) lo = Math.min(0, lo);
    if (hi - lo < 1e-9) hi = lo + 1;
    const ticks = niceTicks(lo, hi, 3).filter((v) => v >= lo - (hi - lo) * 0.02);
    lo = Math.min(lo, ticks[0]!); hi = Math.max(hi, ticks[ticks.length - 1]!);
    const els: SVGElement[] = [];
    for (const v of ticks) {
      els.push(svg('line', { class: 'gridline', x1: L, x2: W - R, y1: f1(Y(v)), y2: f1(Y(v)) }));
      els.push(Object.assign(svg('text', { class: 'tick', x: L - 6, y: f1(Y(v) + 4), 'text-anchor': 'end' }), { textContent: o.fmtY(v) }));
    }
    const xt = niceTicks(a0 * o.xMax, a1 * o.xMax, W < 600 ? 3 : 6).filter((x) => x >= a0 * o.xMax - 1e-9 && x <= a1 * o.xMax + 1e-9);
    xt.forEach((x, i) => els.push(Object.assign(svg('text', { class: 'tick', x: f1(X(x / o.xMax)), y: H - 6, 'text-anchor': X(x / o.xMax) < L + 14 ? 'start' : X(x / o.xMax) > W - R - 30 ? 'end' : 'middle' }), { textContent: `${f1(x)}${i === xt.length - 1 ? ' ' + o.xUnit : ''}` })));
    const pts: string[] = [];
    for (let i = i0; i <= i1; i++) pts.push(`${f1(X(i / (n - 1)))},${f1(Y(vs[i]!))}`);
    const line = pts.join('L');
    const xa = f1(X(i0 / (n - 1))), xb = f1(X(i1 / (n - 1)));
    els.push(svg('path', { class: 'area', d: `M${xa},${f1(Y(lo))}L${line}L${xb},${f1(Y(lo))}Z` }));
    els.push(svg('path', { class: 'line', d: `M${line}` }));
    plot.replaceChildren(svg('clipPath', { id: clipId }, svg('rect', { x: L, y: 0, width: W - L - R, height: H })), svg('g', { 'clip-path': `url(#${clipId})` }, ...els.filter((e) => e.tagName === 'path')), ...els.filter((e) => e.tagName !== 'path'));
  };
  const clipId = `clip${++clipCounter}`;
  draw();
  zoom.on(() => { draw(); cursor.set(cur); });
  const band = dragZoom(el, W, T, H - B, L, R, (p0, p1) => zoom.set([a0 + ((p0 - L) / (W - L - R)) * (a1 - a0), a0 + ((p1 - L) / (W - L - R)) * (a1 - a0)]), (e) => cursor.set(fromEvent(e)));
  el.append(band, hover);
  let cur: number | null = null;
  cursor.on((t) => {
    cur = t;
    if (t === null || t < a0 || t > a1) { hover.setAttribute('visibility', 'hidden'); return; }
    const v = sampleAt(vs, t);
    const x = X(t), y = Y(v);
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
    return a0 + ((vx - L) / (W - L - R)) * (a1 - a0);
  };
  el.addEventListener('pointermove', (e) => cursor.set(fromEvent(e)));
  // A lifted finger 'leaves' too: keep a tapped readout until the next tap or until focus moves.
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') cursor.set(null); });
  el.addEventListener('blur', () => cursor.set(null));
  el.addEventListener('keydown', (e) => {
    const step = ((e.shiftKey ? 0.1 : 0.01) * (a1 - a0));
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); cursor.set(Math.max(a0, Math.min(a1, (cur ?? (e.key === 'ArrowRight' ? a0 - step : a1 + step)) + (e.key === 'ArrowRight' ? step : -step)))); }
    else if (e.key === 'Home') { e.preventDefault(); cursor.set(a0); }
    else if (e.key === 'End') { e.preventDefault(); cursor.set(a1); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); const c = cur ?? (a0 + a1) / 2, w = (a1 - a0) / 4; zoom.set([Math.max(0, c - w), Math.min(1, c + w)]); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); const c = (a0 + a1) / 2, w = a1 - a0; zoom.set(w >= 0.5 ? null : [Math.max(0, c - w), Math.min(1, c + w)]); }
    else if (e.key === '0') zoom.set(null);
    else if (e.key === 'Escape') cursor.set(null);
  });
  return el;
}
let clipCounter = 0;

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
  /** draw the points as dots instead of a line */
  dots?: boolean;
  /** dashed line (models, targets) */
  dash?: boolean;
}

export interface XYChartOptions {
  series: XYSeries[];
  label: string;
  log?: boolean;
  /** tick values, or a function giving them for the visible x range */
  xTicks: number[] | ((lo: number, hi: number) => number[]);
  fmtX: (x: number) => string;
  fmtY: (y: number) => string;
  /** heading of the hover bubble (defaults to fmtX) */
  tipX?: (x: number) => string;
  /** extra bubble line for a series' point (e.g. the date it was set), by series name and x */
  tipExtra?: (series: string, x: number) => string | null;
  yZero?: boolean;
  /** draw a zero line (for values that go negative) */
  zeroLine?: boolean;
  height?: number;
  /** a click picks the nearest point of the first series: its x */
  onPick?: (x: number) => void;
  /** visible x range (data units); default: everything */
  xDomain?: [number, number] | null;
  /** dragging across the chart (or + and − keys) asks for this x range */
  onZoom?: (lo: number, hi: number) => void;
}

/** Line chart over a numeric (optionally logarithmic) x axis, with one shared y axis, a hover readout and drag-to-zoom. */
export function xyChart(o: XYChartOptions): SVGElement {
  const W = narrow() ? 420 : 640, H = o.height ?? 220, L = 48, R = o.series.some((s) => s.endLabel) ? 44 : 12, T = 12, B = 26;
  const tx = (x: number) => (o.log ? Math.log(Math.max(x, 1e-9)) : x);
  const ux = (t: number) => (o.log ? Math.exp(t) : t);
  const allX = o.series.flatMap((s) => s.points.map((p) => p[0]));
  const staticTicks = Array.isArray(o.xTicks) ? o.xTicks : [];
  const full: [number, number] = [Math.min(...allX, ...staticTicks), Math.max(...allX, ...staticTicks)];
  const dom: [number, number] = o.xDomain ? [Math.max(full[0], o.xDomain[0]), Math.min(full[1], o.xDomain[1])] : full;
  const x0 = tx(dom[0]), x1 = tx(dom[1]);
  const inDom = (x: number) => x >= dom[0] - 1e-9 && x <= dom[1] + 1e-9;
  // points inside the range, plus one beyond each edge so lines run to the frame (clipped)
  const clip = (pts: [number, number][]) => {
    const i0 = pts.findIndex((p) => inDom(p[0]));
    if (i0 < 0) return [];
    let i1 = i0; while (i1 + 1 < pts.length && inDom(pts[i1 + 1]![0])) i1++;
    return pts.slice(Math.max(0, i0 - 1), Math.min(pts.length, i1 + 2));
  };
  const series = o.series.map((s) => ({ ...s, points: clip(s.points) }));
  const vis = series.flatMap((s) => s.points.filter((p) => inDom(p[0])));
  let lo = Math.min(...vis.map((p) => p[1])), hi = Math.max(...vis.map((p) => p[1]));
  if (!vis.length) { lo = 0; hi = 1; }
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
  const xTicks = (typeof o.xTicks === 'function' ? o.xTicks(dom[0], dom[1]) : o.xTicks).filter(inDom);
  xTicks.forEach((v) => { const px = X(v); els.push(Object.assign(svg('text', { class: 'tick', x: f1(px), y: H - 6, 'text-anchor': px < L + 20 ? 'start' : px > W - R - 20 ? 'end' : 'middle' }), { textContent: o.fmtX(v) })); });
  const clipId = `clip${++clipCounter}`;
  const marks: SVGElement[] = [];
  for (const s of series) {
    if (s.points.length < 1) continue;
    if (s.dots) { for (const p of s.points) if (inDom(p[0])) marks.push(svg('circle', { class: `xy-dot ${s.cls}`, cx: f1(X(p[0])), cy: f1(Y(p[1])), r: 3 })); continue; }
    const d = s.points.map((p) => `${f1(X(p[0]))},${f1(Y(p[1]))}`).join('L');
    if (s.area) marks.push(svg('path', { class: `xy-area ${s.cls}`, d: `M${f1(X(s.points[0]![0]))},${f1(Y(Math.max(lo, 0)))}L${d}L${f1(X(s.points[s.points.length - 1]![0]))},${f1(Y(Math.max(lo, 0)))}Z` }));
    marks.push(svg('path', { class: `xy-line ${s.cls}${s.dash ? ' dash' : ''}`, d: `M${d}` }));
  }
  els.push(svg('clipPath', { id: clipId }, svg('rect', { x: L, y: 0, width: W - L - R, height: H })), svg('g', { 'clip-path': `url(#${clipId})` }, ...marks));
  // end-of-line labels, pushed apart so they never overlap (at least 13 px between baselines)
  const labels = series.filter((s) => s.endLabel && s.points.length && inDom(s.points[s.points.length - 1]![0])).map((s) => { const p = s.points[s.points.length - 1]!; return { s, x: X(p[0]) + 5, y: Y(p[1]) + 4 }; }).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i]!.y - labels[i - 1]!.y < 13 && Math.abs(labels[i]!.x - labels[i - 1]!.x) < 40) labels[i]!.y = labels[i - 1]!.y + 13;
  for (const l of labels) els.push(Object.assign(svg('text', { class: 'end-label', x: f1(l.x), y: f1(l.y) }), { textContent: l.s.name }));
  const cLine = svg('line', { class: 'cursor', y1: T, y2: H - B });
  const dots = series.map((s) => svg('circle', { class: `cursor-dot ${s.cls}`, r: 4 }));
  const tip = bubble();
  const hover = svg('g', { visibility: 'hidden', 'pointer-events': 'none' }, cLine, ...dots);
  const zoomHint = o.onZoom ? ' Drag across, or press + and −, to zoom.' : '';
  const el = svg('svg', { class: 'chart xy', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${o.label}. Hover, or focus and use the arrow keys, to read values.${zoomHint}`, tabindex: 0 }, ...els);
  // hover and picking follow the series with the most visible points (a part-year still reads against full ones)
  const count = (s: XYSeries) => s.points.filter((p) => inDom(p[0])).length;
  const ref = [...series].sort((a, b) => count(b) - count(a))[0];
  const refPts = ref ? ref.points.map((p, i) => [p, i] as const).filter(([p]) => inDom(p[0])).map(([, i]) => i) : [];
  // nearest point of a series to pixel x
  const nearest = (s: XYSeries, px: number) => {
    let bi = -1, bd = Infinity;
    s.points.forEach((p, i) => { if (!inDom(p[0])) return; const d = Math.abs(X(p[0]) - px); if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  let cur: number | null = null;
  const show = (i: number | null) => {
    cur = i;
    if (i === null || !ref?.points[i]) { hover.setAttribute('visibility', 'hidden'); tip.hide(); return; }
    const p0 = ref.points[i]!;
    const px = X(p0[0]);
    cLine.setAttribute('x1', f1(px)); cLine.setAttribute('x2', f1(px));
    const lines = [(o.tipX ?? o.fmtX)(p0[0])];
    series.forEach((s, k) => {
      const j = nearest(s, px);
      const p = j >= 0 && Math.abs(X(s.points[j]![0]) - px) < (s.dots ? 6 : 3) ? s.points[j]! : null;
      dots[k]!.setAttribute('visibility', p ? 'visible' : 'hidden');
      if (!p) return;
      dots[k]!.setAttribute('cx', f1(X(p[0]))); dots[k]!.setAttribute('cy', f1(Y(p[1])));
      lines.push(`${s.name}: ${o.fmtY(p[1])}`);
      const extra = o.tipExtra?.(s.name, p[0]);
      if (extra) lines.push(`  ${extra}`);
    });
    hover.setAttribute('visibility', 'visible');
    tip.show(px, Y(p0[1]), lines, W - R, T, H - B);
  };
  const pxOf = (e: PointerEvent) => { const r = el.getBoundingClientRect(); return ((e.clientX - r.left) / r.width) * W; };
  const fromEvent = (e: PointerEvent) => (ref ? nearest(ref, pxOf(e)) : -1);
  const pick = (i: number | null) => { if (o.onPick && ref && i !== null && i >= 0) o.onPick(ref.points[i]![0]); };
  if (o.onPick) el.classList.add('pickable');
  const band = o.onZoom
    ? dragZoom(el, W, T, H - B, L, R, (p0, p1) => o.onZoom!(ux(x0 + ((p0 - L) / (W - L - R)) * (x1 - x0)), ux(x0 + ((p1 - L) / (W - L - R)) * (x1 - x0))), (e) => pick(fromEvent(e)))
    : null;
  if (!band && o.onPick) el.addEventListener('click', (e) => pick(fromEvent(e as PointerEvent)));
  if (band) el.append(band);
  el.append(hover, tip.g);
  el.addEventListener('pointermove', (e) => show(fromEvent(e)));
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') show(null); });
  el.addEventListener('blur', () => show(null));
  el.addEventListener('keydown', (e) => {
    const k = refPts.indexOf(cur ?? -1);
    const n = refPts.length;
    const step = e.shiftKey ? Math.max(1, Math.round(n / 10)) : 1;
    if (e.key === 'ArrowRight') { e.preventDefault(); show(refPts[Math.min(n - 1, (k < 0 ? -1 : k) + step)] ?? null); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(refPts[Math.max(0, (k < 0 ? n : k) - step)] ?? null); }
    else if (e.key === 'Enter' && cur !== null) pick(cur);
    else if (e.key === 'Escape') show(null);
    else if (o.onZoom && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
      e.preventDefault();
      const c = cur !== null && ref ? tx(ref.points[cur]![0]) : (x0 + x1) / 2;
      const w = (x1 - x0) * (e.key === '+' || e.key === '=' ? 0.25 : 1);
      o.onZoom(ux(c - w), ux(c + w));
    }
  });
  return el;
}

const views = new Map<string, { domain: [number, number] | null; hidden: Set<string> | null }>();
/** Forget every chart's zoom and hidden series (a new export was loaded). */
export function resetChartViews(): void { views.clear(); }

/**
 * An xyChart with a legend whose entries show and hide their series, drag-to-zoom and a reset button.
 * The view is remembered under `key` while the page re-renders.
 */
export function chartBox(o: XYChartOptions & { key: string; legend?: boolean; hidden?: string[]; onView?: (domain: [number, number] | null) => void }): HTMLElement {
  const v0 = views.get(o.key) ?? views.set(o.key, { domain: o.xDomain ?? null, hidden: null }).get(o.key)!;
  v0.hidden ??= new Set(o.hidden ?? []);
  const v = v0 as { domain: [number, number] | null; hidden: Set<string> };
  const allX = o.series.flatMap((s) => s.points.map((p) => p[0]));
  const fullLo = Math.min(...allX), fullHi = Math.max(...allX);
  const box = h('div', { class: 'chart-box' });
  const legend = h('div', { class: 'chart-legend', role: 'group', 'aria-label': 'Series shown' });
  const reset = h('button', { class: 'zoom-reset', onclick: () => { v.domain = null; draw(); } }, 'Reset zoom');
  const hint = h('span', { class: 'zoom-hint' }, 'Drag across the chart to zoom in');
  const holder = h('div', {});
  const draw = () => {
    const focused = box.contains(document.activeElement) && document.activeElement?.tagName === 'svg';
    legend.replaceChildren(...(o.legend === false ? [] : o.series.map((s) => h('button', { class: s.cls, 'aria-pressed': String(!v.hidden.has(s.name)), title: v.hidden.has(s.name) ? `Show ${s.name}` : `Hide ${s.name}`,
      onclick: () => {
        if (v.hidden.has(s.name)) v.hidden.delete(s.name);
        else if (o.series.filter((x) => !v.hidden.has(x.name)).length > 1) v.hidden.add(s.name);
        draw();
      } }, h('i', {}), s.name))));
    const zoomed = !!v.domain;
    reset.hidden = !zoomed;
    hint.hidden = zoomed;
    const chart = xyChart({ ...o, series: o.series.filter((s) => !v.hidden.has(s.name)), xDomain: v.domain,
      onZoom: (lo, hi) => {
        const d: [number, number] = [Math.max(fullLo, lo), Math.min(fullHi, hi)];
        v.domain = d[0] <= fullLo && d[1] >= fullHi ? null : d[1] > d[0] ? d : v.domain;
        draw();
      } });
    holder.replaceChildren(chart);
    o.onView?.(v.domain);
    if (focused) (chart as unknown as HTMLElement).focus({ preventScroll: true });
  };
  draw();
  box.append(h('div', { class: 'chart-tools' }, legend, h('span', { class: 'spacer' }), hint, reset), holder);
  return box;
}

/** Set a chartBox's visible x range before it is drawn (period buttons). */
export function setChartView(key: string, domain: [number, number] | null): void {
  const v = views.get(key);
  if (v) v.domain = domain; else views.set(key, { domain, hidden: null });
}

/** Visible x range of a chartBox (null = all), for summaries of the zoomed period. */
export const chartView = (key: string): [number, number] | null => views.get(key)?.domain ?? null;

export interface Bar { label: string; value: number; tip: string[]; onClick?: () => void; selected?: boolean; /** stacked segments (bottom first) that add up to value */ parts?: { value: number; cls: string }[] }

/** Vertical bar chart (one series) with a hover readout per bar. Bars with onClick are clickable. */
export function barChart(o: { bars: Bar[]; label: string; fmtY: (v: number) => string; height?: number; cls?: string; labelEvery?: number }): SVGElement {
  const W = narrow() ? 420 : 640, H = o.height ?? 180, L = 48, R = 8, T = 12, B = 24;
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
    const rect = svg('path', { class: `bar ${o.cls ?? ''}${b.selected ? ' selected' : ''}${b.parts ? ' stack-top' : ''}`, d });
    rects.push(rect);
    if (b.parts && hgt > 0) {
      // stacked: square segments from the axis up; the rounded outline on top carries hover and selection
      let acc = 0;
      const g = svg('g', { class: 'stack' });
      for (const p of b.parts) {
        if (p.value <= 0) continue;
        const ya = Y(acc + p.value), yb = Y(acc);
        g.append(svg('rect', { class: `seg-part ${p.cls}`, x: f1(x), y: f1(ya), width: f1(bw), height: f1(Math.max(0, yb - ya - (acc + p.value < b.value ? 0 : 0))) }));
        acc += p.value;
      }
      els.push(g);
    }
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
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') show(null); });
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
