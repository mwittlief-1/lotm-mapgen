export const TURN_YEARS = 3;

export const BUSHELS_PER_PERSON_PER_YEAR = 12;
export const BUSHELS_PER_FARMER_PER_YEAR = 20;

// v0.0.4 baseline accepted; v0.0.5 maintains with minor tuning for content pacing.
export const BASE_FERTILITY = 0.845;

export const SPOILAGE_RATE_BASE = 0.045;
export const SPOILAGE_RATE_GRANARY = 0.02;

export const MARKET_PRICE_MIN = 0.06;
export const MARKET_PRICE_MAX = 0.14;

export const SELL_CAP_FACTOR_MIN = 0.8;
export const SELL_CAP_FACTOR_MAX = 1.2;

export const BUILD_RATE_PER_BUILDER_PER_TURN = 4;

// Combined cap applies to farmers+builders shifts.
export function maxLaborDeltaPerTurn(population: number): number {
  return Math.max(3, Math.floor(population * 0.1));
}

// Consumption role premium: builders consume +1 bushel/year.
export const BUILDER_EXTRA_BUSHELS_PER_YEAR = 1;

// Unrest tuning (v0.0.4-ish)
export const UNREST_SHORTAGE_PENALTY = 9;
export const UNREST_ARREARS_PENALTY = 1;
export const UNREST_BASELINE_DECAY_WHEN_STABLE = 2; // when fed + dues current, per turn

// Mortality / birth tuning (kept threatening but not silly)
export const MORTALITY_MULT_WITH_PHYSICIAN = 0.6;

// Birth tuning (durability): base fertility odds by spouse fertility trait (per 3-year turn)
export const BIRTH_CHANCE_BY_FERTILITY: readonly number[] = [0, 0.09, 0.17, 0.26, 0.34, 0.42] as const;
export const BIRTH_FERTILE_AGE_MIN = 16;
export const BIRTH_FERTILE_AGE_MAX = 48; // inclusive

// Mortality tuning (durability): base death odds per 3-year turn by age band
export const MORTALITY_P_UNDER16 = 0.0035;
export const MORTALITY_P_UNDER40 = 0.006;
export const MORTALITY_P_UNDER55 = 0.02;
export const MORTALITY_P_UNDER65 = 0.045;
export const MORTALITY_P_65PLUS = 0.09;

// Events pacing: target 0.7–1.3 events/turn, cap 2.
export const EVENTS_PER_TURN_PROBS: Array<{ k: 0 | 1 | 2; p: number }> = [
  { k: 0, p: 0.42 },
  { k: 1, p: 0.43 },
  { k: 2, p: 0.15 }
];

// Improvement effect constants (used by sim + docs generator)
export const YIELD_MULT_FIELD_ROTATION = 1.06;
export const YIELD_MULT_DRAINAGE_DITCHES = 1.02;
export const SELL_MULT_MILL_EFFICIENCY = 1.05;
export const DRAINAGE_WEATHER_SOFTEN_BONUS = 0.05;
export const VILLAGE_FEAST_UNREST_REDUCTION = 8;
