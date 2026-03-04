export type TileKind = "land" | "sea" | "void";

export type TerrainType = "sea" | "lake" | "coast" | "plains" | "forest" | "hills" | "marsh" | "mountains";

export type RiverClass = "major" | "minor" | "stream";
export type WaterKind = "sea" | "estuary" | "lake" | "border_river";

export interface HexHydrology {
  river_class?: RiverClass;
  water_kind?: WaterKind;
}

export interface HexV1 {
  hex_id: string;
  q: number;
  r: number;
  tile_kind: TileKind;
  terrain: TerrainType;
  county_id: string | null;
  hydrology?: HexHydrology | null;
}

export interface CountyV1 {
  county_id: string;
  name: string;
  hex_ids: string[];
}

export interface SeatV1 {
  seat_id: string;
  county_id: string;
  hex_id: string;
  is_capital?: boolean;
}

export type SettlementKind =
  | "seat"
  | "hamlet"
  | "village"
  | "town"
  | "market"
  | "abbey"
  | "bishopric"
  | "port";

export interface SettlementV1 {
  settlement_id: string;
  settlement_kind: SettlementKind;
  hex_id: string;
  name?: string;
  is_primary_port?: boolean;
  is_cathedral?: boolean;
  is_metropolitan?: boolean;
}

export interface MapV1 {
  schema_version: "map_schema_v1";
  width: number;
  height: number;
  hexes: HexV1[];
  counties: CountyV1[];
  seats: SeatV1[];
  settlements: SettlementV1[];
  generated_at?: string;
  mapgen_seed?: string;
  config_sha256?: string;
}
