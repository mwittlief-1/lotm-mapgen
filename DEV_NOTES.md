# Dev Agent B — v0.2.6 Tooling Patch

Baseline: v0.2.5 certified deployable (Golden Layout).

## Goals (Dev B)
- Ensure batch harness supports the full **policy × prospectPolicy × horizon** grid without overwriting outputs.
- Ensure prospects telemetry (windows + outcomes) is correct and present in summaries.
- Add v0.2.6 packet hygiene scaffolding (seeds/knobs/known-issues) and convenience scripts.

## Changes

### 1) Batch artifact folder separation by prospectPolicy (P0 harness)
Updated both batch runners so the default output directory includes the prospect policy dimension:

- `artifacts/<app_version>/<policy_sanitized>/prospects_<prospectPolicy>/turns_<N>/`

This prevents `reject-all` / `accept-all` / `accept-if-net-positive` evidence runs from overwriting each other.

Files:
- `scripts/simBatch.ts`
- `scripts/simBatchNoDeps.mjs`

### 2) Fix no-deps prospects windows telemetry double-count
`scripts/simBatchNoDeps.mjs` previously incremented `windows_total` / `windows_by_turn` twice per turn when a ProspectsWindow existed.
This is now counted **exactly once per window**.

File:
- `scripts/simBatchNoDeps.mjs`

### 3) v0.2.6 harness/packet scaffolding
Added v0.2.6 plan + tasks + stabilization contract docs, plus packet scaffolding files:

- `docs/golden_seeds_v0.2.6.json`
- `docs/KNOBS_v0.2.6.json`
- `docs/KNOWN_ISSUES.md`

Also added convenience scripts:

- `scripts/runHarnessGrid_v026.mjs` — runs the full grid (policies × prospect policies × horizons) via the no-deps runner and verifies output folders.
- `scripts/preparePacketRoot_v026.mjs` — creates a packet-root folder containing BUILD_INFO + golden seeds + knobs + known issues.

## Files changed / added

**Changed**
- `scripts/simBatch.ts`
- `scripts/simBatchNoDeps.mjs`
- `DEV_NOTES.md`

**Added**
- `scripts/runHarnessGrid_v026.mjs`
- `scripts/preparePacketRoot_v026.mjs`
- `docs/contracts/v0.2.6_stabilization_contract.md`
- `docs/releases/v0.2.6_PLAN.md`
- `docs/releases/v0.2.6_TASKS_DEV_B.md`
- `docs/releases/v0.2.6_TASKS_BUILD_ENGINEER.md`
- `docs/releases/v0.2.6_TASKS_BALANCE.md`
- `docs/golden_seeds_v0.2.6.json`
- `docs/KNOBS_v0.2.6.json`
- `docs/KNOWN_ISSUES.md`

---

# Dev Agent A — v0.2.5 UI Patch

Baseline: v0.2.4 certified deployable (Golden Layout).

## Changes (UI-only)

### 1) Consumption labels (3-year turn consistency)
- Removed mixed "bushels/turn (turn=3y)" phrasing in tooltips and breakdowns.
- Updated consumption-related copy to consistently use **"this turn (3y)"** language.
- In *Consumption breakdown*, values now render as plain **bushels** with an explicit note: *All values are for this turn (3y).*

### 2) Turn Summary — population change reasons
- The Turn Summary population line now appends a reason breakdown when present (e.g., **Deaths**, **Runaways**, and any additional keyed causes).
- Implemented tolerant parsing of likely sim report shapes:
  - `population_change_breakdown`, `population_change`, `population_delta_breakdown`, `population_change_reasons`, `population_breakdown`, etc.

### 3) Marriage residence visibility
- Marriage accept toast now reflects residence rule:
  - If the subject child is **female (F)** → shows **"leaves your court"**.
  - Otherwise, if spouse name is known → shows **"spouse joins your court"**.
- Household **House Log** now renders marriage entries (`marriage`, `marriage_arranged`, `marriage_resolved`) including:
  - Basic outcome line (who married / which house).
  - Dowry details when provided.
  - Residence/court-size detail (joined vs left court), using explicit event fields when available or a safe fallback rule.

## Files changed
- `src/App.tsx`

## Notes / Constraints
- No sim logic, data contracts, routes, or screens added.
- No new hooks or conditional hook execution patterns introduced.

## Copy note
- The v0.2.5 binding UX copy pack (`ux_docs_v0.2.5.zip`) was not included in the provided inputs.
- Added only minimal, straightforward player-facing labels (e.g., "Deaths", "Runaways", "leaves your court") to unblock UI wiring.
- If final UX copy differs, these strings should be updated to the binding UX doc once it lands.
