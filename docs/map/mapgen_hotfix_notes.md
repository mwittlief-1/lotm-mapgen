# Mapgen Hotfix M2 — Spiral Caps, Jagged Coast, Seat Diagnostics

Last Updated: 2026-02-20

## Summary
This bundle applies a **presentation-only** mapgen hotfix focused on:

- Preventing **one-hex / tiny counties** via deterministic **seat viability check + relocation** and a deterministic **spiral seeding + round-robin** county assignment.
- Enforcing **hard county caps** everywhere (`assignedCount[c] <= cap`).
- Making the coastline **significantly more jagged** using a deterministic **straight-run breaker** after the existing coastal perturbation.
- Improving PNG preview diagnostics by drawing **county seats + ring-1 neighbors** in **black**.

No gameplay systems are changed; this is map generation + presentation-only.

## Knobs
These are read from `data/map/map_v1_config.json` (with defaults shown):

### County sizing
- `mapgen.counties.mu` (default **1.3**)
  - `cap = ceil(mu * avg)`
- `mapgen.counties.alpha` (default **0.25**)
  - `seed_quota = ceil(alpha * avg)`
- `mapgen.counties.seat_viability_radius` (default **6**)
- `mapgen.counties.seat_viability_floor` (default **25**)

Targets:
- `avg = landCount / countyCount`
- `target[c] = floor(avg)` and distribute remainder deterministically by county loop order (distance-to-center order).

### Coastline straight-run breaker
- `mapgen.coast.max_straight_run` (default **8**)
- `mapgen.coast.max_breaks` (default **500**)

## Determinism
- Axial coords `(q,r)` and locked neighbor direction order (`E, NE, NW, W, SW, SE`).
- No iteration over object keys without sorting.
- Coast breaker and seat selection use deterministic hashing keyed by `seed`.

## Outputs
Mapgen writes `--reportOut` JSON (default `qa_artifacts/mapgen/report.json`) containing:

- `coast.max_straight_run_overall`
- `coast.max_straight_run_by_dir[6]`
- `coast.coast_breaks_applied`
- `counties.min/max/avg`
- `counties.counties_over_cap` (must be 0)
- `counties.unassigned_land` (must be 0)

