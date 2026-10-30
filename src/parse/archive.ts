import { gunzipSync, unzipSync } from 'fflate';

/** A file inside the export (from a ZIP entry, a dropped folder or a loose file), read lazily. */
export interface VFile {
  path: string;
  read(): Promise<Uint8Array>;
}

export interface RawInput {
  path: string;
  /** File/Blob from the browser, or raw bytes (tests, demo data). */
  data: Blob | Uint8Array;
}

const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

export const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');

async function toBytes(d: Blob | Uint8Array): Promise<Uint8Array> {
  return d instanceof Uint8Array ? d : new Uint8Array(await d.arrayBuffer());
}

export const isZip = (b: Uint8Array) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);
export const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Expand ZIP inputs into their entries; other inputs pass through. ZIPs are sniffed by content, not extension. */
export async function expandInputs(inputs: RawInput[]): Promise<VFile[]> {
  const out: VFile[] = [];
  for (const inp of inputs) {
    const path = normPath(inp.path);
    const looksZip = /\.zip$/i.test(path);
    const head = inp.data instanceof Uint8Array ? inp.data.subarray(0, 4) : new Uint8Array(await inp.data.slice(0, 4).arrayBuffer());
    if (looksZip || isZip(head)) {
      const bytes = await toBytes(inp.data);
      const names: string[] = [];
      try {
        unzipSync(bytes, { filter: (f) => { if (!f.name.endsWith('/') && f.originalSize <= MAX_ENTRY_BYTES) names.push(f.name); return false; } });
      } catch (e) {
        throw new Error(`"${inp.path}" is not a readable ZIP archive (${(e as Error).message})`);
      }
      for (const name of names) {
        if (name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name)) continue;
        out.push({
          path: normPath(name),
          read: async () => unzipSync(bytes, { filter: (f) => f.name === name })[name]!,
        });
      }
    } else {
      out.push({ path, read: () => toBytes(inp.data) });
    }
  }
  return out;
}

export function maybeGunzip(b: Uint8Array): Uint8Array {
  return isGzip(b) ? gunzipSync(b) : b;
}
