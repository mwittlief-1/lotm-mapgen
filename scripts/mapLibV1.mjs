import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

export function sha256File(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function stableStringify(value) {
  const seen = new WeakSet();
  const helper = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(helper);
    const keys = Object.keys(v).sort();
    const out = {};
    for (const k of keys) out[k] = helper(v[k]);
    return out;
  };
  return JSON.stringify(helper(value));
}

export function parseArgs(argv) {
  /** Supports --key=value and --key value */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      const k = a.slice(2, eq);
      const v = a.slice(eq + 1);
      out[k] = v;
      continue;
    }
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) {
      out[k] = v;
      i++;
    } else {
      out[k] = true;
    }
  }
  return out;
}

export function hashStringToU32(s) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function makeMulberry32(seedU32) {
  let a = seedU32 >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickInt(rand, lo, hi) {
  // inclusive
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const x = rand();
  return a + Math.floor(x * (b - a + 1));
}

export function choice(rand, arr) {
  if (!arr.length) throw new Error("choice() on empty array");
  const idx = Math.floor(rand() * arr.length);
  return arr[idx];
}

export function shuffled(rand, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function defaultNeighborDirs() {
  // LOCKED order: E, NE, NW, W, SW, SE
  return [
    { name: "E", dq: 1, dr: 0 },
    { name: "NE", dq: 1, dr: -1 },
    { name: "NW", dq: 0, dr: -1 },
    { name: "W", dq: -1, dr: 0 },
    { name: "SW", dq: -1, dr: 1 },
    { name: "SE", dq: 0, dr: 1 }
  ];
}

export function inBounds(q, r, width, height) {
  return q >= 0 && q < width && r >= 0 && r < height;
}

export function indexOf(q, r, width) {
  return r * width + q;
}

export function axialDist(aq, ar, bq, br) {
  // axial distance using cube coords
  const ax = aq;
  const az = ar;
  const ay = -ax - az;

  const bx = bq;
  const bz = br;
  const by = -bx - bz;

  return (Math.abs(ax - bx) + Math.abs(ay - by) + Math.abs(az - bz)) / 2;
}

export function neighborsOf(q, r, width, height, dirs = defaultNeighborDirs()) {
  const out = [];
  for (const d of dirs) {
    const nq = q + d.dq;
    const nr = r + d.dr;
    if (!inBounds(nq, nr, width, height)) continue;
    out.push({ q: nq, r: nr, dir: d.name });
  }
  return out;
}

export function computeCoastMetrics(map) {
  const width = map.width;
  const height = map.height;
  const dirs = defaultNeighborDirs();
  const hexes = map.hexes;

  let outerBoundaryEdges = 0;
  let coastEdges = 0;
  let coastlineArcLandCount = 0;
  let left_edge_coast_hexes = 0;
  let sea_neighbors_on_coast_sum = 0;

  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i];
    if (h.tile_kind !== "land") continue;
    const q = h.q;
    const r = h.r;

    let isCoastalLand = false;
    let seaNeighborCount = 0;

    for (const d of dirs) {
      const nq = q + d.dq;
      const nr = r + d.dr;
      if (!inBounds(nq, nr, width, height)) {
        // out-of-bounds treated as void
        outerBoundaryEdges += 1;
        continue;
      }
      const ni = indexOf(nq, nr, width);
      const nh = hexes[ni];
      if (nh.tile_kind === "sea") {
        outerBoundaryEdges += 1;
        coastEdges += 1;
        isCoastalLand = true;
        seaNeighborCount += 1;
      } else if (nh.tile_kind === "void") {
        outerBoundaryEdges += 1;
      }
    }

    if (isCoastalLand) {
      coastlineArcLandCount += 1;
      sea_neighbors_on_coast_sum += seaNeighborCount;
      if (q === 0) left_edge_coast_hexes += 1;
    }
  }

  const coastline_share = outerBoundaryEdges > 0 ? coastEdges / outerBoundaryEdges : 0;
  const coast_hexes_total = coastlineArcLandCount;
  const left_edge_coast_share = coast_hexes_total > 0 ? left_edge_coast_hexes / coast_hexes_total : 0;
  const avg_sea_neighbors_on_coast = coast_hexes_total > 0 ? sea_neighbors_on_coast_sum / coast_hexes_total : 0;
  return { outerBoundaryEdges, coastEdges, coastline_share, coastlineArcLandCount, coast_hexes_total, left_edge_coast_hexes, left_edge_coast_share, avg_sea_neighbors_on_coast };
}

