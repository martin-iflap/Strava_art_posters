import { esc, FONT } from '../posters/common';
import { fromDayNumber } from '../util/time';

/*
 * Small SVG charts for the Wrapped cards and the share picture, as strings (so they work in tests and in
 * the rasterised picture alike). Colours follow the app's dark theme: one accent, white and greys.
 * Colours are attributes, never style="" (the CSP forbids inline styles); animation hooks are classes:
 * w-draw (a line that draws itself, pathLength 1), w-grow (a bar rising from its base), w-fade with a
 * delay class d0–d9 (marks appearing in order).
 */

export const ACCENT = '#2997ff';
export const TEXT = '#f5f5f7';
export const MUTED = '#a1a1a6';
export const W = 440;

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();
const delay = (i: number, n: number) => `d${Math.min(9, Math.floor((i / Math.max(n, 1)) * 10))}`;

export function frame(h: number, body: string, label = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" class="w-chart" font-family="${esc(FONT)}"${label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"'}>${body}</svg>`;
}

export function text(x: number, y: number, s: string, o: { size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; weight?: number; opacity?: number } = {}): string {
  return `<text x="${n1(x)}" y="${n1(y)}" font-size="${o.size ?? 13}" fill="${o.fill ?? MUTED}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.weight ? ` font-weight="${o.weight}"` : ''}${o.opacity !== undefined ? ` fill-opacity="${o.opacity}"` : ''}>${esc(s)}</text>`;
}

const MONTH_INITIALS = 'JFMAMJJASOND';

/** Ticks along a span of days: month initials for one year, year labels for longer spans. */
export function dayTicks(day0: number, day1: number): { day: number; label: string }[] {
  const out: { day: number; label: string }[] = [];
  const p0 = fromDayNumber(day0);
  if (day1 - day0 <= 370) {
    for (let m = 1; m <= 12; m++) out.push({ day: Math.floor(Date.UTC(p0.y, m - 1, 1) / 86_400_000), label: MONTH_INITIALS[m - 1]! });
  } else {
    const p1 = fromDayNumber(day1);
    const every = Math.ceil((p1.y - p0.y + 1) / 8);
    for (let y = p0.y + 1; y <= p1.y; y += every) out.push({ day: Math.floor(Date.UTC(y, 0, 1) / 86_400_000), label: String(y) });
  }
  return out;
}

/** Levels 0–4 by quartiles of the non-zero values. */
function levels(vals: number[]): (v: number) => number {
  const nz = vals.filter((v) => v > 0).sort((a, b) => a - b);
  const q = [0.25, 0.5, 0.75].map((f) => nz[Math.floor(f * (nz.length - 1))] ?? 0);
  return (v) => (v <= 0 ? 0 : v <= q[0]! ? 1 : v <= q[1]! ? 2 : v <= q[2]! ? 3 : 4);
}
const LEVEL_OPACITY = [0.1, 0.32, 0.55, 0.78, 1];

/** One year as dots: 53 week columns × 7 weekday rows, brighter = further that day. */
export function heatYear(values: number[], day0: number): string {
  const lv = levels(values);
  const wd0 = (fromDayNumber(day0).wd);
  const c = W / 53, r = c * 0.36, top = 16;
  let body = '';
  values.forEach((v, i) => {
    const k = i + wd0, col = Math.floor(k / 7), row = k % 7;
    const l = lv(v);
    body += `<circle cx="${n1(col * c + c / 2)}" cy="${n1(top + row * c + c / 2)}" r="${n1(r)}" fill="${l ? ACCENT : '#fff'}" fill-opacity="${LEVEL_OPACITY[l]}" class="w-fade ${delay(col, 53)}"/>`;
  });
  for (const t of dayTicks(day0, day0 + 364)) body += text(Math.floor((t.day - day0 + wd0) / 7) * c + 1, 10, t.label, { size: 11 });
  return frame(top + 7 * c + 2, body);
}

