/**
 * Terrain + Hydrology Painting v1 (MapGen M3)
 *
 * Goal: Paint plausible elevation/moisture/drainage-driven terrain inside the
 * kingdom (and immediate frontier) without touching remask / county shaping.
 *
 * Outputs (mutates hexes):
 *  - Adds terrain "lake" for inland lakes + optional border-river belts
 *  - Assigns mountains/hills/forest/marsh/plains/coast
 *  - Adds hydrology.water_kind for lakes / border rivers (presentation)
 *
 * Determinism:
 *  - All stochastic choices come from seed-derived hashes / dedicated RNG.
 *  - No dependency on caller RNG stream.
 */

import {
  assert,
  axialDist,
  defaultNeighborDirs,
  hashStringToU32,
  inBounds,
  indexOf,
  makeMulberry32,
  pickInt
} from "./mapLibV1.mjs";

function clamp01(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function mixU32(x) {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2(seedU32, a, b) {
  let x = (seedU32 ^ (a + 0x9e3779b9)) >>> 0;
  x = mixU32(x ^ (b >>> 0));
  return x >>> 0;
}

function hash3(seedU32, a, b, c) {
  let x = (seedU32 ^ (a + 0x9e3779b9)) >>> 0;
  x = mixU32(x ^ (b >>> 0));
  x = mixU32(x ^ (c >>> 0));
  return x >>> 0;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function valueNoise2D(seedU32, q, r, scale) {
  const s = Math.max(1, Number(scale ?? 1));
  const x = q / s;
  const y = r / s;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;

  const v00 = hash2(seedU32, x0, y0) / 0xffffffff;
  const v10 = hash2(seedU32, x0 + 1, y0) / 0xffffffff;
  const v01 = hash2(seedU32, x0, y0 + 1) / 0xffffffff;
  const v11 = hash2(seedU32, x0 + 1, y0 + 1) / 0xffffffff;

  const sx = smoothstep01(tx);
  const sy = smoothstep01(ty);
  const a = lerp(v00, v10, sx);
  const b = lerp(v01, v11, sx);
  return lerp(a, b, sy);
}

class MinHeap {
  constructor(cmp) {
    this.a = [];
    this.cmp = cmp;
  }
  push(x) {
    const a = this.a;
    a.push(x);
    this._up(a.length - 1);
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      this._down(0);
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
  _up(i) {
    const a = this.a;
    const cmp = this.cmp;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  _down(i) {
    const a = this.a;
    const cmp = this.cmp;
    for (;;) {
      let l = i * 2 + 1;
      let r = l + 1;
      let s = i;
      if (l < a.length && cmp(a[l], a[s]) < 0) s = l;
      if (r < a.length && cmp(a[r], a[s]) < 0) s = r;
      if (s === i) break;
      [a[i], a[s]] = [a[s], a[i]];
      i = s;
    }
  }
}

function quantileSorted(arrSorted, q) {
  if (!arrSorted.length) return 0;
  const t = clamp01(q);
  const idx = (arrSorted.length - 1) * t;
  const lo = Math.floor(idx);
  const hi = Math.min(arrSorted.length - 1, lo + 1);
  const f = idx - lo;
  return lerp(arrSorted[lo], arrSorted[hi], f);
}

function buildLandSet(hexes) {
  const land = new Uint8Array(hexes.length);
  for (let i = 0; i < hexes.length; i++) {
    if (hexes[i]?.tile_kind === "land") land[i] = 1;
  }
  return land;
}

function computeDistToSources({ width, height, hexes, landMask, sourcesIdx }) {
  const total = width * height;
  const dist = new Int16Array(total);
  dist.fill(-1);
  const q = [];
  for (const idx of sourcesIdx) {
    if (!landMask[idx]) continue;
    if (dist[idx] !== -1) continue;
    dist[idx] = 0;
    q.push(idx);
  }

  const dirs = defaultNeighborDirs();
  const idxOf = (q0, r0) => indexOf(q0, r0, width);

  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cd = dist[cur];
    const h = hexes[cur];
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = idxOf(nq, nr);
      if (!landMask[ni]) continue;
      if (dist[ni] !== -1) continue;
      dist[ni] = cd + 1;
      q.push(ni);
    }
  }
  return dist;
}

function computeIsCoast({ width, height, hexes, landMask }) {
  const total = width * height;
  const isCoast = new Uint8Array(total);
  isCoast.fill(0);
  const dirs = defaultNeighborDirs();
  for (let i = 0; i < total; i++) {
    if (!landMask[i]) continue;
    const h = hexes[i];
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (hexes[ni]?.tile_kind === "sea") {
        isCoast[i] = 1;
        break;
      }
    }
  }
  return isCoast;
}

function computeDownstream({ width, height, hexes, landMask, heightNorm, seedU32 }) {
  const total = width * height;
  const down = new Int32Array(total);
  down.fill(-1);
  const slope = new Float32Array(total);
  slope.fill(0);

  const dirs = defaultNeighborDirs();
  for (let i = 0; i < total; i++) {
    if (!landMask[i]) continue;
    const h = hexes[i];

    const curH = heightNorm[i];
    let best = -1;
    let bestH = curH;

    // Find strict lower neighbor; tie-break on (height, idx).
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!landMask[ni]) continue;
      const nh = heightNorm[ni];
      if (nh < bestH - 1e-9 || (Math.abs(nh - bestH) <= 1e-9 && (best === -1 || ni < best))) {
        bestH = nh;
        best = ni;
      }
    }

    if (best !== -1) {
      down[i] = best;
      slope[i] = Math.max(0, curH - bestH);
    } else {
      down[i] = -1;
      slope[i] = 0;
    }
  }

  // Secondary pass: break rare flat loops by forcing a deterministic drain.
  // If a tile has no lower neighbor but does have equal-height neighbors,
  // route to the minimal-index equal neighbor using a seeded jitter.
  for (let i = 0; i < total; i++) {
    if (!landMask[i]) continue;
    if (down[i] !== -1) continue;
    const h = hexes[i];
    const curH = heightNorm[i];
    let bestEq = -1;
    let bestJ = Infinity;
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!landMask[ni]) continue;
      const nh = heightNorm[ni];
      if (Math.abs(nh - curH) > 1e-9) continue;
      const j = hash3(seedU32 ^ 0x91e10da5, i, ni, 77) / 0xffffffff;
      if (j < bestJ || (j === bestJ && (bestEq === -1 || ni < bestEq))) {
        bestJ = j;
        bestEq = ni;
      }
    }
    if (bestEq !== -1) down[i] = bestEq;
  }

  return { down, slope };
}