export function computeHydrologyMetrics(map) {
  const width = map.width;
  const height = map.height;
  const dirs = defaultNeighborDirs();
  const hexes = map.hexes;

  const isEstuary = (h) => h?.hydrology?.water_kind === "estuary";
  const isSeaWater = (h) => h.tile_kind === "sea" && h?.hydrology?.water_kind !== "estuary";
  const isMajorRiver = (h) => h.tile_kind === "land" && h?.hydrology?.river_class === "major";
  const isFreshLake = (h) => h?.tile_kind === "land" && h?.hydrology?.water_kind === "lake";

  // Saltwater classification: sea connected to the map boundary through sea+estuary.
  const oceanConnectedSea = new Uint8Array(hexes.length);
  oceanConnectedSea.fill(0);
  const oceanQ = [];
  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i];
    if (!h || h.tile_kind !== "sea") continue;
    const q = i % width;
    const r = Math.floor(i / width);
    if (!(q === 0 || r === 0 || q === width - 1 || r === height - 1)) continue;
    oceanConnectedSea[i] = 1;
    oceanQ.push(i);
  }
  for (let qi = 0; qi < oceanQ.length; qi++) {
    const cur = oceanQ[qi];
    const h = hexes[cur];
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (oceanConnectedSea[ni]) continue;
      const nh = hexes[ni];
      if (!nh || nh.tile_kind !== "sea") continue;
      // Saltwater can flow through estuary and open sea.
      oceanConnectedSea[ni] = 1;
      oceanQ.push(ni);
    }
  }

  // Estuary component(s)
  const estuaryIdx = [];
  for (let i = 0; i < hexes.length; i++) if (isEstuary(hexes[i])) estuaryIdx.push(i);

  const seen = new Set();
  const estuaryComponents = [];
  for (const start of estuaryIdx) {
    if (seen.has(start)) continue;
    const comp = [];
    const q = [start];
    seen.add(start);
    while (q.length) {
      const cur = q.pop();
      comp.push(cur);
      const h = hexes[cur];
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (seen.has(ni)) continue;
        if (!isEstuary(hexes[ni])) continue;
        seen.add(ni);
        q.push(ni);
      }
    }
    estuaryComponents.push(comp);
  }

  let estuary_component_count = estuaryComponents.length;
  let estuary_mouth_width = 0;
  let estuary_length = 0;
  let estuary_connects_to_sea = false;

  if (estuaryComponents.length === 1) {
    const comp = estuaryComponents[0];
    // mouth set = estuary tiles adjacent to sea
    const mouthSet = new Set();
    for (const i of comp) {
      const h = hexes[i];
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        const nh = hexes[ni];
        if (isSeaWater(nh)) {
          mouthSet.add(i);
          estuary_connects_to_sea = true;
        }
      }
    }
    estuary_mouth_width = mouthSet.size;

    // length = max graph distance from mouth set to any estuary tile, +1
    if (mouthSet.size) {
      const dist = new Map();
      const bfs = [];
      for (const i of mouthSet) {
        dist.set(i, 0);
        bfs.push(i);
      }
      while (bfs.length) {
        const cur = bfs.shift();
        const h = hexes[cur];
        const base = dist.get(cur) ?? 0;
        for (const d of dirs) {
          const nq = h.q + d.dq;
          const nr = h.r + d.dr;
          if (!inBounds(nq, nr, width, height)) continue;
          const ni = indexOf(nq, nr, width);
          if (!isEstuary(hexes[ni])) continue;
          if (dist.has(ni)) continue;
          dist.set(ni, base + 1);
          bfs.push(ni);
        }
      }
      let maxD = 0;
      for (const v of dist.values()) if (v > maxD) maxD = v;
      estuary_length = maxD + 1;
    }
  }

  // Major river components
  const majorIdx = [];
  for (let i = 0; i < hexes.length; i++) if (isMajorRiver(hexes[i])) majorIdx.push(i);

  const seenR = new Set();
  const riverComponents = [];
  for (const start of majorIdx) {
    if (seenR.has(start)) continue;
    const comp = [];
    const stack = [start];
    seenR.add(start);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      const h = hexes[cur];
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (seenR.has(ni)) continue;
        if (!isMajorRiver(hexes[ni])) continue;
        seenR.add(ni);
        stack.push(ni);
      }
    }
    riverComponents.push(comp);
  }

  let major_river_component_count = riverComponents.length;
  let major_river_touches_estuary = false;

  let freshwater_lake_hex_count = 0;
  let freshwater_adjacent_to_ocean_hex_count = 0;
  for (let i = 0; i < hexes.length; i++) {
    if (!isFreshLake(hexes[i])) continue;
    freshwater_lake_hex_count++;
    const h = hexes[i];
    let bad = false;
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      const nh = hexes[ni];
      if (!nh || nh.tile_kind !== "sea") continue;
      if (oceanConnectedSea[ni] === 1) { bad = true; break; }
    }
    if (bad) freshwater_adjacent_to_ocean_hex_count++;
  }
  if (riverComponents.length === 1 && estuaryComponents.length === 1) {
    const estSet = new Set(estuaryComponents[0]);
    const comp = riverComponents[0];
    for (const i of comp) {
      const h = hexes[i];
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (estSet.has(ni)) major_river_touches_estuary = true;
      }
    }
  }

  return {
    hydrology_present: estuaryIdx.length > 0 || majorIdx.length > 0,
    estuary_component_count,
    estuary_connects_to_sea,
    estuary_mouth_width,
    estuary_length,
    major_river_component_count,
    major_river_touches_estuary,
    major_river_tile_count: majorIdx.length,
    freshwater_lake_hex_count,
    freshwater_adjacent_to_ocean_hex_count
  };
}

