#!/usr/bin/env node
/**
 * Map v1 validation (no-deps)
 *
 * Usage:
 *   npm run map:validate
 *   node scripts/mapValidateV1.mjs --map=data/map/map_v1.json --config=data/map/map_v1_config.json
 */
import fs from "node:fs";
import path from "node:path";

import {
  assert,
  ensureDir,
  parseArgs,
  readJson,
  writeJson,
  stableStringify,
  defaultNeighborDirs,
  inBounds,
  indexOf,
  computeMapMetrics,
  computeHydrologyMetrics
} from "./mapLibV1.mjs";

function fail(msg, ctx = {}) {
  const err = new Error(msg);
  err.ctx = ctx;
  throw err;
}

function deepEqualStable(a, b) {
  return stableStringify(a) === stableStringify(b);
}

function validateMap(map, config) {
  const errors = [];
  const warnings = [];

  const pushErr = (m, ctx) => errors.push({ message: m, ...(ctx ? { ctx } : {}) });
  const pushWarn = (m, ctx) => warnings.push({ message: m, ...(ctx ? { ctx } : {}) });

  if (!map || typeof map !== "object") {
    pushErr("map is not an object");
    return { errors, warnings };
  }

  if (map.schema_version !== "map_schema_v1") pushErr("schema_version must equal map_schema_v1", { got: map.schema_version });

  const width = map.width;
  const height = map.height;
  if (!Number.isInteger(width) || width <= 0) pushErr("width must be positive integer", { width });
  if (!Number.isInteger(height) || height <= 0) pushErr("height must be positive integer", { height });

  if (!Array.isArray(map.hexes)) pushErr("hexes must be array");
  if (Array.isArray(map.hexes) && Number.isInteger(width) && Number.isInteger(height)) {
    const expected = width * height;
    if (map.hexes.length !== expected) pushErr("hexes.length must equal width*height", { len: map.hexes.length, expected });
  }

  const hexes = Array.isArray(map.hexes) ? map.hexes : [];
  const hexById = new Map();

  // Hex enumeration + identity
  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i];
    if (!h || typeof h !== "object") {
      pushErr("hex must be object", { index: i });
      continue;
    }

    const expectedQ = i % width;
    const expectedR = Math.floor(i / width);

    if (h.q !== expectedQ || h.r !== expectedR) {
      pushErr("hex coords must match row-major index", { index: i, expected: { q: expectedQ, r: expectedR }, got: { q: h.q, r: h.r } });
    }

    const expectedId = `hx_${i}`;
    if (h.hex_id !== expectedId) pushErr("hex_id mismatch", { index: i, expected: expectedId, got: h.hex_id });

    if (hexById.has(h.hex_id)) pushErr("duplicate hex_id", { hex_id: h.hex_id });
    hexById.set(h.hex_id, h);

    if (!["land", "sea", "void"].includes(h.tile_kind)) pushErr("tile_kind invalid", { hex_id: h.hex_id, tile_kind: h.tile_kind });

    if (h.tile_kind === "land") {
      // Borderlands context is allowed to be land-without-county.
      // Primary kingdom land is identified by having a county_id.
      if (!(h.county_id === null || h.county_id === undefined)) {
        if (typeof h.county_id !== "string" || !h.county_id) pushErr("land hex county_id must be string when present", { hex_id: h.hex_id, county_id: h.county_id });
      }
    } else {
      if (!(h.county_id === null || h.county_id === undefined)) pushErr("non-land hex must have county_id null", { hex_id: h.hex_id, county_id: h.county_id });
    }

    // Terrain must be one of config.terrain.types (void ignored)
    if (h.tile_kind !== "void") {
      const types = config?.terrain?.types;
      if (Array.isArray(types) && !types.includes(h.terrain)) {
        pushErr("terrain invalid", { hex_id: h.hex_id, terrain: h.terrain });
      }
    }
  }

  // Land count (primary kingdom only)
  const landTarget = config?.scale?.realm_hexes_land_target;
  const landCount = hexes.filter((h) => h?.tile_kind === "land" && typeof h?.county_id === "string" && h.county_id).length;
  if (Number.isInteger(landTarget)) {
    // M2: coastline shaping may legitimately shift the final land count. Allow a tolerance band.
    // Default tolerance is ±5% unless overridden in config.
    const tolPctRaw = config?.scale?.realm_hexes_land_target_tolerance_pct;
    const tolPct = Number.isFinite(Number(tolPctRaw)) ? Number(tolPctRaw) : 0.05;
    const tol = Math.floor(Math.abs(landTarget) * tolPct);

    if (landCount !== landTarget) {
      const delta = landCount - landTarget;
      if (Math.abs(delta) <= tol) {
        pushWarn("land_hex_count differs from realm_hexes_land_target within tolerance", { landCount, landTarget, delta, tol, tolPct });
      } else {
        pushErr("land_hex_count must equal realm_hexes_land_target", { landCount, landTarget, delta, tol, tolPct });
      }
    }
  }

  // Counties
  const counties = Array.isArray(map.counties) ? map.counties : [];
  const countyCountTarget = config?.counties?.county_count;
  if (Number.isInteger(countyCountTarget) && counties.length !== countyCountTarget) {
    pushErr("county_count mismatch", { counties: counties.length, expected: countyCountTarget });
  }

  const countyById = new Map();
  for (const c of counties) {
    if (!c || typeof c !== "object") {
      pushErr("county must be object");
      continue;
    }
    if (typeof c.county_id !== "string" || !c.county_id) {
      pushErr("county.county_id must be string", { county_id: c.county_id });
      continue;
    }
    if (countyById.has(c.county_id)) pushErr("duplicate county_id", { county_id: c.county_id });
    countyById.set(c.county_id, c);
    if (!Array.isArray(c.hex_ids)) pushErr("county.hex_ids must be array", { county_id: c.county_id });
  }

  // Every PRIMARY land hex (county_id present) must belong to exactly one county.
  const landHexIds = new Set();
  const countyLandHexIds = new Set();

  for (const h of hexes) {
    if (h.tile_kind !== "land") continue;
    // Borderlands context is allowed: land with no county_id.
    if (!(typeof h.county_id === "string" && h.county_id)) continue;
    landHexIds.add(h.hex_id);
    if (!countyById.has(h.county_id)) pushErr("hex county_id references missing county", { hex_id: h.hex_id, county_id: h.county_id });
  }

  for (const c of counties) {
    if (!c?.hex_ids || !Array.isArray(c.hex_ids)) continue;
    for (const hid of c.hex_ids) {
      if (countyLandHexIds.has(hid)) pushErr("duplicate hex_id across counties", { hex_id: hid });
      countyLandHexIds.add(hid);

      const hh = hexById.get(hid);
      if (!hh) pushErr("county.hex_ids references missing hex", { county_id: c.county_id, hex_id: hid });
      else {
        if (hh.tile_kind !== "land") pushErr("county.hex_ids must reference land hex", { county_id: c.county_id, hex_id: hid, tile_kind: hh.tile_kind });
        if (hh.county_id !== c.county_id) pushErr("county.hex_ids mismatch vs hex.county_id", { county_id: c.county_id, hex_id: hid, hex_county_id: hh.county_id });
      }
    }
  }

  if (landHexIds.size !== countyLandHexIds.size) {
    // Find missing
    const missing = [];
    for (const hid of landHexIds) if (!countyLandHexIds.has(hid)) missing.push(hid);
    if (missing.length) pushErr("some land hexes are not included in any county.hex_ids", { sample: missing.slice(0, 10), missing_count: missing.length });
  }

  // County contiguity over land hexes only
  const dirs = defaultNeighborDirs();
  for (const c of counties) {
    const ids = c?.hex_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      pushErr("county.hex_ids empty", { county_id: c?.county_id });
      continue;
    }
    const idSet = new Set(ids);
    const start = ids[0];
    const stack = [start];
    const seen = new Set([start]);
    while (stack.length) {
      const curId = stack.pop();
      const h = hexById.get(curId);
      if (!h) continue;
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        const nh = hexes[ni];
        if (nh.tile_kind !== "land") continue;
        if (nh.county_id !== c.county_id) continue;
        if (!idSet.has(nh.hex_id)) continue;
        if (seen.has(nh.hex_id)) continue;
        seen.add(nh.hex_id);
        stack.push(nh.hex_id);
      }
    }
    if (seen.size !== idSet.size) {
      pushErr("county is not contiguous", { county_id: c.county_id, expected: idSet.size, reached: seen.size });
    }
  }

  // Seats
  const seats = Array.isArray(map.seats) ? map.seats : [];
  const seatTarget = config?.settlements?.seats_total;
  if (Number.isInteger(seatTarget) && seats.length !== seatTarget) pushErr("seat_count mismatch", { seats: seats.length, expected: seatTarget });

  const seatByCounty = new Map();
  let capitalCount = 0;
  for (const s of seats) {
    if (!s || typeof s !== "object") {
      pushErr("seat must be object");
      continue;
    }
    if (typeof s.county_id !== "string" || !s.county_id) pushErr("seat.county_id must be string", { seat: s });
    if (typeof s.hex_id !== "string" || !s.hex_id) pushErr("seat.hex_id must be string", { seat: s });
    if (!countyById.has(s.county_id)) pushErr("seat references missing county", { seat: s });

    if (seatByCounty.has(s.county_id)) pushErr("multiple seats for county", { county_id: s.county_id });
    seatByCounty.set(s.county_id, s);

    const h = hexById.get(s.hex_id);
    if (!h) pushErr("seat references missing hex", { seat: s });
    else {
      if (h.tile_kind !== "land") pushErr("seat must be on land", { seat: s, tile_kind: h.tile_kind });
      if (h.county_id !== s.county_id) pushErr("seat hex county mismatch", { seat: s, hex_county_id: h.county_id });
    }

    if (s.is_capital === true) capitalCount += 1;
  }

  const requireCapital = config?.capital?.require_capital === true;
  if (requireCapital && capitalCount !== 1) pushErr("exactly one capital seat required", { capitalCount });

  // Settlements
  const settlements = Array.isArray(map.settlements) ? map.settlements : [];
  const primaryPorts = settlements.filter((s) => s?.settlement_kind === "port" && s?.is_primary_port === true);
  if (primaryPorts.length !== 1) pushErr("exactly one primary port required", { primaryPorts: primaryPorts.length });

  // Primary port must be land + sea-adjacent
  if (primaryPorts.length === 1) {
    const p = primaryPorts[0];
    const h = hexById.get(p.hex_id);
    if (!h) pushErr("primary port references missing hex", { port: p });
    else {
      if (h.tile_kind !== "land") pushErr("primary port must be on land", { port: p, tile_kind: h.tile_kind });
      // sea-adjacent
      let seaAdj = false;
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const nh = hexes[indexOf(nq, nr, width)];
        if (nh.tile_kind === "sea") seaAdj = true;
      }
      if (!seaAdj) pushErr("primary port must be sea-adjacent", { port: p, q: h.q, r: h.r });
    }
  }

  // Bishoprics counts + overlap rules
  const bishoprics = settlements.filter((s) => s?.settlement_kind === "bishopric");
  const bishopricBand = config?.church?.bishopric_count_band;
  if (Array.isArray(bishopricBand) && bishopricBand.length === 2) {
    const [lo, hi] = bishopricBand;
    if (bishoprics.length < lo || bishoprics.length > hi) pushErr("bishopric_count out of band", { bishoprics: bishoprics.length, band: bishopricBand });
  }

  // Archdiocese marker on bishopric only
  const metros = bishoprics.filter((s) => s?.is_metropolitan === true);
  const metroTarget = config?.church?.archdiocese_count;
  if (Number.isInteger(metroTarget) && metros.length !== metroTarget) pushErr("archdiocese_count mismatch", { metros: metros.length, expected: metroTarget });

  // Cathedral count band
  const cath = bishoprics.filter((s) => s?.is_cathedral === true);
  const cathBand = config?.settlements?.cathedral_city_count_band;
  if (Array.isArray(cathBand) && cathBand.length === 2) {
    const [lo, hi] = cathBand;
    if (cath.length < lo || cath.length > hi) pushWarn("cathedral_city_count out of band", { cath: cath.length, band: cathBand });
  }

  // Abbey marker band
  const abbeys = settlements.filter((s) => s?.settlement_kind === "abbey");
  const abbeyBand = config?.church?.abbey_marker_count_band;
  if (Array.isArray(abbeyBand) && abbeyBand.length === 2) {
    const [lo, hi] = abbeyBand;
    if (abbeys.length < lo || abbeys.length > hi) pushErr("abbey_marker_count out of band", { abbeys: abbeys.length, band: abbeyBand });
  }

  // Settlement hex references must be land
  const seenSettlementIds = new Set();
  for (const s of settlements) {
    if (!s || typeof s !== "object") {
      pushErr("settlement must be object");
      continue;
    }
    if (typeof s.settlement_id !== "string" || !s.settlement_id) pushErr("settlement_id missing", { settlement: s });
    else {
      if (seenSettlementIds.has(s.settlement_id)) pushErr("duplicate settlement_id", { settlement_id: s.settlement_id });
      seenSettlementIds.add(s.settlement_id);
    }

    if (typeof s.hex_id !== "string" || !s.hex_id) pushErr("settlement.hex_id missing", { settlement: s });
    else {
      const h = hexById.get(s.hex_id);
      if (!h) pushErr("settlement references missing hex", { settlement: s });
      else if (h.tile_kind !== "land") pushErr("settlement must be on land hex", { settlement: s, tile_kind: h.tile_kind });
    }
  }

  // Coastline presence
  const coastlineLand = hexes.filter((h) => h?.tile_kind === "land" && dirs.some((d) => {
    const nq = h.q + d.dq;
    const nr = h.r + d.dr;
    if (!inBounds(nq, nr, width, height)) return false;
    const nh = hexes[indexOf(nq, nr, width)];
    return nh.tile_kind === "sea";
  }));
  if (config?.coast_and_estuary?.coast_required === true && coastlineLand.length === 0) pushErr("coastline required but no land is sea-adjacent");

  // Hydrology checks only if present or required
  const hydro = computeHydrologyMetrics(map);
  const hydroRequired = config?.coast_and_estuary?.major_river_system?.required === true;
  // v0.3 decision: hydrology metadata is OPTIONAL in the committed artifact.
  // Validation enforces hydrology invariants only if the metadata is present.
  if (hydroRequired && !hydro.hydrology_present) {
    pushWarn("hydrology metadata missing (config marks required, but validator is presence-gated)");
  }
  if (hydro.hydrology_present) {
    if (hydro.estuary_component_count !== 1) pushErr("expected exactly one estuary component", { estuary_component_count: hydro.estuary_component_count });
    if (!hydro.estuary_connects_to_sea) pushErr("estuary must connect to sea", hydro);
    if (hydro.major_river_component_count !== 1) pushErr("expected exactly one major river component", { major_river_component_count: hydro.major_river_component_count });
    if (!hydro.major_river_touches_estuary) pushErr("major river must touch estuary", hydro);
    if ((hydro.freshwater_adjacent_to_ocean_hex_count ?? 0) > 0) {
      pushErr("freshwater lakes must not touch ocean-connected sea", {
        freshwater_adjacent_to_ocean_hex_count: hydro.freshwater_adjacent_to_ocean_hex_count,
        freshwater_lake_hex_count: hydro.freshwater_lake_hex_count
      });
    }

    const estLenBand = config?.coast_and_estuary?.estuary?.length_hex;
    if (Array.isArray(estLenBand) && estLenBand.length === 2) {
      const [lo, hi] = estLenBand;
      if (hydro.estuary_length && (hydro.estuary_length < lo || hydro.estuary_length > hi)) {
        pushWarn("estuary_length out of band", { estuary_length: hydro.estuary_length, band: estLenBand });
      }
    }

    const mouthBand = config?.coast_and_estuary?.estuary?.mouth_width_hex;
    if (Array.isArray(mouthBand) && mouthBand.length === 2) {
      const [lo, hi] = mouthBand;
      if (hydro.estuary_mouth_width && (hydro.estuary_mouth_width < lo || hydro.estuary_mouth_width > hi)) {
        pushWarn("estuary_mouth_width out of band", { estuary_mouth_width: hydro.estuary_mouth_width, band: mouthBand });
      }
    }
  }

  // Terrain disallowed adjacency
  const disallowed = config?.terrain?.disallowed_adjacencies;
  if (Array.isArray(disallowed)) {
    const forb = new Set(disallowed.map((p) => `${p[0]}|${p[1]}`).concat(disallowed.map((p) => `${p[1]}|${p[0]}`)));
    for (const h of hexes) {
      if (h.tile_kind !== "land") continue;
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const nh = hexes[indexOf(nq, nr, width)];
        if (nh.tile_kind === "void") continue;
        // Treat sea as terrain "sea" for adjacency checks
        const a = h.terrain;
        const b = nh.tile_kind === "sea" ? "sea" : nh.terrain;
        if (forb.has(`${a}|${b}`)) {
          pushErr("disallowed terrain adjacency", { a, b, hex_id: h.hex_id, neighbor_hex_id: nh.hex_id });
        }
      }
    }
  }

  // Market town totals (WARN)
  const marketBand = config?.settlements?.market_towns_total_band;
  if (Array.isArray(marketBand) && marketBand.length === 2) {
    const count = settlements.filter((s) => s?.settlement_kind === "market" || s?.settlement_kind === "port").length;
    const [lo, hi] = marketBand;
    if (count < lo || count > hi) pushWarn("market_towns_total out of band", { count, band: marketBand });
  }

  return { errors, warnings };
}