function computeFlowAccum({ landIdx, down, heightNorm }) {
  const acc = new Int32Array(down.length);
  acc.fill(0);
  for (const idx of landIdx) acc[idx] = 1;

  // Sort land by height descending; tie-break by idx descending for consistency.
  const order = landIdx.slice();
  order.sort((a, b) => {
    const da = heightNorm[a];
    const db = heightNorm[b];
    if (da > db) return -1;
    if (da < db) return 1;
    return b - a;
  });

  for (const idx of order) {
    const di = down[idx];
    if (di == null || di < 0) continue;
    acc[di] += acc[idx];
  }

  let maxAcc = 1;
  for (const idx of landIdx) if (acc[idx] > maxAcc) maxAcc = acc[idx];

  return { acc, maxAcc };
}

function buildLakeCandidateList({
  landIdx,
  hexes,
  heightNorm,
  moisture,
  sinkProx,
  distToSea,
  distToVoid,
  isCoast,
  protectedIdxSet,
  majorRiverIdxSet,
  frontierBiasMask,
  wantBorder
}) {
  const cand = [];
  for (const idx of landIdx) {
    if (protectedIdxSet?.has(idx)) continue;
    if (majorRiverIdxSet?.has(idx)) continue;
    if (isCoast[idx] === 1) continue;

    const dSea = distToSea?.[idx];
    if (Number.isFinite(dSea) && dSea >= 0 && dSea <= 1) continue;

    const dVoid = distToVoid?.[idx];

    if (wantBorder) {
      // Near frontier (but not the coast).
      if (!(Number.isFinite(dVoid) && dVoid >= 0 && dVoid <= 2)) continue;
    } else {
      // Interior lakes.
      if (!(Number.isFinite(dVoid) && dVoid >= 0 && dVoid >= 2)) continue;
    }

    const h = heightNorm[idx];
    const m = moisture[idx];
    const sp = sinkProx[idx];
    const fb = frontierBiasMask ? (frontierBiasMask[idx] ? 0.15 : 0) : 0;

    // Low + basin-y + moist gets priority.
    const score = (1 - h) * 0.70 + sp * 0.55 + m * 0.25 + fb;
    cand.push({ idx, score });
  }

  cand.sort((a, b) => {
    if (a.score > b.score) return -1;
    if (a.score < b.score) return 1;
    return a.idx - b.idx;
  });
  return cand;
}

