/**
 * Deterministic RNG with stream isolation.
 * Contract: derive sub-seeds from (run_seed, stream_key, turn_index, subkey).
 * Never use Math.random() inside the sim.
 */
function fnv1a32(str) {
    let h = 0x811c9dc5; // 2166136261
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193); // 16777619
        h >>>= 0;
    }
    return h >>> 0;
}
class Mulberry32 {
    a;
    constructor(seed) {
        this.a = seed >>> 0;
    }
    next() {
        // mulberry32
        this.a = (this.a + 0x6d2b79f5) >>> 0;
        let t = this.a;
        t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
        t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}
export class Rng {
    runSeed;
    stream;
    turnIndex;
    subkey;
    gen;
    constructor(runSeed, stream, turnIndex, subkey = "") {
        this.runSeed = runSeed;
        this.stream = stream;
        this.turnIndex = turnIndex;
        this.subkey = subkey;
        const seed = fnv1a32(`${runSeed}|${stream}|${turnIndex}|${subkey}`);
        this.gen = new Mulberry32(seed);
    }
    fork(sub) {
        const nextSub = (this.subkey ? `${this.subkey}/${sub}` : sub).replace(/^\/+/, "");
        return new Rng(this.runSeed, this.stream, this.turnIndex, nextSub);
    }
    next() {
        return this.gen.next();
    }
    bool(p) {
        const pp = Math.max(0, Math.min(1, p));
        return this.next() < pp;
    }
    int(lo, hi) {
        const a = Math.min(lo, hi);
        const b = Math.max(lo, hi);
        return a + Math.floor(this.next() * (b - a + 1));
    }
    pick(arr) {
        if (arr.length === 0)
            throw new Error("pick() on empty array");
        return arr[Math.floor(this.next() * arr.length)];
    }
}
