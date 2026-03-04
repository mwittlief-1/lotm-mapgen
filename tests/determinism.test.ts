import { describe, it, expect } from "vitest";
import { createNewRun, proposeTurn, applyDecisions } from "../src/sim";
import { decide } from "../src/sim/policies";

describe("determinism", () => {
  it("same seed + same policy decisions produces identical logs (first 3 turns)", () => {
    const seed = "determinism_test_seed_v007";
    const turns = 3;

    function run() {
      let s = createNewRun(seed);
      for (let i = 0; i < turns; i++) {
        const ctx = proposeTurn(s);
        const d = decide("prudent-builder", s, ctx);
        s = applyDecisions(s, d);
      }
      return JSON.stringify(s.log);
    }

    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });
});
