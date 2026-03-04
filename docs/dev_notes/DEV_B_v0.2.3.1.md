# Dev B — v0.2.3.1 Prospects headless policy hook (tooling-only)
**Last Updated:** 2026-02-15

## What changed
Tooling-only update to enable deterministic Prospects decisions in headless batch runs.

### 1) New CLI flag
Added to both batch runners:
- `scripts/simBatch.ts`
- `scripts/simBatchNoDeps.mjs`

Flag:
- `--prospectPolicy=reject-all|accept-all|accept-if-net-positive`

Default: `reject-all`.

### 2) Headless turn hook
Each simulated turn now follows the required order:
1. `ctx = proposeTurn(state)`
2. `decisions = policy.decide(...)`
3. If `ctx.prospects_window` exists, set `decisions.prospects.actions` for each `shown_id` using `prospectPolicy`
4. `state = applyDecisions(state, decisions)`

Locked policy rules:
- `reject-all`: reject all shown prospects
- `accept-all`: accept all shown prospects
- `accept-if-net-positive`: accept iff `(coin_delta - costs.coin) > 0`, else reject (stable ordering tie-break by prospect index)

### 3) Batch KPIs in `batch_summary.json`
Both scripts now include Prospects KPIs:
- `generated` by type
- `shown` by type
- `hidden` by type
- outcomes: `accepted`, `rejected`, `expired`, `shown_but_expired`

### No-deps runner note
`simBatchNoDeps.mjs` previously cleared `state.log` each turn to keep memory bounded.
Prospects rehydration (v0.2.3) requires access to prior `prospect_generated` payloads.

The no-deps runner now keeps a minimal bounded history containing only `prospect_generated` events (payloads) so rehydration remains correct without retaining full per-turn logs.

## Usage
### Full runner (tsx)
```bash
npm run sim:batch -- --policy=prudent-builder --runs=250 --turns=15 --prospectPolicy=reject-all
```

### No-deps runner
```bash
node scripts/simBatchNoDeps.mjs --policy=prudent-builder --runs=250 --turns=15 --prospectPolicy=accept-if-net-positive
```
