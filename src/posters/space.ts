import type { Activity } from '../types';
import { parts } from '../util/time';
import { distance, distanceUnit } from '../util/units';
import { emptyMessage, esc, fmtCount, int, mix, n1, wrapSvg, type Frame, type Poster, type PosterOptions } from './common';

/** Heights above the ground, metres, lowest first. */
export const ALTITUDES = [
  { name: 'Everest', m: 8_849 },
  { name: 'Airliners', m: 11_000 },
  { name: 'Kármán line · edge of space', m: 100_000 },
  { name: 'International Space Station', m: 408_000 },
  { name: 'GPS satellites', m: 20_200_000 },
  { name: 'Geostationary orbit', m: 35_786_000 },
  { name: 'The Moon', m: 384_400_000 },
] as const;

/** The highest mark passed and the next one above `m` (null beyond the Moon). */
export function altitudeMarks(m: number): { passed: (typeof ALTITUDES)[number] | null; next: (typeof ALTITUDES)[number] | null } {
  const i = ALTITUDES.findIndex((a) => a.m > m);
  return { passed: i === 0 ? null : ALTITUDES[i < 0 ? ALTITUDES.length - 1 : i - 1]!, next: i < 0 ? null : ALTITUDES[i]! };
}

/**
 * Height on the poster for an altitude: log(1 + km), so the first kilometres (a few rides) and the Moon
 * both fit, and each power of ten gets the same room.
 */
const lift = (m: number) => Math.log10(1 + m / 1000);

/**
 * "To space": the total (metres climbed, or every distance unit pointed straight up) as a helix rising
 * from the Earth past Everest, the edge of space, the ISS and further marks, coloured by year.
 */
