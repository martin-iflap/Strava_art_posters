import { expandInputs, type RawInput } from './parse/archive';
import { importExport } from './parse/pipeline';
import type { ImportResult } from './types';

export type WorkerIn = { type: 'import'; inputs: RawInput[] } | { type: 'demo' };
export type WorkerOut =
  | { type: 'progress'; done: number; total: number; phase: string }
  | { type: 'result'; result: ImportResult }
  | { type: 'error'; message: string };

const ctx = self as unknown as { postMessage(m: WorkerOut): void; onmessage: ((e: MessageEvent<WorkerIn>) => void) | null };

ctx.onmessage = async (e) => {
  try {
    let inputs: RawInput[];
    if (e.data.type === 'demo') {
      ctx.postMessage({ type: 'progress', done: 0, total: 1, phase: 'Generating demo data' });
      const { generateExport } = await import('./demo/generate');
      inputs = generateExport().map((f) => ({ path: f.path, data: f.data }));
    } else inputs = e.data.inputs;
    const files = await expandInputs(inputs);
    const result = await importExport(files, (done, total, phase) => ctx.postMessage({ type: 'progress', done, total, phase }));
    ctx.postMessage({ type: 'result', result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const tooBig = err instanceof RangeError || /allocation|memory|too large/i.test(msg);
    ctx.postMessage({
      type: 'error',
      message: tooBig ? 'The browser ran out of memory reading this export. Close other tabs and try again, or drop only activities.csv and the activities folder.' : msg,
    });
  }
};
