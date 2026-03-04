import type {
  RunState,
  TurnContext,
  TurnDecisions,
  TurnReport,
  EventResult,
  MarriageWindow,
  MarriageOffer,
  Person,
  RunSnapshot,
  HouseLogEvent,
  HouseholdRoster,
  ProspectsWindow,
  Prospect,
  ProspectType,
  ProspectsLogEvent
} from "./types";
import {
Rng } from "./rng";
import { deepCopy, clampInt, asNonNegInt } from "./util";
import {
  TURN_YEARS,
  BUSHELS_PER_FARMER_PER_YEAR,
  BUSHELS_PER_PERSON_PER_YEAR,
  BASE_FERTILITY,
  SPOILAGE_RATE_BASE,
  SPOILAGE_RATE_GRANARY,
  MARKET_PRICE_MIN,
  MARKET_PRICE_MAX,
  SELL_CAP_FACTOR_MIN,
  SELL_CAP_FACTOR_MAX,
  BUILD_RATE_PER_BUILDER_PER_TURN,
  BUILDER_EXTRA_BUSHELS_PER_YEAR,
  UNREST_SHORTAGE_PENALTY,
  UNREST_ARREARS_PENALTY,
  UNREST_BASELINE_DECAY_WHEN_STABLE,
  EVENTS_PER_TURN_PROBS,
  maxLaborDeltaPerTurn,
  MORTALITY_MULT_WITH_PHYSICIAN,
  BIRTH_CHANCE_BY_FERTILITY,
  BIRTH_FERTILE_AGE_MIN,
  BIRTH_FERTILE_AGE_MAX,
  MORTALITY_P_UNDER16,
  MORTALITY_P_UNDER40,
  MORTALITY_P_UNDER55,
  MORTALITY_P_UNDER65,
  MORTALITY_P_65PLUS,
  YIELD_MULT_FIELD_ROTATION,
  YIELD_MULT_DRAINAGE_DITCHES,
  SELL_MULT_MILL_EFFICIENCY,
  DRAINAGE_WEATHER_SOFTEN_BONUS,
  VILLAGE_FEAST_UNREST_REDUCTION
} from "./constants";
import { normalizeState } from "./normalize";
import { EVENT_DECK } from "../content/events";
import { IMPROVEMENTS, hasImprovement } from "../content/improvements";
import { adjustEdge, relationshipBounds } from "./relationships";
import { ensurePeopleFirst } from "./peopleFirst";
import { ensureExternalHousesSeed_v0_2_2 } from "./worldgen";
import { addCourtExtraId, courtConsumptionBushels_v0_2_4, ensureCourtOfficers, getCourtOfficerIds } from "./court";

function modsObj(state: RunState): Record<string, number> {
  const anyFlags: any = state.flags;
  if (!anyFlags._mods || typeof anyFlags._mods !== "object") anyFlags._mods = {};
  return anyFlags._mods as Record<string, number>;
}
function cooldownsObj(state: RunState): Record<string, number> {
  const anyFlags: any = state.flags;
  if (!anyFlags._cooldowns || typeof anyFlags._cooldowns !== "object") anyFlags._cooldowns = {};
  return anyFlags._cooldowns as Record<string, number>;
}

function consumeMod(state: RunState, key: string, defaultValue = 1): number {
  const mods = modsObj(state);
  const v = typeof mods[key] === "number" ? (mods[key] as number) : defaultValue;
  delete mods[key];
  return v;
}

function currentSpoilageRate(state: RunState): number {
  if (hasImprovement(state.manor.improvements, "granary_upgrade")) return SPOILAGE_RATE_GRANARY;
  return SPOILAGE_RATE_BASE;
}

function stewardshipMultiplier(state: RunState): number {
  const s = state.house.head.traits.stewardship;
  // small, legible
  return 1 + (s - 3) * 0.02; // L1=-0.04 ... L5=+0.04
}

function yieldMultiplier(state: RunState): number {
  let m = 1.0;
  if (hasImprovement(state.manor.improvements, "field_rotation")) m *= YIELD_MULT_FIELD_ROTATION;
  if (hasImprovement(state.manor.improvements, "drainage_ditches")) m *= YIELD_MULT_DRAINAGE_DITCHES;
  return m;
}

function sellMultiplier(state: RunState): number {
  let m = 1.0;
  if (hasImprovement(state.manor.improvements, "mill_efficiency")) m *= SELL_MULT_MILL_EFFICIENCY;
  return m;
}

function decrementCooldowns(state: RunState): void {
  const cd = cooldownsObj(state);
  for (const k of Object.keys(cd)) {
    cd[k] = Math.max(0, Math.trunc((cd[k] ?? 0) - 1));
    if (cd[k] === 0) delete cd[k];
  }
}

function chooseEventCount(rng: Rng): 0 | 1 | 2 {
  const r = rng.next();
  let acc = 0;
  for (const { k, p } of EVENTS_PER_TURN_PROBS) {
    acc += p;
    if (r < acc) return k;
  }
  return 1;
}

function weightedPick<T>(rng: Rng, items: Array<{ item: T; weight: number }>): { picked: T; roll: number; total: number } {
  const total = items.reduce((s, it) => s + it.weight, 0);
  if (total <= 0) throw new Error("weightedPick: total weight <= 0");
  const x = rng.next() * total;
  let acc = 0;
  for (const it of items) {
    acc += it.weight;
    if (x <= acc) return { picked: it.item, roll: x / total, total };
  }
  return { picked: items[items.length - 1]!.item, roll: x / total, total };
}

function computeHeirId(state: RunState): string | null {
  // male-preference primogeniture among children
  const kids = state.house.children.filter((c) => c.alive);
  const byPrimogeniture = (a: Person, b: Person) => {
    // older first; deterministic tie-break by id
    if (b.age !== a.age) return b.age - a.age;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  };
  const males = kids.filter((c) => c.sex === "M").sort(byPrimogeniture);
  const females = kids.filter((c) => c.sex === "F").sort(byPrimogeniture);
  const heir = (males[0] ?? females[0]) ?? null;
  state.house.heir_id = heir ? heir.id : null;
  return state.house.heir_id ?? null;
}

function buildHouseholdRoster_v0_2_3_2(state: RunState): HouseholdRoster {
  const heirId = state.house.heir_id ?? null;
  const spouse = state.house.spouse ?? null;

  // Surviving spouse (if any) gets the widow/widower badge.
  let widowedPersonId: string | null = null;
  if (spouse) {
    if (state.house.head.alive && !spouse.alive) widowedPersonId = state.house.head.id;
    else if (!state.house.head.alive && spouse.alive) widowedPersonId = spouse.id;
  }

  const rows: HouseholdRoster["rows"] = [];
  const seen = new Set<string>();

  const pushRow = (person: Person, role: "head" | "spouse" | "child") => {
    if (!person?.id) return;
    if (seen.has(person.id)) return;
    seen.add(person.id);

    const badges: HouseholdRoster["rows"][number]["badges"] = [];
    if (!person.alive) badges.push("deceased");
    if (person.alive && widowedPersonId === person.id) badges.push(person.sex === "M" ? "widower" : "widow");
    if (person.id === heirId) badges.push("heir");

    rows.push({ person_id: person.id, role, badges });
  };

  pushRow(state.house.head, "head");
  if (spouse) pushRow(spouse, "spouse");

  const sortedKids = [...state.house.children].sort((a, b) => {
    if (b.age !== a.age) return b.age - a.age;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });
  for (const c of sortedKids) pushRow(c, "child");

  return { schema_version: "household_roster_v1", turn_index: state.turn_index, rows };
}


function boundedSnapshot(state: RunState): RunSnapshot {
  // LOCKED (v0.0.5 QA blocker fix): snapshots must never contain `log` (or nested history).
  // Keep only the minimal state needed for debugging.
  return deepCopy({
    turn_index: state.turn_index,
    manor: state.manor,
    house: state.house,
    relationships: state.relationships,
    people: (state as any).people,
    houses: (state as any).houses,
    player_house_id: (state as any).player_house_id,
    kinship_edges: (state as any).kinship_edges ?? (state as any).kinship,
    flags: state.flags,
    game_over: state.game_over ?? null
  });
}


function applySpoilage(state: RunState): { rate: number; loss_bushels: number } {
  const rateBase = currentSpoilageRate(state);
  const mult = consumeMod(state, "spoilage_mult", 1);
  const rate = Math.max(0, Math.min(0.25, rateBase * mult));
  const before = state.manor.bushels_stored;
  const after = asNonNegInt(Math.floor(before * (1 - rate)));
  state.manor.bushels_stored = after;
  return { rate, loss_bushels: before - after };
}

function computeWeatherMarket(state: RunState): { weather_multiplier: number; market: { price_per_bushel: number; sell_cap_bushels: number } } {
  const t = state.turn_index;
  const wRng = new Rng(state.run_seed, "weather", t, "macro");
  const mRng = new Rng(state.run_seed, "market", t, "macro");
  let weather = 0.6 + wRng.next() * (1.25 - 0.6);
  // Apply one-turn mod
  weather *= consumeMod(state, "weather_mult", 1);
  if (hasImprovement(state.manor.improvements, "drainage_ditches") && weather < 1.0) {
    weather = Math.min(1.25, weather + DRAINAGE_WEATHER_SOFTEN_BONUS);
  }
  weather = Math.max(0.6, Math.min(1.25, weather));

  let price = MARKET_PRICE_MIN + mRng.next() * (MARKET_PRICE_MAX - MARKET_PRICE_MIN);
  price *= consumeMod(state, "market_price_mult", 1);
  price *= sellMultiplier(state);
  price = Math.max(0.01, price);

  const baseCap = Math.floor(state.manor.population * BUSHELS_PER_PERSON_PER_YEAR); // one year of local demand
  const capFactor = (SELL_CAP_FACTOR_MIN + mRng.next() * (SELL_CAP_FACTOR_MAX - SELL_CAP_FACTOR_MIN)) * consumeMod(state, "sell_cap_mult", 1);
  const sellCap = Math.max(0, Math.floor(baseCap * capFactor));

  return { weather_multiplier: weather, market: { price_per_bushel: price, sell_cap_bushels: sellCap } };
}

