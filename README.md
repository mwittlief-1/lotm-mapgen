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

## Hosted Map Gallery (Mirror Repo / Vercel)

```bash
npm run map:publish
```

This runs the map batch and publishes a static gallery snapshot under `public/map_seed_batch/`.
When deployed, open:

- `/map_seed_batch/seed_gallery.html`
- or `/map_gallery_index.html` (redirect helper)

Use `npm run map:publish -- --no-batch` to publish the latest existing `qa_runs/map_seed_batch/` without regenerating maps.

