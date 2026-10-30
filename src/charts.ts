import { svg } from './dom';

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

export interface LineChartOptions {
  values: number[];
  /** x extent in display units (km or mi), shown on the axis */
  xMax: number;
  xUnit: string;
  fmtY: (v: number) => string;
  kind: 'speed' | 'hr' | 'power' | 'elevation';
  label: string;
  /** include zero in the y range (speed, power) */
  zeroBased?: boolean;
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
  return svg('svg', { class: `chart chart-${o.kind}`, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.label }, ...els);
}

/** Route polyline fitted into a square viewBox. `markers` adds start (green) and finish (red) dots. */
export function routeSvg(route: number[], opts: { markers?: boolean; label?: string } = {}): SVGElement {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < route.length; i += 2) {
    minLat = Math.min(minLat, route[i]!); maxLat = Math.max(maxLat, route[i]!);
    minLon = Math.min(minLon, route[i + 1]!); maxLon = Math.max(maxLon, route[i + 1]!);
  }
  const k = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const w = (maxLon - minLon) * k || 1e-6, h = maxLat - minLat || 1e-6;
  const pad = opts.markers ? 8 : 4;
  const scale = (100 - 2 * pad) / Math.max(w, h);
  const ox = (100 - w * scale) / 2, oy = (100 - h * scale) / 2;
  const pt = (i: number): [number, number] => [ox + (route[i + 1]! - minLon) * k * scale, oy + (maxLat - route[i]!) * scale];
  const pts: string[] = [];
  for (let i = 0; i < route.length; i += 2) pts.push(pt(i).map(f1).join(','));
  const children: SVGElement[] = [svg('polyline', { class: 'route', points: pts.join(' ') })];
  if (opts.markers) {
    const [sx, sy] = pt(0), [ex, ey] = pt(route.length - 2);
    children.push(svg('circle', { class: 'start', cx: f1(sx), cy: f1(sy), r: 2.4 }), svg('circle', { class: 'finish', cx: f1(ex), cy: f1(ey), r: 2.4 }));
  }
  return svg('svg', { class: 'routesvg', viewBox: '0 0 100 100', role: 'img', 'aria-label': opts.label ?? 'Route preview' }, ...children);
}
