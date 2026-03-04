# Visual Language v1 — Map-lite UI + Badges + Chips

**Last Updated:** 2026-02-17

## Locked Decisions
- Map is **HYBRID**: parchment + ink linework + monochrome terrain patterns, plus muted political wash **under** linework.
- Tier-wash is the default political readability layer.
- Accessibility: map must remain legible with wash reduced/removed using **patterns + stamped borders + tokens**.

---

## Metric icons (compact UI)
- Food: `icon.metric.food`
- Coin: `icon.metric.coin`
- Unrest: `icon.metric.unrest`
- Court: `icon.metric.court`
- Prospects: `icon.metric.prospects`
- Death: `icon.metric.death`
Fallback: `icon.fallback.generic`

## Map tokens (markers)
- Seat: `map_token.seat`
- Settlements by kind:
  - hamlet → `map_token.hamlet`
  - village → `map_token.village`
  - town → `map_token.town`
  - abbey → `map_token.abbey`
  - bishopric → `map_token.bishopric`
  - market → `map_token.market` (optional)
  - port → `map_token.port` (required for v0.3 archetype)
  - fallback → `map_token.fallback.settlement`

## Badges (Roster / People surfaces)
Badge set:
- Heir
- Married
- Widowed
- Officer: Steward / Clerk / Marshal

Ordering:
- If Deceased (future): show only Deceased.
- Else: Heir → Married → Widowed → Officer.

Style:
- 18–20px height, radius 10px, 1px ink border, paper fill.
- Text 12px, tracked; avoid relying on hue-only meaning.

## Tag chips (Event / Prospect impacts)
Chips are icon + label:
- Food, Wealth, Unrest, Relations, Succession
Rule: do not rely on color alone; icon/label is primary.

## Typography hierarchy
- Title: 18–20px serif (Cormorant Garamond), slightly tracked
- Subtitle: 14–15px sans (Source Sans 3), medium
- Body: 14–16px sans
- Secondary: 12–13px sans, muted ink
Numbers: tabular numerals for stats.

## Color-blind safe mode intent
If wash is reduced/removed:
- Terrain = patterns + linework
- Control/claims = stamped borders + hatch variants
- Nodes = tokens (seat/settlement kind glyphs)

Suggested toggle:
- wash_opacity *= 0.25
- border_stamp_intensity += 1 step
- token_visibility = always_on
