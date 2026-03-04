import type { KinshipEdge, Person, RunState, Sex, Traits } from "./types";
import { Rng } from "./rng";
import { ensureEdge } from "./relationships";

const WORLDGEN_FLAG = "_worldgen_external_houses_v0_2_2";
const WORLDGEN_ROOT_SUBKEY = "external_houses/v0.2.2";

const MALE_NAMES = ["Edmund", "Hugh", "Robert", "Walter", "Geoffrey", "Aldric", "Oswin", "Giles", "Roger", "Simon"];
const FEMALE_NAMES = ["Matilda", "Alice", "Joan", "Agnes", "Isolde", "Edith", "Beatrice", "Margery", "Cecily", "Elinor"];
const HOUSE_NAMES = ["Ashford", "Bramwell", "Caldwell", "Dunwick", "Evershaw", "Falkmere", "Glenholt", "Hartwyck", "Ivydale", "Ketterby"];
const HOUSE_TIERS = ["Knight", "Baron", "Count"] as const;

type HouseTier = (typeof HOUSE_TIERS)[number];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function extHouseId(i: number): string {
  return `h_ext_${pad2(i)}`;
}

function extPersonId(i: number, role: "head" | "spouse" | "child1" | "child2"): string {
  return `p_ext_${pad2(i)}_${role}`;
}

function pickName(rng: Rng, sex: Sex): string {
  return sex === "M" ? rng.pick(MALE_NAMES) : rng.pick(FEMALE_NAMES);
}

function traitLevel(rng: Rng): number {
  const r = rng.next();
  if (r < 0.03) return 1;
  if (r < 0.17) return 2;
  if (r < 0.83) return 3;
  if (r < 0.97) return 4;
  return 5;
}

function genTraits(rng: Rng): Traits {
  return {
    stewardship: traitLevel(rng.fork("stew")),
    martial: traitLevel(rng.fork("mart")),
    diplomacy: traitLevel(rng.fork("dip")),
    discipline: traitLevel(rng.fork("disc")),
    fertility: traitLevel(rng.fork("fert"))
  };
}

function mkPerson(rng: Rng, id: string, sex: Sex, age: number, surname: string, married: boolean): Person {
  return {
    id,
    name: `${pickName(rng, sex)} ${surname}`,
    sex,
    age,
    alive: true,
    traits: genTraits(rng.fork(`traits:${id}`)),
    married
  };
}

function holdingsForTier(tier: HouseTier, rng: Rng): number {
  if (tier === "Knight") return rng.int(1, 3);
  if (tier === "Baron") return rng.int(3, 7);
  return rng.int(7, 14);
}

function kinKey(e: KinshipEdge): string {
  if (e.kind === "parent_of") return `parent_of|${e.parent_id}|${e.child_id}`;
  const a = String(e.a_id);
  const b = String(e.b_id);
  const x = a < b ? a : b;
  const y = a < b ? b : a;
  return `spouse_of|${x}|${y}`;
}

function ensureKinshipEdge(state: RunState, e: KinshipEdge): void {
  const s: any = state as any;
  if (!Array.isArray(s.kinship_edges)) s.kinship_edges = [];
  const arr: KinshipEdge[] = s.kinship_edges as KinshipEdge[];
  const key = kinKey(e);
  const has = arr.some((x) => kinKey(x) === key);
  if (!has) arr.push(e);
}

function listExternalHouseIds(state: RunState): string[] {
  const s: any = state as any;
  const houses = s.houses && typeof s.houses === "object" ? (s.houses as Record<string, any>) : {};
  return Object.keys(houses).filter((id) => id.startsWith("h_ext_"))?.sort() ?? [];
}

function ensureRelationshipEdgesToPlayerHead(state: RunState, extHouseIds: string[]): void {
  const s: any = state as any;
  const houses = s.houses as Record<string, any>;
  const playerHeadId = state.house?.head?.id;
  if (!playerHeadId) return;

  // Stable iteration by house id.
  for (const hid of [...extHouseIds].sort()) {
    const h = houses?.[hid];
    const headId: string = (h && typeof h === "object" && typeof h.head_id === "string" && h.head_id) ? h.head_id : hid.replace(/^h_ext_/, "p_ext_") + "_head";
    if (!headId) continue;
    ensureEdge(state, playerHeadId, headId);
    ensureEdge(state, headId, playerHeadId);
  }
}

