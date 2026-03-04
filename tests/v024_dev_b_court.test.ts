import { describe, expect, it } from "vitest";

import { BUSHELS_PER_PERSON_PER_YEAR, TURN_YEARS } from "../src/sim/constants";
import { createNewRun } from "../src/sim/state";
import { applyDecisions, createDefaultDecisions, proposeTurn } from "../src/sim/turn";

describe("v0.2.5 Court/Household (Dev B)", () => {
  it("generates deterministic steward stub and reconciles consumption totals", () => {
    const state = createNewRun(12345);
    const anyState: any = state as any;
    const playerHouseId: string = anyState.player_house_id ?? "h_player";
    const h: any = anyState.houses?.[playerHouseId];

    expect(h).toBeTruthy();
    expect(h.court_officers).toBeTruthy();
    expect(h.court_officers.steward).toBe("p_court_steward");
    expect(h.court_officers.clerk).toBeUndefined();
    expect(h.court_officers.marshal).toBeUndefined();

    // Officers must exist as people records.
    expect(anyState.people?.[h.court_officers.steward]).toBeTruthy();

    const ctx = proposeTurn(state);
    expect(ctx.report.peasant_consumption_bushels).toBeGreaterThanOrEqual(0);
    expect(ctx.report.court_consumption_bushels).toBeGreaterThanOrEqual(0);
    expect(ctx.report.total_consumption_bushels).toBe(ctx.report.peasant_consumption_bushels + ctx.report.court_consumption_bushels);
    expect(ctx.report.consumption_bushels).toBe(ctx.report.total_consumption_bushels);

    // Court consumption must follow the locked formula.
    const headcount = ctx.report.court_headcount ?? ctx.report.court_roster?.headcount_alive;
    expect(typeof headcount).toBe("number");
    expect(ctx.report.court_consumption_bushels).toBe((headcount as number) * BUSHELS_PER_PERSON_PER_YEAR * TURN_YEARS);

    // Court roster must include the officers with role keys.
    const roster = ctx.report.court_roster;
    expect(roster?.schema_version).toBe("court_roster_v1");
    const officerRows = roster?.rows.filter((r) => r.role === "officer") ?? [];
    const officerRoles = new Set(officerRows.map((r) => r.officer_role));
    expect(officerRoles.has("steward")).toBe(true);
    expect(officerRoles.has("clerk")).toBe(false);
    expect(officerRoles.has("marshal")).toBe(false);
  });

  it("accepting a marriage prospect for the heir/eldest son adds spouse to court roster via court_extra_ids", () => {
    const state = createNewRun(777);

    // Force an eligible unmarried child so a marriage prospect is generated.
    state.house.children[0].age = 15;
    state.house.children[0].married = false;

    // v0.2.5: marriage prospects are opposite-sex; ensure the subject is a son and pool contains a daughter/spouse.
    state.house.children[0].sex = "M";
    if (state.locals.nobles.length > 0) state.locals.nobles[0].sex = "F";

    const ctx = proposeTurn(state);
    const pw = ctx.prospects_window;
    expect(pw).toBeTruthy();
    const marriage = pw!.prospects.find((p) => p.type === "marriage");
    expect(marriage).toBeTruthy();
    expect(typeof (marriage as any).spouse_person_id).toBe("string");
    const spouseId: string = (marriage as any).spouse_person_id;

    const decisions: any = createDefaultDecisions();
    decisions.prospects = {
      kind: "prospects",
      actions: [{ prospect_id: marriage!.id, action: "accept", prospect_i: 0 }]
    };

    const next = applyDecisions(state, decisions);
    const anyNext: any = next as any;
    const playerHouseId: string = anyNext.player_house_id ?? "h_player";
    const h: any = anyNext.houses?.[playerHouseId];
    expect(Array.isArray(h.court_extra_ids)).toBe(true);
    expect(h.court_extra_ids).toContain(spouseId);

    // Next turn roster should show the spouse as a married-in spouse.
    const ctx2 = proposeTurn(next);
    const r2 = ctx2.report.court_roster;
    expect(r2?.rows.some((row) => row.role === "married_in_spouse" && row.person_id === spouseId)).toBe(true);
  });
});