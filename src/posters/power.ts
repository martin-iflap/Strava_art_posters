import type { Activity } from '../types';
import { bestPowerCurve, estimateFtp } from '../stats/training';
import { hourOf, parts } from '../util/time';
import { emptyMessage, esc, int, mix, n1, palette, wrapSvg, type Frame, type Poster, type PosterOptions } from './common';

/*
 * Two posters about power, and the sunrise clock.
 */

/** Mechanical work of one activity in kilojoules: watts × seconds from the power stream, else average power × moving time. */
export function workKj(a: Activity): number {
  if (a.powerHist?.length) return a.powerHist.reduce((s, [w, t]) => s + w * t, 0) / 1000;
  return a.avgPower ? (a.avgPower * a.movingS) / 1000 : 0;
}

/**
 * What a number of kilojoules of work at the pedals is worth. The human body turns food into work at
 * about 24 % efficiency and 1 kcal is 4.184 kJ, so kilojoules of work come out close to kilocalories eaten.
 */
export function workEquivalents(kj: number): { value: number; label: string }[] {
  const kcal = (kj / 0.24) / 4.184;
  return [
    { value: kcal / 285, label: 'slices of pizza burned (≈ kcal eaten)' },
    { value: (kj * 1000) / (1500 * 9.81) / 1000, label: 'km you could lift a 1.5-tonne car' },
    { value: kj / (4.186 * 80), label: 'litres of water boiled for tea' },
    { value: kj / 3600 / 0.01 / 24, label: 'days of a 10 W LED bulb' },
  ];
}

const NICE = [1, 2, 2.5, 5];
function cellSize(total: number, maxCells: number): number {
  for (let p = 1; ; p *= 10) for (const m of NICE) if (total / (m * p) <= maxCells) return m * p;
}

/**
 * Work done: every square is a fixed amount of energy (a round number of kilojoules, chosen to fill the
 * page), filled in date order and coloured by year, above what that energy is equal to.
 */
