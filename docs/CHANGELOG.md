# CHANGELOG (append-only)

## v0.0.5 — Content + Clarity
- Expanded event deck for variety; added/adjusted cooldowns to reduce repetition.
- Turn report: clearer top drivers + event “why/what changed” logging.
- Batch runner outputs include per-run improvement booleans and relationship bounds for QA clamps.
- Added allowed game-over reasons list (for QA).

## v0.0.4 — Tuning-only baseline
- Numeric tuning only (unrest curve, mortality/birth rates, event pacing knobs).

## v0.0.3 — Builders + Construction + Marriage + War Levy
- Farmers vs Builders workforce split + labor shift cap.
- Construction progress model; abandon rules (WP-06) and war levy coin fallback (WP-07).
- Marriage window, births, succession (male-preference primogeniture; widowed spouse retained).

## v0.0.5 — QA Hotfix (log snapshot bounding)
- Fixed TurnLogEntry snapshot_before/after to store bounded snapshots that never include log/history (prevents runaway growth/OOM during 15-turn QA gate).
- Added docs/BUILD_INFO.json build_fingerprint to prevent repo/playtest packet drift.

## v0.0.6 — Stabilize + Harden (harness/QA)
- Builder-forward policy-only contracts locked (WP-08 food buffer stall rule; WP-09 cheapest viable project selection).
- Batch runner telemetry expanded (construction path counters, min/max resource extremes, friendly completed_* columns).
- QA gate hardened: `npm run qa` writes JSON/JUnit artifacts to `qa_artifacts/` and fails if 0 tests are discovered.
- Builder-forward policy: sell plan respects food buffer (no selling below 1.2× consumption estimate).

## v0.0.7 — Policy IDs + Matrices + Artifact Sanitation
- Policy registry locked: `prudent-builder`, `builder-forward`, `builder-forward/buffered` (alias `good-faith` -> `prudent-builder`).
- Artifact folder sanitizer locked (WP-10): `/` -> `__` (prevents nested dirs for `builder-forward/buffered`).
- Builder-forward improvement selection locked (WP-11): canonical priority order (first viable) rather than cheapest.
- Added `npm run matrices` to generate reference content/policy tables under `docs/matrices/`.
- Batch runner telemetry extended to include min/max unrest, arrears, and energy.

## v0.0.7a — QA hotfix
- `npm run qa` falls back to a no-deps gate when npm install cannot complete.
- Added `dist_batch/` compiled outputs for sim/content.
- Added `scripts/qaNoDeps.mjs` emitting `qa_artifacts/v0.0.7a_no_deps_gate.json`.

## v0.0.8 — 2026-02-11
- Harness/telemetry evaluation contract update (30-turn readiness).
- sim:batch telemetry expanded (stable finish, tails, horizon tagging).
- 30-turn batch support (100–150 runs) for prudent-builder and builder-forward.
- Golden seeds updated for v0.0.8 (15-turn horizon).
- No gameplay system changes.
- Patch: sim:batch default outdir includes turns_<N> (prevents 15/30 clobber).
- Patch: no-deps QA artifact filename derives from APP_VERSION; BUILD_INFO policy drift check added.
- Patch: UI game-over banner clarity (Dispossessed/DeathNoHeir copy + turn index).

## v0.0.9 — 2026-02-12

- Tuning-only durability/stability pass (no new systems).
- Birth odds increased; fertility window extended; BASE_FERTILITY slightly increased (durability + stability).
- Child/heir mortality reduced; Physician mortality reduction strengthened.
- Arrears→Unrest penalty reduced; stable Unrest decay increased.
- Harness unchanged: 15T regression + 30T batches + Stable Finish + tails.

## v0.1.0 — 2026-02-12
- Hosted web distribution readiness: added vercel.json SPA rewrites, pinned Node engine, package-lock generation.
- No gameplay changes; mechanics identical to v0.0.9 baseline.
