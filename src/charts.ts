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