export function workDone(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  const rows = acts.map((a) => ({ a, kj: workKj(a) })).filter((x) => x.kj > 0).sort((x, y) => x.a.startMs - y.a.startMs);
  if (!rows.length) return wrapSvg(f, o, emptyMessage(f, 'No power data in this selection'));
  const t = f.theme;
  const total = rows.reduce((s, x) => s + x.kj, 0);
  const years = [...new Set(rows.map((x) => parts(x.a.startMs, o.tz).y))];
  const cols = palette(t, Math.max(2, years.length));
  const byYear = years.map((y) => rows.filter((x) => parts(x.a.startMs, o.tz).y === y).reduce((s, x) => s + x.kj, 0));
  const unit = cellSize(total, 1200);

  const headH = 110, eqH = 200, legendH = years.length > 1 ? 40 : 0;
  let body = `<text x="${n1(f.x)}" y="${n1(f.y + 62)}" font-size="70" font-weight="700" letter-spacing="-2" fill="${t.fg}">${int(total)} kJ</text>` +
    `<text x="${n1(f.x)}" y="${n1(f.y + 96)}" font-size="19" fill="${t.muted}">of work at the pedals · each square ${int(unit)} kJ</text>`;

  // the waffle: cells fill row by row; a year's colour runs on from the last cell of the year before
  const ax = f.x, ay = f.y + headH, aw = f.w, ah = f.h - headH - eqH - legendH - 16;
  const n = Math.ceil(total / unit);
  let c = Math.max(1, Math.ceil(Math.sqrt((n * aw) / ah)));
  let s = Math.min(aw / c, ah / Math.ceil(n / c));
  while (c > 1 && Math.min(aw / (c - 1), ah / Math.ceil(n / (c - 1))) > s) { c--; s = Math.min(aw / c, ah / Math.ceil(n / c)); }
  const gap = Math.max(0.6, s * 0.14), r = s * 0.2;
  const ox = ax + (aw - c * s) / 2;
  const paths: string[] = cols.map(() => '');
  let yi = 0, yAcc = byYear[0]!;
  for (let i = 0; i < n; i++) {
    const mid = (i + 0.5) * unit;
    while (mid > yAcc && yi < years.length - 1) { yi++; yAcc += byYear[yi]!; }
    const frac = Math.min(1, (total - i * unit) / unit);
    const x = ox + (i % c) * s, y = ay + Math.floor(i / c) * s;
    const w = (s - gap) * frac;
    paths[yi] += `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(Math.max(0.5, w))}" height="${n1(s - gap)}" rx="${n1(Math.min(r, w / 2))}"/>`;
  }
  body += paths.map((p, i) => (p ? `<g fill="${cols[i]}">${p}</g>` : '')).join('');

  // equivalents, two by two
  const ey = f.y + f.h - eqH - legendH;
  body += `<line x1="${n1(f.x)}" x2="${n1(f.x + f.w)}" y1="${n1(ey)}" y2="${n1(ey)}" stroke="${t.muted}" stroke-opacity="0.35"/>`;
  body += `<text x="${n1(f.x)}" y="${n1(ey + 32)}" font-size="15" letter-spacing="3" fill="${t.accent}" font-weight="600">THAT IS ENOUGH FOR</text>`;
  workEquivalents(total).forEach((e, i) => {
    const x = f.x + (i % 2) * (f.w / 2), y = ey + 92 + Math.floor(i / 2) * 76;
    const v = e.value >= 100 ? int(e.value) : e.value >= 10 ? n1(e.value) : (Math.round(e.value * 100) / 100).toString();
    body += `<text x="${n1(x)}" y="${n1(y)}" font-size="40" font-weight="700" fill="${t.fg}">${v}</text>` +
      `<text x="${n1(x)}" y="${n1(y + 24)}" font-size="16" fill="${t.muted}">${esc(e.label)}</text>`;
  });
  if (legendH) {
    const shown = years.slice(-6), lw = f.w / shown.length;
    body += shown.map((y, j) => {
      const i = years.indexOf(y);
      return `<rect x="${n1(f.x + j * lw)}" y="${n1(f.y + f.h - 16)}" width="16" height="16" rx="3" fill="${cols[i]}"/><text x="${n1(f.x + j * lw + 24)}" y="${n1(f.y + f.h - 2)}" font-size="15" fill="${t.muted}">${y} · ${int(byYear[i]! / 1000)} MJ</text>`;
    }).join('');
  }
  return wrapSvg(f, o, body);
}

const MAX_FAINT = 300;
const MARKS = [5, 60, 300, 1200, 3600, 7200];
const markName = (s: number) => (s < 60 ? `${s} s` : s < 3600 ? `${s / 60} min` : `${s / 3600} h`);

/**
 * Power fingerprint: the power curve wound around a centre. The angle is the duration (1 second at the top,
 * on a log scale clockwise to the longest effort) and the distance from the centre the best power held
 * that long. Every activity is a faint line; each year's best is a bold one, so the years nest like the
 * ridges of a fingerprint.
 */
