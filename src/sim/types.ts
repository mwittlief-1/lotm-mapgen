import { SIM_VERSION } from "./version";

export type SimVersion = typeof SIM_VERSION;

export type Sex = "M" | "F";
export type TraitKey = "stewardship" | "martial" | "diplomacy" | "discipline" | "fertility";

export type Traits = Record<TraitKey, number>; // 1..5

export interface Person {
  id: string;
  name: string;
  sex: Sex;
  age: number; // years
  alive: boolean;
  traits: Traits;
  married?: boolean;
}

export interface RelationshipEdge {
  from_id: string;
  to_id: string;
  allegiance: number; // 0..100
  respect: number; // 0..100
  threat: number; // 0..100
}

export type KinshipEdge =
  | { kind: "parent_of"; parent_id: string; child_id: string }
  | { kind: "spouse_of"; a_id: string; b_id: string };

export type HouseLogEventKind = "widowed" | "succession" | "heir_selected";

export interface HouseLogEvent {
  kind: HouseLogEventKind;
  turn_index: number;
  // For templated outcome lines (UX binding): keep only the minimal IDs/names.
  spouse_name?: string;
  // v0.2.3.2+: widowed is a household-status transition; provide both survivor + deceased.
  // (UI can choose which copy line to render.)
  survivor_name?: string;
  survivor_id?: string;
  survivor_sex?: Sex;
  deceased_name?: string;
  deceased_id?: string;
  deceased_age?: number;
  heir_name?: string;
  new_ruler_name?: string;
}

export type WarLevyDue =
  | null
  | {
      kind: "men_or_coin";
      men: number;
      coin: number;
      created_turn: number;
    };

export interface ObligationsState {
  tax_due_coin: number;
  tithe_due_bushels: number;
  arrears: { coin: number; bushels: number };
  war_levy_due: WarLevyDue;
}

export interface ConstructionState {
  improvement_id: string;
  progress: number;
  required: number;
}

export interface ManorState {
  population: number;
  farmers: number;
  builders: number;
  bushels_stored: number;
  coin: number;
  unrest: number; // 0..100
  improvements: string[];
  construction: ConstructionState | null;
  obligations: ObligationsState;
}

export interface HouseState {
  head: Person;
  spouse?: Person;
  spouse_status?: "spouse" | "widow";
  children: Person[];
  energy: { max: number; available: number };
  heir_id?: string | null;
}

export interface LocalsState {
  liege: Person;
  clergy: Person;
  nobles: Person[];
}

export interface GameOverState {
  reason: "Dispossessed" | "DeathNoHeir";
  turn_index: number;
  details?: Record<string, unknown>;
}

export interface RunState {
  version: SimVersion;
  app_version: string;
  run_seed: string;
  turn_index: number;
  manor: ManorState;
  house: HouseState;
  locals: LocalsState;
  relationships: RelationshipEdge[];
  // v0.2.1 People-First registries (may be absent in legacy saves; migrate deterministically in proposeTurn/applyDecisions)
  people?: Record<string, Person>;
  houses?: Record<string, unknown>;
  player_house_id?: string;
  kinship_edges?: KinshipEdge[];
  kinship?: KinshipEdge[];
  flags: Record<string, unknown>;
  log: TurnLogEntry[];
  game_over?: GameOverState | null;
}

export type HouseSummary = Pick<HouseState, "head" | "spouse" | "spouse_status" | "children" | "energy" | "heir_id">;

/**
 * Bounded snapshot for TurnLogEntry.
 * Must NEVER include `log` or any nested history.
 * (Fix for v0.0.5 QA blocker: runaway log growth / OOM.)
 */
export interface RunSnapshot {
  turn_index: number;
  manor: ManorState;
  house: HouseSummary;
  relationships: RelationshipEdge[];
  // v0.2.1 People-First (optional; included for migration/debug; must remain bounded)
  people?: Record<string, Person>;
  houses?: Record<string, unknown>;
  player_house_id?: string;
  kinship_edges?: KinshipEdge[];
  kinship?: KinshipEdge[];
  flags: Record<string, unknown>;
  game_over?: GameOverState | null;
}

export type EventCategory =
  | "weather"
  | "economic"
  | "security"
  | "religious"
  | "political"
  | "military"
  | "personal"
  | "social"
  | "construction";

export interface EventWhy {
  weight: number;
  roll: number;
  notes: string[];
}