/**
 * v0.2.2 external world seed.
 *
 * Determinism contract:
 * - Uses dedicated RNG stream: stream="worldgen", turn_index=0, subkey rooted at WORLDGEN_ROOT_SUBKEY.
 * - Does NOT introduce any new RNG calls in existing sim streams.
 * - Deterministic IDs (index-based, fixed-width): h_ext_01..10 and p_ext_01_*.
 * - Idempotent: guarded by state.flags[WORLDGEN_FLAG].
 */
export function ensureExternalHousesSeed_v0_2_2(state: RunState): void {
  const s: any = state as any;
  if (!s || typeof s !== "object") return;
  if (!s.flags || typeof s.flags !== "object") s.flags = {};

  // Requires People-First registries to exist.
  if (!s.people || !s.houses || !s.player_house_id) return;

  const flags: any = s.flags;
  const alreadyHouseIds = listExternalHouseIds(state);

  // If already seeded (flag or existing ext houses), do not regenerate; just ensure missing edges.
  if (flags[WORLDGEN_FLAG] || alreadyHouseIds.length > 0) {
    flags[WORLDGEN_FLAG] = true;
    ensureRelationshipEdgesToPlayerHead(state, alreadyHouseIds);
    return;
  }

  const people = s.people as Record<string, Person>;
  const houses = s.houses as Record<string, any>;

  const root = new Rng(state.run_seed, "worldgen", 0, WORLDGEN_ROOT_SUBKEY);
  const houseCount = root.int(5, 10);

  for (let i = 1; i <= houseCount; i++) {
    const hid = extHouseId(i);
    const hRng = root.fork(`house:${hid}`);

    const tier = hRng.pick(HOUSE_TIERS) as HouseTier;
    const surname = hRng.pick(HOUSE_NAMES);
    const holdings_count = holdingsForTier(tier, hRng.fork("holdings"));

    const headId = extPersonId(i, "head");
    const spouseId = extPersonId(i, "spouse");
    const child1Id = extPersonId(i, "child1");
    const child2Id = extPersonId(i, "child2");

    const headAge = hRng.int(24, 60);
    const spouseAge = Math.max(18, headAge - hRng.int(0, 12));

    const spousePresent = hRng.bool(0.8);
    const childCount = hRng.int(0, 2);

    // Upsert people (do not overwrite if already present).
    if (!people[headId]) people[headId] = mkPerson(hRng.fork(`person:${headId}`), headId, "M", headAge, surname, spousePresent);
    if (spousePresent && !people[spouseId]) people[spouseId] = mkPerson(hRng.fork(`person:${spouseId}`), spouseId, "F", spouseAge, surname, true);

    const childIds: string[] = [];
    if (childCount >= 1) {
      const sex1: Sex = hRng.bool(0.55) ? "M" : "F";
      const age1 = hRng.int(1, Math.max(1, headAge - 16));
      if (!people[child1Id]) people[child1Id] = mkPerson(hRng.fork(`person:${child1Id}`), child1Id, sex1, age1, surname, false);
      childIds.push(child1Id);
    }
    if (childCount >= 2) {
      const sex2: Sex = hRng.bool(0.55) ? "M" : "F";
      const age2 = hRng.int(1, Math.max(1, headAge - 16));
      if (!people[child2Id]) people[child2Id] = mkPerson(hRng.fork(`person:${child2Id}`), child2Id, sex2, age2, surname, false);
      childIds.push(child2Id);
    }

    // Upsert house record.
    const prior = houses[hid] && typeof houses[hid] === "object" ? houses[hid] : {};
    houses[hid] = {
      ...prior,
      id: hid,
      name: surname,
      tier,
      holdings_count,
      head_id: headId,
      spouse_id: spousePresent ? spouseId : null,
      child_ids: childIds
    };

    // Kinship edges (spouse + parentage)
    if (spousePresent) ensureKinshipEdge(state, { kind: "spouse_of", a_id: headId, b_id: spouseId });
    for (const cid of childIds) {
      ensureKinshipEdge(state, { kind: "parent_of", parent_id: headId, child_id: cid });
      if (spousePresent) ensureKinshipEdge(state, { kind: "parent_of", parent_id: spouseId, child_id: cid });
    }
  }

  // Ensure relationship edges exist (player head ↔ external heads) in stable house id order.
  const extIds = listExternalHouseIds(state);
  ensureRelationshipEdgesToPlayerHead(state, extIds);

  flags[WORLDGEN_FLAG] = true;
}
