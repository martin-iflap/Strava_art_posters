import { gunzipSync, inflateSync } from 'fflate';

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

/**
 * Largest file the app will unpack (a ZIP entry or a .gz activity file). Real activity files are a few MB;
 * the cap stops a small, hostile archive from expanding into gigabytes and crashing the tab.
 */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

export const normPath = (p: string) => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');

/**
 * The only files the import uses: the activity list and the activity files. Everything else in an export
 * (photos and videos, messages, profile, contacts) is skipped by name and never opened.
 */
export const isWanted = (path: string) =>
  !/(^|\/)(__MACOSX\/|\.)/.test(path) && (/(^|\/)activities[^/]*\.csv$/i.test(path) || /\.(fit|gpx|tcx)(\.gz)?$/i.test(path));

export const isGzip = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Reads a byte range [start, end). Blobs are sliced, so a multi-GB export is never loaded as a whole. */
type ReadRange = (start: number, end: number) => Promise<Uint8Array>;
const ranges = (d: Blob | Uint8Array): ReadRange =>
  d instanceof Uint8Array ? async (s, e) => d.subarray(s, e) : async (s, e) => new Uint8Array(await d.slice(s, e).arrayBuffer());
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u64 = (v: DataView, at: number) => v.getUint32(at, true) + v.getUint32(at + 4, true) * 2 ** 32;

interface ZipEntry { name: string; flags: number; method: number; compSize: number; size: number; offset: number }

