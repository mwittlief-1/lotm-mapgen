# Branch & PR Hygiene (Mapgen)

Use this checklist to avoid recurring merge conflicts and branch drift.

## 0) Quick diagnostics

```bash
npm run repo:health
npm run repo:cleanup-plan
```

Use these two commands first to confirm branch/remotes state and print a safe cleanup command sequence.

## 1) Golden rules

- `main` is protected and receives changes via PR only.
- One branch = one topic = one PR.
- Always create new branches from latest `main`.
- Delete feature branches immediately after merge.
- Never reuse an old feature branch for a new task.

## 2) Before starting any new change

```bash
git checkout main
git pull --ff-only origin main
git checkout -b fix/<short-topic>
```

## 3) Before opening a PR

```bash
npm run repo:health
npm test
npm run qa
```

For map gallery publish/deploy changes:

```bash
npm run map:publish -- --no-batch
```

Verify these paths exist:

- `public/map_seed_batch/seed_gallery.html`
- `public/map_seed_batch/PLAY_A_001/layer_mask.png`
- `dist/map_seed_batch/seed_gallery.html`
- `dist/map_seed_batch/PLAY_A_001/layer_mask.png`

## 4) Merge strategy

- Prefer **Squash and merge** for cleaner history.
- Enable **Automatically delete head branches** in GitHub settings.
- If a PR has heavy conflicts in the same large files repeatedly, close it and create a fresh branch from `main`, then cherry-pick only needed commits.

## 5) Emergency conflict reset

```bash
git checkout main
git pull --ff-only origin main
git checkout -b rescue/<topic>
# cherry-pick only the required commits
```

Open a replacement PR and close the conflicted one.
