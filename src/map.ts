import { h, svg } from './dom';
import { textWidth, type Cursor } from './charts';

/**
 * Map backgrounds. Both are free, need no API key and are run by OpenStreetMap volunteers, so they are used
 * lightly: only for maps on screen (never for posters), and the user can switch them off in the filters.
 * Loading tiles tells the tile server which area is being viewed; the filters say so.
 *
 * tile.openstreetmap.org refuses requests without a Referer header (it answers with a "Referer is required"
 * picture or an error). Tiles are therefore plain <img> elements with an explicit referrer policy, index.html
 * sets the same policy, and a page opened from file:// (which never sends a referrer) uses OpenTopoMap.
 */
export interface TileSource { id: string; name: string; host: string; url: (z: number, x: number, y: number) => string; maxZoom: number; attribution: string; needsReferrer: boolean }
export const TILE_SOURCES: TileSource[] = [
  {
    id: 'osm', name: 'Standard (OpenStreetMap)', host: 'tile.openstreetmap.org', maxZoom: 19, needsReferrer: true,
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attribution: '© OpenStreetMap contributors',
  },
  {
    id: 'topo', name: 'Outdoor (OpenTopoMap)', host: 'tile.opentopomap.org', maxZoom: 17, needsReferrer: false,
    url: (z, x, y) => `https://${'abc'[(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`,
    attribution: '© OpenStreetMap contributors, SRTM · style © OpenTopoMap (CC-BY-SA)',
  },
];
export const tileSource = (id: string | null) => TILE_SOURCES.find((t) => t.id === id) ?? null;
/** Pages opened from a file send no referrer, so a source that needs one cannot work there. */
export const referrerAvailable = () => typeof location === 'undefined' || location.protocol !== 'file:';
/** The background used when the user has not chosen one. */
export const defaultTileSource = (): TileSource => TILE_SOURCES.find((t) => referrerAvailable() || !t.needsReferrer)!;

/** Web Mercator: lon/lat in degrees → world pixels at zoom 0 (256 px wide world). */
export function mercator(lat: number, lon: number): [number, number] {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * 256, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256];
}

/** What a map shows: centre in zoom-0 world pixels and a fractional zoom (scale = 2^z). */
export interface View { cx: number; cy: number; z: number }

/** The view that fits world-pixel points into a `size` square with `pad` on every side (fractional zoom, so the route fills it). */
export function fitView(pts: [number, number][], size: number, pad: number, maxZoom: number): View {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const avail = size - 2 * pad;
  const z = Math.log2(Math.min(avail / Math.max(maxX - minX, 1e-9), avail / Math.max(maxY - minY, 1e-9)));
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, z: Math.max(0, Math.min(maxZoom, z)) };
}

export interface TilePlacement { z: number; x: number; y: number; left: number; top: number; size: number }

/**
 * Tiles covering a `size` square view, fetched at zoom `tz` and scaled to the view's fractional zoom.
 * Positions are in view units; x wraps around the antimeridian, rows outside the world are skipped.
 */
export function tilesFor(v: View, size: number, tz: number, limit = 64): TilePlacement[] {
  const scale = 2 ** v.z, ts = 256 * 2 ** (v.z - tz), count = 2 ** tz;
  const left = v.cx * scale - size / 2, top = v.cy * scale - size / 2;
  const out: TilePlacement[] = [];
  for (let ty = Math.floor(top / ts); ty * ts < top + size; ty++) {
    if (ty < 0 || ty >= count) continue;
    for (let tx = Math.floor(left / ts); tx * ts < left + size; tx++) {
      if (out.length >= limit) return out;
      out.push({ z: tz, x: ((tx % count) + count) % count, y: ty, left: tx * ts - left, top: ty * ts - top, size: ts });
    }
  }
  return out;
}

