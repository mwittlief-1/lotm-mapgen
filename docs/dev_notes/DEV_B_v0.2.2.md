# DEV_NOTES — Dev Agent B patch v0.2.2 (Workstream B-1)

## Scope
Tooling/QA/Docs hygiene only. **No sim/gameplay logic changes.**

Workstream B-1 goal: fix batch runner stamping so `batch_summary.json` reflects the correct `app_version` (and optionally `code_fingerprint`), removing stale hard-coded `v0.0.9` values.

## Changes

### 1) `scripts/simBatch.ts`
- **Removed hard-coded `v0.0.9`** from default:
  - `baseSeed` (now `batch_<app_version>_<policy>`).
  - `outdir` (now `artifacts/<app_version>/<policy>/turns_<N>`).
- `app_version` + `code_fingerprint` are loaded from `docs/BUILD_INFO.json` (preferred source of truth).
- `batch_summary.json` now includes:
  - `app_version`
  - `code_fingerprint` (only if present in BUILD_INFO)

### 2) `scripts/simBatchNoDeps.mjs`
- **Fixed `batch_summary.json.app_version`**: previously hard-coded `"v0.0.9"`, now stamps from:
  - `docs/BUILD_INFO.json.app_version` if available, else fallback to `dist_batch/src/version.js` (`APP_VERSION`).
- Added optional `code_fingerprint` stamping from `docs/BUILD_INFO.json`.
- Aligned default `baseSeed` + `outdir` to use the same stamped version (`APP_VERSION_STAMP`).

## Why
Batch outputs were mixing correct artifact folder stamping (sometimes) with **incorrect summary stamping**, which breaks release hygiene and evaluation traceability. This patch makes the version and fingerprint explicit in the batch summary.

## How to verify
From repo root:

1) TS batch runner:
- `npm run sim:batch -- --runs=1 --turns=1`
- Check:
  - `artifacts/<app_version>/.../batch_summary.json` contains:
    - `"app_version": "<same as docs/BUILD_INFO.json.app_version>"`
    - `"code_fingerprint": "<same as docs/BUILD_INFO.json.code_fingerprint>"` (if present)

2) No-deps batch runner:
- `npm run sim:batch:no-deps -- --runs=1 --turns=1`
- Same check as above.

## Notes
- The summary schema only changed by **adding** `app_version` and optional `code_fingerprint`.
- No changes were made to sim core, policies, events, RNG streams, or gameplay behavior.
