import type { RunState, EventCategory } from "../sim/types";
import type { Rng } from "../sim/rng";
import { clampInt, asNonNegInt } from "../sim/util";
import { hasImprovement } from "./improvements";

export interface ContentEventDef {
  id: string;
  title: string;
  category: EventCategory;
  cooldown: number; // turns
  getWeight: (state: RunState) => { weight: number; notes: string[] };
  apply: (state: RunState, rng: Rng) => string[]; // effects text (human)
}

function ensureMods(state: RunState): Record<string, number> {
  const f: any = state.flags;
  if (!f._mods || typeof f._mods !== "object") f._mods = {};
  return f._mods as Record<string, number>;
}

function addMod(state: RunState, key: string, value: number): void {
  const mods = ensureMods(state);
  mods[key] = (mods[key] ?? 1) * value;
}

function addBushels(state: RunState, delta: number): void {
  state.manor.bushels_stored = asNonNegInt(state.manor.bushels_stored + Math.trunc(delta));
}
function addCoin(state: RunState, delta: number): void {
  state.manor.coin = asNonNegInt(state.manor.coin + Math.trunc(delta));
}
function addUnrest(state: RunState, delta: number): void {
  state.manor.unrest = clampInt(state.manor.unrest + Math.trunc(delta), 0, 100);
}
function addPopulation(state: RunState, delta: number): void {
  state.manor.population = asNonNegInt(state.manor.population + Math.trunc(delta));
  if (state.manor.farmers + state.manor.builders > state.manor.population) {
    state.manor.builders = Math.max(0, state.manor.population - state.manor.farmers);
  }
}

function baseWeight(w: number, notes: string[] = []): { weight: number; notes: string[] } {
  return { weight: Math.max(0, w), notes };
}

function wWithImprovement(state: RunState, base: number, ifHas: string, mult: number, note: string): { weight: number; notes: string[] } {
  const has = hasImprovement(state.manor.improvements, ifHas);
  return baseWeight(has ? base * mult : base, has ? [note] : []);
}

/**
 * Event deck (v0.0.5): expanded for variety + readability.
 * Mechanics are unchanged; this is content + weights/cooldowns.
 */