export interface RouteMapOptions {
  tiles: TileSource | null;
  markers?: boolean;
  label: string;
  /** size of the square map in view units (the map scales to its box; this sets line widths and tile detail) */
  size?: number;
  cursor?: Cursor;
  /** text shown next to the hover marker, for a fraction along the route */
  describe?: (t: number) => string;
  /** drag, wheel, pinch, double-click, keyboard and +/− buttons; small previews stay static */
  interactive?: boolean;
  /** called once when the tile server sends no usable images (refused or offline) */
  onTilesFailed?: () => void;
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();
const pct = (v: number, s: number) => `${((v / s) * 100).toFixed(3)}%`;

/** Route on an optional tile background. Route points are [lat, lon, ...], evenly spaced by distance. */
export function routeMap(route: number[], o: RouteMapOptions): HTMLElement {
  const S = o.size ?? 512;
  const n = route.length / 2;
  const pts: [number, number][] = [];
  for (let i = 0; i < route.length; i += 2) pts.push(mercator(route[i]!, route[i + 1]!));
  const maxZoom = o.tiles ? o.tiles.maxZoom + 1 : 22; // one level of over-zoom keeps tiles readable
  const home = fitView(pts, S, S * (o.markers ? 0.08 : 0.06), maxZoom);
  const minZoom = Math.min(1, home.z);
  let v: View = { ...home };
  const P = ([x, y]: [number, number]): [number, number] => { const k = 2 ** v.z; return [(x - v.cx) * k + S / 2, (y - v.cy) * k + S / 2]; };

  const casing = o.tiles ? svg('polyline', { class: 'route-casing' }) : null;
  const line = svg('polyline', { class: 'route' });
  const start = o.markers ? svg('circle', { class: 'start', r: 6 }) : null;
  const finish = o.markers ? svg('circle', { class: 'finish', r: 6 }) : null;
  const plot = svg('svg', { class: 'routesvg', viewBox: `0 0 ${S} ${S}`, role: 'img', 'aria-label': o.label }, ...[casing, line, start, finish].filter((e): e is SVGElement => !!e));
  const layer = o.tiles ? h('div', { class: 'tiles', 'aria-hidden': 'true' }) : null;
  const root = h('div', { class: `map${o.tiles ? ' has-tiles' : ''}${o.interactive ? ' interactive' : ''}` }, layer, plot);

  // Tiles: reuse the <img> of a tile that stays in view, so panning never reloads it.
  const imgs = new Map<string, HTMLImageElement>();
  let loaded = 0, failed = 0, reported = false;
  const drawTiles = () => {
    if (!o.tiles || !layer) return;
    const px = root.clientWidth || S / 2; // before layout: assume a box half the view size (previews, high-DPI)
    const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    const tz = Math.max(0, Math.min(o.tiles.maxZoom, Math.round(v.z + Math.log2((px * dpr) / S))));
    const keep = new Set<string>();
    for (const t of tilesFor(v, S, tz)) {
      const key = `${t.z}/${t.x}/${t.y}`;
      keep.add(key);
      let img = imgs.get(key);
      if (!img) {
        const el = h('img', { alt: '', draggable: 'false', decoding: 'async', referrerpolicy: 'strict-origin-when-cross-origin', src: o.tiles.url(t.z, t.x, t.y) });
        el.addEventListener('load', () => { loaded++; }, { once: true });
        el.addEventListener('error', () => {
          el.style.visibility = 'hidden'; // no broken-image icon
          if (++failed >= 4 && !loaded && !reported) { reported = true; o.onTilesFailed?.(); }
        }, { once: true });
        imgs.set(key, el);
        layer.append(el);
        img = el;
      }
      // a hair of overlap hides seams between scaled tiles
      Object.assign(img.style, { left: pct(t.left, S), top: pct(t.top, S), width: pct(t.size + 0.6, S), height: pct(t.size + 0.6, S) });
    }
    for (const [key, img] of imgs) if (!keep.has(key)) { img.remove(); imgs.delete(key); }
  };

  let hoverT: number | null = null;
  let moveCursor = () => {};
  const draw = () => {
    const d = pts.map((p) => P(p).map(f1).join(',')).join(' ');
    line.setAttribute('points', d);
    casing?.setAttribute('points', d);
    const place = (c: SVGElement | null, p: [number, number]) => { if (c) { const [x, y] = P(p); c.setAttribute('cx', f1(x)); c.setAttribute('cy', f1(y)); } };
    place(start, pts[0]!);
    place(finish, pts[n - 1]!);
    drawTiles();
    moveCursor();
  };
  draw();

  if (o.cursor) {
    const dot = svg('circle', { class: 'map-cursor', r: 8 });
    const bg = svg('rect', { class: 'bubble', rx: 8, height: 34 });
    const text = svg('text', { class: 'bubble-text map-bubble-text' });
    const g = svg('g', { visibility: 'hidden', 'pointer-events': 'none' }, dot, bg, text);
    plot.append(g);
    moveCursor = () => {
      if (hoverT === null) { g.setAttribute('visibility', 'hidden'); return; }
      const x = hoverT * (n - 1), i = Math.min(n - 2, Math.floor(x)), f = x - i;
      const [ax, ay] = P(pts[i]!), [bx, by] = P(pts[i + 1]!);
      const px = ax + (bx - ax) * f, py = ay + (by - ay) * f;
      dot.setAttribute('cx', f1(px)); dot.setAttribute('cy', f1(py));
      text.textContent = o.describe ? o.describe(hoverT) : '';
      const w = textWidth(text, 11) + 20;
      const lx = px + 14 + w > S ? px - 14 - w : px + 14, ly = Math.max(4, Math.min(S - 38, py - 17));
      bg.setAttribute('x', f1(lx)); bg.setAttribute('y', f1(ly)); bg.setAttribute('width', f1(w));
      bg.setAttribute('visibility', text.textContent ? 'visible' : 'hidden');
      text.setAttribute('x', f1(lx + 10)); text.setAttribute('y', f1(ly + 23));
      g.setAttribute('visibility', 'visible');
    };
    o.cursor.on((t) => { hoverT = t; moveCursor(); });
  }

  if (o.interactive) makeInteractive(root, S, o, {
    get: () => v,
    set: (next) => { v = { ...next, z: Math.max(minZoom, Math.min(maxZoom, next.z)) }; schedule(); },
    home: () => home,
    /** route point index closest to a view position, or -1 when none is near */
    nearest: (mx, my) => {
      let best = -1, bd = (S * 0.06) ** 2;
      pts.forEach((p, i) => { const [x, y] = P(p); const dd = (x - mx) ** 2 + (y - my) ** 2; if (dd < bd) { bd = dd; best = i; } });
      return best < 0 ? null : best / (n - 1);
    },
  });
  // Redraws are batched per frame (wheel and pointer events can fire faster than the screen updates).
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  }
  if (o.interactive && o.tiles && typeof ResizeObserver !== 'undefined') new ResizeObserver(() => schedule()).observe(root);
  return root;
}

