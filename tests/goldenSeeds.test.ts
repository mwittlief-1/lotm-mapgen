import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION } from "../src/version";
import { createNewRun, proposeTurn, applyDecisions } from "../src/sim";
import { decide, type PolicyId } from "../src/sim/policies";

function loadGoldenSeeds(): string[] {
  const candidates = [
    `docs/golden_seeds_${APP_VERSION}.json`,
    "docs/golden_seeds_v0.2.1.json",
    "docs/golden_seeds_v0.1.0.json",
    "docs/golden_seeds_v0.0.9.json"
  ];

  for (const c of candidates) {
    const p = path.resolve(c);
    if (!fs.existsSync(p)) continue;
    const gs = JSON.parse(fs.readFileSync(p, "utf8"));
    const seeds = (gs.golden_seeds ?? gs.seeds ?? [])
      .map((x: any) => (typeof x === "string" ? x : x.seed))
      .filter(Boolean);
    if (seeds.length) return seeds;
  }

  // Fallback (should not happen in release repos)
  return ["lotm_v007_seed_001", "lotm_v007_seed_002", "lotm_v007_seed_003", "lotm_v007_seed_004"];
}

function runDeterministic(seed: string, policy: PolicyId, turns: number): string {
  let s = createNewRun(seed);
  for (let i = 0; i < turns; i++) {
    const ctx = proposeTurn(s);
    const d = decide(policy, s, ctx);
    s = applyDecisions(s, d);
    if (s.game_over) break;
  }
  return JSON.stringify(s.log);
}

const GOLDEN_SEEDS = loadGoldenSeeds();
const POLICIES: PolicyId[] = ["prudent-builder", "builder-forward", "builder-forward/buffered"];
const TURNS = 15;

describe(`golden seeds (${APP_VERSION})`, () => {
  it("seed list is non-empty", () => {
    expect(GOLDEN_SEEDS.length).toBeGreaterThan(0);
  });

  for (const policy of POLICIES) {
    it(`golden seeds are deterministic for ${TURNS} turns under ${policy}`, () => {
      for (const seed of GOLDEN_SEEDS) {
        const a = runDeterministic(seed, policy, TURNS);
        const b = runDeterministic(seed, policy, TURNS);
        expect(a).toEqual(b);
      }
    });
  }
});
