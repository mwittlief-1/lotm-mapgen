export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function clampInt(n: number, lo: number, hi: number): number {
  return Math.trunc(clamp(Math.trunc(n), lo, hi));
}

export function asNonNegInt(n: unknown): number {
  const x = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.trunc(x));
}

export function deepCopy<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export function safeJsonStringify(obj: unknown, pretty = true): string {
  return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v), pretty ? 2 : 0);
}