interface ViewHandle {
  get(): View;
  set(v: View): void;
  home(): View;
  nearest(x: number, y: number): number | null;
}

/** Pan and zoom for a map: drag (mouse, pen or one finger), pinch, wheel, double-click, keys and buttons. */
function makeInteractive(root: HTMLElement, S: number, o: RouteMapOptions, view: ViewHandle): void {
  root.tabIndex = 0;
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', `${o.label}. Drag or use the arrow keys to move the map, plus and minus to zoom, 0 to fit the route.`);
  /** Client coordinates → view units. */
  const toView = (x: number, y: number): [number, number] => {
    const r = root.getBoundingClientRect();
    return [((x - r.left) / (r.width || 1)) * S, ((y - r.top) / (r.height || 1)) * S];
  };
  const panBy = (dx: number, dy: number) => { const v = view.get(), k = 2 ** v.z; view.set({ ...v, cx: v.cx - dx / k, cy: v.cy - dy / k }); };
  /** Zoom to `z`, keeping the world point under view position (x, y) where it is. */
  const zoomAt = (x: number, y: number, z: number) => {
    const v = view.get(), k = 2 ** v.z, wx = v.cx + (x - S / 2) / k, wy = v.cy + (y - S / 2) / k;
    const nz = Math.max(0, z), nk = 2 ** nz;
    view.set({ cx: wx - (x - S / 2) / nk, cy: wy - (y - S / 2) / nk, z: nz });
  };
  const button = (label: string, text: string, act: () => void) =>
    h('button', { type: 'button', 'aria-label': label, title: label, onclick: (e: Event) => { e.stopPropagation(); act(); } }, text);
  const controls = h('div', { class: 'map-controls' },
    button('Zoom in', '+', () => zoomAt(S / 2, S / 2, view.get().z + 1)),
    button('Zoom out', '−', () => zoomAt(S / 2, S / 2, view.get().z - 1)),
    button('Fit the route', '⤢', () => view.set(view.home())));
  controls.addEventListener('pointerdown', (e) => e.stopPropagation());
  controls.addEventListener('dblclick', (e) => e.stopPropagation());
  root.append(controls);

  const down = new Map<number, [number, number]>();
  let pinch: { d: number; mid: [number, number] } | null = null;
  const pinchOf = (): { d: number; mid: [number, number] } => {
    const [a, b] = [...down.values()] as [[number, number], [number, number]];
    return { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
  };
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    root.setPointerCapture(e.pointerId);
    down.set(e.pointerId, toView(e.clientX, e.clientY));
    pinch = down.size === 2 ? pinchOf() : null;
    root.classList.add('dragging');
    o.cursor?.set(null);
  });
  root.addEventListener('pointermove', (e) => {
    const prev = down.get(e.pointerId);
    const p = toView(e.clientX, e.clientY);
    if (!prev) { if (e.pointerType === 'mouse' && o.cursor) o.cursor.set(view.nearest(p[0], p[1])); return; }
    down.set(e.pointerId, p);
    if (down.size === 1) panBy(p[0] - prev[0], p[1] - prev[1]);
    else if (down.size === 2 && pinch) {
      const next = pinchOf();
      zoomAt(pinch.mid[0], pinch.mid[1], view.get().z + Math.log2(next.d / pinch.d));
      panBy(next.mid[0] - pinch.mid[0], next.mid[1] - pinch.mid[1]);
      pinch = next;
    }
  });
  const up = (e: PointerEvent) => {
    down.delete(e.pointerId);
    pinch = down.size === 2 ? pinchOf() : null;
    if (!down.size) root.classList.remove('dragging');
  };
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  root.addEventListener('pointerleave', (e) => { if (!down.size && e.pointerType === 'mouse') o.cursor?.set(null); });
  root.addEventListener('wheel', (e) => {
    e.preventDefault();
    const step = e.deltaMode === 1 ? e.deltaY * 0.05 : e.deltaY * 0.002; // lines or pixels
    const [x, y] = toView(e.clientX, e.clientY);
    zoomAt(x, y, view.get().z - Math.max(-1, Math.min(1, step)));
  }, { passive: false });
  root.addEventListener('dblclick', (e) => { const [x, y] = toView(e.clientX, e.clientY); zoomAt(x, y, view.get().z + 1); });
  root.addEventListener('keydown', (e) => {
    if (e.target !== root || e.altKey || e.ctrlKey || e.metaKey) return;
    const step = S / 6;
    const keys: Record<string, () => void> = {
      ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0), ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step),
      '+': () => zoomAt(S / 2, S / 2, view.get().z + 1), '=': () => zoomAt(S / 2, S / 2, view.get().z + 1),
      '-': () => zoomAt(S / 2, S / 2, view.get().z - 1), '0': () => view.set(view.home()),
    };
    const act = keys[e.key];
    if (act) { e.preventDefault(); act(); }
  });
}

/** Attribution line for a map card (required by the tile licences). */
export const attribution = (t: TileSource) => h('small', { class: 'map-attr' }, t.attribution);