// CLI
const args = parseArgs(process.argv.slice(2));
const mapPath = args.map ?? "data/map/map_v1.json";
const configPath = args.config ?? "data/map/map_v1_config.json";
// Optional outputs (used by map:batch). Defaults preserve map:validate contract.
const metricsOutPath = args.metricsOut ?? "qa_artifacts/mapgen_metrics.json";
const reportOutPath = args.reportOut ?? "qa_artifacts/map_validate/report.json";

const map = readJson(mapPath);
const config = readJson(configPath);

const report = {
  started_at: new Date().toISOString(),
  map_path: mapPath,
  config_path: configPath,
  metrics_out: metricsOutPath,
  ok: false,
  errors: [],
  warnings: []
};

try {
  const { errors, warnings } = validateMap(map, config);
  report.errors = errors;
  report.warnings = warnings;

  if (errors.length) {
    report.ok = false;
  } else {
    report.ok = true;
  }

  // Metrics (authoritative)
  const metrics = computeMapMetrics(map, config);

  const metricsPath = path.resolve(metricsOutPath);
  ensureDir(path.dirname(metricsPath));

  // Compare with existing metrics if present
  if (fs.existsSync(metricsPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(metricsPath, "utf8"));
      if (!deepEqualStable(prev, metrics)) {
        throw new Error("mapgen_metrics mismatch vs recomputed metrics");
      }
    } catch (e) {
      report.ok = false;
      report.errors.push({ message: String(e?.message ?? e), ctx: { metrics_path: metricsPath } });
    }
  }

  // Always overwrite/regenerate metrics so CI always has it
  writeJson(metricsPath, metrics);

  // Report
  const reportPath = path.resolve(reportOutPath);
  ensureDir(path.dirname(reportPath));
  writeJson(reportPath, report);

  if (!report.ok) {
    console.error(`map:validate FAIL — see ${reportPath}`);
    for (const e of report.errors.slice(0, 12)) console.error(" -", e.message);
    process.exit(1);
  }

  console.log(`map:validate OK — ${reportPath}`);
  process.exit(0);
} catch (e) {
  report.ok = false;
  report.errors.push({ message: String(e?.stack ?? e) });
  const reportPath = path.resolve(reportOutPath);
  ensureDir(path.dirname(reportPath));
  writeJson(reportPath, report);
  console.error(`map:validate FAIL — unhandled error; see ${reportPath}`);
  process.exit(1);
}
