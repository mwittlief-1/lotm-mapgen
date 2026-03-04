import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { APP_VERSION } from "../src/version";
import { proposeTurn } from "../src/sim";

function loadFixture(): any {
  const p = path.resolve("tests/fixtures/v0.1.0_state_fixture.json");
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw);
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function getKinshipEdges(state: any): any[] {
  if (Array.isArray(state?.kinship)) return state.kinship;
  if (Array.isArray(state?.kinship_edges)) return state.kinship_edges;
  return [];
}

function edgeType(e: any): string | null {
  return (e?.kind ?? e?.type ?? e?.relation ?? e?.rel ?? null) as any;
}

function edgeIncludesAllIds(e: any, ids: string[]): boolean {
  const vals = Object.values(e ?? {}).filter((v) => typeof v === "string") as string[];
  return ids.every((id) => vals.includes(id));
}

describe("migration regression (v0.1.0 -> v0.2.1 People-First)", () => {
  it("proposeTurn accepts a v0.1.0 state fixture (no crash)", () => {
    const oldState = loadFixture();
    expect(() => proposeTurn(oldState as any)).not.toThrow();
  });

  it("v0.2.1 adds people/houses registries + kinship edges deterministically", () => {
    // This test is v0.2.1-specific; earlier versions won't have People-First fields.
    if (!APP_VERSION.startsWith("v0.2.1")) return;

    const oldA = loadFixture();
    const oldB = loadFixture();

    const ctxA = proposeTurn(clone(oldA) as any);
    const ctxB = proposeTurn(clone(oldB) as any);

    const a: any = ctxA.preview_state;
    const b: any = ctxB.preview_state;

    expect(a.people && typeof a.people === "object").toBe(true);
    expect(a.houses && typeof a.houses === "object").toBe(true);
    expect(typeof a.player_house_id).toBe("string");
    expect(a.player_house_id.length).toBeGreaterThan(0);
    expect(a.houses[a.player_house_id]).toBeTruthy();

    const kin = getKinshipEdges(a);
    expect(Array.isArray(kin)).toBe(true);

    // Determinism: registry + kinship portions must be identical across identical inputs.
    const pick = (s: any) => ({
      people: s.people,
      houses: s.houses,
      player_house_id: s.player_house_id,
      kinship: getKinshipEdges(s)
    });
    expect(JSON.stringify(pick(a))).toEqual(JSON.stringify(pick(b)));

    // Consistency: all v0.1.0 fixture people IDs must exist in the v0.2.1 people registry.
    const expectedIds: string[] = [];
    expectedIds.push(oldA.house?.head?.id);
    expectedIds.push(oldA.house?.spouse?.id);
    for (const c of oldA.house?.children ?? []) expectedIds.push(c?.id);
    expectedIds.push(oldA.locals?.liege?.id);
    expectedIds.push(oldA.locals?.clergy?.id);
    for (const n of oldA.locals?.nobles ?? []) expectedIds.push(n?.id);

    const cleaned = expectedIds.filter((x) => typeof x === "string" && x.length > 0);
    expect(cleaned.length).toBeGreaterThan(0);

    for (const id of cleaned) {
      expect(a.people[id]).toBeTruthy();
      expect(a.people[id].id).toBe(id);
    }

    // Kinship: spouse_of and parent_of edges should exist (flexible edge schema; checks are best-effort).
    const headId = oldA.house?.head?.id;
    const spouseId = oldA.house?.spouse?.id;
    const childIds = (oldA.house?.children ?? []).map((c: any) => c?.id).filter(Boolean);

    if (headId && spouseId) {
      const hasSpouse = kin.some((e) => edgeType(e) === "spouse_of" && edgeIncludesAllIds(e, [headId, spouseId]));
      expect(hasSpouse).toBe(true);
    }

    if (headId && childIds.length) {
      for (const childId of childIds) {
        const hasParent = kin.some((e) => edgeType(e) === "parent_of" && edgeIncludesAllIds(e, [headId, childId]));
        expect(hasParent).toBe(true);
      }
    }
  });
});