function applyProductionAndConstruction(state: RunState, weather_multiplier: number): { production_bushels: number; construction_progress_added: number; completed_improvement_id?: string } {
  // production uses current farmers (set last turn)
  const farmerPenalty = Math.trunc(consumeMod(state, "farmer_penalty", 0));
  const effectiveFarmers = Math.max(0, state.manor.farmers - farmerPenalty);

  const baseProduction = effectiveFarmers * BUSHELS_PER_FARMER_PER_YEAR * TURN_YEARS;
  const prodMult = weather_multiplier * BASE_FERTILITY * stewardshipMultiplier(state) * yieldMultiplier(state) * consumeMod(state, "production_mult", 1);
  const production = Math.max(0, Math.floor(baseProduction * prodMult));
  state.manor.bushels_stored = asNonNegInt(state.manor.bushels_stored + production);

  // Construction progress uses current builders.
  let progressAdded = 0;
  let completed: string | undefined = undefined;
  if (state.manor.construction) {
    progressAdded = state.manor.builders * BUILD_RATE_PER_BUILDER_PER_TURN;
    state.manor.construction.progress = asNonNegInt(state.manor.construction.progress + progressAdded);
    if (state.manor.construction.progress >= state.manor.construction.required) {
      completed = state.manor.construction.improvement_id;
      state.manor.improvements.push(completed);
      state.manor.construction = null;

      // Completion effects (existing mechanics; numeric only)
      if (completed === "village_feast") {
        state.manor.unrest = clampInt(state.manor.unrest - VILLAGE_FEAST_UNREST_REDUCTION, 0, 100);
      }
    }
  }

  return { production_bushels: production, construction_progress_added: progressAdded, completed_improvement_id: completed };
}

function applyConsumptionAndShortage(state: RunState, court_consumption_bushels: number): {
  consumption_bushels: number;
  peasant_consumption_bushels: number;
  court_consumption_bushels: number;
  total_consumption_bushels: number;
  shortage_bushels: number;
  population_delta: number;
  // v0.2.5: population change visibility (labor pool): split shortage losses.
  population_deaths: number;
  population_runaways: number;
  // v0.2.3.2: structured signal when labor is auto-clamped due to population loss.
  labor_auto_clamped?: boolean;
  labor_before?: { population: number; farmers: number; builders: number };
  labor_after?: { population: number; farmers: number; builders: number };
} {
  const pop = state.manor.population;
  const farmers = state.manor.farmers;
  const builders = state.manor.builders;
  const idle = Math.max(0, pop - farmers - builders);

  const peasantConsumption = Math.floor(
    (farmers * BUSHELS_PER_PERSON_PER_YEAR +
      builders * (BUSHELS_PER_PERSON_PER_YEAR + BUILDER_EXTRA_BUSHELS_PER_YEAR) +
      idle * BUSHELS_PER_PERSON_PER_YEAR) *
      TURN_YEARS
  );
  const courtConsumption = Math.max(0, Math.trunc(court_consumption_bushels));
  const consumption = asNonNegInt(peasantConsumption + courtConsumption);
  const before = state.manor.bushels_stored;
  if (before >= consumption) {
    state.manor.bushels_stored = asNonNegInt(before - consumption);
    return {
      consumption_bushels: consumption,
      peasant_consumption_bushels: peasantConsumption,
      court_consumption_bushels: courtConsumption,
      total_consumption_bushels: consumption,
      shortage_bushels: 0,
      population_delta: 0,
      population_deaths: 0,
      population_runaways: 0
    };
  }

  const shortage = consumption - before;
  state.manor.bushels_stored = 0;

  // shortage consequences
  (state.flags as any).Shortage = true;
  state.manor.unrest = clampInt(state.manor.unrest + UNREST_SHORTAGE_PENALALTY_SAFE(), 0, 100);

  const hRng = new Rng(state.run_seed, "household", state.turn_index, "shortage");
  const lossFrac = 0.03 + hRng.next() * 0.08; // 3%..11%
  const lost = Math.max(1, Math.floor(state.manor.population * lossFrac));

  // v0.2.5: split population loss into deaths vs runaways (deterministic; no new RNG).
  const sev01 = Math.max(0, Math.min(1, (lossFrac - 0.03) / 0.08));
  const deathFrac = 0.3 + sev01 * 0.2; // 30%..50%
  const deaths = Math.min(lost, Math.floor(lost * deathFrac));
  const runaways = Math.max(0, lost - deaths);

  state.manor.population = asNonNegInt(state.manor.population - lost);
  let labor_before: { population: number; farmers: number; builders: number } | undefined;
  let labor_after: { population: number; farmers: number; builders: number } | undefined;
  let labor_auto_clamped: boolean | undefined;
  if (state.manor.farmers + state.manor.builders > state.manor.population) {
    labor_before = {
      population: asNonNegInt(state.manor.population),
      farmers: asNonNegInt(state.manor.farmers),
      builders: asNonNegInt(state.manor.builders)
    };
    // remove from builders first (construction labor tends to flee first)
    const overflow = state.manor.farmers + state.manor.builders - state.manor.population;
    const bCut = Math.min(state.manor.builders, overflow);
    state.manor.builders -= bCut;
    const rem = overflow - bCut;
    if (rem > 0) state.manor.farmers = Math.max(0, state.manor.farmers - rem);

    labor_after = {
      population: asNonNegInt(state.manor.population),
      farmers: asNonNegInt(state.manor.farmers),
      builders: asNonNegInt(state.manor.builders)
    };
    labor_auto_clamped = labor_before.farmers !== labor_after.farmers || labor_before.builders !== labor_after.builders;
  }

  const res: {
    consumption_bushels: number;
    peasant_consumption_bushels: number;
    court_consumption_bushels: number;
    total_consumption_bushels: number;
    shortage_bushels: number;
    population_delta: number;
    population_deaths: number;
    population_runaways: number;
    labor_auto_clamped?: boolean;
    labor_before?: { population: number; farmers: number; builders: number };
    labor_after?: { population: number; farmers: number; builders: number };
  } = {
    consumption_bushels: consumption,
    peasant_consumption_bushels: peasantConsumption,
    court_consumption_bushels: courtConsumption,
    total_consumption_bushels: consumption,
    shortage_bushels: shortage,
    population_delta: -lost,
    population_deaths: deaths,
    population_runaways: runaways
  };

  if (labor_before && labor_after) {
    res.labor_auto_clamped = labor_auto_clamped;
    res.labor_before = labor_before;
    res.labor_after = labor_after;
  }
  return res;
}

// small helper to keep constant name typo-proof in this file
function UNREST_SHORTAGE_PENALALTY_SAFE(): number {
  return UNREST_SHORTAGE_PENALTY;
}

function applyObligationsAndArrearsPenalty(state: RunState, production_bushels: number): void {
  const ob = state.manor.obligations;

  // penalties only on existing arrears (WP-02 lock)
  if (ob.arrears.coin > 0 || ob.arrears.bushels > 0) {
    state.manor.unrest = clampInt(state.manor.unrest + UNREST_ARREARS_PENALTY, 0, 100);
    // liege reacts to arrears
    adjustEdge(state, state.locals.liege.id, state.house.head.id, { respect: -2, threat: +2 });
  }

  // compute current dues (player can pay during decisions)
  ob.tax_due_coin = Math.max(1, Math.floor(state.manor.population / 25));
  ob.tithe_due_bushels = Math.floor(production_bushels * 0.05);
}

function relationshipDrift(state: RunState): void {
  for (const e of state.relationships) {
    // drift 1 point toward baseline
    const baseA = 50, baseR = 50, baseT = 20;
    e.allegiance += e.allegiance < baseA ? 1 : e.allegiance > baseA ? -1 : 0;
    e.respect += e.respect < baseR ? 1 : e.respect > baseR ? -1 : 0;
    e.threat += e.threat < baseT ? 1 : e.threat > baseT ? -1 : 0;
    e.allegiance = clampInt(e.allegiance, 0, 100);
    e.respect = clampInt(e.respect, 0, 100);
    e.threat = clampInt(e.threat, 0, 100);
  }
}

