export const fmt = (v: number, d = 1) => v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
export const dash = '–';
export const opt = (v: number | null, d = 0) => (v === null ? dash : fmt(v, d));
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