/** Several years as rows of weekly squares, brighter = further that week. */
export function heatYears(values: number[], day0: number): string {
  const byYear = new Map<number, number[]>();
  values.forEach((v, i) => {
    const p = fromDayNumber(day0 + i);
    const doy = day0 + i - Math.floor(Date.UTC(p.y, 0, 1) / 86_400_000);
    const row = byYear.get(p.y) ?? byYear.set(p.y, Array<number>(53).fill(0)).get(p.y)!;
    row[Math.min(52, Math.floor(doy / 7))]! += v;
  });
  const ys = [...byYear.keys()].sort((a, b) => a - b).slice(-12);
  const lv = levels(ys.flatMap((y) => byYear.get(y)!));
  const left = 40, c = (W - left) / 53, gap = c * 0.18;
  const rh = Math.max(c, Math.min(22, 110 / ys.length)); // few years: taller rows, so the chart is not a sliver
  let body = '';
  ys.forEach((y, r) => {
    body += text(0, r * rh + rh / 2 + 4, String(y), { size: 11 });
    byYear.get(y)!.forEach((v, k) => {
      const l = lv(v);
      body += `<rect x="${n1(left + k * c)}" y="${n1(r * rh)}" width="${n1(c - gap)}" height="${n1(rh - gap)}" rx="1.5" fill="${l ? ACCENT : '#fff'}" fill-opacity="${LEVEL_OPACITY[l]}" class="w-fade ${delay(r, ys.length)}"/>`;
    });
  });
  return frame(ys.length * rh, body);
}

/** Cumulative line (filled underneath) with ticks, an end label, and optional grey lines to compare with. */
export function cumulative(values: number[], o: { ticks: { at: number; label: string }[]; end?: string; others?: { values: number[]; label?: string }[]; h?: number; lines?: { at: number; label: string }[] }): string {
  const h = o.h ?? 190, top = 22, bottom = h - 18, right = W - 4;
  const all = [values, ...(o.others ?? []).map((x) => x.values)];
  const max = Math.max(...all.map((v) => v[v.length - 1] ?? 0), ...(o.lines ?? []).map((l) => l.at), 1);
  const len = Math.max(...all.map((v) => v.length), 2);
  const step = Math.max(1, Math.floor(len / 300));
  const pts = (v: number[]) => v.filter((_, i) => i % step === 0 || i === v.length - 1).map((y, i, arr) => {
    const idx = Math.min(v.length - 1, i * step);
    void arr;
    return [(idx / (len - 1)) * right, bottom - (y / max) * (bottom - top)] as const;
  });
  const d = (v: number[]) => 'M' + pts(v).map(([x, y]) => `${n1(x)},${n1(y)}`).join('L');
  let body = `<line x1="0" x2="${W}" y1="${bottom}" y2="${bottom}" stroke="#fff" stroke-opacity=".16"/>`;
  for (const l of o.lines ?? []) {
    const y = bottom - (l.at / max) * (bottom - top);
    body += `<line x1="0" x2="${right}" y1="${n1(y)}" y2="${n1(y)}" stroke="#fff" stroke-opacity=".22" stroke-dasharray="3 4"/>` + text(right, y - 4, l.label, { size: 11, anchor: 'end' });
  }
  const main = pts(values);
  const last = main[main.length - 1]!;
  for (const x of o.others ?? []) {
    body += `<path d="${d(x.values)}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="1.5" class="w-draw" pathLength="1"/>`;
    const p = pts(x.values).pop()!;
    // keep the label clear of the main line's end label: below the line when the two ends are close
    const near = o.end && Math.abs(p[0] - last[0]) < 90 && Math.abs(p[1] - last[1]) < 26;
    if (x.label) body += text(Math.min(p[0], right - 2), near ? Math.max(p[1], last[1]) + 18 : p[1] - 6, x.label, { size: 12, anchor: 'end' });
  }
  body += `<path d="${d(values)}L${n1(last[0])},${bottom}L0,${bottom}Z" fill="${ACCENT}" fill-opacity=".14" class="w-fade d5"/>`;
  body += `<path d="${d(values)}" fill="none" stroke="${ACCENT}" stroke-width="2.5" stroke-linejoin="round" class="w-draw" pathLength="1"/>`;
  body += `<circle cx="${n1(last[0])}" cy="${n1(last[1])}" r="4" fill="${ACCENT}" class="w-fade d9"/>`;
  if (o.end) body += text(Math.min(last[0], right - 2), last[1] - 10, o.end, { size: 14, fill: TEXT, anchor: 'end', weight: 600 });
  for (const t of o.ticks) body += text((t.at / (len - 1)) * right, h - 4, t.label, { size: 11, anchor: 'middle' });
  return frame(h, body);
}

