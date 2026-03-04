function hasPeopleFirstFields(state) {
    return Boolean(state && typeof state === "object" && state.people && state.houses && state.player_house_id);
}
function sortRecord(rec) {
    const out = {};
    for (const k of Object.keys(rec).sort())
        out[k] = rec[k];
    return out;
}
function kinKey(e) {
    if (e.kind === "parent_of")
        return `parent_of|${e.parent_id}|${e.child_id}`;
    // spouse_of is symmetric; normalize order for dedupe/sort.
    const a = String(e.a_id);
    const b = String(e.b_id);
    const x = a < b ? a : b;
    const y = a < b ? b : a;
    return `spouse_of|${x}|${y}`;
}
function kinInvolvesAny(e, ids) {
    if (e.kind === "parent_of")
        return ids.has(String(e.parent_id)) || ids.has(String(e.child_id));
    return ids.has(String(e.a_id)) || ids.has(String(e.b_id));
}
/**
 * v0.2.x People-First migration/sync.
 *
 * - Accepts legacy v0.1.0-shaped state (embedded `house` + `locals`).
 * - Adds minimal registries: people/houses/player_house_id/kinship_edges.
 * - v0.2.1 constraint: does NOT introduce extra Houses beyond the player house.
 * - v0.2.2+ constraint: sync must be NON-DESTRUCTIVE (upsert only) so externally seeded
 *   registry entries are never wiped.
 * - Deterministic: IDs are derived from existing Person IDs.
 */
export function ensurePeopleFirst(state) {
    const s = state;
    if (!hasPeopleFirstFields(s)) {
        migratePeopleFirstFromLegacy(state);
    }
    // Keep registries in sync with legacy fields (authoritative sim still uses legacy structures).
    return syncPeopleFirstFromLegacyUpsert(state);
}
function migratePeopleFirstFromLegacy(state) {
    const s = state;
    const people = {};
    const addPerson = (p) => {
        if (!p || typeof p !== "object")
            return;
        if (typeof p.id !== "string" || !p.id)
            return;
        people[p.id] = p;
    };
    // Household
    addPerson(state.house?.head);
    addPerson(state.house?.spouse ?? null);
    for (const c of state.house?.children ?? [])
        addPerson(c);
    // Locals (allowed to exist without Houses)
    addPerson(state.locals?.liege);
    addPerson(state.locals?.clergy);
    for (const n of state.locals?.nobles ?? [])
        addPerson(n);
    const playerHouseId = "h_player";
    const headId = state.house?.head?.id;
    const spouseId = state.house?.spouse?.id ?? null;
    const childIds = (state.house?.children ?? []).map((c) => c.id);
    const houses = {
        [playerHouseId]: {
            id: playerHouseId,
            head_id: headId,
            spouse_id: spouseId,
            spouse_status: state.house?.spouse_status ?? null,
            child_ids: childIds,
            heir_id: state.house?.heir_id ?? null
        }
    };
    const kinship_edges = [];
    if (headId && spouseId) {
        kinship_edges.push({ kind: "spouse_of", a_id: headId, b_id: spouseId });
    }
    if (headId) {
        for (const cid of childIds)
            kinship_edges.push({ kind: "parent_of", parent_id: headId, child_id: cid });
    }
    if (spouseId) {
        for (const cid of childIds)
            kinship_edges.push({ kind: "parent_of", parent_id: spouseId, child_id: cid });
    }
    s.people = people;
    s.houses = houses;
    s.player_house_id = playerHouseId;
    s.kinship_edges = kinship_edges;
    return state;
}
function syncPeopleFirstFromLegacyUpsert(state) {
    const s = state;
    const playerHouseId = String(s.player_house_id ?? "h_player");
    if (!s.houses || typeof s.houses !== "object")
        s.houses = {};
    if (!s.people || typeof s.people !== "object")
        s.people = {};
    // Start from existing registries (superset), then upsert legacy persons.
    const people = { ...s.people };
    const upsert = (p) => {
        if (!p || typeof p !== "object")
            return;
        if (typeof p.id !== "string" || !p.id)
            return;
        people[p.id] = p;
    };
    upsert(state.house?.head);
    upsert(state.house?.spouse ?? null);
    for (const c of state.house?.children ?? [])
        upsert(c);
    upsert(state.locals?.liege);
    upsert(state.locals?.clergy);
    for (const n of state.locals?.nobles ?? [])
        upsert(n);
    const headId = state.house?.head?.id;
    const spouseId = state.house?.spouse?.id ?? null;
    const childIds = (state.house?.children ?? []).map((c) => c.id);
    // Upsert only the player house record; preserve all other Houses.
    const houses = { ...s.houses };
    houses[playerHouseId] = {
        ...(houses[playerHouseId] ?? {}),
        id: playerHouseId,
        head_id: headId,
        spouse_id: spouseId,
        spouse_status: state.house?.spouse_status ?? null,
        child_ids: childIds,
        heir_id: state.house?.heir_id ?? null
    };
    // Kinship edges: preserve non-player edges; replace only edges involving the player household IDs.
    const prior = Array.isArray(s.kinship_edges)
        ? s.kinship_edges
        : Array.isArray(s.kinship)
            ? s.kinship
            : [];
    const playerIds = new Set([headId ?? "", spouseId ?? "", ...childIds].filter(Boolean));
    const kept = prior.filter((e) => !kinInvolvesAny(e, playerIds));
    const desired = [];
    if (headId && spouseId)
        desired.push({ kind: "spouse_of", a_id: headId, b_id: spouseId });
    if (headId)
        for (const cid of childIds)
            desired.push({ kind: "parent_of", parent_id: headId, child_id: cid });
    if (spouseId)
        for (const cid of childIds)
            desired.push({ kind: "parent_of", parent_id: spouseId, child_id: cid });
    const mergedByKey = new Map();
    for (const e of [...kept, ...desired])
        mergedByKey.set(kinKey(e), e);
    const merged = [...mergedByKey.values()].sort((a, b) => kinKey(a).localeCompare(kinKey(b)));
    // Stable enumeration for serialization: re-materialize registries in sorted key order.
    s.people = sortRecord(people);
    s.houses = sortRecord(houses);
    s.player_house_id = playerHouseId;
    s.kinship_edges = merged;
    return state;
}