function householdPhase(state: RunState, houseLog: HouseLogEvent[]): { births: string[]; deaths: string[]; population_delta: number } {
  const births: string[] = [];
  const deaths: string[] = [];
  let popDelta = 0;

  // Age household members by 3 years (turn = 3y).
  // v0.2.5 LOCK: court officers must also age (prevents immortal stewards).
  const people: Person[] = [];
  const seenIds = new Set<string>();
  const push = (p: Person | null | undefined) => {
    if (!p || typeof p !== "object") return;
    if (typeof p.id !== "string" || !p.id) return;
    if (seenIds.has(p.id)) return;
    seenIds.add(p.id);
    people.push(p);
  };

  push(state.house.head);
  if (state.house.spouse) push(state.house.spouse);
  for (const c of state.house.children) push(c);

  // Court officers (People-First registry; back-compat no-op if registry missing).
  {
    const anyState: any = state as any;
    const reg: Record<string, Person> | undefined = anyState.people as any;
    if (reg) {
      for (const { person_id } of getCourtOfficerIds(state)) {
        const op = reg[person_id];
        if (op) push(op);
      }
    }
  }

  for (const p of people) p.age += 3;

  // deaths (simple): older increases risk; physician reduces risk.
  const hasPhysician = hasImprovement(state.manor.improvements, "physician");
  const mult = hasPhysician ? MORTALITY_MULT_WITH_PHYSICIAN : 1.0;
  const r = new Rng(state.run_seed, "household", state.turn_index, "mortality");

  const headWasAlive = state.house.head.alive;
  const spouseWasAlive = state.house.spouse?.alive ?? false;

  function deathRoll(p: Person): boolean {
    if (!p.alive) return false;

    // v0.2.3.2: cap extreme old-age survival (turn = 3y). Prevent ~120y rulers.
    if (p.age >= 99) return true;

    let base = 0.0;
    if (p.age < 16) base = MORTALITY_P_UNDER16;
    else if (p.age < 40) base = MORTALITY_P_UNDER40;
    else if (p.age < 55) base = MORTALITY_P_UNDER55;
    else if (p.age < 65) base = MORTALITY_P_UNDER65;
    else {
      // Steepen mortality beyond 65 (no new RNG; deterministic math only).
      const yearsOver = p.age - 65;
      base = MORTALITY_P_65PLUS * (1 + yearsOver * 0.06);
    }
    // discipline reduces risk slightly
    base *= 1 - (p.traits.discipline - 3) * 0.01;
    base *= mult;
    base = Math.max(0, Math.min(0.95, base));
    return r.fork(`d:${p.id}`).bool(base);
  }

  for (const p of people) {
    if (deathRoll(p)) {
      p.alive = false;
      deaths.push(`${p.name} (${p.id})`);
    }
  }

  const headDiedThisTurn = headWasAlive && !state.house.head.alive;
  const spouseDiedThisTurn = spouseWasAlive && Boolean(state.house.spouse) && state.house.spouse!.alive === false;

  // v0.2.3.2 widow semantics:
  // - Surviving spouse is Widow/Widower/Widowed.
  // - Deceased spouse is Deceased.
  // - Log only once, at the turn of death.
  if ((headDiedThisTurn || spouseDiedThisTurn) && state.house.spouse) {
    // Marriage ended; block further births.
    state.house.spouse_status = "widow";

    let survivor: Person | null = null;
    let deceased: Person | null = null;
    if (headDiedThisTurn && state.house.spouse.alive) {
      survivor = state.house.spouse;
      deceased = state.house.head;
    } else if (spouseDiedThisTurn && state.house.head.alive) {
      survivor = state.house.head;
      deceased = state.house.spouse;
    }

    if (survivor && deceased) {
      houseLog.push({
        kind: "widowed",
        turn_index: state.turn_index,
        // Back-compat: spouse_name remains the deceased person's name.
        spouse_name: deceased.name,
        survivor_name: survivor.name,
        survivor_id: survivor.id,
        survivor_sex: survivor.sex,
        deceased_name: deceased.name,
        deceased_id: deceased.id,
        deceased_age: deceased.age
      });
    }
  }

  // births: only if spouse exists + spouse_status is spouse
  if (state.house.spouse && state.house.spouse.alive && state.house.spouse_status === "spouse" && state.house.head.alive) {
    const spouse = state.house.spouse;
    const fertileAge = spouse.age >= BIRTH_FERTILE_AGE_MIN && spouse.age <= BIRTH_FERTILE_AGE_MAX;
    if (fertileAge) {
      const fert = clampInt(spouse.traits.fertility, 1, 5);
      const base = BIRTH_CHANCE_BY_FERTILITY[fert] ?? 0.24;
      const mods = (state.flags as any)._mods ?? {};
      const bonus = typeof mods.birth_bonus === "number" ? mods.birth_bonus : 1;
      const chance = Math.min(0.95, Math.max(0, base * bonus));
      const bRng = new Rng(state.run_seed, "household", state.turn_index, "birth");
      if (bRng.bool(chance)) {
        const childId = `p_child_${state.turn_index}_${state.house.children.length + 1}`;
        const sex = bRng.bool(0.52) ? "M" : "F";
        const baby: Person = {
          id: childId,
          name: sex === "M" ? "Thomas" : "Anne",
          sex,
          age: 0,
          alive: true,
          traits: { stewardship: 3, martial: 3, diplomacy: 3, discipline: 3, fertility: 3 },
          married: false
        };
        state.house.children.push(baby);
        births.push(`${baby.name} (${baby.id})`);
        // population increases too (abstract)
        state.manor.population = asNonNegInt(state.manor.population + 1);
        popDelta += 1;
      }
    }
  }

  return { births, deaths, population_delta: popDelta };
}

function buildMarriageWindow(state: RunState): MarriageWindow | null {
  // Trigger when any child >=15 and unmarried OR an offer flag exists.
  const anyFlags: any = state.flags;
  const forced = Boolean(anyFlags.MarriageOffer);

  const eligibleAll = state.house.children.filter((c) => c.alive && !c.married && c.age >= 15);
  if (!forced && eligibleAll.length === 0) return null;

  // v0.2.5: pick a single subject child (eldest eligible). This keeps the offer list coherent and
  // allows same-sex marriage to be disabled without changing the window schema.
  if (eligibleAll.length === 0) return { eligible_child_ids: [], offers: [] };

  const subject = [...eligibleAll].sort((a, b) => {
    if (b.age !== a.age) return b.age - a.age; // older first
    return a.id.localeCompare(b.id);
  })[0]!;

  const desiredSpouseSex: "M" | "F" = subject.sex === "M" ? "F" : "M";
  const pool = state.locals.nobles.filter((n) => n.alive && n.sex === desiredSpouseSex);

  // If no opposite-sex candidates exist, do not generate a same-sex marriage window.
  if (pool.length === 0) {
    if (forced) return { eligible_child_ids: [subject.id], offers: [] };
    return null;
  }

  const rng = new Rng(state.run_seed, "marriage", state.turn_index, "offers");
  const offers: MarriageOffer[] = [];
  const offerCount = 2 + (rng.bool(0.4) ? 1 : 0);

  for (let i = 0; i < offerCount; i++) {
    const noble = rng.pick(pool);
    const quality = rng.next(); // 0..1
    const dowry = Math.trunc(-4 + quality * 12) - (rng.bool(0.2) ? rng.int(0, 3) : 0); // -4..+8-ish
    offers.push({
      house_person_id: noble.id,
      house_label: noble.name,
      dowry_coin_net: dowry,
      relationship_delta: { respect: Math.trunc(2 + quality * 6), allegiance: Math.trunc(1 + quality * 4), threat: Math.trunc(-1 - quality * 2) },
      liege_delta: rng.bool(0.35) ? { respect: 1, threat: -1 } : null,
      risk_tags: [
        quality > 0.75 ? "prestige" : quality < 0.25 ? "shady" : "plain",
        dowry < 0 ? "costly" : "profitable"
      ]
    });
  }

  return { eligible_child_ids: [subject.id], offers };
}


// --- Prospects (v0.2.3) ---

type ActiveProspectRef = { id: string; expires_turn: number };

function readActiveProspects(state: RunState): ActiveProspectRef[] {
  const anyFlags: any = state.flags;
  const raw = anyFlags._prospects_active_v1;
  if (!Array.isArray(raw)) return [];
  const out: ActiveProspectRef[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const id = (r as any).id;
    const ex = (r as any).expires_turn;
    if (typeof id === "string" && typeof ex === "number" && Number.isFinite(ex)) {
      out.push({ id, expires_turn: Math.trunc(ex) });
    }
  }
  return out.slice(0, 3);
}

function writeActiveProspects(state: RunState, refs: ActiveProspectRef[]): void {
  const anyFlags: any = state.flags;
  const bounded = refs.slice(0, 3).map((r) => ({ id: r.id, expires_turn: Math.trunc(r.expires_turn) }));
  if (bounded.length === 0) {
    delete anyFlags._prospects_active_v1;
    return;
  }
  anyFlags._prospects_active_v1 = bounded;
}

function guessProspectTypeFromId(id: string): ProspectType {
  if (id.includes("marriage")) return "marriage";
  if (id.includes("inheritance")) return "inheritance_claim";
  if (id.includes("grant")) return "grant";
  return "grant";
}

function summaryForType(t: ProspectType): string {
  if (t === "marriage") return "Marriage proposal";
  if (t === "grant") return "Grant offer";
  return "Inheritance claim";
}

function uncertaintyForType(t: ProspectType): "known" | "likely" | "possible" {
  if (t === "marriage") return "known";
  if (t === "grant") return "likely";
  return "possible";
}

function lookupProspectFromHistory(state: RunState, prospectId: string): Prospect | null {
  const log: any[] = (state.log ?? []) as any[];
  for (let i = log.length - 1; i >= 0; i--) {
    const rep: any = log[i]?.report;
    const evs: any[] | undefined = rep?.prospects_log;
    if (!Array.isArray(evs)) continue;
    for (let j = evs.length - 1; j >= 0; j--) {
      const ev: any = evs[j];
      if (ev && ev.kind === "prospect_generated" && ev.prospect_id === prospectId && ev.prospect && typeof ev.prospect === "object") {
        return ev.prospect as Prospect;
      }
    }
  }
  return null;
}

function pickSponsorHouseId(state: RunState): string {
  const anyState: any = state as any;
  const playerHouseId: string = typeof anyState.player_house_id === "string" ? anyState.player_house_id : "h_player";
  const houses: Record<string, any> = anyState.houses && typeof anyState.houses === "object" ? (anyState.houses as Record<string, any>) : {};

  const playerHeadId: string = typeof houses[playerHouseId]?.head_id === "string" ? houses[playerHouseId].head_id : state.house.head.id;

  let best: string | null = null;
  let bestRespect = -1;

  const ids = Object.keys(houses).filter((id) => id !== playerHouseId).sort(); // tie-break: house_id asc
  for (const hid of ids) {
    const headId = houses[hid]?.head_id;
    if (typeof headId !== "string") continue;
    const edge = state.relationships.find((e) => e.from_id === playerHeadId && e.to_id === headId);
    if (!edge) continue;
    if (edge.respect > bestRespect) {
      bestRespect = edge.respect;
      best = hid;
    }
  }

  return best ?? playerHouseId;
}