function computeDistToLandSources({ width, height, hexes, sourcesIdx }) {
  const total = width * height;
  const dist = new Int16Array(total);
  dist.fill(-1);

  const landMask = new Uint8Array(total);
  for (let i = 0; i < total; i++) landMask[i] = hexes[i]?.tile_kind === "land" ? 1 : 0;

  const q = [];
  for (const idx of sourcesIdx) {
    if (!landMask[idx]) continue;
    if (dist[idx] !== -1) continue;
    dist[idx] = 0;
    q.push(idx);
  }

  const dirs = defaultNeighborDirs();
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cd = dist[cur];
    const h = hexes[cur];
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!landMask[ni]) continue;
      if (dist[ni] !== -1) continue;
      dist[ni] = cd + 1;
      q.push(ni);
    }
  }

  return dist;
}

export function computeLakeMetrics(map) {
  const { width, height, hexes } = map;
  const total = width * height;
  const isLake = new Uint8Array(total);
  isLake.fill(0);

  let lakeHexes = 0;
  for (let i = 0; i < total; i++) {
    const h = hexes[i];
    if (h?.tile_kind !== "land") continue;
    if (h?.hydrology?.water_kind === "lake") {
      isLake[i] = 1;
      lakeHexes++;
    }
  }

  const visited = new Uint8Array(total);
  visited.fill(0);
  const dirs = defaultNeighborDirs();
  const sizes = [];

  for (let i = 0; i < total; i++) {
    if (isLake[i] !== 1) continue;
    if (visited[i]) continue;
    let size = 0;
    const q = [i];
    visited[i] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      size++;
      const h = hexes[cur];
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (isLake[ni] !== 1) continue;
        if (visited[ni]) continue;
        visited[ni] = 1;
        q.push(ni);
      }
    }
    sizes.push(size);
  }

  sizes.sort((a, b) => b - a);

  const lakeCount = sizes.length;
  const sum = sizes.reduce((a, b) => a + b, 0);
  const avg = lakeCount ? sum / lakeCount : 0;
  const min = lakeCount ? sizes[sizes.length - 1] : 0;
  const max = lakeCount ? sizes[0] : 0;

  const small = sizes.filter((s) => s >= 3 && s <= 10);
  const medium = sizes.filter((s) => s >= 20 && s <= 50);
  const large = sizes.filter((s) => s >= 30);

  return {
    lake_hex_count: lakeHexes,
    lake_count: lakeCount,
    sizes_desc: sizes,
    size_min: min,
    size_max: max,
    size_avg: avg,
    spec_bands: {
      small_3_10: { count: small.length, sizes: small },
      medium_20_50: { count: medium.length, sizes: medium },
      large_ge_30: { count: large.length, sizes: large }
    }
  };
}