export interface EventDelta {
  key:
    | "bushels"
    | "coin"
    | "unrest"
    | "population"
    | "tax_due_coin"
    | "tithe_due_bushels"
    | "arrears_coin"
    | "arrears_bushels"
    | "construction_progress";
  before: number;
  after: number;
  diff: number;
}

export interface EventResult {
  id: string;
  title: string;
  category: EventCategory;
  why: EventWhy;
  effects: string[]; // plain-language
  deltas: EventDelta[];
}

export interface TurnReport {
  turn_index: number; // processed
  weather_multiplier: number;
  market: { price_per_bushel: number; sell_cap_bushels: number };
  spoilage: { rate: number; loss_bushels: number };
  production_bushels: number;
  consumption_bushels: number;
  // v0.2.4: consumption breakdown (3y). All values are in bushels and reconcile:
  //   total = peasant + court
  peasant_consumption_bushels: number;
  court_consumption_bushels: number;
  total_consumption_bushels: number;
  shortage_bushels: number;
  construction: {
    progress_added: number;
    completed_improvement_id?: string | null;
    // v0.2.3.2+: per-option availability signal (UI can disable/remove built improvements).
    options?: Array<{ improvement_id: string; status: "available" | "built" | "active_project" }>;
  };
  obligations: {
    tax_due_coin: number;
    tithe_due_bushels: number;
    arrears_coin: number;
    arrears_bushels: number;
    war_levy_due: WarLevyDue;
  };
  household: {
    births: string[];
    deaths: string[];
    population_delta: number;
    // v0.2.5: population (labor pool) change visibility.
    // Positive counts; net delta = births - deaths - runaways.
    population_change_breakdown?: {
      schema_version: "population_change_breakdown_v1";
      births: number;
      deaths: number;
      runaways: number;
    };
  };
  house_log: HouseLogEvent[];
  events: EventResult[];
  top_drivers: string[]; // top 3 explanation strings
  notes: string[]; // additional log notes
  // v0.2.3.2+: structured deltas for UI clarity (no mechanics).
  unrest_breakdown?: {
    schema_version: "unrest_breakdown_v1";
    before: number;
    after: number;
    delta: number;
    increased_by: Array<{ label: string; amount: number }>;
    decreased_by: Array<{ label: string; amount: number }>;
  };
  labor_signal?: {
    schema_version: "labor_signal_v1";
    available: number;
    assigned_before: number;
    assigned_after: number;
    farmers_before: number;
    farmers_after: number;
    builders_before: number;
    builders_after: number;
    was_oversubscribed: boolean;
    auto_clamped: boolean;
  };
  // v0.2.3.4+: roster snapshot embedded for history-safe rendering (dedupe + death/heir badges).
  household_roster?: HouseholdRoster;
  // v0.2.4: court roster snapshot embedded for history-safe rendering (officers + married-in spouses).
  court_roster?: CourtRoster;
  court_headcount?: number;
  prospects_log?: ProspectsLogEvent[];
}

// v0.2.3.2+: a UI-ready household roster (deduped; heir is a badge).
export type HouseholdRosterRole = "head" | "spouse" | "child";
export type HouseholdRosterBadge = "heir" | "widow" | "widower" | "widowed" | "deceased";

export interface HouseholdRosterRow {
  person_id: string;
  role: HouseholdRosterRole;
  badges: HouseholdRosterBadge[];
}

export interface HouseholdRoster {
  schema_version: "household_roster_v1";
  turn_index: number;
  rows: HouseholdRosterRow[];
}

// --- Court (v0.2.4) ---

export type CourtOfficerRole = "steward" | "clerk" | "marshal";
export type CourtRosterRole = "head" | "spouse" | "child" | "officer" | "married_in_spouse";

export interface CourtRosterRow {
  person_id: string;
  role: CourtRosterRole;
  // Officer role key (UI maps to title labels per UX contract).
  officer_role: CourtOfficerRole | null;
  badges: HouseholdRosterBadge[];
}

export interface CourtRoster {
  schema_version: "court_roster_v1";
  turn_index: number;
  headcount_alive: number;
  rows: CourtRosterRow[];
}

export interface MarriageOffer {
  house_person_id: string;
  house_label: string;
  dowry_coin_net: number;
  relationship_delta: { respect: number; allegiance: number; threat: number };
  liege_delta?: { respect: number; threat: number } | null;
  risk_tags: string[];
}

export interface MarriageWindow {
  eligible_child_ids: string[];
  offers: MarriageOffer[];
}


// --- Prospects (v0.2.3) ---

