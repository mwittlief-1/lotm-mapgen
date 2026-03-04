# Map v1 notes (v0.3 Commit 1)

## Runtime fetch path

The UI fetches the committed artifact at runtime from:

* `/data/map/map_v1.json` (served from `public/data/map/map_v1.json`)

The committed source of truth remains:

* `data/map/map_v1.json`

`npm run map:gen` writes **both** paths and they must remain identical.

## Determinism + provenance

* Map artifact is generated build-time via `npm run map:gen`.
* The artifact is deterministic for a given:
  * `MAPGEN_SEED`
  * `data/map/map_v1_config.json`
  * generator version (`map_schema_v1` subkey)

### Current committed seed

* `MAPGEN_SEED = MAPGEN_SEED_v0_3_001`

### Current committed config

* `data/map/map_v1_config.json`

`config_sha256` is embedded in the artifact.

## Commit 1 scope

* Counties + seats + settlements are present and render in the map-lite UI.
* Roads are **not** included.
* Hydrology fields may be present; UI ignores in v0.3.0.
  * `map:validate` only enforces hydrology rules if the metadata is present.

## QA artifacts

Generated under `qa_artifacts/` (not committed by default):

* `qa_artifacts/mapgen_metrics.json` (emitted by both gen + validate; validate recomputes and compares)
* `qa_artifacts/map_validate/report.json`