function countLandWithinRadius({ seedIdx, width, height, hexes, landMask, radius }) {
  const dirs = defaultNeighborDirs();
  const seen = new Uint8Array(width * height);
  const q = [seedIdx];
  seen[seedIdx] = 1;
  let qi = 0;
  let ct = 0;

  while (qi < q.length) {
    const cur = q[qi++];
    const h0 = hexes[cur];
    ct += 1;
    for (const d of dirs) {
      const nq = h0.q + d.dq;
      const nr = h0.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (seen[ni]) continue;
      if (!landMask[ni]) continue;
      // radius bound: use axial distance to seed.
      const h1 = hexes[ni];
      if (axialDist(h1.q, h1.r, hexes[seedIdx].q, hexes[seedIdx].r) > radius) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }

  return ct;
}

function growLake({
  lakeId,
  seedIdx,
  targetSize,
  width,
  height,
  hexes,
  landMask,
  heightNorm,
  lakeMask,
  protectedIdxSet,
  forbidMask,
  prioSeedU32
}) {
  const dirs = defaultNeighborDirs();
  const visited = new Uint8Array(width * height);
  const lakeTiles = [];

  const hSeed = hexes[seedIdx];
  const seedQ = hSeed.q;
  const seedR = hSeed.r;

  const heap = new MinHeap((a, b) => (a.p - b.p) || (a.idx - b.idx));
  heap.push({ idx: seedIdx, p: heightNorm[seedIdx] });

  while (heap.size && lakeTiles.length < targetSize) {
    const cur = heap.pop();
    if (!cur) break;
    const idx = cur.idx;
    if (visited[idx]) continue;
    visited[idx] = 1;

    if (!landMask[idx]) continue;
    if (lakeMask[idx]) continue;
    if (protectedIdxSet?.has(idx)) continue;
    if (forbidMask && forbidMask[idx]) continue;

    // Keep lakes as distinct components: do not allow a new lake to touch any
    // already-committed lake tiles.
    {
      const h0 = hexes[idx];
      let touchesExisting = false;
      for (const d of dirs) {
        const nq = h0.q + d.dq;
        const nr = h0.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (lakeMask[ni]) { touchesExisting = true; break; }
      }
      if (touchesExisting) continue;
    }

    lakeTiles.push(idx);

    const h0 = hexes[idx];
    for (const d of dirs) {
      const nq = h0.q + d.dq;
      const nr = h0.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (visited[ni]) continue;
      if (!landMask[ni]) continue;
      if (lakeMask[ni]) continue;
      if (protectedIdxSet?.has(ni)) continue;
      if (forbidMask && forbidMask[ni]) continue;

      const h1 = hexes[ni];
      const d1 = axialDist(seedQ, seedR, h1.q, h1.r);
      const jitter = (hash3(prioSeedU32, ni, lakeId, 901) / 0xffffffff) * 1e-4;
      const p = heightNorm[ni] + d1 * 0.012 + jitter;
      heap.push({ idx: ni, p });
    }
  }

  return lakeTiles;
}

export function paintTerrainHydrologyV1({
  seed,
  width,
  height,
  hexes,
  landIdx,
  distToSea,
  distToVoid,
  distToMajorRiver,
  macroStyleId,
  macroRidgeMask,
  macroBasinId,
  frontierRidgeMask,
  frontierRiverMask,
  frontierRiverFordMask,
  estuaryIdxSet,
  majorRiverIdxSet,
  protectedIdxSet,
  seatsIdx,
  config,
  debugOut
}) {
  assert(typeof seed === "string" && seed.length > 0, "paintTerrainHydrologyV1: seed missing");
  assert(Number.isInteger(width) && width > 0, "paintTerrainHydrologyV1: width invalid");
  assert(Number.isInteger(height) && height > 0, "paintTerrainHydrologyV1: height invalid");
  assert(Array.isArray(hexes) && hexes.length === width * height, "paintTerrainHydrologyV1: hexes invalid");
  assert(Array.isArray(landIdx), "paintTerrainHydrologyV1: landIdx invalid");

  const total = width * height;
  const landMask = buildLandSet(hexes);

  const protectedAll = new Set();
  if (protectedIdxSet) for (const x of protectedIdxSet) protectedAll.add(x);
  if (Array.isArray(seatsIdx)) for (const x of seatsIdx) protectedAll.add(x);

  // --- Coast detection (land adjacent to sea)
  const isCoast = computeIsCoast({ width, height, hexes, landMask });

  // --- Height field (0..1)
  const heightSeed = hashStringToU32(`${seed}|terrain_height_v1`);

  const heightRaw = new Float32Array(total);
  heightRaw.fill(0);

  // Basin base offsets (3 basins typical): subtle broad variation.
  const basinBase = new Map();
  if (macroBasinId) {
    for (const idx of landIdx) {
      const b = macroBasinId[idx];
      if (b < 0) continue;
      if (!basinBase.has(b)) {
        const u = hash3(heightSeed ^ 0x1234abcd, b, 17, 99) / 0xffffffff;
        basinBase.set(b, (u * 0.18) - 0.09); // [-0.09, +0.09]
      }
    }
  }

  const gradAmp = Number(config?.mapgen?.terrain?.height_grad_amp ?? 0.55);
  const gradDen = Math.max(8, Math.floor(Number(config?.mapgen?.terrain?.height_grad_scale ?? 26)));
  const ridgeBoost = Number(config?.mapgen?.terrain?.ridge_height_boost ?? 0.75);
  const frontierRidgeBoost = Number(config?.mapgen?.terrain?.frontier_ridge_height_boost ?? 0.95);
  const riverCarve = Number(config?.mapgen?.terrain?.river_valley_carve ?? 0.55);
  const frontierRiverCarve = Number(config?.mapgen?.terrain?.frontier_river_valley_carve ?? 0.70);

  for (const idx of landIdx) {
    const h = hexes[idx];
    const q = h.q;
    const r = h.r;

    // Multi-scale smooth noise.
    const n1 = valueNoise2D(heightSeed, q, r, Number(config?.mapgen?.terrain?.height_noise_scale1 ?? 18));
    const n2 = valueNoise2D(heightSeed ^ 0x5a5a5a5a, q, r, Number(config?.mapgen?.terrain?.height_noise_scale2 ?? 42));
    const n3 = valueNoise2D(heightSeed ^ 0xa5a5a5a5, q, r, Number(config?.mapgen?.terrain?.height_noise_scale3 ?? 9));
    let v = (n1 * 0.65) + (n2 * 0.25) + (n3 * 0.10);

    // Macro style C: explicit coastal → interior gradient.
    if (String(macroStyleId ?? "A").toUpperCase() === "C") {
      let d = distToSea?.[idx];
      if (!Number.isFinite(d) || d < 0) d = gradDen;
      const g = clamp01(d / gradDen);
      v += g * gradAmp;
    }

    // Basin broad offsets.
    if (macroBasinId) {
      const b = macroBasinId[idx];
      if (basinBase.has(b)) v += basinBase.get(b);
    }

    // Macro ridge belts and frontier ridges are higher.
    if (macroRidgeMask && macroRidgeMask[idx] === 1) v += ridgeBoost;
    if (frontierRidgeMask && frontierRidgeMask[idx] === 1) {
      const dv = distToVoid?.[idx];
      const w = Number.isFinite(dv) ? clamp01(1 - (dv / 4)) : 1;
      v += frontierRidgeBoost * w;
    }

    // River valleys carve lower elevation.
    const dr = distToMajorRiver?.[idx];
    if (Number.isFinite(dr) && dr >= 0 && dr <= 3) {
      const w = clamp01(1 - (dr / 3));
      v -= riverCarve * w;
    }
    if (frontierRiverMask && frontierRiverMask[idx] === 1) {
      const dv = distToVoid?.[idx];
      const w = Number.isFinite(dv) ? clamp01(1 - (dv / 3)) : 1;
      v -= frontierRiverCarve * w;
    }

    heightRaw[idx] = v;
  }

  // Normalize height.
  let hMin = Infinity;
  let hMax = -Infinity;
  for (const idx of landIdx) {
    const v = heightRaw[idx];
    if (v < hMin) hMin = v;
    if (v > hMax) hMax = v;
  }
  const hSpan = Math.max(1e-6, hMax - hMin);

  const heightNorm = new Float32Array(total);
  heightNorm.fill(0);
  for (const idx of landIdx) {
    // small jitter to avoid flats in flow routing
    const j = (hash3(heightSeed ^ 0x3141592, idx, 13, 77) / 0xffffffff) * 1e-4;
    heightNorm[idx] = clamp01(((heightRaw[idx] - hMin) / hSpan) + j);
  }

  // --- Drainage: flow direction + accumulation + sink proximity
  const { down, slope } = computeDownstream({ width, height, hexes, landMask, heightNorm, seedU32: heightSeed });
  const { acc, maxAcc } = computeFlowAccum({ landIdx, down, heightNorm });

  const sinks = [];
  for (const idx of landIdx) {
    if (down[idx] === -1) sinks.push(idx);
  }
  sinks.sort((a, b) => a - b);

  const distToSink = computeDistToSources({ width, height, hexes, landMask, sourcesIdx: sinks });
  const sinkRadius = Math.max(4, Math.floor(Number(config?.mapgen?.terrain?.sink_influence_radius ?? 7)));
  const sinkProx = new Float32Array(total);
  sinkProx.fill(0);
  for (const idx of landIdx) {
    const d = distToSink[idx];
    if (d < 0) { sinkProx[idx] = 0; continue; }
    sinkProx[idx] = clamp01(1 - (d / sinkRadius));
  }

  // --- Moisture (0..1), pass 1 (no lakes yet)
  const moistureSeed = hashStringToU32(`${seed}|terrain_moisture_v1`);
  const moisture = new Float32Array(total);
  moisture.fill(0);

  const seaMoistRadius = Math.max(10, Math.floor(Number(config?.mapgen?.terrain?.sea_moisture_radius ?? 26)));
  const riverMoistRadius = Math.max(6, Math.floor(Number(config?.mapgen?.terrain?.river_moisture_radius ?? 10)));
  const baseMoist = Number(config?.mapgen?.terrain?.base_moisture ?? 0.38);
  const seaMoistAmp = Number(config?.mapgen?.terrain?.sea_moisture_amp ?? 0.36);
  const riverMoistAmp = Number(config?.mapgen?.terrain?.river_moisture_amp ?? 0.22);
  const noiseMoistAmp = Number(config?.mapgen?.terrain?.noise_moisture_amp ?? 0.20);

  for (const idx of landIdx) {
    const h = hexes[idx];
    const q = h.q;
    const r = h.r;

    let m = baseMoist;
    const ds = distToSea?.[idx];
    if (Number.isFinite(ds) && ds >= 0) {
      const w = clamp01(1 - (ds / seaMoistRadius));
      m += seaMoistAmp * w;
    }
    const dr = distToMajorRiver?.[idx];
    if (Number.isFinite(dr) && dr >= 0) {
      const w = clamp01(1 - (dr / riverMoistRadius));
      m += riverMoistAmp * w;
    }
    const n = valueNoise2D(moistureSeed ^ 0x77777777, q, r, Number(config?.mapgen?.terrain?.moisture_noise_scale ?? 15));
    m += (n - 0.5) * 2 * noiseMoistAmp;

    // Slight rain shadow in high elevations.
    m -= (heightNorm[idx] - 0.5) * 0.08;

    moisture[idx] = clamp01(m);
  }

  // --- Lakes placement
  const lakeMask = new Uint8Array(total);
  lakeMask.fill(0);
  const borderRiverMask = new Uint8Array(total);
  borderRiverMask.fill(0);

  const lakesSeed = hashStringToU32(`${seed}|lakes_v1`);
  const lakeRand = makeMulberry32(lakesSeed >>> 0);

  const smallCountBand = config?.mapgen?.terrain?.lakes?.small_count_band ?? [5, 10];
  const smallSizeBand = config?.mapgen?.terrain?.lakes?.small_size_band ?? [3, 10];
  const medCount = Number(config?.mapgen?.terrain?.lakes?.medium_count ?? 2);
  const medSizeBand = config?.mapgen?.terrain?.lakes?.medium_size_band ?? [20, 50];
  const borderChance = Number(config?.mapgen?.terrain?.lakes?.border_large_chance ?? 0.40);
  const borderSizeBand = config?.mapgen?.terrain?.lakes?.border_large_size_band ?? [30, 60];

  const smallCount = pickInt(lakeRand, smallCountBand[0], smallCountBand[1]);
  const wantBorderLake = lakeRand() < clamp01(borderChance);
  const borderCount = wantBorderLake ? 1 : 0;

  const lakeCenters = [];
  const minSepSmall = Math.max(5, Math.floor(Number(config?.mapgen?.terrain?.lakes?.min_sep_small ?? 6)));
  const minSepMed = Math.max(minSepSmall + 1, Math.floor(Number(config?.mapgen?.terrain?.lakes?.min_sep_medium ?? 8)));
  const minSepBorder = Math.max(minSepMed, Math.floor(Number(config?.mapgen?.terrain?.lakes?.min_sep_border ?? 8)));

  const isTooClose = (idx, minSep) => {
    const h0 = hexes[idx];
    for (const c of lakeCenters) {
      const hc = hexes[c];
      if (axialDist(h0.q, h0.r, hc.q, hc.r) < minSep) return true;
    }
    return false;
  };

  // Avoid placing lakes on/adjacent to estuary corridor.
  const forbidNearEstuary = new Uint8Array(total);
  forbidNearEstuary.fill(0);
  if (estuaryIdxSet && estuaryIdxSet.size) {
    // Mark land tiles within 1 step of estuary sea tiles as forbidden.
    const dirs = defaultNeighborDirs();
    for (const e of estuaryIdxSet) {
      const he = hexes[e];
      for (const d of dirs) {
        const nq = he.q + d.dq;
        const nr = he.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (landMask[ni]) forbidNearEstuary[ni] = 1;
      }
    }
  }

  // Coastal lake prohibition (M3 lock): freshwater lakes must be at least 2 hexes
  // away from ocean sea. We enforce this BOTH at candidate selection AND during
  // lake growth by forbidding tiles with distToSea <= 1.
  const forbidLake = new Uint8Array(total);
  forbidLake.fill(0);
  for (const idx of landIdx) {
    if (forbidNearEstuary[idx]) { forbidLake[idx] = 1; continue; }
    const dSea = distToSea?.[idx];
    if (Number.isFinite(dSea) && dSea >= 0 && dSea <= 1) {
      forbidLake[idx] = 1;
    }
  }

  const lakePrioSeed = hashStringToU32(`${seed}|lake_grow_prio_v1`);

  // Candidate lists
  const frontierBiasForBorderLake = frontierRiverMask ?? frontierRidgeMask;
  const candInterior = buildLakeCandidateList({
    landIdx,
    hexes,
    heightNorm,
    moisture,
    sinkProx,
    distToSea,
    distToVoid,
    isCoast,
    protectedIdxSet: protectedAll,
    majorRiverIdxSet,
    frontierBiasMask: null,
    wantBorder: false
  });

  const candBorder = buildLakeCandidateList({
    landIdx,
    hexes,
    heightNorm,
    moisture,
    sinkProx,
    distToSea,
    distToVoid,
    isCoast,
    protectedIdxSet: protectedAll,
    majorRiverIdxSet,
    frontierBiasMask: frontierBiasForBorderLake,
    wantBorder: true
  });

  // Place medium lakes first (more constrained), then border lake, then small.
  const placedLakes = [];

  const placeOneLake = ({ targetSize, candidates, minSep, maxCandScan }) => {
    const scan = Math.max(20, Math.floor(Number(maxCandScan ?? 600)));
    for (let ci = 0; ci < candidates.length && ci < scan; ci++) {
      const idx = candidates[ci].idx;
      if (lakeMask[idx]) continue;
      if (!landMask[idx]) continue;
      if (forbidLake[idx]) continue;
      if (isTooClose(idx, minSep)) continue;

      // Quick viability check: enough land within a compact radius.
      const radius = Math.max(3, Math.ceil(Math.sqrt(targetSize) * 1.25));
      const avail = countLandWithinRadius({ seedIdx: idx, width, height, hexes, landMask, radius });
      if (avail < targetSize) continue;

      const tiles = growLake({
        lakeId: placedLakes.length,
        seedIdx: idx,
        targetSize,
        width,
        height,
        hexes,
        landMask,
        heightNorm,
        lakeMask,
        protectedIdxSet: protectedAll,
        forbidMask: forbidLake,
        prioSeedU32: lakePrioSeed
      });
      if (!tiles.length) continue;
      // Commit
      for (const t of tiles) lakeMask[t] = 1;
      lakeCenters.push(idx);
      placedLakes.push({ seed_idx: idx, size: tiles.length, tiles });
      return true;
    }
    return false;
  };

  for (let i = 0; i < Math.max(0, medCount); i++) {
    const targetSize = pickInt(lakeRand, medSizeBand[0], medSizeBand[1]);
    placeOneLake({ targetSize, candidates: candInterior, minSep: minSepMed, maxCandScan: 1600 });
  }

  for (let i = 0; i < borderCount; i++) {
    const targetSize = pickInt(lakeRand, borderSizeBand[0], borderSizeBand[1]);
    placeOneLake({ targetSize, candidates: candBorder, minSep: minSepBorder, maxCandScan: 2400 });
  }

  for (let i = 0; i < Math.max(0, smallCount); i++) {
    const targetSize = pickInt(lakeRand, smallSizeBand[0], smallSizeBand[1]);
    placeOneLake({ targetSize, candidates: candInterior, minSep: minSepSmall, maxCandScan: 4000 });
  }

  // --- Border river belt (optional): render some frontier-river segments as 1-hex water.
  const enableBorderRiverBelt = config?.mapgen?.terrain?.border_river_belt?.enabled ?? true;
  if (enableBorderRiverBelt && frontierRiverMask) {
    for (const idx of landIdx) {
      if (frontierRiverMask[idx] !== 1) continue;
      if (frontierRiverFordMask && frontierRiverFordMask[idx] === 1) continue;
      if (protectedAll.has(idx)) continue;
      if (lakeMask[idx]) continue;
      if (isCoast[idx] === 1) continue;

      const dv = distToVoid?.[idx];
      // Only along the actual kingdom frontier (void-adjacent), not interior.
      if (!Number.isFinite(dv) || dv > 1) continue;

      borderRiverMask[idx] = 1;
    }
  }

  // --- Moisture pass 2: lakes + border-river belts add local humidity.
  const lakeSources = [];
  for (const idx of landIdx) if (lakeMask[idx] === 1 || borderRiverMask[idx] === 1) lakeSources.push(idx);
  lakeSources.sort((a, b) => a - b);
  const distToLake = lakeSources.length ? computeDistToSources({ width, height, hexes, landMask, sourcesIdx: lakeSources }) : null;
  const lakeMoistRadius = Math.max(4, Math.floor(Number(config?.mapgen?.terrain?.lake_moisture_radius ?? 8)));
  const lakeMoistAmp = Number(config?.mapgen?.terrain?.lake_moisture_amp ?? 0.22);
  if (distToLake) {
    for (const idx of landIdx) {
      const dl = distToLake[idx];
      if (dl < 0) continue;
      const w = clamp01(1 - (dl / lakeMoistRadius));
      moisture[idx] = clamp01(moisture[idx] + lakeMoistAmp * w);
    }
  }

  // --- Terrain assignment
  // Reset terrain for land (leave sea/void alone).
  for (const idx of landIdx) {
    hexes[idx].terrain = "plains";
  }

  // Coast (land adjacent to sea)
  for (const idx of landIdx) {
    if (isCoast[idx] === 1) hexes[idx].terrain = "coast";
  }

  // Lakes (terrain = lake)
  for (const idx of landIdx) {
    if (lakeMask[idx] !== 1) continue;
    const h = hexes[idx];
    h.terrain = "lake";
    h.hydrology = { ...(h.hydrology ?? {}), water_kind: "lake" };
  }

  // Border river water belt
  for (const idx of landIdx) {
    if (borderRiverMask[idx] !== 1) continue;
    const h = hexes[idx];
    h.terrain = "lake";
    h.hydrology = { ...(h.hydrology ?? {}), water_kind: "border_river" };
  }

  // Elevation quantiles for thresholds (exclude coast + lake)
  const elev = [];
  for (const idx of landIdx) {
    if (hexes[idx].terrain === "coast") continue;
    if (hexes[idx].terrain === "lake") continue;
    elev.push(heightNorm[idx]);
  }
  elev.sort((a, b) => a - b);
  const q85 = quantileSorted(elev, 0.85);
  const q70 = quantileSorted(elev, 0.70);

  // Mountains: high elevation, emphasized on ridge belts.
  const mountainsMask = new Uint8Array(total);
  mountainsMask.fill(0);
  const hillsMask = new Uint8Array(total);
  hillsMask.fill(0);

  for (const idx of landIdx) {
    const h = hexes[idx];
    if (h.terrain === "coast" || h.terrain === "lake") continue;
    const e = heightNorm[idx];

    const ridge = (macroRidgeMask && macroRidgeMask[idx] === 1) ? 1 : 0;
    const fRidge = (frontierRidgeMask && frontierRidgeMask[idx] === 1) ? 1 : 0;

    let isMtn = false;
    if (fRidge) {
      // Strong frontier ridges are mountain belts.
      const dv = distToVoid?.[idx];
      if (Number.isFinite(dv) && dv <= 2) isMtn = true;
    }
    if (!isMtn) {
      const thr = ridge ? Math.max(0.62, q70) : Math.max(0.74, q85);
      if (e >= thr) isMtn = true;
    }
    if (isMtn) {
      mountainsMask[idx] = 1;
      h.terrain = "mountains";
    }
  }

  // Hills: buffer around mountains + ridge belts.
  const dirs = defaultNeighborDirs();
  for (const idx of landIdx) {
    const h = hexes[idx];
    if (h.terrain === "coast" || h.terrain === "lake") continue;
    if (h.terrain === "mountains") continue;

    let makeHill = false;
    if (macroRidgeMask && macroRidgeMask[idx] === 1) makeHill = true;
    if (frontierRidgeMask && frontierRidgeMask[idx] === 1) {
      const dv = distToVoid?.[idx];
      if (Number.isFinite(dv) && dv <= 3) makeHill = true;
    }
    if (!makeHill) {
      const e = heightNorm[idx];
      if (e >= q70) makeHill = true;
    }
    if (!makeHill) {
      // buffer: adjacent to mountains
      const h0 = hexes[idx];
      for (const d of dirs) {
        const nq = h0.q + d.dq;
        const nr = h0.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!landMask[ni]) continue;
        if (mountainsMask[ni] === 1) { makeHill = true; break; }
      }
    }

    if (makeHill) {
      hillsMask[idx] = 1;
      h.terrain = "hills";
    }
  }

  // Marsh: low + wet + poor drainage.
  const marshMask = new Uint8Array(total);
  marshMask.fill(0);
  const slopeRef = Number(config?.mapgen?.terrain?.slope_ref ?? 0.10);
  const marshMoistThr = Number(config?.mapgen?.terrain?.marsh_moisture_thr ?? 0.68);
  const marshElevThr = Number(config?.mapgen?.terrain?.marsh_elev_thr ?? 0.34);
  const marshSinkThr = Number(config?.mapgen?.terrain?.marsh_sink_thr ?? 0.45);

  // Optional estuary marsh ring: boost marsh score within N.
  let distToEstuaryLand = null;
  const estuaryRing = config?.coast_and_estuary?.estuary?.marsh_ring_steps ?? [0, 3];
  if (estuaryIdxSet && estuaryIdxSet.size && Array.isArray(estuaryRing) && estuaryRing.length === 2) {
    const src = [];
    const dirs2 = defaultNeighborDirs();
    for (const e of estuaryIdxSet) {
      const he = hexes[e];
      for (const d of dirs2) {
        const nq = he.q + d.dq;
        const nr = he.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (landMask[ni]) src.push(ni);
      }
    }
    src.sort((a, b) => a - b);
    distToEstuaryLand = computeDistToSources({ width, height, hexes, landMask, sourcesIdx: src });
  }
  const estuaryBoostSteps = Array.isArray(estuaryRing) ? Math.max(0, Math.floor(estuaryRing[1] ?? 0)) : 0;

  for (const idx of landIdx) {
    const h = hexes[idx];
    if (h.terrain === "coast" || h.terrain === "lake") continue;
    if (h.terrain === "mountains" || h.terrain === "hills") continue;

    const e = heightNorm[idx];
    const m = moisture[idx];

    // Poor drainage signal
    const flat = 1 - clamp01((slope[idx] ?? 0) / slopeRef);
    const sinky = sinkProx[idx];

    let score = 0;
    score += (e <= marshElevThr) ? 0.55 : 0;
    score += (m >= marshMoistThr) ? 0.35 : 0;
    score += (sinky >= marshSinkThr) ? 0.30 : 0;
    score += flat * 0.20;

    // Estuary-adjacent marsh boost (but not guaranteed).
    if (distToEstuaryLand) {
      const d = distToEstuaryLand[idx];
      if (Number.isFinite(d) && d >= 0 && d <= estuaryBoostSteps) score += 0.25;
    }

    if (score >= 0.80) {
      marshMask[idx] = 1;
      h.terrain = "marsh";
    }
  }

  // Forests: moisture-driven with border "march" bias.
  const forestMask = new Uint8Array(total);
  forestMask.fill(0);
  const forestSeed = hashStringToU32(`${seed}|forest_mask_v1`);
  const forestBaseThr = Number(config?.mapgen?.terrain?.forest_threshold ?? 0.56);

  for (const idx of landIdx) {
    const h = hexes[idx];
    if (h.terrain !== "plains" && h.terrain !== "marsh" && h.terrain !== "hills") continue;
    if (h.terrain === "marsh") continue; // keep marsh as-is

    const e = heightNorm[idx];
    const m = moisture[idx];
    const dv = distToVoid?.[idx];
    const march = (Number.isFinite(dv) && dv >= 0 && dv <= 2 && isCoast[idx] === 0) ? (dv === 0 ? 0.18 : dv === 1 ? 0.12 : 0.06) : 0;
    const n = valueNoise2D(forestSeed, hexes[idx].q, hexes[idx].r, Number(config?.mapgen?.terrain?.forest_noise_scale ?? 11));
    const score = (m * 0.70) + ((1 - e) * 0.15) + ((n - 0.5) * 0.30) + march;
    if (score >= forestBaseThr) forestMask[idx] = 1;
  }

  // Simple smoothing to create clusters (2 passes)
  const smoothPasses = Math.max(0, Math.floor(Number(config?.mapgen?.terrain?.forest_smooth_passes ?? 2)));
  for (let pass = 0; pass < smoothPasses; pass++) {
    const next = new Uint8Array(total);
    next.set(forestMask);
    for (const idx of landIdx) {
      const h = hexes[idx];
      if (h.terrain === "coast" || h.terrain === "lake" || h.terrain === "mountains" || h.terrain === "marsh") continue;
      const h0 = hexes[idx];
      let nForest = 0;
      for (const d of dirs) {
        const nq = h0.q + d.dq;
        const nr = h0.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!landMask[ni]) continue;
        if (forestMask[ni] === 1) nForest++;
      }
      if (forestMask[idx] === 1) {
        // Keep if at least 2 neighbors forest.
        if (nForest < 2) next[idx] = 0;
      } else {
        // Become forest if strong neighborhood.
        if (nForest >= 4) next[idx] = 1;
      }
    }
    forestMask.set(next);
  }

  for (const idx of landIdx) {
    const h = hexes[idx];
    if (h.terrain === "coast" || h.terrain === "lake" || h.terrain === "mountains" || h.terrain === "marsh") continue;
    if (forestMask[idx] === 1) h.terrain = "forest";
  }

  // --- Adjacency corrections (config invariants)
  // 1) Mountains cannot touch sea/coast.
  // 2) Mountains cannot touch plains.
  // 3) Marsh cannot touch mountains.
  for (const idx of landIdx) {
    if (hexes[idx].terrain !== "mountains") continue;
    const h0 = hexes[idx];
    let nearSea = false;
    for (const d of dirs) {
      const nq = h0.q + d.dq;
      const nr = h0.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      const nh = hexes[ni];
      if (!nh) continue;
      if (nh.tile_kind === "sea" || nh.terrain === "coast") { nearSea = true; break; }
    }
    if (nearSea) {
      hexes[idx].terrain = "hills";
      mountainsMask[idx] = 0;
      hillsMask[idx] = 1;
    }
  }

  for (const idx of landIdx) {
    if (hexes[idx].terrain !== "mountains") continue;
    const h0 = hexes[idx];
    for (const d of dirs) {
      const nq = h0.q + d.dq;
      const nr = h0.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!landMask[ni]) continue;
      const t = hexes[ni].terrain;
      if (t === "plains") hexes[ni].terrain = "hills";
      if (t === "marsh") hexes[ni].terrain = "plains";
    }
  }

  // Ensure protected tiles (seats etc.) are not water/marsh/mountains.
  if (Array.isArray(seatsIdx) && seatsIdx.length) {
    for (const idx of seatsIdx) {
      if (!landMask[idx]) continue;
      const t = hexes[idx].terrain;
      if (t === "lake" || t === "marsh" || t === "mountains") {
        hexes[idx].terrain = "hills";
        // Clear lake hydrology if we accidentally painted it.
        if (hexes[idx]?.hydrology?.water_kind === "lake" || hexes[idx]?.hydrology?.water_kind === "border_river") {
          const { water_kind, ...rest } = hexes[idx].hydrology ?? {};
          hexes[idx].hydrology = Object.keys(rest).length ? rest : (hexes[idx].hydrology?.river_class ? { river_class: hexes[idx].hydrology.river_class } : undefined);
        }
      }
    }
  }

  // --- Debug output
  if (debugOut) {
    debugOut.lakes = {
      placed_total: placedLakes.length,
      placed: placedLakes
        .map((l) => ({ seed_idx: l.seed_idx, size: l.size }))
        .sort((a, b) => b.size - a.size || a.seed_idx - b.seed_idx),
      small_target: smallCount,
      medium_target: medCount,
      border_lake_target: borderCount,
      border_river_belt_hexes: landIdx.reduce((acc, i) => acc + (borderRiverMask[i] === 1 ? 1 : 0), 0)
    };
  }

  return {
    lakeMask,
    borderRiverMask,
    heightNorm,
    moisture,
    drainage: { acc, maxAcc, sinkCount: sinks.length }
  };
}