export type ProspectType = "marriage" | "grant" | "inheritance_claim";
export type ProspectUncertainty = "known" | "likely" | "possible";
export type ProspectAction = "accept" | "reject";

export type ProspectRequirementKind = "respect_min" | "allegiance_min" | "threat_max" | "coin_min" | "no_arrears" | "custom";
export type ProspectRequirement = { kind: ProspectRequirementKind; value: number | string | boolean; text: string };

export type ProspectCosts = { coin?: number; energy?: number; bushels?: number };

export type RelationshipDeltaScope = "person" | "house";
export type RelationshipDelta = {
  scope: RelationshipDeltaScope;
  from_id: string;
  to_id: string;
  allegiance_delta: number;
  respect_delta: number;
  threat_delta: number;
};

export type ProspectEffects = {
  coin_delta?: number;
  relationship_deltas?: RelationshipDelta[];
  flags_set?: string[];
};

export type Prospect = {
  id: string;
  type: ProspectType;
  from_house_id: string;
  to_house_id: string;
  subject_person_id: string | null;
  // v0.2.4: when present, identifies the spouse that joins the court on acceptance.
  spouse_person_id?: string | null;
  summary: string;
  requirements: ProspectRequirement[];
  costs: ProspectCosts;
  predicted_effects: ProspectEffects;
  uncertainty: ProspectUncertainty;
  expires_turn: number;
  actions: ProspectAction[];
};

export type ProspectsWindow = {
  schema_version: "prospects_window_v1";
  turn_index: number;
  generated_at_turn_index: number;
  prospects: Prospect[];
  shown_ids: string[];
  hidden_ids: string[];
};

export type ProspectsLogEvent =
  | {
      kind: "prospect_generated";
      turn_index: number;
      type: ProspectType;
      from_house_id: string;
      to_house_id: string;
      subject_person_id: string | null;
      prospect_id: string;
      prospect: Prospect;
    }
  | {
      kind: "prospects_window_built";
      turn_index: number;
      shown_ids: string[];
      hidden_ids: string[];
    }
  | {
      kind: "prospect_accepted" | "prospect_rejected" | "prospect_expired";
      turn_index: number;
      type: ProspectType;
      from_house_id: string;
      to_house_id: string;
      subject_person_id: string | null;
      prospect_id: string;
      effects_applied: ProspectEffects;
    };

export type ProspectsDecisionAction = { prospect_id: string; action: ProspectAction };
export type ProspectsDecision = { kind: "prospects"; actions: ProspectsDecisionAction[] };

export type LaborDecision = { kind: "labor"; desired_farmers: number; desired_builders: number };
export type SellDecision = { kind: "sell"; sell_bushels: number };
export type ObligationsDecision = {
  kind: "pay_obligations";
  pay_coin: number;
  pay_bushels: number;
  war_levy_choice?: "coin" | "men" | "ignore";
};
export type ConstructionDecision =
  | { kind: "construction"; action: "none" }
  | { kind: "construction"; action: "start"; improvement_id: string }
  | { kind: "construction"; action: "abandon"; confirm: boolean };
export type MarriageDecision =
  | { kind: "marriage"; action: "none" }
  | { kind: "marriage"; action: "scout" }
  | { kind: "marriage"; action: "reject_all" }
  | { kind: "marriage"; action: "accept"; child_id: string; offer_index: number };

export type TurnDecisions = {
  labor: LaborDecision;
  sell: SellDecision;
  obligations: ObligationsDecision;
  construction: ConstructionDecision;
  marriage: MarriageDecision;

  prospects?: ProspectsDecision;
};

export interface TurnContext {
  preview_state: RunState;
  report: TurnReport;
  marriage_window: MarriageWindow | null;
  max_labor_shift: number;
  prospects_window?: ProspectsWindow | null;
  // v0.2.3.2+: deduped roster view for UI.
  household_roster?: HouseholdRoster;
  // v0.2.4: court roster view for UI.
  court_roster?: CourtRoster;
}

export interface TurnLogEntry {
  processed_turn_index: number;
  summary: string;
  report: TurnReport;
  decisions: TurnDecisions;
  snapshot_before: RunSnapshot;
  snapshot_after: RunSnapshot;
  deltas: Record<string, number>;
}

export interface RunSummaryExport {
  seed: string;
  app_version: string;
  sim_version: SimVersion;
  turns_played: number;
  game_over_reason: string | null;
  ending_resources: { bushels: number; coin: number; unrest: number; arrears_coin: number; arrears_bushels: number };
  key_flags: string[];
}