/** Vertical bars; `stack` splits a bar into an accent part, a light part and a faint rest. */
export function bars(values: number[], o: { highlight?: number; labels?: { at: number; label: string }[]; h?: number; stack?: [number, number, number][]; topLabel?: string; dim?: boolean } = {}): string {
  const h = o.h ?? 150, bottom = h - (o.labels ? 16 : 2), top = o.topLabel ? 22 : 4;
  const n = values.length, bw = W / n, gap = n > 60 ? 0.6 : Math.min(4, bw * 0.25);
  const max = Math.max(...values, 1e-9);
  let body = '';
  values.forEach((v, i) => {
    const x = i * bw, ht = (v / max) * (bottom - top);
    if (v <= 0) return;
    const cls = `w-grow ${delay(i, n)}`;
    if (o.stack) {
      const [a, b] = o.stack[i]!;
      const tot = o.stack[i]!.reduce((s, x2) => s + x2, 0) || 1;
      const ha = (a / tot) * ht, hb = (b / tot) * ht;
      body += `<g class="${cls}"><rect x="${n1(x)}" y="${n1(bottom - ht)}" width="${n1(bw - gap)}" height="${n1(ht - ha - hb)}" fill="#fff" fill-opacity=".22"/>`
        + `<rect x="${n1(x)}" y="${n1(bottom - ha - hb)}" width="${n1(bw - gap)}" height="${n1(hb)}" fill="#fff" fill-opacity=".6"/>`
        + `<rect x="${n1(x)}" y="${n1(bottom - ha)}" width="${n1(bw - gap)}" height="${n1(ha)}" fill="${ACCENT}"/></g>`;
    } else {
      const hi = o.highlight === i;
      body += `<rect x="${n1(x)}" y="${n1(bottom - ht)}" width="${n1(bw - gap)}" height="${n1(Math.max(ht, 1))}" rx="${n > 60 ? 0 : 2}" fill="${hi || (o.highlight === undefined && !o.dim) ? ACCENT : '#fff'}" fill-opacity="${hi || (o.highlight === undefined && !o.dim) ? 1 : 0.3}" class="${cls}"/>`;
    }
  });
  if (o.topLabel && o.highlight !== undefined) {
    const x = Math.min(Math.max(o.highlight * bw + bw / 2, 30), W - 30);
    body += text(x, 14, o.topLabel, { size: 13, fill: TEXT, anchor: 'middle', weight: 600 });
  }
  for (const l of o.labels ?? []) body += text(l.at * bw + bw / 2, h - 3, l.label, { size: 11, anchor: 'middle' });
  return frame(h, body);
}

/** Weekday × hour dots, sized by how often you started then; the busiest one in the accent. */
export function punchCard(grid: number[][], dayLabels: string[]): string {
  const left = 30, top = 16, c = (W - left) / 24, max = Math.max(...grid.flat(), 1);
  let best = [0, 0];
  grid.forEach((row, d) => row.forEach((v, hr) => { if (v > grid[best[0]!]![best[1]!]!) best = [d, hr]; }));
  let body = '';
  grid.forEach((row, d) => {
    body += text(0, top + d * c + c * 0.68, dayLabels[d]!, { size: 11 });
    row.forEach((v, hr) => {
      const cx = left + hr * c + c / 2, cy = top + d * c + c / 2;
      const hi = d === best[0] && hr === best[1];
      body += v ? `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(Math.max(1.2, Math.sqrt(v / max) * c * 0.46))}" fill="${hi ? ACCENT : '#fff'}" fill-opacity="${hi ? 1 : 0.55}" class="w-fade ${delay(hr, 24)}"/>`
        : `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="1" fill="#fff" fill-opacity=".14"/>`;
    });
  });
  for (const hr of [0, 6, 12, 18]) body += text(left + hr * c + c / 2, 10, `${hr}:00`, { size: 11, anchor: 'middle' });
  return frame(top + 7 * c + 4, body);
}