function bestMarriageOfferIndex_v0_2_2_policy(state: RunState, mw: MarriageWindow): number | null {
  let bestIdx: number | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < mw.offers.length; i++) {
    const o = mw.offers[i]!;
    const dowry = o.dowry_coin_net;
    // same affordability filter as v0.2.2 prudent-builder marriage acceptance policy
    if (dowry < 0 && state.manor.coin < Math.abs(dowry)) continue;
    const score = dowry * 3 + o.relationship_delta.respect * 2 + o.relationship_delta.allegiance;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function buildProspectsWindow_v0_2_3(state: RunState, marriageWindow: MarriageWindow | null, prospectsLog: ProspectsLogEvent[]): ProspectsWindow {
  const t = state.turn_index;
  const anyState: any = state as any;
  const playerHouseId: string = typeof anyState.player_house_id === "string" ? anyState.player_house_id : "h_player";

  const sponsorHouseId = pickSponsorHouseId(state);

  // 1) Expire old prospects at start-of-turn (turn_index > expires_turn)
  const active0 = readActiveProspects(state);
  const active: ActiveProspectRef[] = [];
  for (const ref of active0) {
    if (t > ref.expires_turn) {
      const p = lookupProspectFromHistory(state, ref.id);
      if (p) {
        prospectsLog.push({
          kind: "prospect_expired",
          turn_index: t,
          type: p.type,
          from_house_id: p.from_house_id,
          to_house_id: p.to_house_id,
          subject_person_id: p.subject_person_id,
          prospect_id: p.id,
          effects_applied: {}
        });
      } else {
        const tg = guessProspectTypeFromId(ref.id);
        prospectsLog.push({
          kind: "prospect_expired",
          turn_index: t,
          type: tg,
          from_house_id: sponsorHouseId,
          to_house_id: playerHouseId,
          subject_person_id: null,
          prospect_id: ref.id,
          effects_applied: {}
        });
      }
      continue;
    }
    active.push(ref);
  }

  // Keep flags bounded and accurate
  writeActiveProspects(state, active);

  const prospects: Prospect[] = [];

  // 2) Rehydrate active prospects from history (do not store payloads in flags)
  for (const ref of active) {
    const p = lookupProspectFromHistory(state, ref.id);
    if (p) {
      prospects.push({ ...p, expires_turn: ref.expires_turn });
    } else {
      // Fallback minimal placeholder (should not happen in normal interactive runs)
      const tg = guessProspectTypeFromId(ref.id);
      prospects.push({
        id: ref.id,
        type: tg,
        from_house_id: sponsorHouseId,
        to_house_id: playerHouseId,
        subject_person_id: null,
        summary: summaryForType(tg),
        requirements: [],
        costs: {},
        predicted_effects: {},
        uncertainty: uncertaintyForType(tg),
        expires_turn: ref.expires_turn,
        actions: ["accept", "reject"]
      });
    }
  }

  const activeTypes = new Set<ProspectType>(prospects.map((p) => p.type));

  // 3) Deterministic trigger-only generation (no random chances)
  const idRng = new Rng(state.run_seed, "prospects", t, "id");
  function makeId(pt: ProspectType, subject: string | null): string {
    const n = idRng.fork(`id:${pt}:${sponsorHouseId}:${subject ?? "none"}`).int(0, 1_000_000_000);
    return `pros_${pt}_${t}_${n.toString(36)}`;
  }

  function emitGenerated(p: Prospect): void {
    prospectsLog.push({
      kind: "prospect_generated",
      turn_index: t,
      type: p.type,
      from_house_id: p.from_house_id,
      to_house_id: p.to_house_id,
      subject_person_id: p.subject_person_id,
      prospect_id: p.id,
      prospect: p
    });
  }

  function addProspect(p: Prospect): void {
    if (prospects.length >= 3) return;
    prospects.push(p);
    active.push({ id: p.id, expires_turn: p.expires_turn });
    activeTypes.add(p.type);
    emitGenerated(p);
  }

  // 3.1) marriage
  if (prospects.length < 3 && !activeTypes.has("marriage") && marriageWindow && marriageWindow.eligible_child_ids.length > 0 && marriageWindow.offers.length > 0) {
    const subjectId = [...marriageWindow.eligible_child_ids].sort((a, b) => a.localeCompare(b))[0]!;
    const bestIdx = bestMarriageOfferIndex_v0_2_2_policy(state, marriageWindow);
    if (bestIdx !== null) {
      const offer = marriageWindow.offers[bestIdx]!;
      const relDeltas: any[] = [];
      relDeltas.push({
        scope: "person",
        from_id: state.house.head.id,
        to_id: offer.house_person_id,
        allegiance_delta: offer.relationship_delta.allegiance,
        respect_delta: offer.relationship_delta.respect,
        threat_delta: offer.relationship_delta.threat
      });
      if (offer.liege_delta) {
        relDeltas.push({
          scope: "person",
          from_id: state.house.head.id,
          to_id: state.locals.liege.id,
          allegiance_delta: 0,
          respect_delta: offer.liege_delta.respect,
          threat_delta: offer.liege_delta.threat
        });
      }

      const p: Prospect = {
        id: makeId("marriage", subjectId),
        type: "marriage",
        from_house_id: sponsorHouseId,
        to_house_id: playerHouseId,
        subject_person_id: subjectId,
        spouse_person_id: offer.house_person_id,
        summary: "Marriage proposal",
        requirements: [],
        costs: {},
        predicted_effects: {
          coin_delta: offer.dowry_coin_net,
          relationship_deltas: relDeltas,
          flags_set: []
        },
        uncertainty: "known",
        expires_turn: t + 2,
        actions: ["accept", "reject"]
      };
      addProspect(p);
    }
  }

  // 3.2) grant
  const arrears = state.manor.obligations.arrears;
  const hasArrears = (arrears?.coin ?? 0) > 0 || (arrears?.bushels ?? 0) > 0;
  if (prospects.length < 3 && !activeTypes.has("grant") && hasArrears) {
    // v0.2.3.4: minimal grant semantics (deterministic).
    // Grant gives coin *now* (before obligation payments in applyDecisions), but increases liege leverage slightly.
    const arrearsCoin = asNonNegInt(Math.trunc(arrears?.coin ?? 0));
    const arrearsBushels = asNonNegInt(Math.trunc(arrears?.bushels ?? 0));
    const pressure = arrearsCoin + Math.floor(arrearsBushels / 100);
    const grantCoin = clampInt(2 + Math.floor(pressure * 0.5), 2, 12);

    const relDeltas: any[] = [
      {
        scope: "person",
        // Liege's view of the player (existing mechanics primarily use liege -> head).
        from_id: state.locals.liege.id,
        to_id: state.house.head.id,
        allegiance_delta: +1,
        respect_delta: -1,
        threat_delta: +3
      }
    ];

    const p: Prospect = {
      id: makeId("grant", null),
      type: "grant",
      from_house_id: sponsorHouseId,
      to_house_id: playerHouseId,
      subject_person_id: null,
      summary: "Grant offer",
      requirements: [],
      costs: {},
      predicted_effects: {
        coin_delta: grantCoin,
        relationship_deltas: relDeltas,
        flags_set: []
      },
      uncertainty: "likely",
      expires_turn: t + 2,
      actions: ["accept", "reject"]
    };
    addProspect(p);
  }

  // 3.3) inheritance_claim
  const heir = state.house.heir_id ?? computeHeirId(state);
  if (prospects.length < 3 && !activeTypes.has("inheritance_claim") && heir === null) {
    const p: Prospect = {
      id: makeId("inheritance_claim", state.house.head.id),
      type: "inheritance_claim",
      from_house_id: sponsorHouseId,
      to_house_id: playerHouseId,
      subject_person_id: state.house.head.id,
      summary: "Inheritance claim",
      requirements: [],
      costs: {},
      predicted_effects: { flags_set: ["inheritance_claim_active"] },
      uncertainty: "possible",
      expires_turn: t + 2,
      actions: ["accept", "reject"]
    };
    addProspect(p);
  }

  // Keep flags updated after any generation
  writeActiveProspects(state, active);

  // 4) Stable ordering
  const order: Record<string, number> = { marriage: 0, grant: 1, inheritance_claim: 2 };
  prospects.sort((a, b) => {
    const da = order[a.type] ?? 99;
    const db = order[b.type] ?? 99;
    if (da != db) return da - db;
    return a.id.localeCompare(b.id);
  });

  // 5) Presentation-only relevance filtering
  const householdIds = new Set<string>();
  householdIds.add(state.house.head.id);
  if (state.house.spouse) householdIds.add(state.house.spouse.id);
  for (const c of state.house.children) householdIds.add(c.id);

  function sponsorRespectOk(fromHouseId: string): boolean {
    const houses: Record<string, any> = anyState.houses && typeof anyState.houses === "object" ? (anyState.houses as Record<string, any>) : {};
    const playerHeadId: string = typeof houses[playerHouseId]?.head_id === "string" ? houses[playerHouseId].head_id : state.house.head.id;
    const sponsorHeadId: string | null = typeof houses[fromHouseId]?.head_id === "string" ? houses[fromHouseId].head_id : null;
    if (!sponsorHeadId) return false;
    const e = state.relationships.find((x) => x.from_id === playerHeadId && x.to_id === sponsorHeadId);
    return Boolean(e && e.respect >= 55);
  }

  const shown_ids: string[] = [];
  const hidden_ids: string[] = [];
  for (const p of prospects) {
    const involvesPlayer = p.subject_person_id ? householdIds.has(p.subject_person_id) : false;
    const expiresThisTurn = p.expires_turn === t;
    const sponsorOk = sponsorRespectOk(p.from_house_id);
    const show = involvesPlayer || sponsorOk || expiresThisTurn;
    if (show) shown_ids.push(p.id);
    else hidden_ids.push(p.id);
  }

  if (prospects.length > 0) {
    prospectsLog.push({ kind: "prospects_window_built", turn_index: t, shown_ids, hidden_ids });
  }

  return {
    schema_version: "prospects_window_v1",
    turn_index: t,
    generated_at_turn_index: t,
    prospects,
    shown_ids,
    hidden_ids
  };
}

function applyProspectsDecision(state: RunState, ctx: TurnContext, decisions: TurnDecisions, prospectsLog: ProspectsLogEvent[]): void {
  const anyDecisions: any = decisions as any;
  const pd: any = anyDecisions.prospects;
  if (!pd || typeof pd !== "object" || pd.kind !== "prospects") return;
  const actions: any[] = Array.isArray(pd.actions) ? pd.actions : [];
  if (actions.length === 0) return;

  const active = readActiveProspects(state);
  let activeList = active.slice();
  const activeSet = new Set(activeList.map((r) => r.id));

  const windowProspects = ctx.prospects_window?.prospects ?? [];
  const byId = new Map(windowProspects.map((p) => [p.id, p] as const));

  const processed = new Set<string>();

  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const pid = (a as any).prospect_id;
    const act = (a as any).action;
    if (typeof pid !== "string" || (act !== "accept" && act !== "reject")) continue;
    if (processed.has(pid)) continue;
    if (!activeSet.has(pid)) continue;

    const prospect = byId.get(pid) ?? lookupProspectFromHistory(state, pid);
    if (!prospect) continue;

    let effectiveAct: "accept" | "reject" = act;

    // v0.2.5 LOCK: same-sex marriage is disabled. Enforce at apply-time for safety/legacy states.
    if (effectiveAct === "accept" && prospect.type === "marriage") {
      const sid: any = (prospect as any).subject_person_id;
      const spouseId: any = (prospect as any).spouse_person_id;
      const anyState: any = state as any;
      const reg: Record<string, Person> | undefined = anyState.people as any;
      const subj = sid && reg ? reg[sid] : null;
      const sp = spouseId && reg ? reg[spouseId] : null;
      if (subj && sp && subj.sex === sp.sex) {
        effectiveAct = "reject";
      }
    }

    const applied: any = {};

    function applyRelationshipDeltas(): void {
      const rds: any[] | undefined = (prospect as any).predicted_effects?.relationship_deltas;
      if (!Array.isArray(rds) || rds.length === 0) return;
      for (const rd of rds) {
        if (!rd || typeof rd !== "object") continue;
        const from = (rd as any).from_id;
        const to = (rd as any).to_id;
        if (typeof from !== "string" || typeof to !== "string") continue;
        adjustEdge(state, from, to, {
          allegiance: Math.trunc((rd as any).allegiance_delta ?? 0),
          respect: Math.trunc((rd as any).respect_delta ?? 0),
          threat: Math.trunc((rd as any).threat_delta ?? 0)
        });
      }
      applied.relationship_deltas = rds;
    }

    if (effectiveAct === "accept") {
      const cd = (prospect as any).predicted_effects?.coin_delta;
      if (typeof cd === "number" && Number.isFinite(cd)) {
        const d = Math.trunc(cd);
        if (d >= 0) state.manor.coin = asNonNegInt(state.manor.coin + d);
        else state.manor.coin = asNonNegInt(state.manor.coin - Math.abs(d));
        applied.coin_delta = d;
      }

      applyRelationshipDeltas();

      const fs: any[] | undefined = (prospect as any).predicted_effects?.flags_set;
      if (Array.isArray(fs) && fs.length > 0) {
        const anyFlags: any = state.flags;
        const appliedFlags: string[] = [];
        for (const f of fs) {
          if (typeof f === "string" && f.length > 0) {
            anyFlags[f] = true;
            appliedFlags.push(f);
          }
        }
        if (appliedFlags.length > 0) applied.flags_set = appliedFlags;
      }

      if (prospect.type === "marriage" && prospect.subject_person_id) {
        const sid = prospect.subject_person_id;
        // People-First registry
        const anyState: any = state as any;
        if (anyState.people && anyState.people[sid]) {
          anyState.people[sid].married = true;
        }
        // legacy household
        if (state.house.head.id === sid) state.house.head.married = true;
        if (state.house.spouse && state.house.spouse.id === sid) state.house.spouse.married = true;
        for (const c of state.house.children) {
          if (c.id === sid) c.married = true;
        }

        const spouseId: any = (prospect as any).spouse_person_id;
        if (typeof spouseId === "string" && spouseId.length > 0 && spouseId !== sid) {
          if (anyState.people && anyState.people[spouseId]) {
            anyState.people[spouseId].married = true;
          }
        }

        // v0.2.5 marriage residence LOCK:
        // - Daughters marry out (leave the household court).
        // - Sons marry in only if they are the heir / eldest son; otherwise they also marry out.
        const heirId = state.house.heir_id ?? null;
        const eldestSonId =
          [...state.house.children]
            .filter((c) => c.alive && c.sex === "M")
            .sort((a, b) => {
              if (b.age !== a.age) return b.age - a.age;
              return a.id.localeCompare(b.id);
            })[0]?.id ?? null;

        const subjectChild = state.house.children.find((c) => c.id === sid) ?? null;
        const spouseJoinsCourt =
          Boolean(subjectChild) && subjectChild!.sex === "M" && (sid === heirId || sid === eldestSonId);

        if (spouseJoinsCourt && typeof spouseId === "string" && spouseId.length > 0 && spouseId !== sid) {
          addCourtExtraId(state, spouseId);
        } else if (subjectChild) {
          const idx2 = state.house.children.findIndex((c) => c.id === sid);
          if (idx2 >= 0) state.house.children.splice(idx2, 1);
        }
      }

      prospectsLog.push({
        kind: "prospect_accepted",
        turn_index: state.turn_index,
        type: prospect.type,
        from_house_id: prospect.from_house_id,
        to_house_id: prospect.to_house_id,
        subject_person_id: prospect.subject_person_id,
        prospect_id: prospect.id,
        effects_applied: applied
      });
    } else if (effectiveAct === "reject") {
      // v0.2.3.4 correctness: predicted_effects are acceptance effects; rejecting is a no-op (unless a future
      // prospect type models explicit rejection penalties).

      prospectsLog.push({
        kind: "prospect_rejected",
        turn_index: state.turn_index,
        type: prospect.type,
        from_house_id: prospect.from_house_id,
        to_house_id: prospect.to_house_id,
        subject_person_id: prospect.subject_person_id,
        prospect_id: prospect.id,
        effects_applied: applied
      });
    }

    // remove from active list (decided)
    activeList = activeList.filter((r) => r.id !== pid);
    activeSet.delete(pid);
    processed.add(pid);
  }

  writeActiveProspects(state, activeList);
}

