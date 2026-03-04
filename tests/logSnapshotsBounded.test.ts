
import { describe, it, expect } from "vitest";
import { createNewRun, proposeTurn, applyDecisions } from "../src/sim";
import { decide } from "../src/sim/policies";

const ALLOWED_KEYS = new Set(["turn_index", "manor", "house", "relationships", "flags", "game_over", "people", "houses", "player_house_id", "kinship", "kinship_edges"]);

describe("TurnLogEntry snapshots", () => {
  it("snapshot_before/after are bounded and never include log history", () => {
    let s = createNewRun("snapshots_bounded_v007");
    for (let t = 0; t < 12; t++) {
      const ctx = proposeTurn(s);
      const d = decide("prudent-builder", s, ctx);
      s = applyDecisions(s, d);

      for (const entry of s.log) {
        const before: any = entry.snapshot_before as any;
        const after: any = entry.snapshot_after as any;

        expect(before.log).toBeUndefined();
        expect(after.log).toBeUndefined();

        for (const k of Object.keys(before)) expect(ALLOWED_KEYS.has(k)).toBe(true);
        for (const k of Object.keys(after)) expect(ALLOWED_KEYS.has(k)).toBe(true);
      }

      if (s.game_over) break;
    }
  });
});