/** Every start as a tick on a 24-hour line; the earliest and latest marked. */
export function startStrip(starts: number[], earliest: number, latest: number, el: string, ll: string): string {
  const h = 120, y0 = 50, y1 = 90, x = (hr: number) => 6 + (hr / 24) * (W - 12);
  let body = `<line x1="6" x2="${W - 6}" y1="${y1}" y2="${y1}" stroke="#fff" stroke-opacity=".2"/>`;
  // night shading: before 6 and after 21
  body += `<rect x="6" y="${y0 - 6}" width="${n1(x(6) - 6)}" height="${y1 - y0 + 6}" fill="#fff" fill-opacity=".05"/><rect x="${n1(x(21))}" y="${y0 - 6}" width="${n1(x(24) - x(21))}" height="${y1 - y0 + 6}" fill="#fff" fill-opacity=".05"/>`;
  starts.forEach((s, i) => { body += `<line x1="${n1(x(s))}" x2="${n1(x(s))}" y1="${y0 + 8}" y2="${y1}" stroke="#fff" stroke-opacity=".28" class="w-fade ${delay(i, starts.length)}"/>`; });
  for (const [hr, lab, anchor] of [[earliest, el, 'start'], [latest, ll, 'end']] as const) {
    const xx = x(hr);
    body += `<line x1="${n1(xx)}" x2="${n1(xx)}" y1="${y0 - 14}" y2="${y1}" stroke="${ACCENT}" stroke-width="2.5" class="w-grow d8"/>`
      + text(anchor === 'start' ? Math.max(xx - 2, 4) : Math.min(xx + 2, W - 4), y0 - 22, lab, { size: 14, fill: TEXT, weight: 600, anchor });
  }
  for (const hr of [0, 6, 12, 18, 24]) body += text(x(hr), h - 10, `${hr}:00`, { size: 11, anchor: hr === 0 ? 'start' : hr === 24 ? 'end' : 'middle' });
  return frame(h, body);
}

/** One line of days with active days as ticks and the longest break bracketed. */
export function gapStrip(values: number[], gapStart: number, gapDays: number, label: string): string {
  const h = 96, y = 60, c = W / values.length;
  let body = '';
  values.forEach((v, i) => { if (v > 0) body += `<rect x="${n1(i * c)}" y="${y - 14}" width="${n1(Math.max(c * 0.7, 0.8))}" height="28" fill="#fff" fill-opacity=".5"/>`; });
  const x0 = gapStart * c, x1 = (gapStart + gapDays) * c;
  body += `<rect x="${n1(x0)}" y="${y - 22}" width="${n1(Math.max(x1 - x0, 2))}" height="44" fill="${ACCENT}" fill-opacity=".22" class="w-grow d4"/>`
    + `<path d="M${n1(x0)},${y - 26}V${y - 32}H${n1(x1)}V${y - 26}" fill="none" stroke="${ACCENT}" stroke-width="2" class="w-draw" pathLength="1"/>`
    + text(Math.min(Math.max((x0 + x1) / 2, 40), W - 40), y - 38, label, { size: 14, fill: TEXT, weight: 600, anchor: 'middle' });
  return frame(h, body);
}

/** Routes (flat lat/lon arrays) projected together into the box, faint white; the first one may be the accent. */
export function routesMap(routes: number[][], o: { h?: number; accentFirst?: boolean; width?: number } = {}): string {
  const h = o.h ?? 300;
  let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
  for (const r of routes) for (let i = 0; i < r.length; i += 2) { la0 = Math.min(la0, r[i]!); la1 = Math.max(la1, r[i]!); lo0 = Math.min(lo0, r[i + 1]!); lo1 = Math.max(lo1, r[i + 1]!); }
  if (!Number.isFinite(la0)) return frame(h, '');
  const k = Math.cos((((la0 + la1) / 2) * Math.PI) / 180);
  const bw = (lo1 - lo0) * k || 1e-9, bh = la1 - la0 || 1e-9;
  const s = Math.min((W - 16) / bw, (h - 16) / bh);
  const ox = (W - bw * s) / 2, oy = (h - bh * s) / 2;
  const path = (r: number[]) => {
    let d = '';
    for (let i = 0; i < r.length; i += 2) d += `${i ? 'L' : 'M'}${n1(ox + (r[i + 1]! - lo0) * k * s)},${n1(oy + (la1 - r[i]!) * s)}`;
    return d;
  };
  const sw = o.width ?? (routes.length > 50 ? 1 : 1.6);
  let body = '';
  const rest = o.accentFirst ? routes.slice(1) : routes;
  if (rest.length) body += `<path d="${rest.map(path).join('')}" fill="none" stroke="#fff" stroke-opacity="${routes.length > 50 ? 0.22 : 0.4}" stroke-width="${sw}" stroke-linejoin="round" stroke-linecap="round" class="w-fade d1"/>`;
  if (o.accentFirst && routes[0]) body += `<path d="${path(routes[0])}" fill="none" stroke="${ACCENT}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" class="w-draw" pathLength="1"/>`;
  return frame(h, body);
}

