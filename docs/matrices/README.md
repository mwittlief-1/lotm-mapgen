# Matrices (content + policy reference)

**Last Updated:** 2026-02-11

This folder holds **generated reference tables** (“matrices”) used by QA/Balancing/Design to quickly scan what content exists in a build.

Why this exists:
- Makes it easy to diff versions without reading TypeScript.
- Provides stable CSVs for spreadsheet workflows (sorting, pivots, quick filters).

## Generate / refresh

From repo root:

```bash
npm run matrices
```


Outputs (overwritten in-place):
- `docs/matrices/improvements_matrix.csv`
- `docs/matrices/improvements_effects.md`
- `docs/matrices/events_matrix.csv`
- `docs/matrices/events_effects.md`
- `docs/matrices/policies_matrix.md`


## Notes

- These are **reference outputs** only; the simulation remains the source of truth.
- Policy IDs may contain `/` (example: `builder-forward/buffered`).
  - Artifact folder names must be sanitized: `/` → `__`.
