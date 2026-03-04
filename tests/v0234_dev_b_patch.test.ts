import { describe, expect, test } from "vitest";

import { applyDecisions, createNewRun, proposeTurn } from "../src/sim";

function edge(state: any, fromId: string, toId: string) {
  return state.relationships.find((e: any) => e.from_id === fromId && e.to_id === toId) ?? null;
}

// Dev B patch validation for v0.2.3.4

describe("v0.2.3.4 patch (Dev B)", () => {
  test("TurnReport embeds household_roster and marks deceased head alive=false on the death turn", () => {
    const s = createNewRun("death_turn_consistency_seed");

    // Simulate a widowed head (spouse already deceased), then force head death this turn.
    if (!s.house.spouse) throw new Error("expected starter spouse");
    s.house.spouse.alive = false;
    s.house.spouse_status = "widow";
    s.house.head.age = 96; // +3 => 99 => guaranteed death

    const ctx = proposeTurn(s);

    expect(ctx.preview_state.house.head.alive).toBe(false);
    expect(ctx.report.household.deaths.length).toBeGreaterThan(0);

    // Roster must exist both on ctx and report (history-safe), and be consistent.
    expect(ctx.household_roster).toBeTruthy();
    expect(ctx.report.household_roster).toBeTruthy();
    expect(ctx.report.household_roster).toEqual(ctx.household_roster);

    const roster = ctx.report.household_roster!;
    const ids = roster.rows.map((r) => r.person_id);
    expect(new Set(ids).size).toBe(ids.length);

    const headRow = roster.rows.find((r) => r.person_id === s.house.head.id);
    expect(headRow).toBeTruthy();
    expect(headRow!.role).toBe("head");
    expect(headRow!.badges).toContain("deceased");
  });

  test("labor signal detects oversubscription created by edits entering the turn", () => {
    const s = createNewRun("labor_oversub_enter_seed");

    // Edited/invalid labor plan: assigned > population.
    s.manor.population = 10;
    s.manor.farmers = 10;
    s.manor.builders = 10;

    const ctx = proposeTurn(s);
    const sig = ctx.report.labor_signal;

    expect(sig).toBeTruthy();
    expect(sig!.schema_version).toBe("labor_signal_v1");
    expect(sig!.was_oversubscribed).toBe(true);
    expect(sig!.auto_clamped).toBe(true);

    expect(sig!.available).toBe(10);
    expect(sig!.assigned_before).toBe(20);
    expect(sig!.assigned_after).toBe(10);

    // Clamp rule: builders cut first.
    expect(sig!.farmers_before).toBe(10);
    expect(sig!.builders_before).toBe(10);
    expect(sig!.farmers_after).toBe(10);
    expect(sig!.builders_after).toBe(0);
  });

  test("grant prospects: predicted_effects populated; accept vs reject produces deterministic difference", () => {
    const seed = "grant_semantics_seed";

    const baseA = createNewRun(seed);
    const baseR = createNewRun(seed);

    // Force arrears so a grant is generated.
    baseA.manor.obligations.arrears.coin = 10;
    baseA.manor.obligations.arrears.bushels = 0;
    baseR.manor.obligations.arrears.coin = 10;
    baseR.manor.obligations.arrears.bushels = 0;

    const ctx = proposeTurn(baseA);
    const pw = ctx.prospects_window;
    expect(pw).toBeTruthy();

    const grant = pw!.prospects.find((p) => p.type === "grant") ?? null;
    expect(grant).toBeTruthy();

    // Deterministic formula: pressure = arrearsCoin + floor(arrearsBushels/100)
    // grantCoin = clamp(2 + floor(pressure*0.5), 2..12)
    expect(grant!.predicted_effects.coin_delta).toBe(7);

    const rds = grant!.predicted_effects.relationship_deltas;
    expect(Array.isArray(rds)).toBe(true);
    expect(rds!.length).toBeGreaterThan(0);

    const rd0: any = rds![0];
    expect(rd0.from_id).toBe(baseA.locals.liege.id);
    expect(rd0.to_id).toBe(baseA.house.head.id);
    expect(rd0.allegiance_delta).toBe(1);
    expect(rd0.respect_delta).toBe(-1);
    expect(rd0.threat_delta).toBe(3);

    // Apply decisions: accept vs reject.
    const decisionsAccept = {
      labor: { kind: "labor", desired_farmers: baseA.manor.farmers, desired_builders: baseA.manor.builders },
      sell: { kind: "sell", sell_bushels: 0 },
      obligations: { kind: "pay_obligations", pay_coin: 0, pay_bushels: 0, war_levy_choice: "ignore" },
      construction: { kind: "construction", action: "none" },
      marriage: { kind: "marriage", action: "none" },
      prospects: { kind: "prospects", actions: [{ prospect_id: grant!.id, action: "accept" }] }
    } as any;

    const decisionsReject = {
      labor: { kind: "labor", desired_farmers: baseR.manor.farmers, desired_builders: baseR.manor.builders },
      sell: { kind: "sell", sell_bushels: 0 },
      obligations: { kind: "pay_obligations", pay_coin: 0, pay_bushels: 0, war_levy_choice: "ignore" },
      construction: { kind: "construction", action: "none" },
      marriage: { kind: "marriage", action: "none" },
      prospects: { kind: "prospects", actions: [{ prospect_id: grant!.id, action: "reject" }] }
    } as any;

    const outA = applyDecisions(baseA, decisionsAccept);
    const outR = applyDecisions(baseR, decisionsReject);

    // Accepting the grant adds coin_delta; rejecting does not.
    expect(outA.manor.coin - outR.manor.coin).toBe(7);

    // Accepting applies relationship delta; rejecting does not.
    const liegeId = outA.locals.liege.id;
    const headId = outA.house.head.id;
    const eA = edge(outA, liegeId, headId);
    const eR = edge(outR, liegeId, headId);
    expect(eA).toBeTruthy();
    expect(eR).toBeTruthy();

    expect(eA.allegiance - eR.allegiance).toBe(1);
    expect(eA.respect - eR.respect).toBe(-1);
    expect(eA.threat - eR.threat).toBe(3);
  });
});