export function computeWaterAccessMetrics(map, opts = {}) {
  const { width, height, hexes } = map;
  const total = width * height;
  const radius = Math.max(0, Math.floor(opts.radius ?? 4));

  const landIdx = [];
  for (let i = 0; i < total; i++) if (hexes[i]?.tile_kind === "land") landIdx.push(i);
  const landCount = landIdx.length;
  if (!landCount) {
    return { radius, land_hex_count: 0, within: { any: 0, coast: 0, river: 0, lake: 0 } };
  }

  const dirs = defaultNeighborDirs();

  const coastSrc = [];
  const riverSrc = [];
  const lakeSrc = [];

  for (const idx of landIdx) {
    const h = hexes[idx];

    if (h?.hydrology?.water_kind === "lake") lakeSrc.push(idx);
    if (h?.hydrology?.river_class === "major" || h?.hydrology?.water_kind === "border_river") riverSrc.push(idx);

    // Coast access: land adjacent to sea tile.
    let seaAdj = false;
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (hexes[ni]?.tile_kind === "sea") { seaAdj = true; break; }
    }
    if (seaAdj) coastSrc.push(idx);
  }

  coastSrc.sort((a, b) => a - b);
  riverSrc.sort((a, b) => a - b);
  lakeSrc.sort((a, b) => a - b);

  const distCoast = coastSrc.length ? computeDistToLandSources({ width, height, hexes, sourcesIdx: coastSrc }) : null;
  const distRiver = riverSrc.length ? computeDistToLandSources({ width, height, hexes, sourcesIdx: riverSrc }) : null;
  const distLake = lakeSrc.length ? computeDistToLandSources({ width, height, hexes, sourcesIdx: lakeSrc }) : null;

  const anySrc = [...coastSrc, ...riverSrc, ...lakeSrc];
  anySrc.sort((a, b) => a - b);
  const distAny = anySrc.length ? computeDistToLandSources({ width, height, hexes, sourcesIdx: anySrc }) : null;

  const shareWithin = (distArr) => {
    if (!distArr) return 0;
    let ct = 0;
    for (const idx of landIdx) {
      const d = distArr[idx];
      if (d >= 0 && d <= radius) ct++;
    }
    return ct / landCount;
  };

  return {
    radius,
    land_hex_count: landCount,
    source_counts: {
      coast: coastSrc.length,
      river: riverSrc.length,
      lake: lakeSrc.length
    },
    within: {
      any: shareWithin(distAny),
      coast: shareWithin(distCoast),
      river: shareWithin(distRiver),
      lake: shareWithin(distLake)
    }
  };
}