function applyEvents(state: RunState): EventResult[] {
  const t = state.turn_index;
  const rng = new Rng(state.run_seed, "events", t, "select");
  const cd = cooldownsObj(state);

  const k = chooseEventCount(rng.fork("count"));
  if (k === 0) return [];

  const eligible: Array<{ def: typeof EVENT_DECK[number]; weight: number; notes: string[] }> = [];
  for (const def of EVENT_DECK) {
    if (cd[def.id]) continue;
    const { weight, notes } = def.getWeight(state);
    if (weight > 0) eligible.push({ def, weight, notes });
  }
  if (eligible.length === 0) return [];

  const picked: typeof eligible = [];
  const local = eligible.slice();
  const results: EventResult[] = [];

  for (let i = 0; i < k && local.length > 0; i++) {
    const items = local.map((x) => ({ item: x, weight: x.weight }));
    const pick = weightedPick(rng.fork(`pick${i}`), items);
    const idx = local.findIndex((x) => x === pick.picked);
    const chosen = local.splice(idx, 1)[0]!;
    picked.push(chosen);

    // Apply and log deltas
    const before = {
      bushels: state.manor.bushels_stored,
      coin: state.manor.coin,
      unrest: state.manor.unrest,
      population: state.manor.population,
      tax_due_coin: state.manor.obligations.tax_due_coin,
      tithe_due_bushels: state.manor.obligations.tithe_due_bushels,
      arrears_coin: state.manor.obligations.arrears.coin,
      arrears_bushels: state.manor.obligations.arrears.bushels,
      construction_progress: state.manor.construction ? state.manor.construction.progress : 0
    };

    const effects = chosen.def.apply(state, rng.fork(`apply:${chosen.def.id}`));

    const after = {
      bushels: state.manor.bushels_stored,
      coin: state.manor.coin,
      unrest: state.manor.unrest,
      population: state.manor.population,
      tax_due_coin: state.manor.obligations.tax_due_coin,
      tithe_due_bushels: state.manor.obligations.tithe_due_bushels,
      arrears_coin: state.manor.obligations.arrears.coin,
      arrears_bushels: state.manor.obligations.arrears.bushels,
      construction_progress: state.manor.construction ? state.manor.construction.progress : 0
    };

    const deltas = (Object.keys(before) as Array<keyof typeof before>).map((k2) => ({
      key: k2 as any,
      before: before[k2],
      after: after[k2],
      diff: after[k2] - before[k2]
    })).filter((d) => d.diff !== 0);

    // set cooldown
    cd[chosen.def.id] = chosen.def.cooldown;

    results.push({
      id: chosen.def.id,
      title: chosen.def.title,
      category: chosen.def.category,
      why: {
        weight: chosen.weight,
        roll: pick.roll,
        notes: [
          `Selected from ${eligible.length} eligible events (cap=2).`,
          `Weight≈${chosen.weight.toFixed(2)} (relative p≈${(chosen.weight / pick.total).toFixed(2)}).`,
          `State@trigger: bushels=${before.bushels}, coin=${before.coin}, unrest=${before.unrest}, pop=${before.population}, arrears_coin=${before.arrears_coin}, arrears_bushels=${before.arrears_bushels}.`,
          `Cooldown: ${chosen.def.cooldown} turns.`,
          ...chosen.notes
        ]
      },
      effects,
      deltas
    });
  }

  return results;
}

function computeTopDrivers(report: TurnReport, before: RunState, after: RunState): string[] {
  const drivers: Array<{ label: string; score: number; text: string }> = [];

  const bushelDiff = after.manor.bushels_stored - before.manor.bushels_stored;
  const unrestDiff = after.manor.unrest - before.manor.unrest;
  const coinDiff = after.manor.coin - before.manor.coin;
  const arrearsCoinDiff = after.manor.obligations.arrears.coin - before.manor.obligations.arrears.coin;
  const arrearsBushelDiff = after.manor.obligations.arrears.bushels - before.manor.obligations.arrears.bushels;

  drivers.push({
    label: "Food",
    score: Math.abs(bushelDiff),
    text: `Food: prod +${report.production_bushels}, cons -${report.consumption_bushels}, spoil -${report.spoilage.loss_bushels}, net ${bushelDiff >= 0 ? "+" : ""}${bushelDiff}.`
  });
  drivers.push({
    label: "Unrest",
    score: Math.abs(unrestDiff),
    text: `Unrest: net ${unrestDiff >= 0 ? "+" : ""}${unrestDiff} (threshold dispossession at 100).`
  });
  drivers.push({
    label: "Obligations",
    score: Math.abs(arrearsCoinDiff) * 20 + Math.abs(arrearsBushelDiff),
    text: `Obligations: tax due ${report.obligations.tax_due_coin}, tithe due ${report.obligations.tithe_due_bushels}, arrears Δ coin ${arrearsCoinDiff >= 0 ? "+" : ""}${arrearsCoinDiff}, bushels ${arrearsBushelDiff >= 0 ? "+" : ""}${arrearsBushelDiff}.`
  });
  drivers.push({
    label: "Coin",
    score: Math.abs(coinDiff),
    text: `Coin: net ${coinDiff >= 0 ? "+" : ""}${coinDiff}.`
  });
  drivers.sort((a, b) => b.score - a.score);
  return drivers.slice(0, 3).map((d) => d.text);
}

