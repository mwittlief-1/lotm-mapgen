/**
 * Deterministic RNG with stream isolation.
 * Contract: derive sub-seeds from (run_seed, stream_key, turn_index, subkey).
 * Never use Math.random() inside the sim.
 */

function fnv1a32(str: string): number {
  let h = 0x811c9dc5; // 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // 16777619
    h >>>= 0;
  }
  return h >>> 0;
}

class Mulberry32 {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  next(): number {
    // mulberry32
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t ^= (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// Stream isolation contract: each major system uses a distinct stream key.
// v0.2.2 adds "worldgen" for external world seeding (turn_index=0 only).
// v0.2.4 adds "court" for deterministic court officer generation (turn_index=0 only).
export type StreamKey = "weather" | "events" | "household" | "marriage" | "prospects" | "court" | "ai" | "market" | "worldgen";

export class Rng {
  private gen: Mulberry32;

  constructor(
    public readonly runSeed: string,
    public readonly stream: StreamKey,
    public readonly turnIndex: number,
    public readonly subkey: string = ""
  ) {
    const seed = fnv1a32(`${runSeed}|${stream}|${turnIndex}|${subkey}`);
    this.gen = new Mulberry32(seed);
  }

  fork(sub: string): Rng {
    const nextSub = (this.subkey ? `${this.subkey}/${sub}` : sub).replace(/^\/+/, "");
    return new Rng(this.runSeed, this.stream, this.turnIndex, nextSub);
  }

  next(): number {
    return this.gen.next();
  }

  bool(p: number): boolean {
    const pp = Math.max(0, Math.min(1, p));
    return this.next() < pp;
  }

  int(lo: number, hi: number): number {
    const a = Math.min(lo, hi);
    const b = Math.max(lo, hi);
    return a + Math.floor(this.next() * (b - a + 1));
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("pick() on empty array");
    return arr[Math.floor(this.next() * arr.length)] as T;
  }
}
