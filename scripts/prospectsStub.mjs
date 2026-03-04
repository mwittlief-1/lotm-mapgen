#!/usr/bin/env node
/**
 * ProspectsWindow v1 stub generator (fixtures for UX/QA/Balance).
 *
 * Usage:
 *   npm run prospects:stub -- --seed=<seed> --turn=<t>
 *
 * Notes:
 * - Deterministic.
 * - Uses isolated RNG stream key: "prospects" (per v0.2.3 contract).
 * - Does NOT mutate or depend on sim outputs beyond reading registries for plausible IDs.
 */
import path from "node:path";
import crypto from "node:crypto";

const sim = await import(path.resolve("dist_batch/src/sim/index.js"));
const { Rng } = await import(path.resolve("dist_batch/src/sim/rng.js"));

function parseArgs(argv) {
  const out = { seed: "lotm_stub_seed", turn: 0, pretty: true };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, v] = arg.slice(2).split("=");
    if (k === "seed" && v) out.seed = v;
    if (k === "turn" && v) out.turn = Number(v);
    if (k === "pretty" && v) out.pretty = v !== "0" && v !== "false";
  }
  return out;
}

function hashId(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

const args = parseArgs(process.argv.slice(2));
const seed = String(args.seed);
const turn = Number.isFinite(args.turn) ? Math.max(0, Math.floor(args.turn)) : 0;

const state = sim.createNewRun(seed);
const toHouseId = String(state.player_house_id ?? "h_player");
const houseIds = Object.keys(state.houses ?? {}).map(String).filter((x) => x && x !== toHouseId).sort();
const from1 = houseIds[0] ?? "h_ext_01";
const from2 = houseIds[1] ?? from1;
const from3 = houseIds[2] ?? from1;

const children = state.house?.children ?? [];
const subjectChildId = String(children[0]?.id ?? "p_child1");

const rng = new Rng(seed, "prospects", turn, "stub");

// Deterministic helper to make small, UI-friendly numbers.
function smallInt(subkey, lo, hi) {
  return rng.fork(subkey).int(lo, hi);
}

function mkProspectBase(type, fromHouseId, subjectPersonId, extra) {
  const id = `pros_${type}_${hashId(`${seed}|${turn}|${type}|${fromHouseId}|${subjectPersonId ?? ""}`)}`;
  const expires = turn + (type === "inheritance_claim" ? 1 : 2);

  return {
    id,
    type,
    from_house_id: fromHouseId,
    to_house_id: toHouseId,
    subject_person_id: subjectPersonId ?? null,
    summary: extra?.summary ?? `Stub ${type} prospect`,
    requirements: extra?.requirements ?? [],
    costs: extra?.costs ?? {},
    predicted_effects: extra?.predicted_effects ?? {},
    uncertainty: extra?.uncertainty ?? "likely",
    expires_turn: expires,
    actions: ["accept", "reject"]
  };
}

const marriage = mkProspectBase("marriage", from1, subjectChildId, {
  summary: "Stub: Marriage proposal (covers required subject_person_id)",
  requirements: [
    { kind: "respect_min", value: 40, text: "Respect at least 40" }
  ],
  costs: { energy: 1, coin: smallInt("m/coin", 0, 10) },
  predicted_effects: {
    relationship_deltas: [
      { scope: "person", from_id: String(state.people?.[String(state.houses?.[from1]?.head_id ?? "")]?.id ?? (state.houses?.[from1]?.head_id ?? "p_ext_01_head")), to_id: String(state.house?.head?.id ?? "p_head"), allegiance_delta: 2, respect_delta: 6, threat_delta: -1 }
    ],
    flags_set: ["prospect_marriage_stub"]
  },
  uncertainty: "possible"
});

const grant = mkProspectBase("grant", from2, null, {
  summary: "Stub: Grant offer (covers costs + coin_delta)",
  requirements: [
    { kind: "no_arrears", value: true, text: "No arrears owed" },
    { kind: "coin_min", value: 5, text: "At least 5 coin available" }
  ],
  costs: { energy: 2 },
  predicted_effects: {
    coin_delta: smallInt("g/coin_delta", 5, 20),
    flags_set: ["prospect_grant_stub"]
  },
  uncertainty: "likely"
});

const claim = mkProspectBase("inheritance_claim", from3, null, {
  summary: "Stub: Inheritance claim (claim-only; no holdings granted)",
  requirements: [
    { kind: "custom", value: "claim_strength_medium", text: "Claim strength: medium" }
  ],
  costs: { coin: smallInt("c/coin", 5, 15) },
  predicted_effects: {
    relationship_deltas: [
      { scope: "house", from_id: from3, to_id: toHouseId, allegiance_delta: -2, respect_delta: -4, threat_delta: 3 }
    ],
    flags_set: ["inheritance_claim_active"]
  },
  uncertainty: "possible"
});

// Deterministic relevance split for fixtures:
// - marriage: always shown (directly involves player person)
// - grant: shown
// - claim: hidden (so UI can exercise hidden section)
const prospects = [marriage, grant, claim];

const shown_ids = [marriage.id, grant.id];
const hidden_ids = [claim.id];

const win = {
  schema_version: "prospects_window_v1",
  turn_index: turn,
  generated_at_turn_index: turn,
  prospects,
  shown_ids,
  hidden_ids
};

const json = JSON.stringify(win, null, args.pretty ? 2 : 0);
process.stdout.write(json + "\n");
