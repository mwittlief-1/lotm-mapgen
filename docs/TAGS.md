# TAGS (version -> summary + golden seeds)

## v0.0.5
Summary:
- Content + Clarity release (expanded event deck, better logging, batch runner columns).

Golden seeds:
- lotm_v005_001_baseline
- lotm_v005_002_builder_pressure
- lotm_v005_003_market_tight
- lotm_v005_004_war_levy
- lotm_v005_005_unrest_chain
- lotm_v005_006_household_risk
- lotm_v005_007_security_losses
- lotm_v005_008_blight_weather

## v0.0.5 — QA Fix
Summary:
- Bounded TurnLogEntry snapshots (exclude log) + build fingerprint for drift prevention.

Build fingerprint:
- 7ddd0f464220298473ced72502a7feccfaa56f61580c72ec6f637b17f160cec7

## v0.0.6
Summary:
- Stabilize + harden harness/QA; builder-forward temptation path validation telemetry.

Golden seeds:
- lotm_v006_001_baseline
- lotm_v006_002_builder_pressure
- lotm_v006_003_market_tight
- lotm_v006_004_war_levy
- lotm_v006_005_unrest_chain
- lotm_v006_006_household_risk
- lotm_v006_007_security_losses
- lotm_v006_008_blight_weather
## v0.0.6
Summary:
- Harness/telemetry/QA hardening baseline.
Golden seeds:
- (see v0.0.6 playtest packet)

## v0.0.7
Summary:
- Productization sprint: policy registry + clarity + matrices + updated golden seeds.
Golden seeds:
- lotm_v007_001_baseline
- lotm_v007_002_temptation_build
- lotm_v007_003_weather_swing
- lotm_v007_004_market_tight
- lotm_v007_005_obligations_spike
- lotm_v007_006_security_losses
- lotm_v007_007_household_risk
- lotm_v007_008_unrest_chain

## v0.0.7a
Summary: QA gate fallback (Vitest -> no-deps gate), no gameplay changes.

## v0.0.8
Summary:
- Measurement + harness fidelity + 30-turn readiness (no new gameplay systems)
Policy IDs:
- prudent-builder
- builder-forward
- builder-forward/buffered (artifact folder uses '__')
- Patch: sim:batch outdir includes turns_<N>; QA no-deps artifact naming uses APP_VERSION; BUILD_INFO policy list matches registry.
- Patch: UI game-over banner clarity (Dispossessed/DeathNoHeir copy).
Golden seeds:
- see docs/golden_seeds_v0.0.8.json

## v0.0.9

**Summary:** Tuning-only durability + stability (BASE_FERTILITY + birth/mortality/physician + unrest).

**Golden seeds:** see docs/golden_seeds_v0.0.9.json

**Policies:** prudent-builder, builder-forward, builder-forward/buffered (slash ID sanitized to builder-forward__buffered)

**Notes:** Measurement harness preserved from v0.0.8 (15T regression + 30T batches; Stable Finish + tails).

## v0.1.0
Summary:
- Hosted web build readiness (Vercel)
- No gameplay changes vs v0.0.9

SIM_VERSION:
- mvp_v0_1

Golden seeds:
- (use v0.0.9 seeds)