export const EVENT_DECK: ContentEventDef[] = [
  // --- Weather / yield modifiers (set one-turn mods) ---
  {
    id: "evt_hard_winter",
    title: "Hard Winter",
    category: "weather",
    cooldown: 6,
    getWeight: (s) => wWithImprovement(s, 1.0, "drainage_ditches", 0.8, "Drainage softens winter damage."),
    apply: (s) => {
      addMod(s, "weather_mult", 0.85);
      addUnrest(s, 1);
      return ["Weather worsens: harvest multiplier reduced next turn.", "+1 unrest from hardship."];
    }
  },
  {
    id: "evt_drought",
    title: "Dry Summer",
    category: "weather",
    cooldown: 6,
    getWeight: (s) => wWithImprovement(s, 0.9, "drainage_ditches", 0.8, "Drainage reduces drought impact."),
    apply: (s) => {
      addMod(s, "weather_mult", 0.88);
      return ["Weather worsens: harvest multiplier reduced next turn."];
    }
  },
  {
    id: "evt_late_rains",
    title: "Late Rains",
    category: "weather",
    cooldown: 5,
    getWeight: (s) => baseWeight(0.7, ["Mild yield disruption possible."]),
    apply: (s) => {
      addMod(s, "weather_mult", 0.92);
      return ["Weather unsettled: harvest multiplier reduced slightly next turn."];
    }
  },
  {
    id: "evt_gentle_season",
    title: "Gentle Season",
    category: "weather",
    cooldown: 5,
    getWeight: (s) => baseWeight(0.55, ["A favorable growing season."]),
    apply: (s) => {
      addMod(s, "weather_mult", 1.06);
      addUnrest(s, -1);
      return ["Weather improves: harvest multiplier increased next turn.", "-1 unrest (good spirits)."];
    }
  },
  {
    id: "evt_bumper_harvest_omen",
    title: "Bumper Harvest Omens",
    category: "weather",
    cooldown: 7,
    getWeight: (s) => baseWeight(0.35, ["Rare but impactful."]),
    apply: (s) => {
      addMod(s, "weather_mult", 1.12);
      return ["Strong omens: harvest multiplier increased next turn."];
    }
  },

  // --- Crop / storage pressures ---
  {
    id: "evt_blight",
    title: "Blight in the Fields",
    category: "weather",
    cooldown: 6,
    getWeight: (s) => wWithImprovement(s, 0.9, "field_rotation", 0.6, "Field rotation reduces blight risk."),
    apply: (s, rng) => {
      const loss = Math.trunc(s.manor.bushels_stored * rng.fork("blight").next() * 0.10);
      addBushels(s, -loss);
      addUnrest(s, 2);
      return [`Spoilage/rot ruins stores: -${loss} bushels.`, "+2 unrest."];
    }
  },
  {
    id: "evt_spoilage_spike",
    title: "Spoilage Spike",
    category: "economic",
    cooldown: 5,
    getWeight: (s) => wWithImprovement(s, 0.55, "granary_upgrade", 0.4, "Granary reduces spoilage incidents."),
    apply: (s, rng) => {
      const loss = rng.int(40, 140);
      addBushels(s, -loss);
      return [`Unexpected spoilage: -${loss} bushels.`];
    }
  },
  {
    id: "evt_rodent_infestation",
    title: "Rodent Infestation",
    category: "economic",
    cooldown: 5,
    getWeight: (s) => wWithImprovement(s, 0.45, "granary_upgrade", 0.5, "Granary helps keep vermin out."),
    apply: (s, rng) => {
      const loss = rng.int(25, 90);
      addBushels(s, -loss);
      addUnrest(s, 1);
      return [`Vermin nibble the stores: -${loss} bushels.`, "+1 unrest."];
    }
  },
  {
    id: "evt_good_storage_year",
    title: "Dry Air in the Granary",
    category: "economic",
    cooldown: 6,
    getWeight: (s) => baseWeight(hasImprovement(s.manor.improvements, "granary_upgrade") ? 0.35 : 0.15, ["Better storage conditions."]),
    apply: (s) => {
      addMod(s, "spoilage_mult", 0.85);
      return ["Spoilage reduced next turn."];
    }
  },

  // --- Market / coin ---
  {
    id: "evt_market_glut",
    title: "Market Glut",
    category: "economic",
    cooldown: 5,
    getWeight: (s) => baseWeight(0.55, ["Price down, demand up."]),
    apply: (s) => {
      addMod(s, "market_price_mult", 0.90);
      addMod(s, "sell_cap_mult", 1.10);
      return ["Market price dips next turn.", "Sell cap slightly higher next turn."];
    }
  },
  {
    id: "evt_market_shortage",
    title: "Market Shortage",
    category: "economic",
    cooldown: 5,
    getWeight: (s) => baseWeight(0.55, ["Price up, demand constrained."]),
    apply: (s) => {
      addMod(s, "market_price_mult", 1.10);
      addMod(s, "sell_cap_mult", 0.90);
      return ["Market price rises next turn.", "Sell cap slightly lower next turn."];
    }
  },
  {
    id: "evt_traveling_merchant",
    title: "Traveling Merchant",
    category: "economic",
    cooldown: 5,
    getWeight: (s) => baseWeight(0.45, ["Opportunity for extra coin."]),
    apply: (s, rng) => {
      const coin = rng.int(2, 6);
      addCoin(s, coin);
      return [`A merchant pays fees: +${coin} coin.`];
    }
  },
  {
    id: "evt_tool_breakage",
    title: "Tool Breakage",
    category: "economic",
    cooldown: 4,
    getWeight: (s) => baseWeight(s.manor.construction ? 0.6 : 0.2, [s.manor.construction ? "Active construction is vulnerable." : "Minor risk."]),
    apply: (s, rng) => {
      const coin = rng.int(1, 3);
      addCoin(s, -coin);
      return [`Repairs and replacements: -${coin} coin.`];
    }
  },
  {
    id: "evt_small_windfall",
    title: "Minor Windfall",
    category: "economic",
    cooldown: 4,
    getWeight: (s) => baseWeight(0.5, ["A small stroke of luck."]),
    apply: (s, rng) => {
      const coin = rng.int(1, 4);
      addCoin(s, coin);
      return [`Unexpected fees and fines collected: +${coin} coin.`];
    }
  },

  // --- Security / loss events ---
  {
    id: "evt_bandits",
    title: "Bandit Raid",
    category: "security",
    cooldown: 6,
    getWeight: (s) => {
      const base = 0.7 + s.manor.unrest / 60;
      const mult = hasImprovement(s.manor.improvements, "watch_ward") ? 0.6 : 1.0;
      return baseWeight(base * mult, [hasImprovement(s.manor.improvements, "watch_ward") ? "Watch & Ward deters raids." : "Higher unrest emboldens bandits."]);
    },
    apply: (s, rng) => {
      const bushels = rng.int(30, 160);
      const coin = rng.int(0, 3);
      addBushels(s, -bushels);
      addCoin(s, -coin);
      addUnrest(s, rng.int(2, 6));
      return [`Stores looted: -${bushels} bushels.`, coin > 0 ? `Purses taken: -${coin} coin.` : "No coin taken.", "Unrest rises after the raid."];
    }
  },
  {
    id: "evt_fire",
    title: "Manor Fire",
    category: "security",
    cooldown: 8,
    getWeight: (s) => baseWeight(0.45, ["Rare but costly."]),
    apply: (s, rng) => {
      const bushels = rng.int(60, 220);
      const coin = rng.int(1, 5);
      addBushels(s, -bushels);
      addCoin(s, -coin);
      addUnrest(s, 3);
      return [`Fire destroys stores: -${bushels} bushels.`, `Repairs and relief: -${coin} coin.`, "+3 unrest."];
    }
  },
  {
    id: "evt_petty_theft",
    title: "Petty Theft",
    category: "security",
    cooldown: 4,
    getWeight: (s) => baseWeight(hasImprovement(s.manor.improvements, "watch_ward") ? 0.25 : 0.5, ["Small but frequent if uncontrolled."]),
    apply: (s, rng) => {
      const coin = rng.int(0, 2);
      const bushels = rng.int(10, 40);
      addCoin(s, -coin);
      addBushels(s, -bushels);
      return [`Small losses: -${bushels} bushels${coin ? `, -${coin} coin` : ""}.`];
    }
  },
  {
    id: "evt_boundary_dispute",
    title: "Boundary Dispute",
    category: "political",
    cooldown: 7,
    getWeight: (s) => baseWeight(0.35 + s.manor.unrest / 200, ["Neighbors test weakness."]),
    apply: (s, rng) => {
      const coin = rng.int(1, 4);
      addCoin(s, -coin);
      addUnrest(s, 2);
      return [`Surveyors and bribes: -${coin} coin.`, "+2 unrest."];
    }
  },

  // --- Social / unrest ---
  {
    id: "evt_peasant_petition",
    title: "Peasant Petition",
    category: "social",
    cooldown: 4,
    getWeight: (s) => baseWeight(0.6 + s.manor.unrest / 120, ["Higher unrest means more petitions."]),
    apply: (s, rng) => {
      const u = rng.int(1, 4);
      addUnrest(s, u);
      return [`Demands for relief: +${u} unrest.`];
    }
  },
  {
    id: "evt_runaways",
    title: "Runaways",
    category: "social",
    cooldown: 6,
    getWeight: (s) => baseWeight(s.manor.unrest >= 60 ? 0.55 : 0.2, ["Runaways spike when unrest is high."]),
    apply: (s, rng) => {
      const n = rng.int(1, 4);
      addPopulation(s, -n);
      addUnrest(s, 2);
      return [`${n} villagers flee: population -${n}.`, "+2 unrest."];
    }
  },
  {
    id: "evt_festival",
    title: "Local Festival",
    category: "social",
    cooldown: 6,
    getWeight: (s) => baseWeight(0.35, ["A small relief valve."]),
    apply: (s, rng) => {
      const coin = rng.int(0, 2);
      addCoin(s, -coin);
      addUnrest(s, -rng.int(2, 6));
      return [coin ? `Small spending: -${coin} coin.` : "No spending required.", "Unrest falls as spirits lift."];
    }
  },
  {
    id: "evt_good_harvest_celebration",
    title: "Good Harvest Celebration",
    category: "social",
    cooldown: 7,
    getWeight: (s) => baseWeight(s.manor.bushels_stored > 1200 ? 0.35 : 0.15, ["More likely if stores are healthy."]),
    apply: (s) => {
      addUnrest(s, -4);
      return ["-4 unrest (confidence rises with plenty)."];
    }
  },

  // --- Religious / obligations pressure ---
  {
    id: "evt_tithe_collector",
    title: "Tithe Collector",
    category: "religious",
    cooldown: 5,
    getWeight: (s) => baseWeight(0.5 + (s.manor.obligations.arrears.bushels > 0 ? 0.2 : 0), [s.manor.obligations.arrears.bushels > 0 ? "Clergy pressures existing arrears." : "Routine collection."]),
    apply: (s, rng) => {
      const extra = rng.int(0, 12);
      s.manor.obligations.tithe_due_bushels = asNonNegInt(s.manor.obligations.tithe_due_bushels + extra);
      return [extra ? `Extra tithe demanded: +${extra} bushels due.` : "Routine tithe reminder (no extra due)."];
    }
  },
  {
    id: "evt_clergy_mediation",
    title: "Clergy Mediation",
    category: "religious",
    cooldown: 6,
    getWeight: (s) => baseWeight(s.manor.unrest >= 40 ? 0.35 : 0.15, ["More likely when unrest is visible."]),
    apply: (s) => {
      addUnrest(s, -3);
      return ["Clergy calms tempers: -3 unrest."];
    }
  },
  {
    id: "evt_pilgrims_pay_tolls",
    title: "Pilgrims Pay Tolls",
    category: "religious",
    cooldown: 7,
    getWeight: (s) => baseWeight(0.25, ["Rare but pleasant."]),
    apply: (s, rng) => {
      const coin = rng.int(1, 3);
      addCoin(s, coin);
      return [`Pilgrims leave offerings: +${coin} coin.`];
    }
  },

  // --- Political / taxes ---
  {
    id: "evt_tax_surge",
    title: "Tax Surge",
    category: "political",
    cooldown: 7,
    getWeight: (s) => baseWeight(0.35, ["The liege tightens his hand."]),
    apply: (s, rng) => {
      const extra = rng.int(1, 3);
      s.manor.obligations.tax_due_coin = asNonNegInt(s.manor.obligations.tax_due_coin + extra);
      addUnrest(s, 1);
      return [`Extra tax demanded: +${extra} coin due.`, "+1 unrest."];
    }
  },
  {
    id: "evt_tax_relief",
    title: "Tax Relief",
    category: "political",
    cooldown: 8,
    getWeight: (s) => baseWeight(0.20, ["A rare mercy."]),
    apply: (s, rng) => {
      const relief = rng.int(1, 3);
      s.manor.obligations.tax_due_coin = asNonNegInt(Math.max(0, s.manor.obligations.tax_due_coin - relief));
      addUnrest(s, -1);
      return [`Tax eased: -${relief} coin due.`, "-1 unrest."];
    }
  },
  {
    id: "evt_liege_inspection",
    title: "Liege Inspection",
    category: "political",
    cooldown: 6,
    getWeight: (s) => baseWeight(0.35 + (s.manor.obligations.arrears.coin > 0 ? 0.25 : 0), [s.manor.obligations.arrears.coin > 0 ? "Arrears draws attention." : "Routine oversight."]),
    apply: (s) => {
      addUnrest(s, 1);
      return ["Inspection stirs anxiety: +1 unrest."];
    }
  },

  // --- Military / war levy ---
  {
    id: "evt_war_levy",
    title: "War Levy",
    category: "military",
    cooldown: 10,
    getWeight: (s) => baseWeight(s.turn_index >= 2 ? 0.35 : 0.15, ["More likely after the realm heats up."]),
    apply: (s, rng) => {
      if (s.manor.obligations.war_levy_due) return ["A levy is already outstanding."];
      const men = rng.int(3, 8);
      const coin = rng.int(4, 10);
      s.manor.obligations.war_levy_due = { kind: "men_or_coin", men, coin, created_turn: s.turn_index };
      return [`The liege demands service: provide ${men} men OR pay ${coin} coin.`];
    }
  },

  // --- Household / illness (keep as content; core rates live elsewhere) ---
  {
    id: "evt_minor_illness",
    title: "Minor Illness",
    category: "personal",
    cooldown: 4,
    getWeight: (s) => {
      const base = 0.55;
      const mult = hasImprovement(s.manor.improvements, "physician") ? 0.6 : 1.0;
      return baseWeight(base * mult, [hasImprovement(s.manor.improvements, "physician") ? "Physician reduces illness pressure." : "Illness is always near."]);
    },
    apply: (s, rng) => {
      const u = rng.int(0, 2);
      addUnrest(s, u);
      return [u ? `Sickness unsettles the village: +${u} unrest.` : "A few fall ill, but it passes quietly."];
    }
  },
  {
    id: "evt_infant_loss",
    title: "Infant Loss",
    category: "personal",
    cooldown: 8,
    getWeight: (s) => baseWeight(0.12, ["Rare; represented separately from core mortality."]),
    apply: (s, rng) => {
      const u = rng.int(1, 3);
      addUnrest(s, u);
      return [`A tragedy in the village: +${u} unrest.`];
    }
  },

  // --- Construction / project volatility ---
  {
    id: "evt_skilled_mason",
    title: "Skilled Mason Arrives",
    category: "construction",
    cooldown: 6,
    getWeight: (s) => baseWeight(s.manor.construction ? 0.45 : 0.1, ["Only helpful if building."]),
    apply: (s, rng) => {
      if (!s.manor.construction) return ["No active works; the mason moves on."];
      const bonus = rng.int(6, 16);
      s.manor.construction.progress = asNonNegInt(s.manor.construction.progress + bonus);
      return [`Work accelerates: +${bonus} construction progress.`];
    }
  },
  {
    id: "evt_supply_shortage",
    title: "Supply Shortage",
    category: "construction",
    cooldown: 6,
    getWeight: (s) => baseWeight(s.manor.construction ? 0.35 : 0.08, ["Active works sometimes stall."]),
    apply: (s, rng) => {
      if (!s.manor.construction) return ["No active works are affected."];
      const penalty = rng.int(5, 14);
      s.manor.construction.progress = asNonNegInt(Math.max(0, s.manor.construction.progress - penalty));
      return [`Materials run short: -${penalty} construction progress.`];
    }
  }
];