export function fingerprint(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  let withPower = acts.filter((a) => a.powerCurve && a.powerCurve.length > 2).sort((a, b) => a.startMs - b.startMs);
  if (!withPower.length) return wrapSvg(f, o, emptyMessage(f, 'No power data in this selection'));
  const t = f.theme;
  const all = bestPowerCurve(withPower);
  const maxW = Math.max(...all.map((p) => p.watts));
  const maxS = Math.min(all[all.length - 1]!.seconds, 6 * 3600);
  const years = [...new Set(withPower.map((a) => parts(a.startMs, o.tz).y))].slice(-8);
  const legendH = 40;
  const cx = f.x + f.w / 2, cy = f.y + (f.h - legendH) / 2;
  const R = Math.min(f.w, f.h - legendH) / 2 - 46, r0 = R * 0.2;
  const SPAN = 2 * Math.PI * 0.9;
  const ang = (s: number) => -Math.PI / 2 + (Math.log(Math.max(1, s)) / Math.log(Math.max(2, maxS))) * SPAN;
  const rad = (w: number) => r0 + (R - r0) * Math.sqrt(Math.max(0, w) / maxW);
  const pt = (s: number, w: number) => `${n1(cx + rad(w) * Math.cos(ang(s)))},${n1(cy + rad(w) * Math.sin(ang(s)))}`;
  const line = (c: [number, number][]) => 'M' + c.filter(([s]) => s <= maxS).map(([s, w]) => pt(s, w)).join('L');

  let body = '';
  // watt rings and duration spokes
  for (const w of [100, 200, 400, 800, 1600]) {
    if (w > maxW) break;
    body += `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(rad(w))}" fill="none" stroke="${t.muted}" stroke-opacity="0.25" stroke-dasharray="2 5"/>` +
      `<text x="${n1(cx - 6)}" y="${n1(cy - rad(w) - 4)}" font-size="12" text-anchor="end" fill="${t.muted}">${w} W</text>`;
  }
  for (const s of MARKS) {
    if (s > maxS) break;
    const a = ang(s), best = all.find((p) => p.seconds === s);
    body += `<line x1="${n1(cx + r0 * Math.cos(a))}" y1="${n1(cy + r0 * Math.sin(a))}" x2="${n1(cx + (R + 8) * Math.cos(a))}" y2="${n1(cy + (R + 8) * Math.sin(a))}" stroke="${t.muted}" stroke-opacity="0.35"/>`;
    const lx = cx + (R + 28) * Math.cos(a), ly = cy + (R + 28) * Math.sin(a);
    const anchor = Math.cos(a) > 0.3 ? 'start' : Math.cos(a) < -0.3 ? 'end' : 'middle';
    body += `<text x="${n1(lx)}" y="${n1(ly)}" font-size="15" text-anchor="${anchor}" fill="${t.fg}">${markName(s)}</text>` +
      (best ? `<text x="${n1(lx)}" y="${n1(ly + 17)}" font-size="13" text-anchor="${anchor}" fill="${t.muted}">${int(best.watts)} W</text>` : '');
  }
  // every activity, faint
  if (withPower.length > MAX_FAINT) { const step = withPower.length / MAX_FAINT; withPower = Array.from({ length: MAX_FAINT }, (_, i) => withPower[Math.floor(i * step)]!); }
  body += `<path class="faint" fill="none" stroke="${t.fg}" stroke-opacity="${withPower.length > 100 ? 0.07 : 0.14}" stroke-width="0.8" d="${withPower.map((a) => line(a.powerCurve!)).join('')}"/>`;
  // each year's best, oldest first so the latest is on top
  const cols = palette(t, Math.max(2, years.length));
  for (const [i, y] of years.entries()) {
    const c = bestPowerCurve(acts.filter((a) => a.powerCurve && parts(a.startMs, o.tz).y === y));
    body += `<path class="year" fill="none" stroke="${cols[i]}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" d="${line(c.map((p) => [p.seconds, p.watts]))}"/>`;
  }
  const ftp = estimateFtp(all);
  if (ftp) {
    body += `<text x="${n1(cx)}" y="${n1(cy + 8)}" font-size="${n1(r0 * 0.38)}" font-weight="700" text-anchor="middle" fill="${t.fg}">${ftp} W</text>` +
      `<text x="${n1(cx)}" y="${n1(cy + 8 + r0 * 0.3)}" font-size="${n1(r0 * 0.13)}" letter-spacing="2" text-anchor="middle" fill="${t.muted}">ESTIMATED FTP</text>`;
  }
  const lw = f.w / years.length;
  body += years.map((y, i) => `<rect x="${n1(f.x + i * lw)}" y="${n1(f.y + f.h - 16)}" width="16" height="16" rx="3" fill="${cols[i]}"/><text x="${n1(f.x + i * lw + 24)}" y="${n1(f.y + f.h - 2)}" font-size="15" fill="${t.muted}">${y}</text>`).join('');
  return wrapSvg(f, o, body);
}

