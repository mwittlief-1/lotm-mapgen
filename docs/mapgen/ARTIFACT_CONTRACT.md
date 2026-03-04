# Mapgen Artifact Contract

## Inputs

Map generation is defined by:

- `--seed` (map seed string)
- `--config` (map config JSON)

For identical seed + config content, `map_v1.json` output must be deterministic.

## Deterministic output (`map_v1.json`)

`map_v1.json` is the contracted map artifact and must not contain volatile metadata.

In particular, it must not include:

- wall-clock generation timestamps (for example `generated_at`)
- machine-specific absolute file paths

Useful run metadata should be emitted to report artifacts instead.

## Run outputs (untracked)

Batch runs write to:

- `qa_runs/map_seed_batch/<PLAY_ID>/map_v1.json`
- `qa_runs/map_seed_batch/<PLAY_ID>/mapgen_report.json`
- `qa_runs/map_seed_batch/<PLAY_ID>/map_validate_report.json`
- `qa_runs/map_seed_batch/<PLAY_ID>/mapgen_metrics.json`

`qa_runs/` is intentionally untracked and intended for local/CI run artifacts.

## Determinism boundary

Determinism applies to content artifacts generated from seed + config (not wall-clock metadata):

- Contracted map JSON remains stable for the same inputs.
- Volatile diagnostics (timestamps, execution context, output paths) belong in report JSON files.