export function computeMapMetrics(map, config) {
  const width = map.width;
  const height = map.height;

  const hexes = map.hexes;
  const counties = map.counties;
  const seats = map.seats;
  const settlements = map.settlements;

  let land_hex_count = 0;
  let sea_hex_count = 0;
  let void_hex_count = 0;

  for (const h of hexes) {
    if (h.tile_kind === "land") land_hex_count += 1;
    else if (h.tile_kind === "sea") sea_hex_count += 1;
    else void_hex_count += 1;
  }

  const countySizes = counties.map((c) => ({ county_id: c.county_id, land_hex_count: Array.isArray(c.hex_ids) ? c.hex_ids.length : 0 }));
  countySizes.sort((a, b) => b.land_hex_count - a.land_hex_count || a.county_id.localeCompare(b.county_id));

  const nodeCounts = {
    seats: seats.length,
    settlements_total: settlements.length,
    port_total: settlements.filter((s) => s.settlement_kind === "port").length,
    market_total: settlements.filter((s) => s.settlement_kind === "market").length,
    abbey_total: settlements.filter((s) => s.settlement_kind === "abbey").length,
    bishopric_total: settlements.filter((s) => s.settlement_kind === "bishopric").length
  };

  const capitalSeatCount = seats.filter((s) => s.is_capital === true).length;
  const primaryPortCount = settlements.filter((s) => s.settlement_kind === "port" && s.is_primary_port === true).length;
  const metropolitanCount = settlements.filter((s) => s.settlement_kind === "bishopric" && s.is_metropolitan === true).length;
  const cathedralCount = settlements.filter((s) => s.settlement_kind === "bishopric" && s.is_cathedral === true).length;

  const coast = computeCoastMetrics(map);
  const hydro = computeHydrologyMetrics(map);
  const lakes = computeLakeMetrics(map);
  const water_access = computeWaterAccessMetrics(map, {
    radius: config?.mapgen?.terrain?.water_access_radius ?? 4,
  });

  const derived = computeDerivedCountyMetrics(map);

  const out = {
    schema: {
      map_schema_version: map.schema_version,
      config_schema_version: config.schema_version,
      width,
      height
    },
    counts: {
      land_hex_count,
      sea_hex_count,
      void_hex_count,
      county_count: counties.length,
      seat_count: seats.length,
      capital_seat_count: capitalSeatCount,
      settlement_counts: nodeCounts,
      primary_port_count: primaryPortCount,
      metropolitan_bishopric_count: metropolitanCount,
      cathedral_bishopric_count: cathedralCount
    },
    county_size_stats: {
      min: countySizes.length ? countySizes[countySizes.length - 1].land_hex_count : 0,
      max: countySizes.length ? countySizes[0].land_hex_count : 0,
      avg: countySizes.length ? countySizes.reduce((a, b) => a + b.land_hex_count, 0) / countySizes.length : 0,
      by_county: countySizes
    },
    coastline: coast,
    hydrology: hydro,
    lakes,
    water_access,
    derived,
    warnings: [],
    // Must be stable across map:gen and map:validate.
    generated_at: typeof map?.generated_at === "string" ? map.generated_at : null
  };

  // Soft target warnings
  try {
    const [lo, hi] = config?.coast_and_estuary?.coast_boundary_share_target ?? [];
    if (typeof lo === "number" && typeof hi === "number") {
      if (coast.coastline_share < lo || coast.coastline_share > hi) {
        out.warnings.push({ code: "coastline_share_out_of_band", coastline_share: coast.coastline_share, target: [lo, hi] });
      }
    }
  } catch {}

  try {
    // Patch A3: left-edge coastline dominance (jaggedness heuristic)
    if (typeof coast?.left_edge_coast_share === "number" && coast.left_edge_coast_share > 0.25) {
      out.warnings.push({ code: "left_edge_coast_share_high", left_edge_coast_share: coast.left_edge_coast_share, threshold: 0.25 });
    }
  } catch {}

  try {
    const band = config?.church?.bishopric_count_band;
    if (Array.isArray(band) && band.length === 2) {
      const [lo, hi] = band;
      if (nodeCounts.bishopric_total < lo || nodeCounts.bishopric_total > hi) {
        out.warnings.push({ code: "bishopric_count_out_of_band", bishopric_total: nodeCounts.bishopric_total, band });
      }
    }
  } catch {}

  return out;
}


