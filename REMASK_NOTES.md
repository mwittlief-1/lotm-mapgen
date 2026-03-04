# M3 Remask: Rounded kingdom border inside an expanded context ring

This build adds a **kingdom border re-mask pass** that breaks the straight “megahex” land-border edges without changing the target land hex count.

## What it does

1. **Expands the world radius** by a small `context_buffer` (default `10`) to create a ring of extra, temporary “context” hexes around the original realm.
2. Keeps the **ocean carve anchored** to the original `world_radius` (treated as the **core radius**) so the coastline stays where it was tuned.
3. Runs a **Dijkstra re-mask** to select exactly `realm_hexes_land_target` land hexes:
   - Seeds = all land within a central **seed radius** (plus protected tiles like the estuary/river mouth).
   - Expansion cost includes:
     - **Penalties near the old straight land-border planes** (creates rounding / dents / bulges)
     - **Frontier rails** outside the core (ridge wall + frontier river) acting as near-hard boundaries
     - Light noise + mild radial penalty to keep the edge organic
   - After selection, we **fill enclosed land pockets** (no enclaves) and then trim/grow back to the exact target count.
4. Any world-land hex **not selected** becomes `tile_kind="void"` (off-map / neighboring realm placeholder).

## Fast iteration

Generate a single map:

```bash
node scripts/mapGenV1.mjs \
  --seed=PLAY_A_001 \
  --config=data/map/map_v1_config.json \
  --out=out/map.json \
  --publicOut=out/map_public.json \
  --metricsOut=out/map_metrics.json \
  --reportOut=out/map_report.json
```

Render a quick PNG:

```bash
node scripts/renderOnePreviewV1.mjs \
  --in=out/map.json \
  --out=out/preview.png \
  --mode=terrain_counties
```

## Config knobs

All knobs live under `mapgen.remask` in `data/map/map_v1_config.json`.

### Core / ring

- `context_buffer` (default `10`)
  - How many rings of extra world context to add beyond `world_radius`.
  - If you increase this, make sure the grid is large enough to contain the expanded radius.

- `seed_radius` (default `~0.75*world_radius`)
  - Radius around the map center that is always considered **in-kingdom** (plus protected tiles).
  - Smaller = border can eat further inward and/or bulge outward more.
  - Larger = more stable interior, but more “megahex-like” borders.

- `kernel_margin`
  - Legacy fallback for older configs (only used if `seed_radius` is not set).

### Rounding pressure

- `plane_band_width` (default `5`)
  - Thickness of the band (on **both sides** of the old straight border plane) where we penalize hugging the old megahex outline.

- `plane_penalty_slope` (default `18`)
  - Strength of that penalty. Bigger = stronger rounding (more likely to swap tiles out near the old straight edge and swap in tiles in the outer ring).

- `plane_meander_scale` / `plane_meander_amp` and the `*2` variants
  - Adds smooth(ish) variation along each side so the edge doesn’t dent uniformly.
  - Scale = wavelength, amp = magnitude.

### Secondary shaping

- `radial_penalty_slope` (default `6`)
  - Discourages far-out bulges beyond the core radius.

- `noise_scale`, `noise_amp`
  - Adds gentle variation so the expansion isn’t perfectly symmetric.

### Frontier rails

Rails sit **outside** the core and behave like near-hard boundaries.

- `enabled_frontier_rails` (default `true`)
- Ridge wall:
  - `frontier_ridge_offset` (how far outside the core)
  - `frontier_ridge_belt_radius`
  - `frontier_ridge_penalty`
  - `frontier_ridge_meander_scale` / `frontier_ridge_meander_amp`
- Frontier river:
  - `frontier_river_offset`
  - `frontier_river_belt_radius`
  - `frontier_river_penalty`
  - `frontier_ford_penalty`
  - `frontier_river_ford_count`
  - `frontier_river_meander_scale` / `frontier_river_meander_amp`

### Cleanup

- `smooth_passes` (default `1`)
  - Simple hole-fill + spike-prune on the selected land mask.

Note: Even with `smooth_passes=0`, we still run the explicit **enclave fill** (absorbing enclosed non-kingdom land pockets).
