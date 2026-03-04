# map_schema_v1

This document describes the **Map v1** contract artifact produced by `npm run map:gen` and consumed by the **presentation-only** Mapboard shell.

## Goals

* Deterministic, build-time **static** artifact.
* Safe for UI usage only (no simulation coupling).
* Canonical enumeration and IDs so tooling and QA can rely on stable references.

## File locations

* Committed source of truth: `data/map/map_v1.json`
* Runtime-served copy: `public/data/map/map_v1.json` (fetched by UI at `/data/map/map_v1.json`)

Both files must be identical.

## Locked invariants

* Coordinates: **axial** `(q, r)`.
* Storage: **row-major** array enumeration.
  * `index = r * width + q`
  * `hex_id = "hx_" + index` (no padding)
* Neighbor direction order (for any algorithm requiring deterministic neighbors):
  1. E  `( +1,  0)`
  2. NE `( +1, -1)`
  3. NW `(  0, -1)`
  4. W  `( -1,  0)`
  5. SW `( -1, +1)`
  6. SE `(  0, +1)`

## Top-level shape

```ts
interface MapV1 {
  schema_version: "map_schema_v1";
  width: number;
  height: number;

  // Optional provenance
  generated_at?: string;      // ISO timestamp
  mapgen_seed?: string;       // MAPGEN_SEED used
  config_sha256?: string;     // sha256 of data/map/map_v1_config.json

  hexes: HexV1[];             // length = width * height
  counties: CountyV1[];       // v0.3: 15
  seats: SeatV1[];            // v0.3: 15 (1 per county)
  settlements: SettlementV1[];
}
```

## Hexes

```ts
type TileKind = "land" | "sea" | "void";

type TerrainType = "sea" | "coast" | "plains" | "forest" | "hills" | "marsh" | "mountains";

interface HexHydrology {
  // Optional metadata (UI may ignore in v0.3.0)
  water_kind?: "sea" | "estuary";
  river_class?: "major" | "minor" | "stream";
}

interface HexV1 {
  hex_id: string;             // hx_<index>
  q: number;
  r: number;

  tile_kind: TileKind;
  terrain: TerrainType;

  // County ownership
  county_id: string | null;   // required for land; must be null on sea/void

  hydrology?: HexHydrology | null;
}
```

### Notes on land/sea/void

* **`land_hex_target = 10000`** counts **only** `tile_kind="land"` hexes.
* Sea hexes are **additional** and are not owned by counties.
* Void hexes are optional padding used to represent out-of-realm boundary (also not owned).

## Counties

```ts
interface CountyV1 {
  county_id: string;
  name: string;
  hex_ids: string[];          // land hexes only (contiguous)
}
```

## Seats

```ts
interface SeatV1 {
  seat_id: string;
  county_id: string;
  hex_id: string;             // land hex in that county
  is_capital?: boolean;       // exactly one true
}
```

## Settlements

```ts
type SettlementKind =
  | "hamlet" | "village" | "town" | "market"
  | "abbey" | "bishopric" | "port";

interface SettlementV1 {
  settlement_id: string;
  settlement_kind: SettlementKind;
  hex_id: string;             // land hex
  name?: string;

  // Port
  is_primary_port?: boolean;  // exactly one port has true

  // Bishopric flags
  is_cathedral?: boolean;
  is_metropolitan?: boolean;  // exactly one bishopric has true
}
```
