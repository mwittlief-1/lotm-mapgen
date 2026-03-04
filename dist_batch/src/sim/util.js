export function clamp(n, lo, hi) {
    if (!Number.isFinite(n))
        return lo;
    return Math.max(lo, Math.min(hi, n));
}
export function clampInt(n, lo, hi) {
    return Math.trunc(clamp(Math.trunc(n), lo, hi));
}
export function asNonNegInt(n) {
    const x = typeof n === "number" ? n : Number(n);
    if (!Number.isFinite(x))
        return 0;
    return Math.max(0, Math.trunc(x));
}
export function deepCopy(obj) {
    return JSON.parse(JSON.stringify(obj));
}
export function safeJsonStringify(obj, pretty = true) {
    return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v), pretty ? 2 : 0);
}
