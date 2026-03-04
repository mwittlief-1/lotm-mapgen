# Dev Agent B — v0.2.5 realism pass (sim/data)

## Scope
Implements **v0.2.5_realism_contract** P0 locks for sim/data correctness and realism.

**No UI changes.**  
Changes are limited to `src/sim/*`, `tests/*`, and `docs/*`.

## Implemented locks

### 1) Population semantics (labor pool) + stable-ish start
- `manor.population` is treated as the **labor pool**.
- **Idle consumes** (already true in prior builds; retained).
- Starter run now initializes with **higher farmer allocation** to avoid a large idle surprise (`farmers: 36` of `population: 45`).

### 2) Court affordability (start small)
- Court starts with **only a Steward** officer by default.
- **Clerk** and **Marshal** are no longer auto-generated at start (future: hire/event).

### 3) Marriage residence
- **Daughters marry out**: the married daughter is removed from `house.children` (no longer appears in court roster).
- **Sons marry in only if heir / eldest son**: spouse is added to `court_extra_ids`; otherwise the son marries out.

### 4) Officers male + aging
- Court officers are enforced as **male**.
- Court officers now **age each turn** (turn = 3 years), preventing immortal officers.

### 5) Disable same-sex marriage prospect generation
- Marriage offers are generated for **one subject child** (eldest eligible) and pulled from **opposite-sex** nobles.
- Accept-time enforcement also blocks same-sex acceptance for legacy/edge states.

### 7) Population change visibility (runaways vs deaths)
- Shortage-driven population loss is deterministically split into:
  - `deaths`
  - `runaways`
- Added `TurnReport.household.population_change_breakdown` with schema `population_change_breakdown_v1`.

## Tests
- Updated legacy v0.2.4 court test expectations to match v0.2.5 semantics.
- Added new v0.2.5 realism tests covering:
  - stable-ish initial labor allocation
  - officer sex + aging
  - opposite-sex marriage offers
  - marriage residence (daughters marry out)
  - population change breakdown under shortage
