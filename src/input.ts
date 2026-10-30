import type { RawInput } from './parse/archive';

/** Files picked via <input> (folder picks carry webkitRelativePath). */
export const fromFileList = (list: FileList | File[]): RawInput[] =>
  Array.from(list).map((f) => ({ path: f.webkitRelativePath || f.name, data: f }));

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  file?(ok: (f: File) => void, err: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (e: FsEntry[]) => void, err: (e: unknown) => void): void };
}

async function walk(entry: FsEntry, out: RawInput[]): Promise<void> {
  if (entry.isFile) {
    const f = await new Promise<File>((ok, err) => entry.file!(ok, err));
    out.push({ path: entry.fullPath.replace(/^\//, ''), data: f });
  } else if (entry.isDirectory) {
    const reader = entry.createReader!();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
      if (!batch.length) break; // readEntries returns chunks; an empty chunk means done
      for (const e of batch) await walk(e, out);
    }
  }
}

/** Files/folders dropped onto the page. */
export async function fromDrop(dt: DataTransfer): Promise<RawInput[]> {
  const out: RawInput[] = [];
  const entries: FsEntry[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    const e = (item as unknown as { webkitGetAsEntry?(): FsEntry | null }).webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (entries.length) for (const e of entries) await walk(e, out);
  else out.push(...fromFileList(dt.files));
  return out;
}
