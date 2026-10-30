type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;

/** Tiny hyperscript helper. Strings always become text nodes (never HTML), so activity names cannot inject markup. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

const NS = 'http://www.w3.org/2000/svg';
export function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: Node[]): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

export function table(head: string[], rows: Child[][], opts: { numFrom?: number; numCols?: number[]; caption?: string } = {}): HTMLTableElement {
  const numFrom = opts.numFrom ?? 1;
  const isNum = (i: number) => (opts.numCols ? opts.numCols.includes(i) : i >= numFrom);
  return h('table', {},
    opts.caption ? h('caption', {}, opts.caption) : null,
    h('thead', {}, h('tr', {}, ...head.map((t, i) => h('th', { scope: 'col', class: isNum(i) ? 'num' : '' }, t)))),
    h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c, i) => h('td', { class: isNum(i) ? 'num' : '' }, c))))),
  );
}

export function download(filename: string, data: string | Blob, mime: string): void {
  const url = URL.createObjectURL(typeof data === 'string' ? new Blob([data], { type: mime }) : data);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
