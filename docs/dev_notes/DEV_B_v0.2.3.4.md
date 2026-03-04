# DEV_B v0.2.3.4 (Sim/Data correctness + minimal grant semantics)

## Scope

Patch targets **sim/types/tests/docs** only (no UI changes).

## P0 fixes

### 1) Death-turn state consistency

* **Household roster is now embedded into `TurnReport`** (`report.household_roster`).
  * This ensures the Turn Report payload has a consistent household snapshot for the processed turn (including `deceased` badge) and avoids "dead head still ruling" presentations caused by reconstructing roster from multiple sources.
* Heir selection is **recomputed after births/deaths** during turn proposal, preventing the roster/report from pointing at a deceased heir.

### 2) Roster uniqueness + stable IDs

* `HouseholdRosterRow.person_id` remains the stable identifier.
* Roster rows are deduped by `person_id` (no separate "heir person" rows).
* The roster snapshot is included in both:
  * `TurnContext.household_roster` (for current-turn UI)
  * `TurnReport.household_roster` (for historical reports)

### 3) Labor oversubscription signal

* If labor is oversubscribed **entering a turn** (e.g., edited/legacy state), the sim now clamps labor **immediately before** production/consumption math.
  * Deterministic rule: **cut builders first**, then farmers.
* The existing `report.labor_signal` is emitted for this case, making oversubscription detectable even when it was created by edits.

## P1: Minimal grant semantics

Grant prospects are no longer ambiguous:

* `predicted_effects` is populated:
  * `coin_delta`: deterministic grant amount (bounded)
  * `relationship_deltas`: a small deterministic change representing increased liege leverage
  * `flags_set`: empty array (no new flag system)
* Decision tradeoff:
  * **Accept**: gains coin immediately; applies the relationship deltas.
  * **Reject**: no-op.
* Prospect rejection no longer applies `predicted_effects` (those are acceptance effects).

## Tests

Added `tests/v0234_dev_b_patch.test.ts` to assert:

* TurnReport embeds `household_roster` and marks deceased on the death turn.
* Labor oversubscription entering a turn triggers `report.labor_signal` and clamps deterministically.
* Grant `predicted_effects` are populated and accept vs reject differs deterministically.
