import { describe, expect, it } from "vitest";

import { createNewRun } from "../src/sim/state";
import { applyDecisions, createDefaultDecisions, proposeTurn } from "../src/sim/turn";

describe("v0.2.5 realism locks (Dev B)", () => {
  it("initial labor allocation starts near food-stable (no huge idle surprise)", () => {
    const s = createNewRun(202501);
    expect(s.manor.population).toBeGreaterThan(0);
    // Contract intent: population is the labor pool; start with most assigned to farmers.
    expect(s.manor.farmers / s.manor.population).toBeGreaterThanOrEqual(0.75);
    expect(s.manor.farmers + s.manor.builders).toBeLessThanOrEqual(s.manor.population);
  });

  it("court officers are male and age each turn", () => {
    const s = createNewRun(9090);
    const anyS: any = s as any;
    const playerHouseId: string = anyS.player_house_id ?? "h_player";
    const stewardId: string = anyS.houses?.[playerHouseId]?.court_officers?.steward;
    expect(typeof stewardId).toBe("string");

    const p0 = anyS.people?.[stewardId];
    expect(p0).toBeTruthy();
    expect(p0.sex).toBe("M");
    const age0 = p0.age;

    const next = applyDecisions(s, createDefaultDecisions());
    const anyN: any = next as any;
    const p1 = anyN.people?.[stewardId];
    expect(p1).toBeTruthy();
    expect(p1.sex).toBe("M");
    expect(p1.age).toBe(age0 + 3);
  });

  it("same-sex marriage offers are not generated (offers match subject child sex)", () => {
    const s = createNewRun(4242);

    // Make exactly one eligible subject (male) for determinism.
    s.house.children[0].age = 15;
    s.house.children[0].married = false;
    s.house.children[0].sex = "M";
    s.house.children[1].age = 9;
    s.house.children[1].married = false;

    // Ensure there is at least one female noble in the pool.
    if (s.locals.nobles.length > 0) s.locals.nobles[0].sex = "F";

    const ctx = proposeTurn(s);
    const mw = ctx.marriage_window;
    expect(mw).toBeTruthy();
    expect(mw!.eligible_child_ids.length).toBe(1);
    const subjectId = mw!.eligible_child_ids[0]!;
    const anyPrev: any = ctx.preview_state as any;
    const subject = anyPrev.people?.[subjectId];
    expect(subject).toBeTruthy();

    for (const off of mw!.offers) {
      const spouse = anyPrev.people?.[off.house_person_id];
      expect(spouse).toBeTruthy();
      expect(spouse.sex).not.toBe(subject.sex);
    }
  });

  it("marriage residence: daughters marry out (spouse does not join the court)", () => {
    const s = createNewRun(5151);

    // Make exactly one eligible subject (female).
    const daughter = s.house.children[0];
    daughter.age = 15;
    daughter.married = false;
    daughter.sex = "F";
    s.house.children[1].age = 9;
    s.house.children[1].married = false;

    // Ensure there is at least one male noble in the pool.
    if (s.locals.nobles.length > 0) s.locals.nobles[0].sex = "M";

    const ctx = proposeTurn(s);
    const marriage = ctx.prospects_window?.prospects.find((p) => p.type === "marriage");
    expect(marriage).toBeTruthy();
    const spouseId: string = (marriage as any).spouse_person_id;
    const subjectId: string = (marriage as any).subject_person_id;
    expect(typeof spouseId).toBe("string");
    expect(typeof subjectId).toBe("string");

    const decisions: any = createDefaultDecisions();
    decisions.prospects = {
      kind: "prospects",
      actions: [{ prospect_id: marriage!.id, action: "accept", prospect_i: 0 }]
    };

    const next = applyDecisions(s, decisions);
    const anyNext: any = next as any;
    const playerHouseId: string = anyNext.player_house_id ?? "h_player";
    const h: any = anyNext.houses?.[playerHouseId];

    // Daughters marry out: subject removed from children list and spouse NOT added to court_extra_ids.
    expect(next.house.children.some((c) => c.id === subjectId)).toBe(false);
    const extra: any[] = Array.isArray(h?.court_extra_ids) ? h.court_extra_ids : [];
    expect(extra).not.toContain(spouseId);
  });

  it("population change breakdown is present when shortage causes population loss", () => {
    const s = createNewRun(80808);

    // Force severe shortage: no production and no stored food. Also prevent births.
    s.manor.bushels_stored = 0;
    s.manor.farmers = 0;
    s.manor.builders = 0;
    s.house.spouse.age = 60;

    const ctx = proposeTurn(s);
    const br: any = (ctx.report as any).household?.population_change_breakdown;
    expect(br).toBeTruthy();
    expect(br.schema_version).toBe("population_change_breakdown_v1");
    expect(br.births).toBe(0);
    expect(typeof br.deaths).toBe("number");
    expect(typeof br.runaways).toBe("number");
    expect(br.deaths).toBeGreaterThanOrEqual(0);
    expect(br.runaways).toBeGreaterThanOrEqual(0);

    const expectedDelta = br.births - br.deaths - br.runaways;
    expect(ctx.report.household.population_delta).toBe(expectedDelta);

    // If shortage happened, we should see a negative delta.
    expect(ctx.report.household.population_delta).toBeLessThanOrEqual(0);
  });
});
