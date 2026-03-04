import { describe, it, expect } from "vitest";
import { createNewRun, proposeTurn, applyDecisions } from "../src/sim";
import { decide } from "../src/sim/policies";

function assertInvariants(state: any) {
  // resources non-negative
  expect(state.manor.bushels_stored).toBeGreaterThanOrEqual(0);
  expect(state.manor.coin).toBeGreaterThanOrEqual(0);

  // clamps
  expect(state.manor.unrest).toBeGreaterThanOrEqual(0);
  expect(state.manor.unrest).toBeLessThanOrEqual(100);

  // energy
  expect(state.house.energy.available).toBeGreaterThanOrEqual(0);

  // labor constraints
  expect(state.manor.farmers + state.manor.builders).toBeLessThanOrEqual(state.manor.population);

  // relationships clamps
  for (const e of state.relationships) {
    expect(e.allegiance).toBeGreaterThanOrEqual(0);
    expect(e.allegiance).toBeLessThanOrEqual(100);
    expect(e.respect).toBeGreaterThanOrEqual(0);
    expect(e.respect).toBeLessThanOrEqual(100);
    expect(e.threat).toBeGreaterThanOrEqual(0);
    expect(e.threat).toBeLessThanOrEqual(100);
  }

  // no NaN
  const allNums: number[] = [
    state.manor.population,
    state.manor.farmers,
    state.manor.builders,
    state.manor.bushels_stored,
    state.manor.coin,
    state.manor.unrest,
    state.house.energy.max,
    state.house.energy.available
  ];
  for (const n of allNums) expect(Number.isFinite(n)).toBe(true);
}

describe("invariants", () => {
  it("no NaN; clamps hold; energy never negative", () => {
    const seeds = Array.from({ length: 10 }).map((_, i) => `inv_${i}_seed_v007`);
    for (const seed of seeds) {
      for (const policy of ["prudent-builder", "builder-forward", "builder-forward/buffered"] as const) {
        let s = createNewRun(seed);
        for (let t = 0; t < 10; t++) {
          const ctx = proposeTurn(s);
          const d = decide(policy, s, ctx);
          s = applyDecisions(s, d);
          assertInvariants(s);
          if (s.game_over) break;
        }
      }
    }
  });
});