/** The ZIP's central directory (its table of contents, at the end of the file), including ZIP64 archives. */
async function zipDirectory(read: ReadRange, total: number): Promise<ZipEntry[]> {
  // The end record is the last 22 bytes, unless the archive has a comment (up to 64 KB) after it.
  let tailStart = Math.max(0, total - 22);
  let tail = view(await read(tailStart, total));
  if (tail.byteLength < 22 || tail.getUint32(0, true) !== 0x06054b50) {
    tailStart = Math.max(0, total - 22 - 0xffff);
    tail = view(await read(tailStart, total));
  }
  let end = -1;
  for (let i = tail.byteLength - 22; i >= 0 && end < 0; i--) if (tail.getUint32(i, true) === 0x06054b50) end = i;
  if (end < 0) throw new Error('no ZIP directory found; the file may be cut short');
  let count = tail.getUint16(end + 10, true), size = tail.getUint32(end + 12, true), offset = tail.getUint32(end + 16, true);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    // archives over 4 GB or 65,535 files: a 20-byte locator just before the end record points to the ZIP64 record
    const locAt = tailStart + end - 20;
    const loc = view(await read(Math.max(0, locAt), Math.max(0, locAt + 20)));
    if (loc.byteLength < 20 || loc.getUint32(0, true) !== 0x07064b50) throw new Error('broken ZIP64 directory');
    const at = u64(loc, 8);
    const rec = view(await read(at, at + 56));
    if (rec.byteLength < 56 || rec.getUint32(0, true) !== 0x06064b50) throw new Error('broken ZIP64 directory');
    count = u64(rec, 32); size = u64(rec, 40); offset = u64(rec, 48);
  }
  if (offset + size > total) throw new Error('the ZIP directory points past the end of the file');
  const cd = await read(offset, offset + size);
  const dv = view(cd);
  const names = new TextDecoder();
  const out: ZipEntry[] = [];
  for (let p = 0, n = 0; n < count; n++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('broken ZIP directory');
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const e: ZipEntry = {
      name: names.decode(cd.subarray(p + 46, p + 46 + nameLen)),
      flags: dv.getUint16(p + 8, true), method: dv.getUint16(p + 10, true),
      compSize: dv.getUint32(p + 20, true), size: dv.getUint32(p + 24, true), offset: dv.getUint32(p + 42, true),
    };
    // ZIP64 sizes and offsets live in extra field 0x0001, in this order, for each value saturated above
    for (let x = p + 46 + nameLen, xEnd = x + extraLen; x + 4 <= xEnd; x += 4 + dv.getUint16(x + 2, true)) {
      if (dv.getUint16(x, true) !== 1) continue;
      let v = x + 4;
      if (e.size === 0xffffffff) { e.size = u64(dv, v); v += 8; }
      if (e.compSize === 0xffffffff) { e.compSize = u64(dv, v); v += 8; }
      if (e.offset === 0xffffffff) e.offset = u64(dv, v);
    }
    out.push(e);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** A stored (uncompressed) entry as a slice of the archive, so it is never copied into memory as a whole. */
async function innerBlob(read: ReadRange, e: ZipEntry, data: Blob): Promise<Blob> {
  const head = view(await read(e.offset, e.offset + 30));
  if (head.byteLength < 30 || head.getUint32(0, true) !== 0x04034b50) throw new Error('broken ZIP entry');
  const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  return data.slice(start, start + e.compSize);
}

/** One entry's bytes: only its own compressed data is read from the archive. */
async function readEntry(read: ReadRange, e: ZipEntry): Promise<Uint8Array> {
  if (e.flags & 1) throw new Error('the file is encrypted');
  const head = view(await read(e.offset, e.offset + 30));
  if (head.byteLength < 30 || head.getUint32(0, true) !== 0x04034b50) throw new Error('broken ZIP entry');
  const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const data = await read(start, start + e.compSize);
  if (e.method === 0) return data;
  // The output buffer has the declared size and never grows, so a lying size cannot use more memory.
  if (e.method === 8) return inflateSync(data, { out: new Uint8Array(e.size) });
  throw new Error(`unsupported ZIP compression (method ${e.method})`);
}

/**
 * ZIPs inside the export that hold activity files: Garmin puts the original FIT files in
 * DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_*.zip. These are opened one level deep only,
 * each within the usual size cap and all of them together within MAX_NESTED_BYTES.
 */
export const isActivityZip = (path: string) => !/(^|\/)(__MACOSX\/|\.)/.test(path) && /\.zip$/i.test(path) && /(uploaded|activit|fit|gpx|tcx)/i.test(path.split('/').pop()!);
export const MAX_NESTED_BYTES = 2 * 1024 * 1024 * 1024;

const sizeOf = (d: Blob | Uint8Array) => (d instanceof Uint8Array ? d.length : d.size);

/**
 * Turn the picked or dropped files into the ones the import uses. ZIP archives are opened by their
 * directory: unwanted entries (photos above all) are neither read nor unpacked. Other unwanted files are
 * skipped by name. Wanted files are only read when the import gets to them.
 */
export async function expandInputs(inputs: RawInput[]): Promise<VFile[]> {
  const out: VFile[] = [];
  let nested = 0;
  const openZip = async (label: string, data: Blob | Uint8Array, prefix: string, depth: number) => {
    const read = ranges(data);
    let entries: ZipEntry[];
    try {
      entries = await zipDirectory(read, sizeOf(data));
    } catch (e) {
      throw new Error(`"${label}" is not a readable ZIP archive (${(e as Error).message})`);
    }
    for (const e of entries) {
      const name = normPath(e.name);
      if (name.endsWith('/') || e.size > MAX_ENTRY_BYTES || e.compSize > MAX_ENTRY_BYTES) continue;
      if (isWanted(name)) out.push({ path: prefix + name, read: () => readEntry(read, e) });
      else if (depth === 0 && isActivityZip(name) && nested + e.size <= MAX_NESTED_BYTES) {
        nested += e.size;
        // A stored inner ZIP is a plain byte range of the outer one; a compressed one has to be unpacked.
        const inner = e.method === 0 && data instanceof Blob ? await innerBlob(read, e, data) : await readEntry(read, e);
        try { await openZip(name, inner, `${name}/`, depth + 1); } catch { /* an unreadable inner archive: skip it */ }
      }
    }
  };
  for (const inp of inputs) {
    const path = normPath(inp.path);
    if (/\.zip$/i.test(path)) await openZip(inp.path, inp.data, '', 0);
    else if (isWanted(path)) {
      out.push({ path, read: async () => (inp.data instanceof Uint8Array ? inp.data : new Uint8Array(await inp.data.arrayBuffer())) });
    }
  }
  return out;
}

/**
 * Unpack gzip data. The size comes from the gzip trailer; fflate never writes more than that, so checking
 * it caps the memory used even when the trailer lies (the output is then cut short and fails to parse).
 */
export function maybeGunzip(b: Uint8Array): Uint8Array {
  if (!isGzip(b)) return b;
  const size = b.length >= 18 ? new DataView(b.buffer, b.byteOffset + b.length - 4, 4).getUint32(0, true) : 0;
  if (size > MAX_ENTRY_BYTES) throw new Error(`unpacks to ${Math.round(size / 1024 / 1024)} MB, more than the ${MAX_ENTRY_BYTES / 1024 / 1024} MB limit`);
  return gunzipSync(b);
}