/** An elevation profile as a filled area. */
export function profile(values: number[], h = 80): string {
  const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
  const pts = values.map((v, i) => `${n1((i / (values.length - 1)) * W)},${n1(h - 4 - ((v - lo) / span) * (h - 14))}`);
  return frame(h, `<path d="M0,${h}L${pts.join('L')}L${W},${h}Z" fill="#fff" fill-opacity=".14" class="w-fade d3"/><path d="M${pts.join('L')}" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1.5" class="w-draw" pathLength="1"/>`);
}

/** A mean-maximal power curve on a log time axis, against the earlier best. */
export function powerCurves(now: { seconds: number; watts: number }[], before: { seconds: number; watts: number }[], labelNow: string, labelBefore: string): string {
  const h = 190, top = 20, bottom = h - 18;
  const s0 = Math.log(1), s1 = Math.log(Math.max(...now.map((p) => p.seconds), ...before.map((p) => p.seconds), 3600));
  const max = Math.max(...now.map((p) => p.watts), ...before.map((p) => p.watts), 1);
  const x = (s: number) => ((Math.log(s) - s0) / (s1 - s0)) * (W - 4);
  const y = (w: number) => bottom - (w / max) * (bottom - top);
  const d = (c: { seconds: number; watts: number }[]) => 'M' + c.map((p) => `${n1(x(p.seconds))},${n1(y(p.watts))}`).join('L');
  let body = `<line x1="0" x2="${W}" y1="${bottom}" y2="${bottom}" stroke="#fff" stroke-opacity=".16"/>`;
  if (before.length) body += `<path d="${d(before)}" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  body += `<path d="${d(now)}" fill="none" stroke="${ACCENT}" stroke-width="2.5" class="w-draw" pathLength="1"/>`;
  for (const [s, l] of [[5, '5 s'], [60, '1 min'], [300, '5 min'], [1200, '20 min'], [3600, '1 h']] as const) if (Math.log(s) <= s1) body += text(x(s), h - 4, l, { size: 11, anchor: 'middle' });
  body += `<rect x="${W - 150}" y="2" width="12" height="3" fill="${ACCENT}"/>` + text(W - 134, 7, labelNow, { size: 12 });
  if (before.length) body += `<rect x="${W - 80}" y="2" width="12" height="3" fill="#fff" fill-opacity=".45"/>` + text(W - 64, 7, labelBefore, { size: 12 });
  return frame(h, body);
}

/** A filled line (fitness over the period) with its peak marked. */
export function area(values: number[], peakLabel: string, ticks: { at: number; label: string }[]): string {
  const h = 170, top = 26, bottom = h - 18;
  const max = Math.max(...values, 1);
  const step = Math.max(1, Math.floor(values.length / 300));
  const idx = values.map((_, i) => i).filter((i) => i % step === 0 || i === values.length - 1);
  const X = (i: number) => (i / Math.max(values.length - 1, 1)) * W, Y = (v: number) => bottom - (v / max) * (bottom - top);
  const line = idx.map((i) => `${n1(X(i))},${n1(Y(values[i]!))}`).join('L');
  const pk = values.indexOf(max);
  return frame(h, `<path d="M0,${bottom}L${line}L${W},${bottom}Z" fill="${ACCENT}" fill-opacity=".16" class="w-fade d4"/>`
    + `<path d="M${line}" fill="none" stroke="${ACCENT}" stroke-width="2" class="w-draw" pathLength="1"/>`
    + `<circle cx="${n1(X(pk))}" cy="${n1(Y(max))}" r="4.5" fill="${TEXT}" class="w-fade d9"/>`
    + text(Math.min(Math.max(X(pk), 40), W - 40), Y(max) - 10, peakLabel, { size: 13, fill: TEXT, anchor: 'middle', weight: 600 })
    + ticks.map((t) => text((t.at / Math.max(values.length - 1, 1)) * W, h - 4, t.label, { size: 11, anchor: 'middle' })).join(''));
}

/** Columns of squares: each square is `unit`; partial squares are faint. */
export function waffle(cols: { label: string; v: number }[], unit: number): string {
  const n = cols.length, cw = W / n, sq = Math.min(cw * 0.7, 16), maxN = Math.max(...cols.map((c) => Math.ceil(c.v / unit)), 1);
  const h = maxN * (sq + 3) + 20;
  let body = '';
  cols.forEach((c, i) => {
    const full = Math.floor(c.v / unit), part = c.v / unit - full;
    for (let k = 0; k < full + (part > 0.05 ? 1 : 0); k++) {
      const y = h - 18 - (k + 1) * (sq + 3);
      body += `<rect x="${n1(i * cw + (cw - sq) / 2)}" y="${n1(y)}" width="${n1(sq)}" height="${n1(sq)}" rx="2" fill="${k < full ? ACCENT : '#fff'}" fill-opacity="${k < full ? 1 : 0.3}" class="w-fade ${delay(k, maxN)}"/>`;
    }
    body += text(i * cw + cw / 2, h - 4, c.label, { size: 11, anchor: 'middle' });
  });
  return frame(h, body);
}

/** Horizontal bars with labels and values. */
export function hbars(rows: { label: string; v: number; value: string }[], highlightFirst = true): string {
  const rh = 30, h = rows.length * rh, max = Math.max(...rows.map((r) => r.v), 1);
  let body = '';
  rows.forEach((r, i) => {
    const y = i * rh;
    const w = Math.max(3, (r.v / max) * (W - 150));
    const label = r.label.length > 17 ? `${r.label.slice(0, 16)}…` : r.label;
    body += text(0, y + 18, label, { size: 14, fill: TEXT })
      + `<rect x="140" y="${y + 8}" width="${n1(w)}" height="13" rx="3" fill="${i === 0 && highlightFirst ? ACCENT : '#fff'}" fill-opacity="${i === 0 && highlightFirst ? 1 : 0.35}" class="w-grow-x ${delay(i, rows.length)}"/>`
      + text(146 + w, y + 18, r.value, { size: 13 });
  });
  return frame(h, body);
}

/** Dots: distance (x) against climbing (y), every activity. */
export function scatter(pts: [number, number][], xl: string, yl: string): string {
  const h = 200, left = 4, bottom = h - 16, top = 6;
  const mx = Math.max(...pts.map((p) => p[0]), 1e-9), my = Math.max(...pts.map((p) => p[1]), 1e-9);
  let body = `<line x1="0" x2="${W}" y1="${bottom}" y2="${bottom}" stroke="#fff" stroke-opacity=".16"/>`;
  pts.forEach(([x, y], i) => { body += `<circle cx="${n1(left + (x / mx) * (W - 12))}" cy="${n1(bottom - (y / my) * (bottom - top))}" r="3" fill="${ACCENT}" fill-opacity=".7" class="w-fade ${delay(i, pts.length)}"/>`; });
  return frame(h, body + text(W, h - 3, xl, { size: 11, anchor: 'end' }) + text(2, 12, yl, { size: 11 }));
}

/** A single bar split by share (sports), accent first, then lighter greys. */
export function shareBar(shares: { label: string; share: number }[]): string {
  const h = 54;
  let x = 0, body = '';
  const fills: [string, number][] = [[ACCENT, 1], ['#fff', 0.7], ['#fff', 0.45], ['#fff', 0.28], ['#fff', 0.16]];
  shares.slice(0, 5).forEach((s, i) => {
    const w = s.share * W;
    body += `<rect x="${n1(x)}" y="0" width="${n1(Math.max(w - 2, 1))}" height="16" fill="${fills[i]![0]}" fill-opacity="${fills[i]![1]}" class="w-grow-x ${delay(i, 5)}"/>`;
    if (w > 46) body += text(x, 36, s.label, { size: 13, fill: TEXT }) + text(x, 50, `${Math.round(s.share * 100)} %`, { size: 12 });
    x += w;
  });
  return frame(h, body);
}
