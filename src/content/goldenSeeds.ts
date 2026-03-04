export interface GoldenSeed {
  seed: string;
  note: string;
}

export const GOLDEN_SEEDS_V005: GoldenSeed[] = [
  { seed: "lotm_v005_001_baseline", note: "Baseline equilibrium; moderate variance." },
  { seed: "lotm_v005_002_builder_pressure", note: "Builder tension; construction vs food." },
  { seed: "lotm_v005_003_market_tight", note: "Low price/sell-cap variance; obligations stress." },
  { seed: "lotm_v005_004_war_levy", note: "War levy pressure; coin fallback -> men." },
  { seed: "lotm_v005_005_unrest_chain", note: "Unrest drivers; dispossession risk." },
  { seed: "lotm_v005_006_household_risk", note: "Mortality/birth variance; heir risk." },
  { seed: "lotm_v005_007_security_losses", note: "Bandits/fire/petty theft buffering test." },
  { seed: "lotm_v005_008_blight_weather", note: "Weather+blight modifiers; yield fragility." }
];


export const GOLDEN_SEEDS_V007: GoldenSeed[] = [
  { seed: "lotm_v007_001_baseline", note: "Baseline equilibrium; sanity check across policies." },
  { seed: "lotm_v007_002_temptation_build", note: "Builder-forward stress; early construction pressure." },
  { seed: "lotm_v007_003_weather_swing", note: "Weather volatility; yield risk and buffer management." },
  { seed: "lotm_v007_004_market_tight", note: "Low price / sell-cap squeeze; obligations pinch." },
  { seed: "lotm_v007_005_obligations_spike", note: "Taxes/tithes timing pressure; arrears risk." },
  { seed: "lotm_v007_006_security_losses", note: "Banditry/theft chain; watch & ward value." },
  { seed: "lotm_v007_007_household_risk", note: "Household illness/death pressure; succession risk." },
  { seed: "lotm_v007_008_unrest_chain", note: "Unrest escalation path; dispossession threshold clarity." }
];

export const GOLDEN_SEEDS_V006: GoldenSeed[] = [
  { seed: "lotm_v006_001_baseline", note: "Baseline equilibrium; moderate variance." },
  { seed: "lotm_v006_002_builder_pressure", note: "Builder tension; construction vs food (temptation path)." },
  { seed: "lotm_v006_003_market_tight", note: "Low price/sell-cap variance; obligations stress." },
  { seed: "lotm_v006_004_war_levy", note: "War levy pressure; coin fallback -> men (WP-07 lock)." },
  { seed: "lotm_v006_005_unrest_chain", note: "Unrest drivers; dispossession risk." },
  { seed: "lotm_v006_006_household_risk", note: "Mortality/birth variance; heir risk." },
  { seed: "lotm_v006_007_security_losses", note: "Bandits/fire/petty theft buffering test." },
  { seed: "lotm_v006_008_blight_weather", note: "Weather+blight modifiers; yield fragility." }
];

export const GOLDEN_SEEDS_V008 = [
  { seed: "lotm_v008_001_baseline", note: "Baseline equilibrium; normal variance." },
  { seed: "lotm_v008_002_market_tight", note: "Lower sell cap/price dips; obligations pressure." },
  { seed: "lotm_v008_003_weather_stack", note: "Hard winter/blight/drought stack potential." },
  { seed: "lotm_v008_004_unrest_pressure", note: "Petitions/runaways; dispossession risk." },
  { seed: "lotm_v008_005_war_levy_early", note: "Early war levy; men/coin stress." },
  { seed: "lotm_v008_006_construction_path", note: "Construction-heavy path; checks builders tradeoffs." },
  { seed: "lotm_v008_007_household_risk", note: "Mortality/heir risk edge." },
  { seed: "lotm_v008_008_bandit_fire", note: "Sudden losses (bandits/fire) test buffers." },
] as const;


export const GOLDEN_SEEDS_V009 = [
  { seed: "lotm_v009_001_baseline", note: "Baseline equilibrium; sanity check after durability tuning." },
  { seed: "lotm_v009_002_heir_pressure", note: "Household death/birth variance; DeathNoHeir pressure test." },
  { seed: "lotm_v009_003_market_tight", note: "Low price / sell-cap squeeze; arrears stability under stress." },
  { seed: "lotm_v009_004_weather_stack", note: "Weather volatility stack; buffer discipline." },
  { seed: "lotm_v009_005_builder_temptation", note: "Builder-forward path; unrest/arrears tail risk." },
  { seed: "lotm_v009_006_war_levy_early", note: "Early war levy; men-or-coin fallback handling." },
  { seed: "lotm_v009_007_unrest_pressure", note: "Unrest escalation path; decay vs arrears coupling." },
  { seed: "lotm_v009_008_bandit_fire", note: "Sudden losses (bandits/fire) test recovery loops." },
] as const;

export const GOLDEN_SEEDS_CURRENT = GOLDEN_SEEDS_V009;
