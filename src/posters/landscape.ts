import type { Activity } from '../types';
import { parts, ymd } from '../util/time';
import { elevation, elevationUnit } from '../util/units';
import { emptyMessage, esc, int, n1, niceStep, wrapSvg, type Frame, type Poster, type PosterOptions } from './common';

export type ProfilePick = 'recent' | 'longest' | 'climbiest';

/** The `count` activities with an elevation profile that are most recent, longest or climb most; oldest first. */
export function pickProfiles(acts: Activity[], pick: ProfilePick, count: number): Activity[] {
  const key = pick === 'longest' ? (a: Activity) => a.distanceM : pick === 'climbiest' ? (a: Activity) => a.elevGainM : (a: Activity) => a.startMs;
  return acts.filter((a) => a.profile).sort((a, b) => key(b) - key(a)).slice(0, count).sort((a, b) => a.startMs - b.startMs);
}

export const pickLabel = (pick: ProfilePick) => (pick === 'recent' ? 'Most recent' : pick === 'longest' ? 'Longest' : 'Biggest climbs');

/**
 * Elevation profiles stretched to the same width and drawn over each other with a faint fill, oldest first,
 * so the shapes you repeat most build up into a dark range. Heights are above sea level ('absolute') or
 * from each activity's own lowest point ('relative').
 */
export function landscape(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  const sel = pickProfiles(acts, o.landSelect, o.landCount);
  if (!sel.length) return wrapSvg(f, o, emptyMessage(f, 'No elevation data in this selection'));
  const t = f.theme, eu = elevationUnit(o.units);
  const lows = sel.map((a) => Math.min(...a.profile!)), highs = sel.map((a) => Math.max(...a.profile!));
  const abs = o.landHeight === 'absolute';
  const floor = abs ? Math.min(...lows) : 0;
  const top = Math.max(...sel.map((_, i) => highs[i]! - (abs ? floor : lows[i]!)), 10);
  const axisW = 70;
  const x0 = f.x + axisW, w = f.w - axisW;
  // a wide, low range in the middle of the frame
  const height = Math.min(f.h - 90, w * 0.75), base = f.y + Math.min(f.h - 28, (f.h + height) / 2 + 30);
  const X = (k: number, n: number) => n1(x0 + (k / (n - 1)) * w);
  const Y = (v: number) => n1(base - (v / top) * height);
  // Denser stacks get a fainter fill, so the overlap still has room to darken.
  const alpha = n1(Math.max(0.035, Math.min(0.3, 3 / sel.length)));
  const lineAlpha = n1(Math.max(0.08, Math.min(0.4, 8 / sel.length)));
  let body = '';

  // Height scale: a few round ticks on the left.
  const toUnit = elevation(1, o.units), lowD = elevation(floor, o.units), topD = elevation(floor + top, o.units);
  const step = niceStep(topD - lowD, 4);
  for (let v = Math.ceil(lowD / step) * step; v <= topD + 1e-9; v += step) {
    const y = Y(v / toUnit - floor);
    body += `<line x1="${x0}" x2="${n1(x0 + w)}" y1="${y}" y2="${y}" stroke="${t.muted}" stroke-opacity="0.18"/>` +
      `<text x="${n1(x0 - 10)}" y="${n1(Number(y) + 5)}" font-size="14" text-anchor="end" fill="${t.muted}">${int(v)}</text>`;
  }
  body += `<text x="${n1(x0 - 10)}" y="${n1(base - height - 22)}" font-size="13" letter-spacing="1" text-anchor="end" fill="${t.muted}">${esc(abs ? eu.toUpperCase() : `+${eu}`.toUpperCase())}</text>`;

  let peak = 0;
  sel.forEach((a, i) => {
    const p = a.profile!, lo = abs ? floor : lows[i]!;
    const line = 'M' + p.map((v, k) => `${X(k, p.length)},${Y(v - lo)}`).join('L');
    body += `<path d="${line}L${n1(x0 + w)},${n1(base)}L${n1(x0)},${n1(base)}Z" fill="${t.fg}" fill-opacity="${alpha}" stroke="${t.fg}" stroke-opacity="${lineAlpha}" stroke-width="0.8" stroke-linejoin="round"/>`;
    if (highs[i]! - lo > highs[peak]! - (abs ? floor : lows[peak]!)) peak = i;
  });
  // The tallest profile is traced in the accent colour and its summit labelled.
  const pa = sel[peak]!, pp = pa.profile!, plo = abs ? floor : lows[peak]!;
  body += `<path d="M${pp.map((v, k) => `${X(k, pp.length)},${Y(v - plo)}`).join('L')}" fill="none" stroke="${t.accent}" stroke-width="1.6" stroke-linejoin="round"/>`;
  const pk = pp.indexOf(highs[peak]!), px = Number(X(pk, pp.length)), py = Number(Y(highs[peak]! - plo));
  const label = `${abs ? '' : '+'}${int(elevation(highs[peak]! - (abs ? 0 : plo), o.units))} ${eu} · ${ymd(parts(pa.startMs, o.tz))}`;
  const anchor = px > x0 + w * 0.75 ? 'end' : px < x0 + w * 0.25 ? 'start' : 'middle';
  body += `<circle cx="${n1(px)}" cy="${n1(py)}" r="4.5" fill="${t.accent}"/>` +
    `<text x="${n1(px)}" y="${n1(py - 14)}" font-size="16" font-weight="600" text-anchor="${anchor}" fill="${t.fg}">${esc(label)}</text>`;
  body += `<line x1="${x0}" x2="${n1(x0 + w)}" y1="${n1(base)}" y2="${n1(base)}" stroke="${t.muted}" stroke-opacity="0.5"/>` +
    `<text x="${x0}" y="${n1(base + 22)}" font-size="14" letter-spacing="1" fill="${t.muted}">START</text>` +
    `<text x="${n1(x0 + w)}" y="${n1(base + 22)}" font-size="14" letter-spacing="1" text-anchor="end" fill="${t.muted}">FINISH · EVERY ACTIVITY STRETCHED TO THE SAME WIDTH</text>`;
  return wrapSvg(f, o, body);
}
