# Lords of the Manor — MVP

Version: **v0.1.0** (APP_VERSION)

This is a deterministic, seeded manor-management prototype with:
- a pure simulation core (`src/sim/`)
- content definitions (`src/content/`)
- a minimal UI (`src/`)
- a headless batch runner (`npm run sim:batch`)
- QA gate (`npm run qa`)

See `RUN.md` for commands.


## Map Quickstart

```bash
npm ci
npm run map:batch
npm run map:review
```

Batch map artifacts are written to `qa_runs/` (untracked), under `qa_runs/map_seed_batch/`.
`map:review` runs the batch generator and then opens the gallery HTML when possible (otherwise it prints the absolute path).