export function proposeTurn(state: RunState): TurnContext {
  // v0.2.1 migration/sync (must accept v0.1.0-shaped saves)
  // NOTE: proposeTurn must not mutate caller state; we do this on a working copy below.
  if (state.game_over) {
    return {
      preview_state: deepCopy(state),
      report: {
        turn_index: state.turn_index,
        weather_multiplier: 1,
        market: { price_per_bushel: 0.1, sell_cap_bushels: 0 },
        spoilage: { rate: 0, loss_bushels: 0 },
        production_bushels: 0,
        consumption_bushels: 0,
        peasant_consumption_bushels: 0,
        court_consumption_bushels: 0,
        total_consumption_bushels: 0,
        shortage_bushels: 0,
        construction: { progress_added: 0, completed_improvement_id: null },
        obligations: {
          tax_due_coin: state.manor.obligations.tax_due_coin,
          tithe_due_bushels: state.manor.obligations.tithe_due_bushels,
          arrears_coin: state.manor.obligations.arrears.coin,
          arrears_bushels: state.manor.obligations.arrears.bushels,
          war_levy_due: state.manor.obligations.war_levy_due
        },
        household: { births: [], deaths: [], population_delta: 0 },
        house_log: [],
        events: [],
        top_drivers: ["Game over."],
        notes: []
      },
      marriage_window: null,
      max_labor_shift: 0
    };
  }

  const working = deepCopy(state as any) as RunState;
  ensurePeopleFirst(working);
  ensureExternalHousesSeed_v0_2_2(working);
  // v0.2.4: deterministic court officers (idempotent; stream-isolated).
  ensureCourtOfficers(working);

  const houseLog: HouseLogEvent[] = [];

  // v0.2.3.2: structured delta trackers (UI support; no mechanics).
  const unrestBefore = working.manor.unrest;
  let unrestCursor = unrestBefore;
  const unrestContribs: Array<{ label: string; diff: number }> = [];

  // Track the most recent labor auto-clamp (for UX messaging).
  let laborSignalBefore: { population: number; farmers: number; builders: number } | null = null;
  let laborSignalAfter: { population: number; farmers: number; builders: number } | null = null;

  // v0.2.3.4: If labor is oversubscribed entering the turn (edited/legacy state),
  // clamp immediately *before* production/consumption math so the simulation runs on valid labor totals.
  // NOTE: This preserves determinism for valid runs (oversubscription should never occur in normal play).
  {
    const pop0 = asNonNegInt(working.manor.population);
    const f0 = asNonNegInt(working.manor.farmers);
    const b0 = asNonNegInt(working.manor.builders);
    if (f0 + b0 > pop0) {
      laborSignalBefore = { population: pop0, farmers: f0, builders: b0 };
      const overflow = f0 + b0 - pop0;
      // Deterministic clamp rule: cut builders first, then farmers (same as shortage clamp).
      const bCut = Math.min(b0, overflow);
      const b1 = asNonNegInt(b0 - bCut);
      const rem = overflow - bCut;
      const f1 = rem > 0 ? asNonNegInt(Math.max(0, f0 - rem)) : f0;
      working.manor.farmers = f1;
      working.manor.builders = b1;
      laborSignalAfter = { population: pop0, farmers: f1, builders: b1 };
    }
  }

  // 1) restore energy; compute heir
  working.house.energy.available = working.house.energy.max;
  const prevHeir = working.house.heir_id ?? null;
  const nextHeir = computeHeirId(working);
  if (nextHeir && nextHeir !== prevHeir) {
    const heirName = working.house.children.find((c) => c.id === nextHeir)?.name;
    if (heirName) houseLog.push({ kind: "heir_selected", turn_index: working.turn_index, heir_name: heirName });
  }

  // 2) macro env shift
  decrementCooldowns(working);
  const spoil = applySpoilage(working);
  const macro = computeWeatherMarket(working);

  // 3) production (+ construction progress)
  const prod = applyProductionAndConstruction(working, macro.weather_multiplier);

  // 4) obligations
  const unrestBeforeObl = working.manor.unrest;
  applyObligationsAndArrearsPenalty(working, prod.production_bushels);
  {
    const diff = working.manor.unrest - unrestBeforeObl;
    if (diff !== 0) unrestContribs.push({ label: "Arrears", diff });
    unrestCursor = working.manor.unrest;
  }

  // 5) relationship drift
  relationshipDrift(working);

  // 6) household (births/deaths)
  const hh = householdPhase(working, houseLog);

  // v0.2.3.4: Recompute heir after births/deaths so the report/roster never points at a deceased heir.
  {
    const prev = working.house.heir_id ?? null;
    const next = computeHeirId(working);
    if (next && next !== prev) {
      const heirName = working.house.children.find((c) => c.id === next)?.name;
      if (heirName) houseLog.push({ kind: "heir_selected", turn_index: working.turn_index, heir_name: heirName });
    }
  }

  // 7) court size/consumption (v0.2.4)
  const court = courtConsumptionBushels_v0_2_4(working, BUSHELS_PER_PERSON_PER_YEAR, TURN_YEARS);

  // 8) consumption (peasants + court)
  const cons = applyConsumptionAndShortage(working, court.court_consumption_bushels);

  // Unrest contributor: shortage.
  {
    const diff = working.manor.unrest - unrestCursor;
    if (diff !== 0) unrestContribs.push({ label: "Shortage", diff });
    unrestCursor = working.manor.unrest;
  }

  // Labor auto-clamp (from shortage population loss).
  if (cons.labor_before && cons.labor_after) {
    laborSignalBefore = cons.labor_before;
    laborSignalAfter = cons.labor_after;
  }

  // 9) event engine (independent)
  const events = applyEvents(working);

  // Unrest contributors: events.
  for (const ev of events) {
    const d = ev.deltas.find((x) => x.key === "unrest");
    if (d && d.diff !== 0) unrestContribs.push({ label: ev.title, diff: d.diff });
  }

  // Normalize/clamp state invariants.
  // Capture labor auto-clamp here as well (e.g., event-driven population loss).
  const laborBeforeNorm = {
    population: asNonNegInt(working.manor.population),
    farmers: asNonNegInt(working.manor.farmers),
    builders: asNonNegInt(working.manor.builders)
  };
  normalizeState(working);
  const laborAfterNorm = {
    population: asNonNegInt(working.manor.population),
    farmers: asNonNegInt(working.manor.farmers),
    builders: asNonNegInt(working.manor.builders)
  };
  if (laborBeforeNorm.farmers !== laborAfterNorm.farmers || laborBeforeNorm.builders !== laborAfterNorm.builders) {
    laborSignalBefore = laborBeforeNorm;
    laborSignalAfter = laborAfterNorm;
  }

  const report: TurnReport = {
    turn_index: state.turn_index,
    weather_multiplier: macro.weather_multiplier,
    market: macro.market,
    spoilage: spoil,
    production_bushels: prod.production_bushels,
    consumption_bushels: cons.consumption_bushels,
    peasant_consumption_bushels: cons.peasant_consumption_bushels,
    court_consumption_bushels: cons.court_consumption_bushels,
    total_consumption_bushels: cons.total_consumption_bushels,
    shortage_bushels: cons.shortage_bushels,
    construction: { progress_added: prod.construction_progress_added, completed_improvement_id: prod.completed_improvement_id ?? null },
    obligations: {
      tax_due_coin: working.manor.obligations.tax_due_coin,
      tithe_due_bushels: working.manor.obligations.tithe_due_bushels,
      arrears_coin: working.manor.obligations.arrears.coin,
      arrears_bushels: working.manor.obligations.arrears.bushels,
      war_levy_due: working.manor.obligations.war_levy_due
    },
    household: {
      births: hh.births,
      deaths: hh.deaths,
      population_delta: cons.population_delta + hh.population_delta,
      // v0.2.5: make labor-pool changes visible (runaways vs deaths).
      population_change_breakdown: {
        schema_version: "population_change_breakdown_v1",
        births: Math.max(0, hh.population_delta),
        deaths: asNonNegInt(cons.population_deaths),
        runaways: asNonNegInt(cons.population_runaways)
      }
    },
    house_log: houseLog,
    events,
    top_drivers: [],
    notes: []
  };

  report.top_drivers = computeTopDrivers(report, state, working);

  // v0.2.3.2: labor oversubscription auto-clamp signal (UI).
  if (laborSignalBefore && laborSignalAfter) {
    const assigned_before = asNonNegInt(laborSignalBefore.farmers) + asNonNegInt(laborSignalBefore.builders);
    const assigned_after = asNonNegInt(laborSignalAfter.farmers) + asNonNegInt(laborSignalAfter.builders);
    const available = asNonNegInt(laborSignalAfter.population);
    report.labor_signal = {
      schema_version: "labor_signal_v1",
      available,
      assigned_before,
      assigned_after,
      farmers_before: asNonNegInt(laborSignalBefore.farmers),
      farmers_after: asNonNegInt(laborSignalAfter.farmers),
      builders_before: asNonNegInt(laborSignalBefore.builders),
      builders_after: asNonNegInt(laborSignalAfter.builders),
      was_oversubscribed: assigned_before > available,
      auto_clamped:
        laborSignalBefore.farmers !== laborSignalAfter.farmers || laborSignalBefore.builders !== laborSignalAfter.builders
    };
  }

  // v0.2.3.2: unrest delta breakdown (contributors up/down).
  const unrestAfter = working.manor.unrest;
  report.unrest_breakdown = {
    schema_version: "unrest_breakdown_v1",
    before: unrestBefore,
    after: unrestAfter,
    delta: unrestAfter - unrestBefore,
    increased_by: unrestContribs.filter((c) => c.diff > 0).map((c) => ({ label: c.label, amount: c.diff })),
    decreased_by: unrestContribs.filter((c) => c.diff < 0).map((c) => ({ label: c.label, amount: Math.abs(c.diff) }))
  };

  // v0.2.3.2: construction option availability (built / in-progress / available).
  report.construction.options = Object.keys(IMPROVEMENTS)
    .sort((a, b) => {
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    })
    .map((improvement_id) => {
      const isBuilt = hasImprovement(working.manor.improvements, improvement_id);
      const isActive = Boolean(working.manor.construction) && working.manor.construction?.improvement_id === improvement_id;
      const status = isBuilt ? "built" : isActive ? "active_project" : "available";
      return { improvement_id, status };
    });

  const marriageWindow = buildMarriageWindow(working);

  // Prospects window + engine log (v0.2.3)
  const prospectsLog: ProspectsLogEvent[] = [];
  const prospectsWindow = buildProspectsWindow_v0_2_3(working, marriageWindow, prospectsLog);
  if (prospectsLog.length) report.prospects_log = prospectsLog;

  const maxShift = maxLaborDeltaPerTurn(working.manor.population);

  // Ensure registries remain in sync after preview simulation.
  ensurePeopleFirst(working);

  const roster = buildHouseholdRoster_v0_2_3_2(working);
  // v0.2.3.4: embed roster into the Turn Report so history views don't have to reconstruct it (dedupe + death badges).
  report.household_roster = roster;

  // v0.2.4: embed court roster + headcount into report for history-safe rendering.
  report.court_roster = court.court_roster;
  report.court_headcount = court.court_headcount;

  return {
    preview_state: working,
    report,
    marriage_window: marriageWindow,
    prospects_window: prospectsWindow,
    max_labor_shift: maxShift,
    household_roster: roster,
    court_roster: court.court_roster
  };
}

