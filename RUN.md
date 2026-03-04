# Lords of the Manor — MVP (v0.1.0)

This repo contains the web MVP + deterministic simulation core + batch/QA harness.

## Install / Run (UI)
```bash
npm install
npm run dev
```

## Policy IDs
- prudent-builder (alias: good-faith)
- builder-forward
- builder-forward/buffered (artifact folder sanitized to builder-forward__buffered)

## Batch runner (headless)
```bash
npm run sim:batch -- --policy=prudent-builder --runs=250 --turns=15
npm run sim:batch -- --policy=builder-forward --runs=250 --turns=15
# optional (diagnostic)
npm run sim:batch -- --policy=builder-forward/buffered --runs=250 --turns=15
```

Outputs are written under:
- `artifacts/v0.1.0/<policy_sanitized>/`

Policy sanitizer (WP-10 LOCK):
- `builder-forward/buffered` → `builder-forward__buffered`

## QA gate
```bash
npm run qa
```

This runs:
- determinism tests
- invariants/clamps tests
- golden-seed determinism checks

## Policy identifiers (canonical)
- `prudent-builder` (baseline)
- `builder-forward` (stress)
  - Canonical temptation path (no buffer-floor stall).
- `builder-forward/buffered` (diagnostic)
  - Buffered variant (may stall builders under food buffer floor).

Aliases (supported):
- `good-faith` -> `prudent-builder`

## Content matrices (docs)
```bash
npm run matrices
```
Writes reference CSV/MD tables to `docs/matrices/`.


QA artifacts are written to `qa_artifacts/` (vitest.json + junit.xml when supported).


## QA gate fallback (no-install path)

`npm run qa` is authoritative.
- If `node_modules/.bin/vitest` exists, it runs Vitest and writes `qa_artifacts/vitest.json`.
- Otherwise it runs a no-deps gate against `dist_batch/` and writes `qa_artifacts/<APP_VERSION>_no_deps_gate.json`.



## v0.1.0 Evaluation
- 15-turn regression: 250 runs (prudent-builder, builder-forward)
- 30-turn readiness: 100–150 runs (prudent-builder, builder-forward)
- Stable Finish KPI: end_unrest<=40 AND end_arrears_bushels<=100


## No-deps batch runner (if npm install is unavailable)
- npm run sim:batch:no-deps -- --policy=prudent-builder --runs=250 --turns=15


## 30-turn readiness batches (v0.1.0 evaluation contract)
Run 100–150×30 for separation over dynastic horizon:

```bash
npm run sim:batch -- --policy=prudent-builder --runs=120 --turns=30
npm run sim:batch -- --policy=builder-forward --runs=120 --turns=30
```

Artifacts are written to:
- `artifacts/v0.1.0/<policy_sanitized>/turns_<N>/`

## Stress KPIs (v0.1.0 standard)
Balance should report (per horizon):
- Completion rate
- Stable Finish rate:
  - Stable Finish = end_unrest <= 40 AND end_arrears_bushels <= 100 AND not game_over
- Tail risks:
  - % ending unrest >= 80
  - % ending arrears_bushels >= 1000
  - % where min_bushels == 0


## Hosting (Vercel)
- Framework: Vite
- Install: npm ci
- Build: npm run build
- Output: dist
- SPA routing: vercel.json rewrites included.
