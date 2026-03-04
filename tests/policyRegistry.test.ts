import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createNewRun, proposeTurn } from "../src/sim";
import { canonicalizePolicyId, sanitizePolicyIdForArtifacts, decide, POLICY_IDS } from "../src/sim/policies";

describe("policy registry", () => {
  it("canonicalizePolicyId maps locked alias 'good-faith' -> prudent-builder", () => {
    expect(canonicalizePolicyId("good-faith")).toBe("prudent-builder");
  });

  it("canonicalizePolicyId accepts sanitized id builder-forward__buffered", () => {
    expect(canonicalizePolicyId("builder-forward__buffered")).toBe("builder-forward/buffered");
  });

  it("canonicalizePolicyId falls back to prudent-builder on unknown", () => {
    expect(canonicalizePolicyId("definitely-not-a-policy")).toBe("prudent-builder");
  });

  it("sanitizes policy ids for artifact folder names", () => {
    expect(sanitizePolicyIdForArtifacts("builder-forward/buffered")).toBe("builder-forward__buffered");
  });
});


  it("BUILD_INFO.policy_ids matches registry (drift prevention)", () => {
    const buildInfoPath = path.resolve("docs/BUILD_INFO.json");
    const raw = fs.readFileSync(buildInfoPath, "utf8");
    const info = JSON.parse(raw);
    const declared: string[] = Array.isArray(info?.policy_ids) ? info.policy_ids : [];
    // canonical registry IDs are implied by canonicalizePolicyId mapping and POLICY_IDS constant (via decide import)
    const registry = Array.from(POLICY_IDS);
    const sort = (arr: string[]) => [...new Set(arr.map(String))].sort();
    expect(sort(declared)).toEqual(sort(registry));
  });

describe("builder-forward improvement selection", () => {
  it("builder-forward uses WP-11 priority order (field_rotation first)", () => {
    const s = createNewRun("bf_priority_seed");
    // ensure we can afford any improvement and won't trip food-buffer selling logic
    s.manor.coin = 50;
    s.manor.bushels_stored = 5000;

    const ctx = proposeTurn(s);
    const d = decide("builder-forward", s, ctx);

    expect(d.construction.kind).toBe("construction");
    expect(d.construction.action).toBe("start");
    // Village Feast is cheaper, so this asserts we are *not* choosing cheapest.
    expect(d.construction.improvement_id).toBe("field_rotation");
  });

  it("builder-forward/buffered selects the cheapest viable improvement (diagnostic)", () => {
    const s = createNewRun("bf_buffered_seed");
    s.manor.coin = 50;
    s.manor.bushels_stored = 5000;

    const ctx = proposeTurn(s);
    const d = decide("builder-forward/buffered", s, ctx);

    expect(d.construction.kind).toBe("construction");
    expect(d.construction.action).toBe("start");
    expect(d.construction.improvement_id).toBe("village_feast");
  });
});
