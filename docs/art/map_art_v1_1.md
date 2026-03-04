# Map Art Direction — Hybrid Wash (v1.1)

**Last Updated:** 2026-02-17

## Locked Decisions
- Hybrid map: parchment + ink linework + monochrome terrain patterns (base), plus muted political wash (tier/type) under linework.
- Borders/claims remain stamped (ink + hatching/outline).
- Wash palette is CSS/theme tokens (not baked per-hex).

## Wash opacity targets
- Zoom OUT: 0.22
- Zoom IN: 0.12

## Wash palette tokens
See: `assets/palettes/map_wash_palette_v1.json`

## Color-blind safe mode
Washes must remain supplemental. Political readability should rely on:
- tokens (seat/market/port),
- stamped borders + hatching variants,
- patterns for terrain.