function payCoin(state: RunState, amount: number): number {
  const pay = Math.min(state.manor.coin, Math.max(0, Math.trunc(amount)));
  state.manor.coin = asNonNegInt(state.manor.coin - pay);
  return pay;
}
function payBushels(state: RunState, amount: number): number {
  const pay = Math.min(state.manor.bushels_stored, Math.max(0, Math.trunc(amount)));
  state.manor.bushels_stored = asNonNegInt(state.manor.bushels_stored - pay);
  return pay;
}

function applyObligationPaymentsAndPenalties(state: RunState, decisions: TurnDecisions, reportNotes: string[]): void {
  const ob = state.manor.obligations;

  // Pay arrears first
  let coinPay = payCoin(state, decisions.obligations.pay_coin);
  let bushelPay = payBushels(state, decisions.obligations.pay_bushels);

  // Apply to arrears
  const arrearsCoinBefore = ob.arrears.coin;
  const arrearsBushelsBefore = ob.arrears.bushels;
  const toArrearsCoin = Math.min(ob.arrears.coin, coinPay);
  ob.arrears.coin = asNonNegInt(ob.arrears.coin - toArrearsCoin);
  coinPay = asNonNegInt(coinPay - toArrearsCoin);

  const toArrearsBushels = Math.min(ob.arrears.bushels, bushelPay);
  ob.arrears.bushels = asNonNegInt(ob.arrears.bushels - toArrearsBushels);
  bushelPay = asNonNegInt(bushelPay - toArrearsBushels);

  // Then apply to current dues (any remaining pay after arrears)
  const toTax = Math.min(ob.tax_due_coin, coinPay);
  ob.tax_due_coin = asNonNegInt(ob.tax_due_coin - toTax);
  coinPay = asNonNegInt(coinPay - toTax);

  const toTithe = Math.min(ob.tithe_due_bushels, bushelPay);
  ob.tithe_due_bushels = asNonNegInt(ob.tithe_due_bushels - toTithe);
  bushelPay = asNonNegInt(bushelPay - toTithe);

  if (arrearsCoinBefore > 0 || arrearsBushelsBefore > 0) {
    reportNotes.push(`Paid arrears: coin -${toArrearsCoin}, bushels -${toArrearsBushels}.`);
  }
  if (toTax > 0 || toTithe > 0) {
    reportNotes.push(`Paid current dues: tax -${toTax} coin, tithe -${toTithe} bushels.`);
  }

  // War levy handling (WP-07 auto fallback)
  if (ob.war_levy_due && ob.war_levy_due.kind === "men_or_coin") {
    const levy = ob.war_levy_due;
    const choice = decisions.obligations.war_levy_choice ?? "ignore";
    if (choice === "men") {
      // men reduces farmers next turn
      const mods = modsObj(state);
      mods["farmer_penalty"] = (mods["farmer_penalty"] ?? 0) + levy.men;
      ob.war_levy_due = null;
      adjustEdge(state, state.locals.liege.id, state.house.head.id, { respect: +2, threat: -2 });
      reportNotes.push(`War levy answered with men: -${levy.men} effective farmers next turn.`);
    } else if (choice === "coin") {
      const paid = payCoin(state, levy.coin);
      const remaining = levy.coin - paid;
      if (remaining <= 0) {
        ob.war_levy_due = null;
        adjustEdge(state, state.locals.liege.id, state.house.head.id, { respect: +2, threat: -2 });
        reportNotes.push(`War levy paid in coin: -${levy.coin} coin.`);
      } else {
        // fallback to men proportional to remaining coin
        const menNeeded = Math.ceil(levy.men * (remaining / levy.coin));
        const availableMen = Math.max(0, state.manor.farmers); // simplistic availability
        if (availableMen >= menNeeded) {
          const mods = modsObj(state);
          mods["farmer_penalty"] = (mods["farmer_penalty"] ?? 0) + menNeeded;
          ob.war_levy_due = null;
          adjustEdge(state, state.locals.liege.id, state.house.head.id, { respect: +1, threat: -1 });
          reportNotes.push(`War levy coin shortfall: paid ${paid}/${levy.coin} coin; covered remainder with men (-${menNeeded} effective farmers next turn).`);
        } else {
          // refusal
          adjustEdge(state, state.locals.liege.id, state.house.head.id, { respect: -4, threat: +6 });
          reportNotes.push(`War levy NOT met: paid ${paid}/${levy.coin} coin; insufficient men. Liege anger rises.`);
        }
      }
    } else {
      // ignore => refusal
      adjustEdge(state, state.locals.liege.id, state.house.head.id, { respect: -3, threat: +5 });
      reportNotes.push("War levy ignored; liege displeased.");
    }
  }
}

function applyConstructionDecision(state: RunState, decisions: TurnDecisions, reportNotes: string[]): void {
  const d = decisions.construction;
  if (d.action === "none") return;

  if (d.action === "abandon") {
    if (!state.manor.construction) return;
    if (!d.confirm) {
      reportNotes.push("Abandon project canceled.");
      return;
    }
    // WP-06: abandon is lossy; progress lost; coin not refunded.
    state.manor.construction = null;
    reportNotes.push("Project abandoned; progress lost and coin not refunded.");
    return;
  }

  if (d.action === "start") {
    // disallow selecting a new project if one is active (WP-06)
    if (state.manor.construction) {
      reportNotes.push("Cannot start a new project while construction is active. Abandon first.");
      return;
    }
    const def = IMPROVEMENTS[d.improvement_id];
    if (!def) {
      reportNotes.push("Invalid improvement selection.");
      return;
    }
    if (state.manor.improvements.includes(def.id)) {
      reportNotes.push("Improvement already completed.");
      return;
    }
    if (state.manor.coin < def.coin_cost) {
      reportNotes.push("Insufficient coin to start project.");
      return;
    }
    if (state.house.energy.available < def.energy_cost) {
      reportNotes.push("Insufficient energy to start project.");
      return;
    }
    state.manor.coin = asNonNegInt(state.manor.coin - def.coin_cost);
    state.house.energy.available = clampInt(state.house.energy.available - def.energy_cost, 0, state.house.energy.max);
    state.manor.construction = { improvement_id: def.id, progress: 0, required: def.required };
    reportNotes.push(`Started construction: ${def.name} (cost ${def.coin_cost} coin).`);
  }
}

function applyMarriageDecision(state: RunState, ctx: TurnContext, decisions: TurnDecisions, reportNotes: string[]): void {
  const mw = ctx.marriage_window;
  const d = decisions.marriage;
  if (!mw) return;
  if (d.action === "none") return;

  // energy cost (simple)
  if (state.house.energy.available <= 0) {
    reportNotes.push("No energy for marriage action.");
    return;
  }

  if (d.action === "scout") {
    state.house.energy.available = clampInt(state.house.energy.available - 1, 0, state.house.energy.max);
    // small coin cost for scouting
    if (state.manor.coin > 0) state.manor.coin -= 1;
    // set a flag to slightly improve next offer quality (implemented as mod)
    const mods = modsObj(state);
    mods["marriage_quality"] = (mods["marriage_quality"] ?? 1) * 1.05;
    reportNotes.push("Scouted prospects; next marriage window slightly improved.");
    return;
  }

  if (d.action === "reject_all") {
    state.house.energy.available = clampInt(state.house.energy.available - 1, 0, state.house.energy.max);
    // small social penalty: unrest +1
    state.manor.unrest = clampInt(state.manor.unrest + 1, 0, 100);
    reportNotes.push("Rejected all offers; slight social friction (+1 unrest).");
    return;
  }

  if (d.action === "accept") {
    const child = state.house.children.find((c) => c.id === d.child_id);
    const offer = mw.offers[d.offer_index];
    if (!child || !offer) {
      reportNotes.push("Invalid marriage selection.");
      return;
    }

    // v0.2.5 LOCK: same-sex marriage is disabled.
    // Offers are generated to avoid this, but enforce at accept-time for safety/legacy states.
    {
      const anyState: any = state as any;
      const reg: Record<string, Person> | undefined = anyState.people as any;
      const spousePerson = reg ? reg[offer.house_person_id] : null;
      if (spousePerson && spousePerson.sex === child.sex) {
        reportNotes.push("Cannot accept: same-sex marriage is disallowed.");
        return;
      }
    }

    const dowry = offer.dowry_coin_net;

    // Must-fix: negative dowry requires sufficient coin; do not silently proceed.
    if (dowry < 0 && state.manor.coin < Math.abs(dowry)) {
      reportNotes.push("Cannot accept: insufficient coin for negative dowry.");
      return;
    }

    state.house.energy.available = clampInt(state.house.energy.available - 1, 0, state.house.energy.max);

    // Apply dowry
    if (dowry >= 0) state.manor.coin = asNonNegInt(state.manor.coin + dowry);
    else state.manor.coin = asNonNegInt(state.manor.coin - Math.abs(dowry));

    // Mark married
    child.married = true;

    // People-First registry mirror (prevents later sync overwrites in hybrid runs).
    {
      const anyState: any = state as any;
      if (anyState.people && anyState.people[child.id]) anyState.people[child.id].married = true;
      if (anyState.people && anyState.people[offer.house_person_id]) anyState.people[offer.house_person_id].married = true;
    }

    // v0.2.5 marriage residence LOCK:
    // - Daughters marry out (leave the household court).
    // - Sons marry in only if they are the heir / eldest son; otherwise they also marry out.
    const heirId = state.house.heir_id ?? null;
    const eldestSonId =
      [...state.house.children]
        .filter((c) => c.alive && c.sex === "M")
        .sort((a, b) => {
          if (b.age !== a.age) return b.age - a.age;
          return a.id.localeCompare(b.id);
        })[0]?.id ?? null;

    const spouseJoinsCourt = child.sex === "M" && (child.id === heirId || child.id === eldestSonId);

    if (spouseJoinsCourt) {
      addCourtExtraId(state, offer.house_person_id);
    } else {
      const idx = state.house.children.findIndex((c) => c.id === child.id);
      if (idx >= 0) state.house.children.splice(idx, 1);
    }

    // Relationship deltas (to offering house + sometimes liege)
    adjustEdge(state, state.house.head.id, offer.house_person_id, offer.relationship_delta);
    if (offer.liege_delta) {
      adjustEdge(state, state.house.head.id, state.locals.liege.id, { respect: offer.liege_delta.respect, threat: offer.liege_delta.threat });
    }

    // Set flag increasing birth chance slightly
    const mods = modsObj(state);
    mods["birth_bonus"] = (mods["birth_bonus"] ?? 1) * 1.03;

    reportNotes.push(`Marriage accepted for ${child.name}: dowry ${dowry >= 0 ? "+" : ""}${dowry} coin.`);
  }
}

