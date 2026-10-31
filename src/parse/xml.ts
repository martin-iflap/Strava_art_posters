/** Minimal tag helpers. DOMParser does not exist in Web Workers, so GPX/TCX are scanned with regexes. */
const cache = new Map<string, RegExp>();

export function tagText(body: string, name: string): string | null {
  let re = cache.get(name);
  if (!re) {
    re = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</`, 'i');
    cache.set(name, re);
  }
  const m = re.exec(body);
  return m ? decodeEntities(m[1]!) : null;
}

export function tagNumber(body: string, ...names: string[]): number {
  for (const n of names) {
    const t = tagText(body, n);
    if (t !== null && t !== '') {
      const v = Number(t);
      if (Number.isFinite(v)) return v;
    }
  }
  return NaN;
}

export function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => codePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, x: string) => codePoint(parseInt(x, 16)))
    .replace(/&amp;/g, '&');
}

/** A numeric character reference; out-of-range or control values (a hostile file) become U+FFFD instead of throwing. */
const codePoint = (n: number) => (Number.isFinite(n) && n >= 0x20 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : n === 9 || n === 10 || n === 13 ? String.fromCharCode(n) : '\ufffd');