// ---------- sunrise clock ----------

const RAD = Math.PI / 180;
/**
 * Sunrise and sunset (epoch ms, UTC) on a day (days since 1970-01-01) at a place, from the sunrise
 * equation (NOAA's simplified solar position). Polar day gives a full 24 hours, polar night none.
 */
export function sunTimes(day: number, lat: number, lon: number): { rise: number; set: number } {
  const n = day - 10957 + 0.5; // days since J2000.0 at noon of that date
  const jStar = n - lon / 360;
  const M = (357.5291 + 0.98560028 * jStar) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const decl = Math.asin(Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD));
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(decl)) / (Math.cos(lat * RAD) * Math.cos(decl));
  const w = Math.acos(Math.max(-1, Math.min(1, cosW))) / (2 * Math.PI); // fraction of a day
  const ms = (j: number) => (j + 10957) * 86_400_000;
  return { rise: ms(transit - w), set: ms(transit + w) };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]!; };

/**
 * Sunrise clock: a 24-hour dial with midnight at the bottom and noon at the top. Every activity is an
 * arc from the time it started to the time it ended, one ring further out each day, so the dial fills
 * from the centre outward in date order. Behind them, daylight from sunrise to sunset where you usually start.
 */
export function sunriseClock(acts: Activity[], o: PosterOptions, f: Frame): Poster {
  const rows = [...acts].sort((a, b) => a.startMs - b.startMs);
  if (!rows.length) return wrapSvg(f, o, emptyMessage(f, 'No activities in this selection'));
  const t = f.theme;
  const day = (ms: number) => Math.floor((ms + (o.tz === 'UTC' ? 0 : -new Date(ms).getTimezoneOffset() * 60_000)) / 86_400_000);
  const d0 = day(rows[0]!.startMs), d1 = Math.max(d0 + 1, day(rows[rows.length - 1]!.startMs));
  const legendH = 40;
  const cx = f.x + f.w / 2, cy = f.y + (f.h - legendH) / 2;
  const R = Math.min(f.w, f.h - legendH) / 2 - 34, r0 = R * 0.22;
  const radius = (d: number) => r0 + ((d - d0) / (d1 - d0)) * (R - r0);
  const ang = (h: number) => Math.PI / 2 + (h / 24) * 2 * Math.PI;
  const at = (r: number, a: number) => `${n1(cx + r * Math.cos(a))},${n1(cy + r * Math.sin(a))}`;
  let body = '';

  // daylight band at the usual start (only the median of the starts is used, and it is not drawn)
  const starts = rows.filter((a) => a.route && a.route.length >= 2);
  if (starts.length) {
    const lat = median(starts.map((a) => a.route![0]!)), lon = median(starts.map((a) => a.route![1]!));
    const step = Math.max(1, Math.round((d1 - d0) / 300));
    const ds: number[] = [];
    for (let d = d0; d < d1; d += step) ds.push(d);
    ds.push(d1);
    const sun = ds.map((d) => { const s = sunTimes(d, lat, lon); let rise = hourOf(s.rise, o.tz), set = hourOf(s.set, o.tz); if (set < rise) set += 24; if (s.set - s.rise >= 86_399_000) { rise = 0; set = 23.99; } return { d, rise, set, none: s.set - s.rise < 60_000 }; });
    if (sun.some((s) => !s.none)) {
      const last = sun[sun.length - 1]!, first = sun[0]!;
      const big = (s: { rise: number; set: number }) => (s.set - s.rise > 12 ? 1 : 0);
      const d = 'M' + sun.map((s) => at(radius(s.d), ang(s.rise))).join('L') +
        `A${n1(radius(last.d))},${n1(radius(last.d))} 0 ${big(last)} 1 ${at(radius(last.d), ang(last.set))}` +
        'L' + [...sun].reverse().map((s) => at(radius(s.d), ang(s.set))).join('L') +
        `A${n1(radius(first.d))},${n1(radius(first.d))} 0 ${big(first)} 0 ${at(radius(first.d), ang(first.rise))}Z`;
      body += `<path class="daylight" d="${d}" fill="${mix(t.bg, t.accent, 0.12)}" stroke="${mix(t.bg, t.accent, 0.35)}" stroke-width="1"/>`;
    }
  }
  // hour ticks
  for (let h = 0; h < 24; h++) {
    const a = ang(h), major = h % 6 === 0;
    const r1 = R + 4, r2 = R + (major ? 16 : 10);
    body += `<line x1="${n1(cx + r1 * Math.cos(a))}" y1="${n1(cy + r1 * Math.sin(a))}" x2="${n1(cx + r2 * Math.cos(a))}" y2="${n1(cy + r2 * Math.sin(a))}" stroke="${t.muted}" stroke-width="${major ? 2 : 1}"/>`;
    if (major) {
      const side = h === 6 || h === 18, lr = R + (side ? 22 : 32);
      const lx = cx + lr * Math.cos(a), ly = cy + lr * Math.sin(a);
      body += `<text x="${n1(lx)}" y="${n1(ly + 6)}" font-size="16" text-anchor="${h === 6 ? 'end' : h === 18 ? 'start' : 'middle'}" fill="${t.fg}">${String(h).padStart(2, '0')}:00</text>`;
    }
  }
  body += `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r0)}" fill="none" stroke="${t.muted}" stroke-opacity="0.3"/>`;

  // the activities: one path per sport
  const sports = [...new Set(rows.map((a) => a.sport))];
  const cols = palette(t, Math.max(2, sports.length));
  const ring = (R - r0) / Math.max(1, d1 - d0);
  const sw = Math.max(1.1, Math.min(4, ring * 0.85));
  const paths = sports.map(() => [] as string[]);
  for (const a of rows) {
    const r = radius(day(a.startMs));
    const h0 = hourOf(a.startMs, o.tz) + new Date(a.startMs).getSeconds() / 3600;
    const len = Math.min(23.9, Math.max(0.05, (a.elapsedS || a.movingS) / 3600));
    paths[sports.indexOf(a.sport)]!.push(`M${at(r, ang(h0))}A${n1(r)},${n1(r)} 0 ${len > 12 ? 1 : 0} 1 ${at(r, ang(h0 + len))}`);
  }
  body += `<g fill="none" stroke-linecap="round" stroke-width="${n1(sw)}" stroke-opacity="0.85">` + paths.map((p, i) => (p.length ? `<path class="session" stroke="${cols[i]}" d="${p.join('')}"/>` : '')).join('') + '</g>';

  // centre: the usual start time
  const hours = new Array(24).fill(0) as number[];
  for (const a of rows) hours[Math.floor(hourOf(a.startMs, o.tz)) % 24]++;
  const top = hours.indexOf(Math.max(...hours));
  body += `<text x="${n1(cx)}" y="${n1(cy + 4)}" font-size="${n1(r0 * 0.36)}" font-weight="700" text-anchor="middle" fill="${t.fg}">${String(top).padStart(2, '0')}:00</text>` +
    `<text x="${n1(cx)}" y="${n1(cy + 4 + r0 * 0.28)}" font-size="${n1(r0 * 0.12)}" letter-spacing="2" text-anchor="middle" fill="${t.muted}">FAVOURITE HOUR</text>`;
  const items: [string, string][] = sports.slice(0, 5).map((sp, i) => [cols[i]!, sp]);
  if (starts.length) items.push([mix(t.bg, t.accent, 0.35), 'Daylight']);
  const lw = f.w / items.length;
  body += items.map(([c, nm], i) => `<rect x="${n1(f.x + i * lw)}" y="${n1(f.y + f.h - 16)}" width="16" height="16" rx="3" fill="${c}"/><text x="${n1(f.x + i * lw + 24)}" y="${n1(f.y + f.h - 2)}" font-size="15" fill="${t.muted}">${esc(nm)}</text>`).join('');
  return wrapSvg(f, o, body);
}
