# Map v1 preflight (v0.3)

This repo includes **contract-first** preflight scripts for the Map/Art/UX lane.

## Commands

### Generate the committed artifact

```bash
npm run map:gen -- --seed=MAPGEN_SEED_v0_3_001 --config=data/map/map_v1_config.json --out=data/map/map_v1.json
```

This writes:

* `data/map/map_v1.json` (committed)
* `public/data/map/map_v1.json` (runtime fetch path)
* `qa_artifacts/mapgen_metrics.json`

### Validate the artifact

```bash
npm run map:validate
```

Hard-fail invariants (v0.3.0):

* land hex count == 10,000 (tile_kind=land)
* 15 contiguous counties over land hexes
* 15 seats; exactly one capital seat
* exactly one primary port (port + is_primary_port=true), land + sea-adjacent
* (if hydrology metadata present) exactly one estuary component connected to sea, and exactly one major river component touching the estuary

Outputs:

* `qa_artifacts/map_validate/report.json`
* `qa_artifacts/mapgen_metrics.json` (recomputed + compared)

### Validate assets

```bash
npm run assets:validate
```

Contract:

* Manifest source of truth: `assets/asset_manifest_v1.json`
* required_keys.P0 and required_keys.MapP0 must all exist
* referenced asset files must exist on disk

Output:

* `qa_artifacts/assets_validate/report.json`

### Boundary check (hard boundary)

```bash
npm run boundary:check
```

Fails if anything in `src/sim/**` imports:

* `src/map/**`
* `assets/**`
* `data/map/**`

Output:

* `qa_artifacts/boundary_check/report.json`