// Add a bunch of low-impact flavor events to increase variety without raising pace.
const FLAVOR: Array<{ id: string; title: string; category: EventCategory; cooldown: number; w: number; apply: (s: RunState, r: Rng) => string[] }> = [
  { id: "evt_herd_disease", title: "Herd Disease", category: "economic", cooldown: 7, w: 0.25, apply: (s, r) => { const c=r.int(1,3); addCoin(s,-c); return [`Lost livestock value: -${c} coin.`]; } },
  { id: "evt_repair_bridge", title: "Bridge Repairs", category: "economic", cooldown: 7, w: 0.22, apply: (s, r) => { const c=r.int(1,4); addCoin(s,-c); return [`Maintenance costs: -${c} coin.`]; } },
  { id: "evt_hired_miners", title: "Hired Miners Pass Through", category: "economic", cooldown: 8, w: 0.18, apply: (s, r) => { const c=r.int(1,3); addCoin(s,c); return [`They pay for ale and lodging: +${c} coin.`]; } },
  { id: "evt_wandering_bards", title: "Wandering Bards", category: "social", cooldown: 8, w: 0.20, apply: (s, r) => { addUnrest(s,-r.int(1,3)); return ["Stories lift spirits: unrest falls slightly."]; } },
  { id: "evt_bad_rumors", title: "Bad Rumors", category: "social", cooldown: 6, w: 0.25, apply: (s, r) => { addUnrest(s,r.int(1,3)); return ["Rumors spread: unrest rises slightly."]; } },
  { id: "evt_good_rumors", title: "Good Rumors", category: "social", cooldown: 6, w: 0.22, apply: (s, r) => { addUnrest(s,-r.int(1,3)); return ["Good news travels: unrest falls slightly."]; } },
  { id: "evt_pious_procession", title: "Pious Procession", category: "religious", cooldown: 9, w: 0.15, apply: (s, r) => { addUnrest(s,-2); return ["The village steadies: -2 unrest."]; } },
  { id: "evt_clergy_rebuke", title: "Clergy Rebuke", category: "religious", cooldown: 9, w: 0.15, apply: (s, r) => { addUnrest(s,2); return ["Public rebuke: +2 unrest."]; } },
  { id: "evt_muddy_roads", title: "Muddy Roads", category: "economic", cooldown: 6, w: 0.20, apply: (s, r) => { addMod(s,"sell_cap_mult",0.9); return ["Trade slows: sell cap lower next turn."]; } },
  { id: "evt_clear_roads", title: "Clear Roads", category: "economic", cooldown: 6, w: 0.20, apply: (s, r) => { addMod(s,"sell_cap_mult",1.1); return ["Trade flows: sell cap higher next turn."]; } },
  { id: "evt_local_scribe", title: "Local Scribe", category: "political", cooldown: 10, w: 0.12, apply: (s, r) => { const relief = r.int(1,2); s.manor.obligations.tax_due_coin = asNonNegInt(Math.max(0, s.manor.obligations.tax_due_coin - relief)); return [`A scribe finds an exemption: -${relief} coin tax due.`]; } },
  { id: "evt_ale_shortage", title: "Ale Shortage", category: "social", cooldown: 9, w: 0.18, apply: (s, r) => { addUnrest(s,2); return ["Ale runs thin: +2 unrest."]; } },
  { id: "evt_ale_plenty", title: "Ale Plenty", category: "social", cooldown: 9, w: 0.18, apply: (s, r) => { addUnrest(s,-2); return ["Ale flows: -2 unrest."]; } },
  { id: "evt_muster_practice", title: "Muster Practice", category: "military", cooldown: 10, w: 0.14, apply: (s, r) => { addUnrest(s,1); return ["Muster drills disrupt work: +1 unrest."]; } },
  { id: "evt_truce_news", title: "Truce News", category: "political", cooldown: 10, w: 0.14, apply: (s, r) => { addUnrest(s,-1); return ["Good tidings: -1 unrest."]; } },
  { id: "evt_small_theft_tools", title: "Tools Misplaced", category: "construction", cooldown: 7, w: 0.16, apply: (s, r) => { if (!s.manor.construction) return ["Nothing is misplaced."]; const pen=r.int(3,8); s.manor.construction.progress = asNonNegInt(Math.max(0,s.manor.construction.progress-pen)); return [`Delays at the works: -${pen} progress.`]; } },
  { id: "evt_extra_hands", title: "Extra Hands Volunteer", category: "construction", cooldown: 7, w: 0.16, apply: (s, r) => { if (!s.manor.construction) return ["No active works; hands disperse."]; const bon=r.int(3,10); s.manor.construction.progress = asNonNegInt(s.manor.construction.progress+bon); return [`Work quickens: +${bon} progress.`]; } },
  { id: "evt_wolf_scare", title: "Wolf Scare", category: "security", cooldown: 10, w: 0.12, apply: (s, r) => { addUnrest(s,1); return ["Wolves near the pastures: +1 unrest."]; } },
  { id: "evt_craft_fair", title: "Craft Fair", category: "economic", cooldown: 10, w: 0.12, apply: (s, r) => { const c=r.int(1,4); addCoin(s,c); return [`A fair brings coin: +${c} coin.`]; } },
  { id: "evt_miller_dispute", title: "Miller Dispute", category: "social", cooldown: 10, w: 0.12, apply: (s, r) => { addUnrest(s,2); return ["A dispute at the mill: +2 unrest."]; } },
  { id: "evt_miller_settles", title: "Miller Settles Accounts", category: "economic", cooldown: 10, w: 0.12, apply: (s, r) => { const c=r.int(1,3); addCoin(s,c); return [`Accounts settle: +${c} coin.`]; } },
  { id: "evt_salt_shortage", title: "Salt Shortage", category: "economic", cooldown: 12, w: 0.10, apply: (s, r) => { const c=r.int(1,2); addCoin(s,-c); return [`Salt prices rise: -${c} coin.`]; } },
  { id: "evt_salt_wagon", title: "Salt Wagon Arrives", category: "economic", cooldown: 12, w: 0.10, apply: (s, r) => { const c=r.int(1,2); addCoin(s,c); return [`Cheap salt boosts trade: +${c} coin.`]; } },
  { id: "evt_minor_blessing", title: "Minor Blessing", category: "religious", cooldown: 12, w: 0.10, apply: (s, r) => { addMod(s,"weather_mult",1.03); return ["A small blessing: harvest multiplier slightly higher next turn."]; } },
  { id: "evt_minor_curse", title: "Minor Curse", category: "religious", cooldown: 12, w: 0.10, apply: (s, r) => { addMod(s,"weather_mult",0.97); return ["A small curse: harvest multiplier slightly lower next turn."]; } },
  { id: "evt_village_wedding", title: "Village Wedding", category: "social", cooldown: 12, w: 0.10, apply: (s, r) => { addUnrest(s,-3); return ["Celebration: -3 unrest."]; } },
  { id: "evt_funeral_procession", title: "Funeral Procession", category: "social", cooldown: 12, w: 0.10, apply: (s, r) => { addUnrest(s,2); return ["A somber season: +2 unrest."]; } },
  { id: "evt_better_seed", title: "Better Seed Stock", category: "weather", cooldown: 12, w: 0.10, apply: (s, r) => { addMod(s,"production_mult",1.03); return ["Better seed: production slightly higher next turn."]; } },
  { id: "evt_bad_seed", title: "Bad Seed Stock", category: "weather", cooldown: 12, w: 0.10, apply: (s, r) => { addMod(s,"production_mult",0.97); return ["Bad seed: production slightly lower next turn."]; } }
];

for (const f of FLAVOR) {
  EVENT_DECK.push({
    id: f.id,
    title: f.title,
    category: f.category,
    cooldown: f.cooldown,
    getWeight: () => baseWeight(f.w),
    apply: (s, r) => f.apply(s, r)
  });
}

// Ensure deck size is stable-ish for QA scripts (v0.0.5 target: > current set).
export const EVENT_COUNT = EVENT_DECK.length;
