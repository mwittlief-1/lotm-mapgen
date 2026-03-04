import { describe, expect, test } from "vitest";

import { createNewRun, proposeTurn } from "../src/sim";

// Dev B patch validation for v0.2.3.2

describe("v0.2.3.2 patch (Dev B)", () => {
  test("age sanity: starting family ages align to LOCK rule", () => {
    const s = createNewRun("age_sanity_seed");
    const headAge = s.house.head.age;
    const spouseAge = s.house.spouse?.age ?? 0;
    const oldestChild = [...s.house.children].sort((a, b) => b.age - a.age)[0];

    expect(oldestChild).toBeTruthy();
    expect(headAge - oldestChild.age).toBe(22);
    expect(spouseAge - oldestChild.age).toBe(18);
  });

  test("household roster is deduped and heir is a badge (no duplicate row)", () => {
    const s = createNewRun("roster_seed");
    const ctx = proposeTurn(s);

    expect(ctx.household_roster).toBeTruthy();
    const rows = ctx.household_roster!.rows;

    // Unique person_ids
    const ids = rows.map((r) => r.person_id);
    expect(new Set(ids).size).toBe(ids.length);

    // Exactly one heir badge, and it matches state.house.heir_id
    const heirId = ctx.preview_state.house.heir_id;
    expect(heirId).toBeTruthy();
    const heirRows = rows.filter((r) => r.badges.includes("heir"));
    expect(heirRows.length).toBe(1);
    expect(heirRows[0].person_id).toBe(heirId);
    expect(heirRows[0].role).toBe("child");
  });

  test("widowed log emits once on spouse death, with survivor+deceased fields populated", () => {
    const s = createNewRun("widow_once_seed");
    // Force spouse death this turn (age advances +3 before roll; >=99 hard cap).
    if (!s.house.spouse) throw new Error("expected starter spouse");
    s.house.spouse.age = 96;

    const ctx = proposeTurn(s);

    expect(ctx.preview_state.house.spouse?.alive).toBe(false);
    expect(ctx.preview_state.house.head.alive).toBe(true);
    expect(ctx.preview_state.house.spouse_status).toBe("widow");

    const widowed = ctx.report.house_log.filter((e) => e.kind === "widowed");
    expect(widowed.length).toBe(1);
    const ev = widowed[0];

    // Back-compat field: spouse_name refers to the deceased.
    expect(ev.spouse_name).toBe(s.house.spouse.name);
    expect(ev.deceased_id).toBe(s.house.spouse.id);
    expect(ev.survivor_id).toBe(s.house.head.id);
    expect(ev.survivor_sex).toBe(s.house.head.sex);

    // Roster semantics: survivor is widower; deceased is deceased.
    const roster = ctx.household_roster!;
    const headRow = roster.rows.find((r) => r.person_id === s.house.head.id)!;
    const spouseRow = roster.rows.find((r) => r.person_id === s.house.spouse!.id)!;
    expect(headRow.badges).toContain("widower");
    expect(spouseRow.badges).toContain("deceased");
    expect(spouseRow.badges).not.toContain("widow");
    expect(spouseRow.badges).not.toContain("widower");
  });

  test("widowed log does not repeat when spouse was already dead in prior state", () => {
    const s = createNewRun("widow_dedupe_seed");
    if (!s.house.spouse) throw new Error("expected starter spouse");
    s.house.spouse.alive = false;
    s.house.spouse_status = "widow";

    const ctx = proposeTurn(s);
    const widowed = ctx.report.house_log.filter((e) => e.kind === "widowed");
    expect(widowed.length).toBe(0);
  });

  test("unrest breakdown is structurally consistent (delta equals contributors)", () => {
    const s = createNewRun("unrest_breakdown_seed");
    // Force shortage + arrears: no food, no income.
    s.manor.bushels_stored = 0;
    s.manor.coin = 0;
    s.manor.farmers = 0;
    s.manor.builders = 0;
    s.manor.population = 100;
    s.manor.unrest = 0;

    const ctx = proposeTurn(s);
    const b = ctx.report.unrest_breakdown;
    expect(b).toBeTruthy();
    expect(b!.schema_version).toBe("unrest_breakdown_v1");
    expect(b!.before).toBe(0);
    expect(b!.after).toBe(ctx.preview_state.manor.unrest);
    expect(b!.delta).toBe(b!.after - b!.before);

    const sumInc = b!.increased_by.reduce((acc, x) => acc + x.amount, 0);
    const sumDec = b!.decreased_by.reduce((acc, x) => acc + x.amount, 0);
    expect(b!.delta).toBe(sumInc - sumDec);

    const labels = new Set(b!.increased_by.map((x) => x.label));
    expect(labels.has("Shortage")).toBe(true);
    expect(labels.has("Arrears")).toBe(true);
  });

  test("construction options include built + active_project statuses", () => {
    const s = createNewRun("construction_options_seed");
    s.manor.improvements = ["granary"];
    s.manor.construction = { improvement_id: "mason_hut", progress: 0 };
    s.manor.builders = 0; // keep project in-progress

    const ctx = proposeTurn(s);
    const opts = ctx.report.construction.options;
    expect(opts).toBeTruthy();

    const byId = new Map(opts!.map((o) => [o.improvement_id, o.status]));
    expect(byId.get("granary")).toBe("built");
    expect(byId.get("mason_hut")).toBe("active_project");
  });

  test("labor signal is emitted when shortage causes population loss to oversubscribe labor", () => {
    // Choose a seed with 0 events for deterministic labor math.
    let ctx: ReturnType<typeof proposeTurn> | null = null;
    for (let i = 0; i < 50; i++) {
      const s = createNewRun(`labor_signal_seed_${i}`);
      s.manor.population = 100;
      s.manor.bushels_stored = 0;
      s.manor.coin = 0;
      s.manor.farmers = 0;
      s.manor.builders = 100;
      s.manor.unrest = 0;

      const c = proposeTurn(s);
      if (c.report.events.length === 0) {
        ctx = c;
        break;
      }
    }
    expect(ctx).toBeTruthy();

    const sig = ctx!.report.labor_signal;
    expect(sig).toBeTruthy();
    expect(sig!.schema_version).toBe("labor_signal_v1");
    expect(sig!.was_oversubscribed).toBe(true);
    expect(sig!.auto_clamped).toBe(true);

    // With full shortage: lossFrac caps at 0.25 => pop 100 -> 75, builders clamp 100 -> 75.
    expect(sig!.available).toBe(75);
    expect(sig!.builders_before).toBe(100);
    expect(sig!.builders_after).toBe(75);
    expect(sig!.assigned_before).toBe(100);
    expect(sig!.assigned_after).toBe(75);
  });
});
