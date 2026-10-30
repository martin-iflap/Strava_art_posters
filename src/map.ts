import { h, svg } from './dom';
import { textWidth, type Cursor } from './charts';

/**
 * Optional map backgrounds. Both are free, need no API key and are run by OpenStreetMap volunteers,
 * so they are used lightly: only for maps on screen, only when the user turns them on.
 * Loading tiles tells the tile server which area is being viewed; the UI says so where it is switched on.
 */
export interface TileSource { id: string; name: string; host: string; url: (z: number, x: number, y: number) => string; maxZoom: number; attribution: string }
export const TILE_SOURCES: TileSource[] = [
  {
    id: 'topo', name: 'Outdoor (OpenTopoMap)', host: 'tile.opentopomap.org', maxZoom: 17,
    url: (z, x, y) => `https://${'abc'[(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`,
    attribution: '© OpenStreetMap contributors, SRTM · style © OpenTopoMap (CC-BY-SA)',
  },
  {
    id: 'osm', name: 'Standard (OpenStreetMap)', host: 'tile.openstreetmap.org', maxZoom: 19,
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attribution: '© OpenStreetMap contributors',
  },
];
export const tileSource = (id: string | null) => TILE_SOURCES.find((t) => t.id === id) ?? null;

/** Web Mercator: lon/lat in degrees → world pixels at zoom 0 (256 px wide world). */
export function mercator(lat: number, lon: number): [number, number] {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * 256, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256];
}

/** Largest integer zoom at which a box of `bw` × `bh` zoom-0 pixels fits into `size` px with padding. */
export function fitZoom(bw: number, bh: number, size: number, pad: number, maxZoom: number): number {
  const avail = size - 2 * pad;
  const z = Math.floor(Math.log2(Math.min(avail / Math.max(bw, 1e-9), avail / Math.max(bh, 1e-9))));
  return Math.max(1, Math.min(maxZoom, z));
}

export interface RouteMapOptions {
  tiles: TileSource | null;
  markers?: boolean;
  label: string;
  /** virtual pixel size of the square map (tiles are requested for this, sharper on high-DPI screens) */
  size?: number;
  cursor?: Cursor;
  /** text shown next to the hover marker, for a fraction along the route */
  describe?: (t: number) => string;
}

/** Route on an optional tile background, as one square SVG. Route points are [lat, lon, ...], evenly spaced by distance. */
export function routeMap(route: number[], o: RouteMapOptions): SVGElement {
  const S = o.size ?? 512;
  const n = route.length / 2;
  const pts: [number, number][] = [];
  for (let i = 0; i < route.length; i += 2) pts.push(mercator(route[i]!, route[i + 1]!));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const pad = S * (o.markers ? 0.08 : 0.06);
  // With tiles the scale is a power of two (tiles stay crisp); without, fit exactly.
  const scale = o.tiles ? 2 ** fitZoom(maxX - minX, maxY - minY, S, pad, o.tiles.maxZoom) : (S - 2 * pad) / Math.max(maxX - minX, maxY - minY, 1e-9);
  const ox = ((minX + maxX) / 2) * scale - S / 2, oy = ((minY + maxY) / 2) * scale - S / 2;
  const P = ([x, y]: [number, number]): [number, number] => [x * scale - ox, y * scale - oy];
  const f1 = (v: number) => (Math.round(v * 10) / 10).toString();
  const children: SVGElement[] = [];
  if (o.tiles) {
    const z = Math.log2(scale);
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 1 && z < o.tiles.maxZoom ? 1 : 0;
    const tz = z + dpr, k = 2 ** dpr, ts = 256 / k, count = 2 ** tz;
    const layer = svg('g', { class: 'tiles' });
    for (let ty = Math.floor((oy * k) / 256); ty * ts < oy + S; ty++) {
      if (ty < 0 || ty >= count) continue;
      for (let tx = Math.floor((ox * k) / 256); tx * ts < ox + S; tx++) {
        const img = svg('image', { x: f1(tx * ts - ox), y: f1(ty * ts - oy), width: ts + 0.5, height: ts + 0.5, href: o.tiles.url(tz, ((tx % count) + count) % count, ty), preserveAspectRatio: 'none' });
        layer.append(img);
      }
    }
    children.push(svg('rect', { class: 'map-bg', width: S, height: S }), layer);
  }
  const d = pts.map((p) => P(p).map(f1).join(',')).join(' ');
  if (o.tiles) children.push(svg('polyline', { class: 'route-casing', points: d }));
  children.push(svg('polyline', { class: 'route', points: d }));
  if (o.markers) {
    const [sx, sy] = P(pts[0]!), [ex, ey] = P(pts[n - 1]!);
    children.push(svg('circle', { class: 'start', cx: f1(sx), cy: f1(sy), r: 6 }), svg('circle', { class: 'finish', cx: f1(ex), cy: f1(ey), r: 6 }));
  }
  const root = svg('svg', { class: o.tiles ? 'routesvg map has-tiles' : 'routesvg map', viewBox: `0 0 ${S} ${S}`, role: 'img', 'aria-label': o.label }, ...children);

  if (o.cursor) {
    const dot = svg('circle', { class: 'map-cursor', r: 8 });
    const bg = svg('rect', { class: 'bubble', rx: 8, height: 34 });
    const text = svg('text', { class: 'bubble-text map-bubble-text' });
    const g = svg('g', { visibility: 'hidden', 'pointer-events': 'none' }, dot, bg, text);
    root.append(g);
    o.cursor.on((t) => {
      if (t === null) { g.setAttribute('visibility', 'hidden'); return; }
      const x = t * (n - 1), i = Math.min(n - 2, Math.floor(x)), f = x - i;
      const [ax, ay] = P(pts[i]!), [bx, by] = P(pts[i + 1]!);
      const px = ax + (bx - ax) * f, py = ay + (by - ay) * f;
      dot.setAttribute('cx', f1(px)); dot.setAttribute('cy', f1(py));
      text.textContent = o.describe ? o.describe(t) : '';
      const w = textWidth(text, 11) + 20;
      const lx = px + 14 + w > S ? px - 14 - w : px + 14, ly = Math.max(4, Math.min(S - 38, py - 17));
      bg.setAttribute('x', f1(lx)); bg.setAttribute('y', f1(ly)); bg.setAttribute('width', f1(w));
      bg.setAttribute('visibility', text.textContent ? 'visible' : 'hidden');
      text.setAttribute('x', f1(lx + 10)); text.setAttribute('y', f1(ly + 23));
      g.setAttribute('visibility', 'visible');
    });
    // Hovering near the route moves the shared cursor to the closest point.
    const cur = o.cursor;
    root.addEventListener('pointermove', (e) => {
      const r = root.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * S, my = ((e.clientY - r.top) / r.height) * S;
      let best = -1, bd = (S * 0.06) ** 2;
      pts.forEach((p, i) => { const [x, y] = P(p); const dd = (x - mx) ** 2 + (y - my) ** 2; if (dd < bd) { bd = dd; best = i; } });
      cur.set(best < 0 ? null : best / (n - 1));
    });
    root.addEventListener('pointerleave', () => cur.set(null));
  }
  return root;
}

/** Attribution line for a map card (required by the tile licences). */
export const attribution = (t: TileSource) => h('small', { class: 'map-attr' }, t.attribution);