export function space(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  const value = o.spaceMetric === 'distance' ? (a: Activity) => a.distanceM : (a: Activity) => a.elevGainM;
  const sel = acts.filter((a) => value(a) > 0).sort((a, b) => a.startMs - b.startMs);
  const total = sel.reduce((s, a) => s + value(a), 0);
  if (!total) return wrapSvg(f, o, emptyMessage(f, o.spaceMetric === 'distance' ? 'No distance in this selection' : 'No elevation gain in this selection'));
  const t = f.theme, du = distanceUnit(o.units);
  const { passed, next } = altitudeMarks(total);
  const big = (m: number) => `${int(distance(m, o.units))} ${du}`;

  // Headline: the total, the highest mark passed and how far towards the next one.
  const cw = f.w / 3;
  const col = (i: number, value: string, unit: string, label: string, detail: string) => {
    const x = f.x + i * cw;
    return `<text x="${n1(x)}" y="${n1(f.y + 72)}" font-size="46" font-weight="700" letter-spacing="-2" fill="${t.fg}">${esc(value)}<tspan font-size="26" font-weight="600" dx="3" fill="${t.accent}">${esc(unit)}</tspan></text>` +
      `<text x="${n1(x)}" y="${n1(f.y + 100)}" font-size="17" font-weight="600" fill="${t.fg}">${esc(label)}</text>` +
      `<text x="${n1(x)}" y="${n1(f.y + 121)}" font-size="12" letter-spacing="1" fill="${t.muted}">${esc(detail)}</text>`;
  };
  let body = `<text x="${f.x}" y="${f.y + 18}" font-size="16" letter-spacing="3" fill="${t.muted}">${o.spaceMetric === 'distance' ? `IF EVERY ${du === 'km' ? 'KILOMETRE' : 'MILE'} WENT STRAIGHT UP` : 'IF YOUR CLIMBING WENT STRAIGHT UP'}</text>` +
    col(0, int(distance(total, o.units)), du, o.spaceMetric === 'distance' ? 'travelled' : 'climbed', `${int(sel.length)} ACTIVITIES`);
  if (passed) body += col(1, fmtCount(total / passed.m), '×', passed.name.split(' · ')[0]!, `${big(passed.m).toUpperCase()} UP`);
  if (next) body += col(passed ? 2 : 1, String(Math.min(99, Math.floor((total / next.m) * 100))), '%', `of the way to ${next.name === 'The Moon' ? 'the Moon' : next.name.split(' · ')[0]!}`, `${big(next.m).toUpperCase()} UP`);

  // Plot: Earth along the bottom, altitude marks as dashed lines, the helix in between.
  const top = f.y + 180, base = f.y + f.h - 50, H = base - top;
  const ceiling = lift((next ?? ALTITUDES[ALTITUDES.length - 1]!).m) * 1.04;
  const Y = (m: number) => base - (lift(m) / ceiling) * H;
  const cx = f.x + f.w * 0.36;
  const earthR = f.W * 1.4;
  const defs = `<clipPath id="space-clip"><rect x="0" y="${n1(top - 40)}" width="${f.W}" height="${n1(f.y + f.h - top + 40)}"/></clipPath>` +
    `<linearGradient id="space-air" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${t.accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></linearGradient>`;
  body += `<g clip-path="url(#space-clip)">` +
    `<rect x="0" y="${n1(base - 70)}" width="${f.W}" height="70" fill="url(#space-air)"/>` +
    `<circle cx="${n1(f.W / 2)}" cy="${n1(base + earthR)}" r="${n1(earthR)}" fill="${mix(t.bg, t.accent, 0.22)}" stroke="${t.accent}" stroke-width="2"/></g>` +
    `<text x="${f.x}" y="${n1(base + 30)}" font-size="13" letter-spacing="1" fill="${t.muted}">EARTH · HEIGHTS ON A LOG SCALE: EACH STEP ×10 GETS THE SAME ROOM</text>`;

  // Marks, skipping any that would print on top of a lower one.
  let lastY = Infinity;
  for (const a of ALTITUDES) {
    if (a.m > (next ?? a).m) break;
    const y = Y(a.m);
    if (lastY - y < 30) continue;
    lastY = y;
    const reached = a.m <= total;
    body += `<line x1="${f.x}" x2="${n1(f.x + f.w)}" y1="${n1(y)}" y2="${n1(y)}" stroke="${reached ? t.fg : t.muted}" stroke-opacity="${reached ? 0.45 : 0.3}" stroke-dasharray="4 6"/>` +
      `<text x="${n1(f.x + f.w)}" y="${n1(y - 8)}" font-size="15" text-anchor="end" fill="${reached ? t.fg : t.muted}">${esc(a.name)}<tspan fill="${t.muted}"> · ${esc(big(a.m))}</tspan></text>`;
  }

  // The helix: evenly spaced in poster height, five turns over the full height, narrowing as it rises
  // (as if seen from below). Parts behind the axis are drawn first and fainter; the colour fades from the
  // text colour to the accent with height.
  const end = lift(total) / ceiling, STEPS = 900, TURNS = 5, SHADES = 12;
  const pts = Array.from({ length: STEPS + 1 }, (_, i) => {
    const h = (i / STEPS) * end, th = 2 * Math.PI * TURNS * h, amp = f.w * 0.28 * (1 - 0.65 * h);
    return { x: cx + amp * Math.sin(th), y: base - h * H, front: Math.cos(th) >= 0, shade: Math.min(SHADES - 1, Math.floor((i / STEPS) * SHADES)) };
  });
  const runs: { front: boolean; shade: number; d: string }[] = [];
  pts.forEach((p, i) => {
    const prev = runs[runs.length - 1];
    if (prev && prev.front === p.front && prev.shade === p.shade) prev.d += `L${n1(p.x)},${n1(p.y)}`;
    else {
      const from = i ? pts[i - 1]! : p; // start where the previous run ended, so there are no gaps
      runs.push({ front: p.front, shade: p.shade, d: `M${n1(from.x)},${n1(from.y)}L${n1(p.x)},${n1(p.y)}` });
    }
  });
  const stroke = (r: (typeof runs)[number]) =>
    `<path d="${r.d}" fill="none" stroke="${mix(t.fg, t.accent, r.shade / (SHADES - 1))}" stroke-width="${r.front ? 5 : 3}" stroke-opacity="${r.front ? 1 : 0.3}" stroke-linecap="round" stroke-linejoin="round"/>`;
  body += runs.filter((r) => !r.front).map(stroke).join('') + runs.filter((r) => r.front).map(stroke).join('');

  // Where each new year began, when there is room for its label.
  const atHeight = (m: number) => pts[Math.min(STEPS, Math.round(((lift(m) / ceiling) / end) * STEPS))]!;
  let acc = 0, lastLabel = Infinity;
  const startOf = new Map<number, number>();
  for (const a of sel) { const y = parts(a.startMs, o.tz).y; if (!startOf.has(y)) startOf.set(y, acc); acc += value(a); }
  for (const [year, m] of startOf) {
    if (!m) continue;
    const p = atHeight(m);
    if (lastLabel - p.y < 24) continue;
    lastLabel = p.y;
    body += `<circle cx="${n1(p.x)}" cy="${n1(p.y)}" r="5" fill="${t.bg}" stroke="${t.fg}" stroke-width="2"/>` +
      `<text x="${n1(p.x + (p.x < cx ? -14 : 14))}" y="${n1(p.y + 5)}" font-size="14" text-anchor="${p.x < cx ? 'end' : 'start'}" fill="${t.muted}">${year}</text>`;
  }
  const tip = pts[STEPS]!;
  body += `<circle cx="${n1(tip.x)}" cy="${n1(tip.y)}" r="8" fill="${t.accent}" stroke="${t.bg}" stroke-width="3"/>` +
    `<text x="${n1(tip.x + 16)}" y="${n1(tip.y + 6)}" font-size="18" font-weight="700" fill="${t.fg}">${esc(big(total))}</text>`;
  return wrapSvg(f, o, body, defs);
}