function applyLaborDecision(state: RunState, decisions: TurnDecisions, maxShift: number, reportNotes: string[]): void {
  const desiredFarmers = Math.max(0, Math.trunc(decisions.labor.desired_farmers));
  const desiredBuilders = Math.max(0, Math.trunc(decisions.labor.desired_builders));

  if (desiredFarmers + desiredBuilders > state.manor.population) {
    reportNotes.push("Labor plan invalid (exceeds population); no change applied.");
    return;
  }

  const curF = state.manor.farmers;
  const curB = state.manor.builders;

  const dF = Math.abs(desiredFarmers - curF);
  const dB = Math.abs(desiredBuilders - curB);
  const totalShift = dF + dB;

  // v0.2.3.2: If the current state is oversubscribed (legacy save / earlier bug),
  // allow rebalancing without being blocked by the per-turn labor delta cap.
  const oversubscribedNow = curF + curB > state.manor.population;

  if (!oversubscribedNow && totalShift > maxShift) {
    reportNotes.push(`Labor change exceeds cap (max ${maxShift}); no change applied.`);
    return;
  }
  // Intentionally no note: the UI can show structured labor warnings via report.labor_signal.

  // energy cost if any change
  if (totalShift > 0) {
    if (state.house.energy.available <= 0) {
      reportNotes.push("No energy for labor plan; no change applied.");
      return;
    }
    state.house.energy.available = clampInt(state.house.energy.available - 1, 0, state.house.energy.max);
  }

  state.manor.farmers = clampInt(desiredFarmers, 0, state.manor.population);
  state.manor.builders = clampInt(desiredBuilders, 0, state.manor.population);
  reportNotes.push(`Labor plan set (takes effect next turn's production): farmers ${state.manor.farmers}, builders ${state.manor.builders}.`);
}

function applySellDecision(state: RunState, ctx: TurnContext, decisions: TurnDecisions, reportNotes: string[]): void {
  const sell = Math.max(0, Math.trunc(decisions.sell.sell_bushels));
  if (sell <= 0) return;
  if (state.house.energy.available <= 0) {
    reportNotes.push("No energy to sell.");
    return;
  }
  const cap = ctx.report.market.sell_cap_bushels;
  const allowed = Math.min(cap, sell);
  const sold = Math.min(state.manor.bushels_stored, allowed);
  state.manor.bushels_stored = asNonNegInt(state.manor.bushels_stored - sold);
  const earned = Math.floor(sold * ctx.report.market.price_per_bushel);
  state.manor.coin = asNonNegInt(state.manor.coin + earned);
  state.house.energy.available = clampInt(state.house.energy.available - 1, 0, state.house.energy.max);

  reportNotes.push(`Sold ${sold} bushels (cap ${cap}) for +${earned} coin at ${ctx.report.market.price_per_bushel.toFixed(2)}/bushel.`);
  if (sell > allowed) reportNotes.push("Sell amount trimmed to market cap.");
}

function closeTurn(state: RunState, reportNotes: string[], houseLog: HouseLogEvent[]): void {
  const ob = state.manor.obligations;

  // move any unpaid due into arrears (end-of-turn)
  if (ob.tax_due_coin > 0) ob.arrears.coin = asNonNegInt(ob.arrears.coin + ob.tax_due_coin);
  if (ob.tithe_due_bushels > 0) ob.arrears.bushels = asNonNegInt(ob.arrears.bushels + ob.tithe_due_bushels);
  ob.tax_due_coin = 0;
  ob.tithe_due_bushels = 0;

  // relationship reaction to compliance
  if (ob.arrears.coin === 0) {
    adjustEdge(state, state.locals.liege.id, state.house.head.id, { respect: +1, threat: -1 });
  } else {
    adjustEdge(state, state.locals.liege.id, state.house.head.id, { respect: -1, threat: +1 });
  }
  if (ob.arrears.bushels === 0) {
    adjustEdge(state, state.locals.clergy.id, state.house.head.id, { respect: +1 });
  } else {
    adjustEdge(state, state.locals.clergy.id, state.house.head.id, { respect: -1, threat: +1 });
  }

  // mild unrest decay when stable
  const shortage = Boolean((state.flags as any).Shortage);
  if (!shortage && ob.arrears.coin === 0 && ob.arrears.bushels === 0) {
    state.manor.unrest = clampInt(state.manor.unrest - UNREST_BASELINE_DECAY_WHEN_STABLE, 0, 100);
  }

  // clear transient flags
  delete (state.flags as any).Shortage;
  delete (state.flags as any).MarriageOffer;

  // succession (minimal)
  if (!state.house.head.alive) {
    const heirId = computeHeirId(state);
    if (!heirId) {
      state.game_over = { reason: "DeathNoHeir", turn_index: state.turn_index };
      return;
    }
    const idx = state.house.children.findIndex((c) => c.id === heirId);
    const heir = state.house.children.splice(idx, 1)[0]!;
    heir.married = true; // assume household continuity
    state.house.head = heir;

    if (state.house.spouse) {
      // Status only (Widow/Widower) — the widowed life log is emitted at the moment of death
      // inside householdPhase (v0.2.3.2).
      state.house.spouse_status = "widow";
    }

    // Structured People-First life log events
    houseLog.push({ kind: "succession", turn_index: state.turn_index, new_ruler_name: heir.name });

    // Heir selection after succession (same turn) — keep deterministic.
    const prev = state.house.heir_id ?? null;
    const next = computeHeirId(state);
    if (next && next !== prev) {
      const nm = state.house.children.find((c) => c.id === next)?.name;
      if (nm) houseLog.push({ kind: "heir_selected", turn_index: state.turn_index, heir_name: nm });
    }

    reportNotes.push(`Succession resolved.`);
  }

  // game-over: dispossession rule
  if (state.manor.unrest >= 100) {
    state.game_over = { reason: "Dispossessed", turn_index: state.turn_index, details: { unrest: state.manor.unrest } };
    return;
  }

  // advance turn
  state.turn_index += 1;
}

export function applyDecisions(state: RunState, decisions: TurnDecisions): RunState {
  if (state.game_over) return state;

  // Defensive People-First migration for legacy saves.
  // applyDecisions may be called on a v0.1.0-shaped RunState; migrate deterministically before proceeding.
  const anyState: any = state as any;
  const needsMigration = !(anyState && anyState.people && anyState.houses && anyState.player_house_id);
  const base: RunState = needsMigration ? (deepCopy(state as any) as RunState) : state;
  if (needsMigration) ensurePeopleFirst(base);

  const snapshotBefore = boundedSnapshot(base);

  // Defensive migration: if an older save/log entry ever contained full RunState snapshots (including nested `log`),
  // strip them down to bounded snapshots so the run can't balloon in memory.
  const cleanedPriorLog = (base.log ?? []).map((e: any) => {
    const sb: any = e.snapshot_before;
    const sa: any = e.snapshot_after;
    const cleanBefore = sb && typeof sb === "object" && "log" in sb ? boundedSnapshot(sb as any) : sb;
    const cleanAfter = sa && typeof sa === "object" && "log" in sa ? boundedSnapshot(sa as any) : sa;
    return { ...e, snapshot_before: cleanBefore, snapshot_after: cleanAfter };
  });

  const ctx = proposeTurn(base);
  let working = deepCopy(ctx.preview_state);

  const notes: string[] = [];
  const maxShift = ctx.max_labor_shift;

  const prospectsLog: ProspectsLogEvent[] = [...(ctx.report.prospects_log ?? [])];

  // 10) apply decisions
  applyLaborDecision(working, decisions, maxShift, notes);
  applySellDecision(working, ctx, decisions, notes);
  applyConstructionDecision(working, decisions, notes);
  applyMarriageDecision(working, ctx, decisions, notes);
  applyProspectsDecision(working, ctx, decisions, prospectsLog);
  applyObligationPaymentsAndPenalties(working, decisions, notes);

  // 11) minimal AI/world reactions handled via relationship adjustments above.

  // 12) end-of-turn checks + log
  const lifeLog: HouseLogEvent[] = [];
  // Carry over any People-First preview events (e.g., spouse death widowhood) from proposeTurn.
  for (const e of ctx.report.house_log ?? []) lifeLog.push(e);

  closeTurn(working, notes, lifeLog);

  normalizeState(working);

  ensurePeopleFirst(working);

  const snapshotAfter = boundedSnapshot(working);

  // deltas for quick debug
  const deltas: Record<string, number> = {
    bushels: snapshotAfter.manor.bushels_stored - snapshotBefore.manor.bushels_stored,
    coin: snapshotAfter.manor.coin - snapshotBefore.manor.coin,
    unrest: snapshotAfter.manor.unrest - snapshotBefore.manor.unrest,
    pop: snapshotAfter.manor.population - snapshotBefore.manor.population,
    arrears_coin: snapshotAfter.manor.obligations.arrears.coin - snapshotBefore.manor.obligations.arrears.coin,
    arrears_bushels: snapshotAfter.manor.obligations.arrears.bushels - snapshotBefore.manor.obligations.arrears.bushels
  };

  const summary = `Turn ${ctx.report.turn_index} resolved. ${notes.slice(0, 2).join(" ")}`.trim();

  const orderedHouseLog = (lifeLog ?? []).map((e, i) => ({ e, i })).sort((a, b) => {
    if (a.e.turn_index !== b.e.turn_index) return a.i - b.i;
    const w = (k: HouseLogEvent["kind"]) => (k === "succession" ? 0 : k === "widowed" ? 1 : 2);
    const da = w(a.e.kind);
    const db = w(b.e.kind);
    if (da !== db) return da - db;
    return a.i - b.i;
  }).map((x) => x.e);

  working.log = [...cleanedPriorLog, {
    processed_turn_index: ctx.report.turn_index,
    summary,
    // Order rule: if succession + heir_selected occur same turn, show Succession first.
    report: { ...ctx.report, house_log: orderedHouseLog, notes: [...ctx.report.notes, ...notes], prospects_log: prospectsLog.length ? prospectsLog : undefined },
    decisions,
    snapshot_before: snapshotBefore,
    snapshot_after: snapshotAfter,
    deltas
  }];

  return working;
}
