import { APP_VERSION } from "../version";
import { SIM_VERSION } from "./version";
import type { Person, RunState, Sex, Traits } from "./types";
import { Rng } from "./rng";
import { normalizeState } from "./normalize";
import { ensureEdge } from "./relationships";
import { ensurePeopleFirst } from "./peopleFirst";
import { ensureExternalHousesSeed_v0_2_2 } from "./worldgen";
import { ensureCourtOfficers } from "./court";

function traitLevel(rng: Rng): number {
  const r = rng.next();
  if (r < 0.03) return 1;
  if (r < 0.17) return 2; // 14%
  if (r < 0.83) return 3; // 66%
  if (r < 0.97) return 4; // 14%
  return 5; // 3%
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

const MALE_NAMES = ["Edmund", "Hugh", "Robert", "Walter", "Geoffrey", "Aldric", "Oswin", "Giles", "Roger", "Simon"];
const FEMALE_NAMES = ["Matilda", "Alice", "Joan", "Agnes", "Isolde", "Edith", "Beatrice", "Margery", "Cecily", "Elinor"];
const HOUSE_NAMES = ["Ashford", "Bramwell", "Caldwell", "Dunwick", "Evershaw", "Falkmere", "Glenholt", "Hartwyck", "Ivydale", "Ketterby"];

function pickName(rng: Rng, sex: Sex): string {
  return sex === "M" ? rng.pick(MALE_NAMES) : rng.pick(FEMALE_NAMES);
}

function mkPerson(rng: Rng, id: string, sex: Sex, age: number): Person {
  return {
    id,
    name: pickName(rng, sex),
    sex,
    age,
    alive: true,
    traits: genTraits(rng.fork(`traits:${id}`)),
    married: false
  };
}

export function createNewRun(run_seed: string): RunState {
  const rng = new Rng(run_seed, "household", 0, "init");
  // v0.2.3.2 age sanity (LOCK): first child at husband age 22, wife age 18.
  // Keep deterministic starter ages (no randomness yet).
  const head = mkPerson(rng, "p_head", "M", 34);
  head.married = true;
  const spouse = mkPerson(rng, "p_spouse", "F", 30);
  spouse.married = true;

  const child1 = mkPerson(rng, "p_child1", rng.bool(0.55) ? "M" : "F", 12);
  const child2 = mkPerson(rng, "p_child2", rng.bool(0.55) ? "M" : "F", 9);

  const liege = mkPerson(rng, "p_liege", "M", 41);
  const clergy = mkPerson(rng, "p_clergy", "M", 52);

  // v0.2.5: ensure marriage pool has both sexes (same-sex marriage disabled).
  const nobleSexes: Sex[] = Array.from({ length: 4 }).map(() => (rng.bool(0.7) ? "M" : "F"));
  const hasM = nobleSexes.includes("M");
  const hasF = nobleSexes.includes("F");
  if (!hasM) nobleSexes[nobleSexes.length - 1] = "M";
  if (!hasF) nobleSexes[nobleSexes.length - 1] = "F";

  const nobles = Array.from({ length: 4 }).map((_, i) => {
    const sex = nobleSexes[i] ?? "M";
    const n = mkPerson(rng, `p_noble${i + 1}`, sex, rng.int(22, 55));
    n.name = `${n.name} of ${rng.pick(HOUSE_NAMES)}`;
    return n;
  });

  const state: RunState = {
    version: SIM_VERSION,
    app_version: APP_VERSION,
    run_seed,
    turn_index: 0,
    manor: {
      population: 45,
      farmers: 36, // v0.2.5: start nearer food-stable (population is labor pool)
      builders: 0,
      bushels_stored: 900,
      coin: 10,
      unrest: 10,
      improvements: [],
      construction: null,
      obligations: {
        tax_due_coin: 0,
        tithe_due_bushels: 0,
        arrears: { coin: 0, bushels: 0 },
        war_levy_due: null
      }
    },
    house: {
      head,
      spouse,
      spouse_status: "spouse",
      children: [child1, child2],
      energy: { max: 5, available: 5 },
      heir_id: null
    },
    locals: {
      liege,
      clergy,
      nobles
    },
    relationships: [],
    flags: {
      _cooldowns: {},
      _mods: {}
    },
    log: [],
    game_over: null
  };

  // baseline relationships (directed)
  ensureEdge(state, head.id, liege.id);
  ensureEdge(state, liege.id, head.id);
  ensureEdge(state, head.id, clergy.id);
  ensureEdge(state, clergy.id, head.id);
  for (const n of nobles) {
    ensureEdge(state, head.id, n.id);
    ensureEdge(state, n.id, head.id);
  }

  normalizeState(state);
  ensurePeopleFirst(state);
  ensureExternalHousesSeed_v0_2_2(state);
  // v0.2.4: deterministic court officers (idempotent; stream-isolated).
  ensureCourtOfficers(state);
  ensurePeopleFirst(state);
  return state;
}
