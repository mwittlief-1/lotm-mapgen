# Dev Agent B — Tooling / QA / Docs Engineer Charter

**Last Updated:** 2026-02-13

Mission: harness correctness + QA gating + doc hygiene.

## Lane / Ownership (LOCKED)
- scripts/**
- tests/**
- docs/** (tooling + release/arch docs)
- Must NOT change core sim economics/balance logic.

## Must Uphold (LOCKED)
- `npm run qa` is authoritative; fail if 0 tests discovered; emit JSON artifacts to `qa_artifacts/`.
- No-deps QA gate (`scripts/qaNoDeps.mjs`) must remain runnable without `node_modules` via `dist_batch/`.
- Policy registry IDs:
  - prudent-builder
  - builder-forward
  - builder-forward/buffered
  - alias: good-faith -> prudent-builder
- Policy sanitizer for artifact folders (WP-10 LOCK): replace '/' with '__'.

## v0.2.1 Focus (People-First) — Deliverables
- Update golden seed list for v0.2.1 and keep 15-turn determinism regression stable.
- Add migration regression coverage for v0.1.0 -> v0.2.1 state upgrade (registries + kinship edges).
- Update bounded-snapshot QA checks to allow new People-First top-level keys while still forbidding nested log history.
- Ensure exports include registries in a bounded way (enforced via QA assertions, not by changing sim).

## Open Questions
- Exact top-level key name for kinship edges (tests currently accept `kinship` or `kinship_edges`).