function computeDerivedCountyMetrics(map) {
  const width = map.width;
  const height = map.height;
  const dirs = defaultNeighborDirs();
  const hexes = map.hexes;

  // Seat spacing
  const seats = Array.isArray(map.seats) ? map.seats : [];
  const seatIdx = [];
  for (const s of seats) {
    const h = hexes.find((x) => x.hex_id === s.hex_id);
    if (h) seatIdx.push(h);
  }

  let seat_spacing_min = null;
  let seat_spacing_sum = 0;
  let seat_pairs = 0;
  for (let i = 0; i < seatIdx.length; i++) {
    for (let j = i + 1; j < seatIdx.length; j++) {
      const d = axialDist(seatIdx[i].q, seatIdx[i].r, seatIdx[j].q, seatIdx[j].r);
      seat_pairs += 1;
      seat_spacing_sum += d;
      if (seat_spacing_min == null || d < seat_spacing_min) seat_spacing_min = d;
    }
  }
  const seat_spacing_avg = seat_pairs > 0 ? seat_spacing_sum / seat_pairs : null;

  // County compactness proxy: perimeter_edges / area, averaged
  const countyAreas = new Map();
  const countyPerim = new Map();

  const isMajorRiver = (h) => h?.tile_kind === "land" && h?.hydrology?.river_class === "major";

  let boundaryEdgesBetweenCounties = 0;
  let riverBoundaryEdges = 0;
  let mountainBoundaryEdges = 0;

  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i];
    if (h.tile_kind !== "land") continue;
    const cid = h.county_id;
    if (!cid) continue;

    countyAreas.set(cid, (countyAreas.get(cid) ?? 0) + 1);

    // check edges
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) {
        countyPerim.set(cid, (countyPerim.get(cid) ?? 0) + 1);
        continue;
      }
      const ni = indexOf(nq, nr, width);
      const nh = hexes[ni];
      if (nh.tile_kind !== "land" || nh.county_id !== cid) {
        countyPerim.set(cid, (countyPerim.get(cid) ?? 0) + 1);
      }
      if (nh.tile_kind === "land" && nh.county_id && nh.county_id !== cid) {
        boundaryEdgesBetweenCounties += 1;
        // river boundary proxy: XOR on major river tile
        if (isMajorRiver(h) !== isMajorRiver(nh)) riverBoundaryEdges += 1;
        if (h.terrain === "mountains" || nh.terrain === "mountains") mountainBoundaryEdges += 1;
      }
    }
  }

  let compactness_sum = 0;
  let compactness_n = 0;
  for (const [cid, area] of countyAreas.entries()) {
    const per = countyPerim.get(cid) ?? 0;
    if (area > 0) {
      compactness_sum += per / area;
      compactness_n += 1;
    }
  }
  const county_compactness_avg = compactness_n > 0 ? compactness_sum / compactness_n : null;

  const river_boundary_share = boundaryEdgesBetweenCounties > 0 ? riverBoundaryEdges / boundaryEdgesBetweenCounties : null;
  const mountain_boundary_share = boundaryEdgesBetweenCounties > 0 ? mountainBoundaryEdges / boundaryEdgesBetweenCounties : null;

  return {
    seat_spacing_min,
    seat_spacing_avg,
    county_compactness_avg,
    river_boundary_share,
    mountain_boundary_share
  };
}
