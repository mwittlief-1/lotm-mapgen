# Overlay v26 — Border reshave unblocked + straight-border penalty + inward snap

## Intent
- Fix `reshave.adds/dels = 0` no-op by allowing reshave to trade with **adjacent inland water/sea tiles** (non-edge) by converting them to land when added.
- Add a **straight-border penalty** to discourage long facet runs ("Northwest Territory" look).
- Allow **inward snap** by trimming down toward `landMin` (tolerance) and removing the forced exact `landTarget` rebalance after hole-fill.

## Files changed
- `scripts/mapGenV1.mjs`

## Key behavior changes
1) **Frontier candidates** now include adjacent tiles that are either:
   - `tile_kind == "land"`, or
   - `tile_kind == "sea"` with `distToWorldEdge > 2` (i.e., not the outer ocean).
   If a sea tile is selected during reshave add-phase, it is converted to `tile_kind = "land"` (borderlands).

2) **Straight-border penalty**
   - Adds `remask.reshave_straight_penalty` knob (default 2500).
   - Frontier sort uses `dist + penalty * straightPairsAt(idx)`.
   - Boundary deletion sort uses `dist - penalty * straightPairsAt(idx)` so we preferentially delete tiles that contribute to long straight runs.

3) **Inward snap + tolerance**
   - Phase-B trim stops only at `landMin` (not at `landTarget`).
   - Post hole-fill rebalance now clamps within `[landMin, landMax]` instead of forcing exact `landTarget`:
     - `trimToTarget(landMax)`
     - `growToTarget(landMin)`

## How to test
```bash
npm run map:gen -- --seed PLAY_C_005 --config data/map/map_v1_config.json --out qa_artifacts/tmp_map_v1.json
node -e "const r=require('./qa_artifacts/mapgen/report.json'); console.log(r.remask.reshave)"
```
Expected: `adds > 0` and `dels > 0`.

Then:
```bash
npm run map:batch
```
Confirm borders are less faceted and `remask.reshave` shows non-zero adds/dels in reports.
