#!/usr/bin/env node
/**
 * MapGen v1 — build-time deterministic generator
 *
 * Usage:
 *   npm run map:gen -- --seed=<MAPGEN_SEED> --config=data/map/map_v1_config.json --out=data/map/map_v1.json
 *
 * Outputs:
 * - data/map/map_v1.json (out)
 * - public/data/map/map_v1.json (runtime fetch path)
 * - --metricsOut path (metrics)
 */
import fs from "node:fs";
import path from "node:path";

import {
  assert,
  ensureDir,
  parseArgs,
  readJson,
  writeJson,
  sha256File,
  hashStringToU32,
  makeMulberry32,
  pickInt,
  choice,
  shuffled,
  defaultNeighborDirs,
  inBounds,
  indexOf,
  axialDist,
  computeMapMetrics,
  stableStringify
} from "./mapLibV1.mjs";

import { perturbCoastlineMask, breakCoastStraightRunsMask, computeCoastStraightRunMetrics } from "./coastPerturbV1.mjs";
import {
  pickSeatsV2,
  ensureSeatViability,
  repairSeatsForMinCountySizeCostVoronoi,
  deriveCountyLoopOrder,
  computeCountyTargetsEqualSplit,
  assignCountiesSpiralCaps,
  assignCountiesCostVoronoi
} from "./countyV2PQ.mjs";
import { parseMacroStyleFromSeed, generateMacroDividerCostV1 } from "./macroSkeletonV1.mjs";
import { paintTerrainHydrologyV1 } from "./terrainHydrologyV1.mjs";

function hexId(i) {
  return `hx_${i}`;
}

function buildCountyNames() {
  // 15 placeholder names; keep stable/deterministic.
  return [
    "Alderwick",
    "Bramholt",
    "Crowmarsh",
    "Dunmere",
    "Eldham",
    "Falkenford",
    "Glastonmere",
    "Harrowfield",
    "Ivydale",
    "Kestrelford",
    "Larkspire",
    "Merewatch",
    "Northwych",
    "Orchardmere",
    "Wyrmford"
  ];
}

const SIDE_PLANES_CW = ["x_pos","z_neg","y_pos","x_neg","z_pos","y_neg"];

function cubeRel(q, r, cq, cr) {
  const x = q - cq;
  const z = r - cr;
  const y = -x - z;
  return { x, y, z };
}

function cubeDist(x, y, z) {
  return Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
}

function approxHexRadiusForArea(hexCount) {
  // Solve N = 1 + 3r(r+1) for r.
  const n = Math.max(1, Number(hexCount ?? 1));
  const r = (Math.sqrt(Math.max(0, 12 * n - 3)) - 3) / 6;
  return Math.max(0, Math.floor(r));
}

function angleBinFromRel(rel, bins) {
  const B = Math.max(8, Math.floor(Number(bins ?? 360)));
  // Axial->2D projection (pointy-top) for a stable angle.
  const px = rel.x + rel.z * 0.5;
  const py = rel.z * 0.8660254037844386;
  let a = Math.atan2(py, px); // [-pi, +pi]
  let t = (a + Math.PI) / (2 * Math.PI); // [0,1]
  if (!Number.isFinite(t)) t = 0;
  let bi = Math.floor(t * B);
  if (bi < 0) bi = 0;
  if (bi >= B) bi = B - 1;
  return bi;
}

function buildWorldMask({ width, height, radius }) {
  const cq = Math.floor(width / 2);
  const cr = Math.floor(height / 2);
  const inWorld = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let q = 0; q < width; q++) {
      const { x, y, z } = cubeRel(q, r, cq, cr);
      if (cubeDist(x, y, z) <= radius) inWorld[indexOf(q, r, width)] = 1;
    }
  }
  return { inWorld, cq, cr, radius };
}

// --- Remask helpers (kingdom border re-mask) ---
function mixU32_remask(x) {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2(seedU32, x, y) {
  let h = (seedU32 ^ (x + 0x9e3779b9)) >>> 0;
  h = mixU32_remask(h ^ (y >>> 0));
  return h >>> 0;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep01(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

// Hex disk tile count for axial/cube radius r (inclusive): 1 + 3r(r+1)
function hexCountForRadius(r) {
  const rr = Math.max(0, Math.floor(r));
  return 1 + 3 * rr * (rr + 1);
}

// Invert hexCountForRadius to get a useful radius hint for a target tile count.
// Returns floor(r) such that hexCountForRadius(r) <= n.
function approxRadiusForLandCount(n) {
  const nn = Math.max(1, Math.floor(n));
  if (nn <= 1) return 0;
  // Solve 1 + 3r(r+1) = n => r = (-3 + sqrt(12n - 3)) / 6
  const r = (-3 + Math.sqrt(Math.max(0, 12 * nn - 3))) / 6;
  const rf = Math.max(0, Math.floor(r));
  // Guard against float error.
  let out = rf;
  while (hexCountForRadius(out + 1) <= nn) out++;
  while (hexCountForRadius(out) > nn) out--;
  return out;
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

function clampInt(x, lo, hi) {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return Math.max(a, Math.min(b, Math.floor(x)));
}

function meander1D(seedU32, t, scale, amp) {
  const a = Math.max(0, Math.floor(Number(amp ?? 0)));
  if (a <= 0) return 0;
  const s = Math.max(1, Number(scale ?? 1));
  const n = valueNoise2D(seedU32, t, 0, s);
  const x = (n * 2) - 1;
  return clampInt(Math.round(x * a), -a, +a);
}

function cubeToAxial(cq, cr, x, y, z) {
  // Given cubeRel definition, q maps to x and r maps to z.
  return { q: cq + x, r: cr + z };
}

function cubePointOnPlane(plane, R, frac01) {
  const f = Math.max(0, Math.min(1, Number(frac01 ?? 0)));
  const t = Math.round(f * R);
  switch (plane) {
    case "x_pos": {
      const x = R;
      const y = -R + t;
      const z = -x - y;
      return { x, y, z };
    }
    case "x_neg": {
      const x = -R;
      const y = t;
      const z = -x - y;
      return { x, y, z };
    }
    case "y_pos": {
      const y = R;
      const z = -R + t;
      const x = -y - z;
      return { x, y, z };
    }
    case "y_neg": {
      const y = -R;
      const x = t;
      const z = -x - y;
      return { x, y, z };
    }
    case "z_pos": {
      const z = R;
      const x = -R + t;
      const y = -x - z;
      return { x, y, z };
    }
    case "z_neg": {
      const z = -R;
      const x = t;
      const y = -x - z;
      return { x, y, z };
    }
    default:
      return { x: 0, y: 0, z: 0 };
  }
}

class MinHeap {
  constructor() {
    this.a = [];
  }
  size() { return this.a.length; }
  push(node) {
    const a = this.a;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] < a[i][0] || (a[p][0] === a[i][0] && a[p][1] <= a[i][1])) break;
      const tmp = a[p];
      a[p] = a[i];
      a[i] = tmp;
      i = p;
    }
  }
  pop() {
    const a = this.a;
    if (a.length === 0) return null;
    const root = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        if (l >= a.length) break;
        let m = l;
        if (r < a.length) {
          if (a[r][0] < a[l][0] || (a[r][0] === a[l][0] && a[r][1] < a[l][1])) m = r;
        }
        if (a[i][0] < a[m][0] || (a[i][0] === a[m][0] && a[i][1] <= a[m][1])) break;
        const tmp = a[i];
        a[i] = a[m];
        a[m] = tmp;
        i = m;
      }
    }
    return root;
  }
}

function inSideBand({ x, y, z, radius, bandWidth, plane }) {
  const t = radius - bandWidth + 1;
  switch (plane) {
    case "x_pos": return x >= t;
    case "x_neg": return x <= -t;
    case "y_pos": return y >= t;
    case "y_neg": return y <= -t;
    case "z_pos": return z >= t;
    case "z_neg": return z <= -t;
    default: return false;
  }
}

function carveWorldOceanAndEstuary({ width, height, worldRadius, oceanRadius, seaBandWidth, estuaryMouthWidth, estuaryLength, seed, rand }) {
  const total = width * height;
  const { inWorld, cq, cr, radius } = buildWorldMask({ width, height, radius: worldRadius });
  const oceanR = Number.isInteger(oceanRadius) ? oceanRadius : radius;

  const tile_kind = new Array(total);
  const terrain = new Array(total);
  const hydrology = new Array(total).fill(null);

  // Initialize: hex-world interior is land; outside is void.
  for (let i = 0; i < total; i++) {
    if (inWorld[i]) {
      tile_kind[i] = "land";
      terrain[i] = "plains";
    } else {
      tile_kind[i] = "void";
      terrain[i] = "sea";
    }
  }

  // Deterministic ocean orientation: pick 2 adjacent sides from a fixed CW ordering.
  const sideStart = hashStringToU32(String(seed) + "|ocean_sides_v1") % 6;
  const oceanPlanes = [SIDE_PLANES_CW[sideStart], SIDE_PLANES_CW[(sideStart + 1) % 6]];

  // Mark ocean band as sea. IMPORTANT: this band is evaluated against the *ocean anchor radius*
  // (core kingdom radius), not the expanded world radius, so the coastline stays near the
  // original realm boundary even if we add an outer context ring.
  for (let r = 0; r < height; r++) {
    for (let q = 0; q < width; q++) {
      const idx = indexOf(q, r, width);
      if (!inWorld[idx]) continue;
      const { x, y, z } = cubeRel(q, r, cq, cr);
      if (inSideBand({ x, y, z, radius: oceanR, bandWidth: seaBandWidth, plane: oceanPlanes[0] }) ||
          inSideBand({ x, y, z, radius: oceanR, bandWidth: seaBandWidth, plane: oceanPlanes[1] })) {
        tile_kind[idx] = "sea";
        terrain[idx] = "sea";
        hydrology[idx] = { water_kind: "sea" };
      }
    }
  }

  const dirs = defaultNeighborDirs();

  // Choose an estuary mouth tile on the primary ocean side: a sea tile adjacent to land.
  const primaryPlane = oceanPlanes[0];
  const mouthCandidates = [];
  for (let i = 0; i < total; i++) {
    if (!inWorld[i]) continue;
    if (tile_kind[i] !== "sea") continue;
    const q = i % width;
    const r = Math.floor(i / width);
    const { x, y, z } = cubeRel(q, r, cq, cr);
    if (!inSideBand({ x, y, z, radius: oceanR, bandWidth: seaBandWidth, plane: primaryPlane })) continue;

    let hasLand = false;
    for (const d of dirs) {
      const nq = q + d.dq;
      const nr = r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!inWorld[ni]) continue;
      if (tile_kind[ni] === "land") { hasLand = true; break; }
    }
    if (!hasLand) continue;

    // Prefer a mouth near the middle of the side.
    const along = Math.abs(y - z);
    mouthCandidates.push([along, i]);
  }
  mouthCandidates.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

  // Select a viable mouth that can produce a non-null river_end.
  // This avoids rare cases where the estuary is carved entirely inside the sea band
  // (no adjacent land), which would break major-river generation/validation.
  const pickViableMouth = () => {
    if (!mouthCandidates.length) return null;

    const simulateFromStart = (startIdx) => {
      const carved = new Uint8Array(total);
      const path = [];
      let cur = startIdx;
      for (let t = 0; t < estuaryLength && cur != null; t++) {
        carved[cur] = 1;
        path.push(cur);
        const q0 = cur % width;
        const r0 = Math.floor(cur / width);
        // Next step: choose neighboring land tile that moves toward center.
        let next = null;
        let nextD = Infinity;
        for (const d of dirs) {
          const nq = q0 + d.dq;
          const nr = r0 + d.dr;
          if (!inBounds(nq, nr, width, height)) continue;
          const ni = indexOf(nq, nr, width);
          if (!inWorld[ni]) continue;
          if (tile_kind[ni] !== "land") continue;
          if (carved[ni] === 1) continue;
          const rel = cubeRel(nq, nr, cq, cr);
          const dd = cubeDist(rel.x, rel.y, rel.z);
          if (dd < nextD || (dd === nextD && (next == null || ni < next))) {
            nextD = dd;
            next = ni;
          }
        }
        cur = next;
      }

      if (!path.length) return null;
      const headIdx = path[path.length - 1];
      const hq = headIdx % width;
      const hr = Math.floor(headIdx / width);
      // River end: a land neighbor adjacent to the estuary head.
      let endIdx = null;
      let endBest = Infinity;
      for (const d of dirs) {
        const nq = hq + d.dq;
        const nr = hr + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!inWorld[ni]) continue;
        if (tile_kind[ni] !== "land") continue;
        if (carved[ni] === 1) continue;
        const rel = cubeRel(nq, nr, cq, cr);
        const dd = cubeDist(rel.x, rel.y, rel.z);
        if (dd < endBest || (dd === endBest && (endIdx == null || ni < endIdx))) {
          endBest = dd;
          endIdx = ni;
        }
      }
      if (endIdx == null) return null;
      return { path, headIdx, endIdx };
    };

    // Try mouth candidates in deterministic order; for each, try its land neighbors as start options.
    for (const [_along, mouthIdx] of mouthCandidates) {
      const mouthQ = mouthIdx % width;
      const mouthR = Math.floor(mouthIdx / width);
      const landStarts = [];
      for (const d of dirs) {
        const nq = mouthQ + d.dq;
        const nr = mouthR + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!inWorld[ni]) continue;
        if (tile_kind[ni] !== "land") continue;
        const rel = cubeRel(nq, nr, cq, cr);
        const dd = cubeDist(rel.x, rel.y, rel.z);
        landStarts.push([dd, ni]);
      }
      landStarts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
      for (const [_dd, startIdx] of landStarts) {
        const sim = simulateFromStart(startIdx);
        if (!sim) continue;
        return { mouthSeaIdx: mouthIdx, startIdx, path: sim.path, headIdx: sim.headIdx, endIdx: sim.endIdx };
      }
    }

    // Fallback: original best mouth.
    return { mouthSeaIdx: mouthCandidates[0][1], startIdx: null, path: null, headIdx: null, endIdx: null };
  };

  const mouthPick = pickViableMouth();
  const mouthSeaIdx = mouthPick?.mouthSeaIdx ?? null;

  const estuaryTiles = new Set();
  let estuary_head = { q: cq, r: cr, idx: indexOf(cq, cr, width) };
  let river_end = null;

  if (mouthSeaIdx != null) {
    const mouthQ = mouthSeaIdx % width;
    const mouthR = Math.floor(mouthSeaIdx / width);

    // If we already simulated a viable channel, use it.
    let path = mouthPick?.path ?? null;
    let endIdx = mouthPick?.endIdx ?? null;

    // Fallback if viable search failed: keep the old behavior.
    if (!path || !path.length) {
      // Pick inland start: adjacent land that is closest to center.
      let startIdx = null;
      let bestD = Infinity;
      for (const d of dirs) {
        const nq = mouthQ + d.dq;
        const nr = mouthR + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!inWorld[ni]) continue;
        if (tile_kind[ni] !== "land") continue;
        const rel = cubeRel(nq, nr, cq, cr);
        const dd = cubeDist(rel.x, rel.y, rel.z);
        if (dd < bestD) { bestD = dd; startIdx = ni; }
      }

      path = [];
      let cur = startIdx;
      for (let t = 0; t < estuaryLength && cur != null; t++) {
        path.push(cur);
        const q0 = cur % width;
        const r0 = Math.floor(cur / width);
        let next = null;
        let nextD = Infinity;
        for (const d of dirs) {
          const nq = q0 + d.dq;
          const nr = r0 + d.dr;
          if (!inBounds(nq, nr, width, height)) continue;
          const ni = indexOf(nq, nr, width);
          if (!inWorld[ni]) continue;
          if (tile_kind[ni] !== "land") continue;
          const rel = cubeRel(nq, nr, cq, cr);
          const dd = cubeDist(rel.x, rel.y, rel.z);
          if (dd < nextD) { nextD = dd; next = ni; }
        }
        cur = next;
      }

      // River end from the head.
      if (path.length) {
        const headIdx = path[path.length - 1];
        const hq = headIdx % width;
        const hr = Math.floor(headIdx / width);
        let endBest = Infinity;
        for (const d of dirs) {
          const nq = hq + d.dq;
          const nr = hr + d.dr;
          if (!inBounds(nq, nr, width, height)) continue;
          const ni = indexOf(nq, nr, width);
          if (!inWorld[ni]) continue;
          if (tile_kind[ni] !== "land") continue;
          const rel = cubeRel(nq, nr, cq, cr);
          const dd = cubeDist(rel.x, rel.y, rel.z);
          if (dd < endBest) { endBest = dd; endIdx = ni; }
        }
      }
    }

    // Carve the channel.
    if (path && path.length) {
      for (const cur of path) {
        const q = cur % width;
        const r = Math.floor(cur / width);
        tile_kind[cur] = "sea";
        terrain[cur] = "sea";
        hydrology[cur] = { water_kind: "estuary" };
        estuaryTiles.add(cur);
        estuary_head = { q, r, idx: cur };
      }
    }

    river_end = endIdx != null ? { q: endIdx % width, r: Math.floor(endIdx / width), idx: endIdx } : null;

    // Widen the mouth region a bit (presentation-only).
    const mouthHalf = Math.floor(estuaryMouthWidth / 2);
    for (let k = -mouthHalf; k <= mouthHalf; k++) {
      const rr = mouthR + k;
      if (rr < 0 || rr >= height) continue;
      const ii = indexOf(mouthQ, rr, width);
      if (!inWorld[ii]) continue;
      tile_kind[ii] = "sea";
      terrain[ii] = "sea";
      hydrology[ii] = { water_kind: "estuary" };
      estuaryTiles.add(ii);
    }
  }

  return { tile_kind, terrain, hydrology, estuary_head, river_end, estuaryTiles, world: { cq, cr, radius, core_radius: oceanR }, ocean: { sideStart, oceanPlanes, ocean_radius: oceanR }, inWorld };
}

function computeRiverPathBFS({ width, height, inWorld, tile_kind, startIdx, endIdx, seed }) {
  const dirs = defaultNeighborDirs();
  const total = width * height;
  const prev = new Int32Array(total);
  prev.fill(-1);
  const prevDir = new Int8Array(total);
  prevDir.fill(-1);
  const q = new Int32Array(total);
  let qh = 0, qt = 0;

  q[qt++] = startIdx;
  prev[startIdx] = startIdx;
  prevDir[startIdx] = -1;

  while (qh < qt) {
    const cur = q[qh++];
    if (cur === endIdx) break;
    const cq = cur % width;
    const cr = Math.floor(cur / width);

    // Deterministic meander: rotate/flip neighbor exploration order by a hash of (seed, cur).
    // This keeps shortest-path length, but chooses a wavier path among ties.
    let start = 0;
    let step = 1;
    if (seed != null) {
      const h = hashStringToU32(`${seed}|river_meander|${cur}`);
      start = h % 6;
      step = ((h >>> 3) & 1) ? 1 : -1;
    }
    const pd = prevDir[cur];

    // Build the 6 directions in a rotated order.
    const order = [];
    for (let k = 0; k < 6; k++) {
      const di = (start + step * k + 6 * 16) % 6;
      order.push(di);
    }

    // Prefer turns: try directions that are not the previous direction first.
    const passes = pd >= 0 ? [order.filter((x) => x !== pd), [pd]] : [order];

    for (const pass of passes) {
      for (const di of pass) {
        const d = dirs[di];
        const nq = cq + d.dq;
        const nr = cr + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!inWorld[ni]) continue;
        if (tile_kind[ni] !== "land") continue;
        if (prev[ni] !== -1) continue;
        prev[ni] = cur;
        prevDir[ni] = di;
        q[qt++] = ni;
      }
    }
  }

  if (prev[endIdx] === -1) return null;
  const path = [];
  let cur = endIdx;
  while (cur !== startIdx) {
    path.push(cur);
    cur = prev[cur];
    if (cur === -1) return null;
  }
  path.push(startIdx);
  path.reverse();
  return path;
}

// --- River meander helpers (deterministic) ---
class MinHeapRiver {
  constructor() {
    this.a = [];
  }
  _less(i, j) {
    const A = this.a[i];
    const B = this.a[j];
    if (A.f !== B.f) return A.f < B.f;
    return A.idx < B.idx;
  }
  push(node) {
    const a = this.a;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this._less(i, p)) break;
      const tmp = a[i];
      a[i] = a[p];
      a[p] = tmp;
      i = p;
    }
  }
  pop() {
    const a = this.a;
    if (!a.length) return null;
    const root = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      while (true) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this._less(l, m)) m = l;
        if (r < a.length && this._less(r, m)) m = r;
        if (m === i) break;
        const tmp = a[i];
        a[i] = a[m];
        a[m] = tmp;
        i = m;
      }
    }
    return root;
  }
  get size() {
    return this.a.length;
  }
}

function computeDistToSeedsBFS({ width, height, inWorld, passableMask, seeds }) {
  const total = width * height;
  const dist = new Int16Array(total);
  dist.fill(-1);
  if (!seeds?.length) return dist;
  const q = new Int32Array(total);
  let qh = 0, qt = 0;
  for (const s of seeds) {
    if (s == null) continue;
    if (!inWorld[s]) continue;
    if (passableMask && passableMask[s] !== 1) continue;
    if (dist[s] !== -1) continue;
    dist[s] = 0;
    q[qt++] = s;
  }
  const dirs = defaultNeighborDirs();
  while (qh < qt) {
    const cur = q[qh++];
    const cd = dist[cur];
    const cq = cur % width;
    const cr = Math.floor(cur / width);
    for (const d of dirs) {
      const nq = cq + d.dq;
      const nr = cr + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!inWorld[ni]) continue;
      if (passableMask && passableMask[ni] !== 1) continue;
      if (dist[ni] !== -1) continue;
      dist[ni] = cd + 1;
      q[qt++] = ni;
    }
  }
  return dist;
}

function collectWithinRadiusBFS({ width, height, inWorld, passableMask, centerIdx, radius }) {
  const out = [];
  const R = Math.max(0, Math.floor(Number(radius ?? 0)));
  if (R <= 0) {
    if (centerIdx != null && passableMask?.[centerIdx] === 1 && inWorld?.[centerIdx]) out.push(centerIdx);
    return out;
  }
  const total = width * height;
  const dist = new Int16Array(total);
  dist.fill(-1);
  const q = new Int32Array(total);
  let qh = 0, qt = 0;

  if (centerIdx == null) return out;
  if (!inWorld[centerIdx]) return out;
  if (passableMask && passableMask[centerIdx] !== 1) return out;

  dist[centerIdx] = 0;
  q[qt++] = centerIdx;
  out.push(centerIdx);

  const dirs = defaultNeighborDirs();
  while (qh < qt) {
    const cur = q[qh++];
    const cd = dist[cur];
    if (cd >= R) continue;
    const cq = cur % width;
    const cr = Math.floor(cur / width);
    for (const d of dirs) {
      const nq = cq + d.dq;
      const nr = cr + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!inWorld[ni]) continue;
      if (passableMask && passableMask[ni] !== 1) continue;
      if (dist[ni] !== -1) continue;
      dist[ni] = cd + 1;
      q[qt++] = ni;
      out.push(ni);
    }
  }
  return out;
}

function computeRiverPathMeandered({ width, height, inWorld, tile_kind, startIdx, endIdx, seed, config, tag }) {
  // (1) Base shortest path establishes the "reasonable corridor".
  const base = computeRiverPathBFS({ width, height, inWorld, tile_kind, startIdx, endIdx, seed: `${seed}|${tag ?? "river"}|base` });
  if (!base || base.length < 2) return base;

  const total = width * height;
  const landMask = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (!inWorld[i]) continue;
    if (tile_kind[i] === "land") landMask[i] = 1;
  }

  // Config (optional). Defaults tuned to produce visible sinuosity without huge detours.
  const hcfg = config?.mapgen?.hydrology ?? {};
  const majorCfg = hcfg?.major_river ?? hcfg?.majorRiver ?? {};
  const tribCfg = hcfg?.tributary ?? {};

  const isTrib = String(tag ?? "").includes("trib") || String(tag ?? "").includes("tribut");
  const cfg = isTrib ? tribCfg : majorCfg;

  // M3 tuning: slightly stronger meander defaults for visual plausibility.
  // Kept deterministic; users can override via config.mapgen.hydrology.*
  const boostMajor = Number.isFinite(Number(hcfg?.meander_boost_major)) ? Number(hcfg.meander_boost_major) : 1.35;
  const boostTrib = Number.isFinite(Number(hcfg?.meander_boost_tributary)) ? Number(hcfg.meander_boost_tributary) : 1.25;
  const boost = isTrib ? boostTrib : boostMajor;

  const corridorRadius = Math.max(1, Math.floor(Number(cfg?.corridor_radius ?? (isTrib ? 4 : 7)) + (boost > 1 ? 1 : 0)));
  const waypointCount = Math.max(0, Math.floor((Number(cfg?.waypoints ?? (isTrib ? 2 : 4))) * boost));
  const noiseScale = Math.max(2, Number(cfg?.noise_scale ?? (isTrib ? 10 : 12)));
  const noiseAmp = Math.max(0, Math.floor((Number(cfg?.noise_amp ?? (isTrib ? 55 : 85))) * boost));
  const distPenalty = Math.max(0, Math.floor(Number(cfg?.corridor_penalty ?? 0)));
  const baseStep = Math.max(1, Math.floor(Number(cfg?.base_step_cost ?? (isTrib ? 55 : 70))));
  const maxLenFactor = Math.max(1.0, Number(cfg?.max_len_factor ?? 1.8));

  const corridorMask = corridorRadius > 0
    ? dilateIdxSetToMask({ width, height, inWorld, seeds: base, radius: corridorRadius, passableMask: landMask })
    : landMask;

  // Dist-to-base is used both for optional corridor penalties and for
  // waypoint selection.
  const distToBase = computeDistToSeedsBFS({ width, height, inWorld, passableMask: corridorMask, seeds: base });

  // (2) Waypoint swing: choose a few deterministic waypoints that alternate
  // between low/high noise pockets within the corridor. This forces visible
  // meanders without letting the river wander arbitrarily far.
  if (waypointCount > 0 && base.length >= 10 + waypointCount * 4) {
    const seedWp = hashStringToU32(`${seed}|river_waypoints_v1|${tag ?? "major"}`);
    const wps = [startIdx];
    const used = new Set([startIdx, endIdx]);

    for (let k = 1; k <= waypointCount; k++) {
      const t = k / (waypointCount + 1);
      const bi = base[Math.max(0, Math.min(base.length - 1, Math.floor(base.length * t)))];
      const cand = collectWithinRadiusBFS({ width, height, inWorld, passableMask: corridorMask, centerIdx: bi, radius: corridorRadius });
      if (!cand.length) continue;

      // Alternate extremes: odd waypoints seek low noise, even seek high noise.
      const wantHigh = (k % 2) === 0;
      let best = null;
      let bestScore = wantHigh ? -Infinity : Infinity;

      for (const idx of cand) {
        if (used.has(idx)) continue;
        const q = idx % width;
        const r = Math.floor(idx / width);
        const n = valueNoise2D(seedWp, q, r, noiseScale); // 0..1
        const d = distToBase[idx] >= 0 ? distToBase[idx] : 0;
        // Prefer farther-from-base within the corridor (bigger swings).
        const swing = d * 20;
        const score = (n * 1000) + (wantHigh ? swing : -swing);
        if (wantHigh) {
          if (score > bestScore || (score === bestScore && (best == null || idx < best))) {
            bestScore = score;
            best = idx;
          }
        } else {
          if (score < bestScore || (score === bestScore && (best == null || idx < best))) {
            bestScore = score;
            best = idx;
          }
        }
      }

      if (best != null) {
        used.add(best);
        wps.push(best);
      }
    }

    wps.push(endIdx);
    if (wps.length >= 3) {
      let ok = true;
      const stitched = [];
      for (let i = 0; i < wps.length - 1; i++) {
        const a = wps[i];
        const b = wps[i + 1];
        const seg = computePathBFSWithMask({ width, height, inWorld, passable: corridorMask, startIdx: a, endIdx: b, seed: `${seed}|${tag ?? "river"}|seg|${i}`, tag: "river_seg" });
        if (!seg) { ok = false; break; }
        if (i === 0) stitched.push(...seg);
        else stitched.push(...seg.slice(1));
      }

      const maxLen = Math.ceil(base.length * maxLenFactor);
      if (ok && stitched.length >= 2 && stitched.length <= maxLen) {
        return stitched;
      }
    }
  }

  const seedU32 = hashStringToU32(`${seed}|river_meander_v2|${tag ?? "major"}`);
  const endQ = endIdx % width;
  const endR = Math.floor(endIdx / width);

  const INF = 0x3fffffff;
  const gCost = new Int32Array(total);
  gCost.fill(INF);
  const prev = new Int32Array(total);
  prev.fill(-1);

  const heap = new MinHeapRiver();
  const h0 = axialDist(startIdx % width, Math.floor(startIdx / width), endQ, endR) * baseStep;
  gCost[startIdx] = 0;
  prev[startIdx] = startIdx;
  heap.push({ f: h0, g: 0, idx: startIdx });

  const dirs = defaultNeighborDirs();

  while (heap.size) {
    const node = heap.pop();
    if (!node) break;
    const cur = node.idx;
    const g = node.g;
    if (g !== gCost[cur]) continue; // stale
    if (cur === endIdx) break;

    const cq = cur % width;
    const cr = Math.floor(cur / width);

    for (let di = 0; di < 6; di++) {
      const d = dirs[di];
      const nq = cq + d.dq;
      const nr = cr + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!inWorld[ni]) continue;
      if (landMask[ni] !== 1) continue;
      if (corridorMask[ni] !== 1) continue;

      const n = valueNoise2D(seedU32, nq, nr, noiseScale); // 0..1
      const nCost = noiseAmp > 0 ? Math.floor(n * noiseAmp) : 0;
      const dBase = (distToBase && distToBase[ni] >= 0) ? distToBase[ni] : 0;
      const stepCost = baseStep + nCost + dBase * distPenalty;
      const ng = g + stepCost;

      if (ng < gCost[ni] || (ng === gCost[ni] && (prev[ni] === -1 || cur < prev[ni]))) {
        gCost[ni] = ng;
        prev[ni] = cur;
        const hh = axialDist(nq, nr, endQ, endR) * baseStep;
        heap.push({ f: ng + hh, g: ng, idx: ni });
      }
    }
  }

  if (prev[endIdx] === -1) return base;

  // Reconstruct
  const path = [];
  let cur = endIdx;
  let guard = 0;
  while (cur !== startIdx) {
    path.push(cur);
    cur = prev[cur];
    if (cur === -1) return base;
    if (++guard > total) return base;
  }
  path.push(startIdx);
  path.reverse();

  // Safety: avoid extreme detours (keeps county shaping stable-ish).
  const maxLen = Math.ceil(base.length * maxLenFactor);
  if (path.length > maxLen) return base;
  return path;
}

function computePathBFSWithMask({ width, height, inWorld, passable, startIdx, endIdx, seed, tag }) {
  const dirs = defaultNeighborDirs();
  const total = width * height;
  const prev = new Int32Array(total);
  prev.fill(-1);
  const prevDir = new Int8Array(total);
  prevDir.fill(-1);
  const q = new Int32Array(total);
  let qh = 0, qt = 0;

  q[qt++] = startIdx;
  prev[startIdx] = startIdx;
  prevDir[startIdx] = -1;

  while (qh < qt) {
    const cur = q[qh++];
    if (cur === endIdx) break;
    const cq = cur % width;
    const cr = Math.floor(cur / width);

    // Deterministic meander: rotate/flip neighbor exploration order by a hash of (seed, cur).
    let start = 0;
    let step = 1;
    if (seed != null) {
      const h = hashStringToU32(`${seed}|${tag ?? "path"}|${cur}`);
      start = h % 6;
      step = ((h >>> 3) & 1) ? 1 : -1;
    }
    const pd = prevDir[cur];

    const order = [];
    for (let k = 0; k < 6; k++) {
      const di = (start + step * k + 6 * 16) % 6;
      order.push(di);
    }
    const passes = pd >= 0 ? [order.filter((x) => x !== pd), [pd]] : [order];

    for (const pass of passes) {
      for (const di of pass) {
        const d = dirs[di];
        const nq = cq + d.dq;
        const nr = cr + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!inWorld[ni]) continue;
        if (passable[ni] !== 1) continue;
        if (prev[ni] !== -1) continue;
        prev[ni] = cur;
        prevDir[ni] = di;
        q[qt++] = ni;
      }
    }
  }

  if (prev[endIdx] === -1) return null;
  const path = [];
  let cur = endIdx;
  while (cur !== startIdx) {
    path.push(cur);
    cur = prev[cur];
    if (cur === -1) return null;
  }
  path.push(startIdx);
  path.reverse();
  return path;
}

function dilateIdxSetToMask({ width, height, inWorld, seeds, radius, passableMask }) {
  const out = new Uint8Array(width * height);
  if (!seeds?.length || radius <= 0) {
    for (const idx of (seeds ?? [])) out[idx] = 1;
    return out;
  }
  const q = [];
  const dist = new Int16Array(width * height);
  dist.fill(-1);
  for (const idx of seeds) {
    if (!inWorld[idx]) continue;
    if (passableMask && passableMask[idx] !== 1) continue;
    if (dist[idx] !== -1) continue;
    dist[idx] = 0;
    out[idx] = 1;
    q.push(idx);
  }
  const dirs = defaultNeighborDirs();
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cd = dist[cur];
    if (cd >= radius) continue;
    const cq = cur % width;
    const cr = Math.floor(cur / width);
    for (const d of dirs) {
      const nq = cq + d.dq;
      const nr = cr + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!inWorld[ni]) continue;
      if (passableMask && passableMask[ni] !== 1) continue;
      if (dist[ni] !== -1) continue;
      dist[ni] = cd + 1;
      out[ni] = 1;
      q.push(ni);
    }
  }
  return out;
}

function buildFrontierRails({ width, height, inWorld, tile_kind, world, ocean, worldRadius, kingdomRadiusHint, seed, config }) {
  const total = width * height;
  const remaskCfg = config?.mapgen?.remask ?? {};
  const enabled = remaskCfg?.enabled_frontier_rails !== false;
  const ridgeBeltRadius = Math.max(0, Math.floor(Number(remaskCfg?.frontier_ridge_belt_radius ?? 2)));
  const riverBeltRadius = Math.max(0, Math.floor(Number(remaskCfg?.frontier_river_belt_radius ?? 1)));
  const wr = Number.isInteger(worldRadius) ? worldRadius : (world?.radius ?? 0);
  const kr = Number.isInteger(kingdomRadiusHint) ? kingdomRadiusHint : (world?.core_radius ?? 0);
  const outer = Math.max(0, (wr - 1) - kr);
  const ridgeBaseOffset = Math.max(2, Math.floor(Number(remaskCfg?.frontier_ridge_offset ?? Math.max(4, Math.floor(outer * 0.6)))));
  const riverBaseOffset = Math.max(2, Math.floor(Number(remaskCfg?.frontier_river_offset ?? Math.max(3, Math.floor(outer * 0.45)))));
  const ridgeMeanderScale = Math.max(1, Number(remaskCfg?.frontier_ridge_meander_scale ?? 16));
  const ridgeMeanderAmp = Math.max(0, Math.floor(Number(remaskCfg?.frontier_ridge_meander_amp ?? 4)));
  const riverMeanderScale = Math.max(1, Number(remaskCfg?.frontier_river_meander_scale ?? 14));
  const riverMeanderAmp = Math.max(0, Math.floor(Number(remaskCfg?.frontier_river_meander_amp ?? 3)));
  const fordCount = Math.max(0, Math.floor(Number(remaskCfg?.frontier_river_ford_count ?? 2)));

  const ridgeMask = new Uint8Array(total);
  const riverMask = new Uint8Array(total);
  const riverFordMask = new Uint8Array(total);
  if (!enabled || outer <= 0) return { ridgeMask, riverMask, riverFordMask };

  const cq = world.cq;
  const cr = world.cr;
  const worldR = world.radius;
  const nominalR = approxHexRadiusForArea(landTarget);
  const seedU32 = hashStringToU32(`${seed}|frontier_rails_v1`);
  const oceanPlanes = ocean?.oceanPlanes ?? ocean?.ocean_planes ?? ocean?.oceanPlanes ?? [];
  const oceanSet = new Set(oceanPlanes);
  const landPlanes = SIDE_PLANES_CW.filter((p) => !oceanSet.has(p));

  // Helper: passable land mask in the outer ring outside the expected kingdom.
  const outsideCoreLand = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (!inWorld[i]) continue;
    if (tile_kind[i] !== "land") continue;
    const q = i % width;
    const r = Math.floor(i / width);
    const rel = cubeRel(q, r, cq, cr);
    const dd = cubeDist(rel.x, rel.y, rel.z);
    if (dd <= kr) continue;
    if (dd > (wr - 1)) continue;
    outsideCoreLand[i] = 1;
  }

  // Assign up to 4 near-hard rails across the 4 land-border sides.
  // Default: 2 ridge rails + 2 river rails (alternating by CW plane order).
  const ridgePlanes = [];
  const riverPlanes = [];
  for (let i = 0; i < landPlanes.length; i++) {
    const p = landPlanes[i];
    if ((i % 2) === 0) ridgePlanes.push(p); else riverPlanes.push(p);
  }

  // (1) Frontier ridge wall: meandering belts mostly outside the core.
  const N = Math.max(8, kr);
  const ridgeLine = [];
  for (const plane of ridgePlanes) {
    const planeSeed = seedU32 ^ hashStringToU32(`ridge|${plane}`);
    for (let i = 1; i < N; i++) {
      const frac = i / N;
      // Taper meander near ends to avoid sharp vertex kinks.
      const taper = Math.min(1, Math.min(frac, 1 - frac) * 2);
      const dm = meander1D(planeSeed, i, ridgeMeanderScale, Math.floor(ridgeMeanderAmp * taper));
      const R = clampInt(kr + ridgeBaseOffset + dm, kr + 2, (wr - 1) - 2);
      const { x, y, z } = cubePointOnPlane(plane, R, frac);
      const ax = cubeToAxial(cq, cr, x, y, z);
      if (!inBounds(ax.q, ax.r, width, height)) continue;
      const idx = indexOf(ax.q, ax.r, width);
      if (!inWorld[idx]) continue;
      if (outsideCoreLand[idx] !== 1) continue;
      ridgeLine.push(idx);
    }
  }
  // Deduplicate and widen.
  ridgeLine.sort((a, b) => a - b);
  const ridgeLineUniq = [];
  for (let i = 0; i < ridgeLine.length; i++) {
    if (i === 0 || ridgeLine[i] !== ridgeLine[i - 1]) ridgeLineUniq.push(ridgeLine[i]);
  }
  const ridgeBelt = ridgeBeltRadius > 0
    ? dilateIdxSetToMask({ width, height, inWorld, seeds: ridgeLineUniq, radius: ridgeBeltRadius, passableMask: outsideCoreLand })
    : dilateIdxSetToMask({ width, height, inWorld, seeds: ridgeLineUniq, radius: 0, passableMask: outsideCoreLand });
  ridgeMask.set(ridgeBelt);

  // (2) Frontier rivers: meandering belts on the remaining land-border sides.
  // These are cost rails for remasking (they are not yet hydrology).
  for (const plane of riverPlanes) {
    const planeSeed = seedU32 ^ hashStringToU32(`river|${plane}`);
    const riverLine = [];
    for (let i = 1; i < N; i++) {
      const frac = i / N;
      const taper = Math.min(1, Math.min(frac, 1 - frac) * 2);
      const dm = meander1D(planeSeed, i, riverMeanderScale, Math.floor(riverMeanderAmp * taper));
      const R = clampInt(kr + riverBaseOffset + dm, kr + 2, (wr - 1) - 2);
      const { x, y, z } = cubePointOnPlane(plane, R, frac);
      const ax = cubeToAxial(cq, cr, x, y, z);
      if (!inBounds(ax.q, ax.r, width, height)) continue;
      const idx = indexOf(ax.q, ax.r, width);
      if (!inWorld[idx]) continue;
      if (outsideCoreLand[idx] !== 1) continue;
      riverLine.push(idx);
    }
    if (!riverLine.length) continue;
    riverLine.sort((a, b) => a - b);
    const uniq = [];
    for (let i = 0; i < riverLine.length; i++) {
      if (i === 0 || riverLine[i] !== riverLine[i - 1]) uniq.push(riverLine[i]);
    }
    const riverBelt = riverBeltRadius > 0
      ? dilateIdxSetToMask({ width, height, inWorld, seeds: uniq, radius: riverBeltRadius, passableMask: outsideCoreLand })
      : dilateIdxSetToMask({ width, height, inWorld, seeds: uniq, radius: 0, passableMask: outsideCoreLand });
    riverMask.set(riverBelt);

    // Ford(s): pick a few points along the line, spaced out.
    if (fordCount > 0) {
      const step = Math.max(1, Math.floor(uniq.length / (fordCount + 1)));
      for (let k = 1; k <= fordCount; k++) {
        const idx = uniq[Math.min(uniq.length - 1, k * step)];
        riverFordMask[idx] = 1;
      }
    }
  }

  return { ridgeMask, riverMask, riverFordMask };
}

function remaskKingdomLand({ width, height, inWorld, tile_kind, world, ocean, coreRadius, buffer, landTarget, seed, config, protectedIdxSet }) {
  const total = width * height;
  const remaskCfg = config?.mapgen?.remask ?? {};
  const enabled = remaskCfg?.enabled !== false;
  if (!enabled) return { selectedMask: null, debug: { enabled: false } };

  const cq = world.cq;
  const cr = world.cr;
  const worldR = world.radius;
  const nominalR = approxHexRadiusForArea(landTarget);

  // World-edge buffer contract (M3): the primary kingdom must not reach the outer mega-hex edge.
  // Enforced here by excluding tiles within `world_edge_buffer` hexes of the inWorld boundary.
  // Default buffer is ~5% of world radius, minimum 2.
  // Keep the primary kingdom comfortably inside the world-disk so the
  // borderlands context reaches the megahex edge. Default: 10% of world radius.
  const worldEdgeBufferDefault = Math.max(2, Math.ceil(worldR * 0.10));
  const worldEdgeBuffer = Math.max(0, Math.floor(Number(remaskCfg?.world_edge_buffer ?? worldEdgeBufferDefault)));
  const tolPctRaw = remaskCfg?.land_target_tolerance_pct ?? config?.scale?.realm_hexes_land_target_tolerance_pct;
  const tolPct = Number.isFinite(Number(tolPctRaw)) ? Number(tolPctRaw) : 0.05;
  const landMin = Math.max(1, Math.floor(landTarget * (1 - Math.abs(tolPct))));
  const landMax = Math.max(landMin, Math.ceil(landTarget * (1 + Math.abs(tolPct))));

  const reshaveEnabled = remaskCfg?.reshave_enabled !== false;
  const reshaveIters = Math.max(0, Math.floor(Number(remaskCfg?.reshave_iters ?? 600)));
  const reshaveTopK = Math.max(1, Math.floor(Number(remaskCfg?.reshave_top_k ?? 16)));
	const reshaveLocalityBase = Math.max(1, Math.floor(Number(remaskCfg?.reshave_locality_base ?? 2)));
	const reshaveLocalityMax = Math.max(reshaveLocalityBase, Math.floor(Number(remaskCfg?.reshave_locality_max ?? 4)));
	const reshaveMinDelta = Math.max(0, Math.floor(Number(remaskCfg?.reshave_min_delta ?? 1)));
	const reshaveRiverBonus = Math.max(0, Math.floor(Number(remaskCfg?.reshave_river_bonus ?? 0)));
	const reshaveFordBonus = Math.max(0, Math.floor(Number(remaskCfg?.reshave_ford_bonus ?? 0)));
	const reshaveRidgePenalty = Math.max(0, Math.floor(Number(remaskCfg?.reshave_ridge_penalty ?? 0)));
	const coastalExclusionK = Math.max(0, Math.floor(Number(remaskCfg?.reshave_coastal_exclusion_k ?? 2)));
	const straightPenaltyW = Math.max(0, Math.floor(Number(remaskCfg?.reshave_straight_penalty ?? 2500)));
	const lineRunPenaltyW = Math.max(0, Math.floor(Number(remaskCfg?.reshave_line_run_penalty ?? 600)));
	const phaseBandsRaw = Array.isArray(remaskCfg?.reshave_phase_bands) ? remaskCfg.reshave_phase_bands : [10, 6, 3];
	const reshavePhaseBands = phaseBandsRaw
	  .map((v) => Math.max(1, Math.floor(Number(v))))
	  .filter((v, i, arr) => Number.isFinite(v) && v > 0 && arr.indexOf(v) === i);

  // Distance from each inWorld tile to the inWorld boundary (tiles adjacent to not-inWorld).
  // Used as a hard eligibility constraint for kingdom selection.
  const distToWorldEdge = new Int16Array(total);
  distToWorldEdge.fill(-1);
  {
    const q = [];
    const dirs0 = defaultNeighborDirs();
    for (let i = 0; i < total; i++) {
      if (!inWorld[i]) continue;
      const iq = i % width;
      const ir = Math.floor(i / width);
      let isBoundary = false;
      for (const d of dirs0) {
        const nq = iq + d.dq;
        const nr = ir + d.dr;
        if (!inBounds(nq, nr, width, height)) { isBoundary = true; break; }
        const ni = indexOf(nq, nr, width);
        if (!inWorld[ni]) { isBoundary = true; break; }
      }
      if (isBoundary) {
        distToWorldEdge[i] = 0;
        q.push(i);
      }
    }
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cd = distToWorldEdge[cur];
      const cq0 = cur % width;
      const cr0 = Math.floor(cur / width);
      for (const d of dirs0) {
        const nq = cq0 + d.dq;
        const nr = cr0 + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!inWorld[ni]) continue;
        if (distToWorldEdge[ni] !== -1) continue;
        distToWorldEdge[ni] = cd + 1;
        q.push(ni);
      }
    }
  }

  // Identify ocean-connected sea (saltwater) so we can (a) avoid reshaping coasts and
  // (b) allow converting ONLY inland water pockets (non-ocean sea) when the inland
  // border is blocked by bays.
  const oceanSea = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (!inWorld[i]) continue;
    if (tile_kind[i] === "sea") oceanSea[i] = 1;
  }
  const oceanConnected = new Uint8Array(total);
  {
    const q = [];
    const dirs0 = defaultNeighborDirs();
    for (let i = 0; i < total; i++) {
      if (!oceanSea[i]) continue;
      // Seed floodfill from sea tiles on the world boundary.
      if (distToWorldEdge[i] === 0) {
        oceanConnected[i] = 1;
        q.push(i);
      }
    }
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cq0 = cur % width;
      const cr0 = Math.floor(cur / width);
      for (const d of dirs0) {
        const nq = cq0 + d.dq;
        const nr = cr0 + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!oceanSea[ni]) continue;
        if (oceanConnected[ni]) continue;
        oceanConnected[ni] = 1;
        q.push(ni);
      }
    }
  }

  // IMPORTANT: do NOT hard-lock the old mega-hex interior.
  // We only seed a small core region (plus protected estuary/river tiles) and then
  // select a kingdom mask by cost-aware Dijkstra growth.
  const seedRadiusDefault = Math.max(2, Math.floor(nominalR * 0.16));
  const seedRadius = Math.max(0, Math.floor(Number(remaskCfg?.seed_radius ?? seedRadiusDefault)));
  // Shape knobs: a 1D angular meander defines a "desired" border radius around the center.
  // This is *not* tied to the old mega-hex planes, and it allows neighboring realms to bite inward.
  const shapeBins = Math.max(60, Math.floor(Number(remaskCfg?.shape_bins ?? 360)));
  const shapeBase = Math.floor(Number(remaskCfg?.shape_base_radius ?? nominalR));
  const shapeSlope = Math.max(0, Math.floor(Number(remaskCfg?.shape_slope ?? 22)));
  const shapeAmp = Math.max(0, Math.floor(Number(remaskCfg?.shape_amp ?? 14)));
  const shapeScale = Math.max(1, Number(remaskCfg?.shape_scale ?? 22));
  const shapeAmp2 = Math.max(0, Math.floor(Number(remaskCfg?.shape_amp2 ?? 7)));
  const shapeScale2 = Math.max(1, Number(remaskCfg?.shape_scale2 ?? 8));
  const shapeMinR = clampInt(
    Math.floor(Number(remaskCfg?.shape_min_radius ?? (shapeBase - (shapeAmp + shapeAmp2 + 4)))),
    0,
    worldR - 2
  );
  const shapeMaxR = clampInt(
    Math.floor(Number(remaskCfg?.shape_max_radius ?? (shapeBase + (shapeAmp + shapeAmp2 + 8)))),
    shapeMinR,
    worldR - 2
  );
  const noiseAmp = Math.max(0, Math.floor(Number(remaskCfg?.noise_amp ?? 6)));
  const noiseScale = Math.max(1, Number(remaskCfg?.noise_scale ?? 9));
  const ridgePenalty = Math.max(0, Math.floor(Number(remaskCfg?.frontier_ridge_penalty ?? 120)));
  const riverPenalty = Math.max(0, Math.floor(Number(remaskCfg?.frontier_river_penalty ?? 90)));
  const fordPenalty = Math.max(0, Math.floor(Number(remaskCfg?.frontier_ford_penalty ?? 20)));
  const smoothPasses = Math.max(0, Math.floor(Number(remaskCfg?.smooth_passes ?? 1)));

  const seedU32 = hashStringToU32(`${seed}|remask_kingdom_v2`);

  // Cache per-bin desired radius so the inner tile loop is cheap/deterministic.
  const desiredRByBin = new Int16Array(shapeBins);
  for (let b = 0; b < shapeBins; b++) {
    const o1 = meander1D(seedU32 ^ 0x51a7f00d, b, shapeScale, shapeAmp);
    const o2 = meander1D(seedU32 ^ 0x9d3b0c11, b + 1013, shapeScale2, shapeAmp2);
    desiredRByBin[b] = clampInt(shapeBase + o1 + o2, shapeMinR, shapeMaxR);
  }

  const { ridgeMask: frontierRidgeMask, riverMask: frontierRiverMask, riverFordMask: frontierRiverFordMask } = buildFrontierRails({
    width,
    height,
    inWorld,
    tile_kind,
    world,
    ocean,
    worldRadius: worldR,
    // Place rails just outside the *intended* kingdom outline, not the historical core radius.
    // This helps the border meander organically instead of hugging the megahex planes.
    kingdomRadiusHint: shapeBase,
    seed,
    config
  });

  // Precompute per-tile penalties used by Dijkstra.
  const stepBase = 10;
  const penalty = new Int32Array(total);
  penalty.fill(0);
  const maxR = worldR;

  for (let i = 0; i < total; i++) {
    if (!inWorld[i]) continue;
    if (tile_kind[i] !== "land") continue;
    // Hard exclusion near world edge to preserve a borderlands buffer.
    if (worldEdgeBuffer > 0 && distToWorldEdge[i] >= 0 && distToWorldEdge[i] < worldEdgeBuffer) continue;
    const q = i % width;
    const r = Math.floor(i / width);
    const rel = cubeRel(q, r, cq, cr);
    const dd = cubeDist(rel.x, rel.y, rel.z);
    if (dd > maxR) continue;

    let p = 0;

    // Angular "shape" penalty — encourages a meandering outline that's NOT tied to the
    // old mega-hex planes.
    if (shapeSlope > 0) {
      const bin = angleBinFromRel(rel, shapeBins);
      const wantR = desiredRByBin[bin];
      if (dd > wantR) p += (dd - wantR) * shapeSlope;
    }

    // Low-frequency noise to break symmetry.
    if (noiseAmp > 0) {
      const n = valueNoise2D(seedU32 ^ 0xA5A5A5A5, q, r, noiseScale);
      p += clampInt(Math.round(n * noiseAmp), 0, noiseAmp);
    }

    // NOTE: We intentionally do not apply any plane-based penalty here.

    // Frontier rails (near-hard): discourage crossing beyond the buffer features.
    if (frontierRidgeMask[i] === 1) p += ridgePenalty;
    if (frontierRiverMask[i] === 1) p += (frontierRiverFordMask[i] === 1 ? fordPenalty : riverPenalty);

    penalty[i] = p;
  }

  // Seeds: a small, always-included core near the center.
  const seeds = [];
  const isSeed = new Uint8Array(total);

  // Core seed around the center.
  for (let i = 0; i < total; i++) {
    if (!inWorld[i]) continue;
    if (tile_kind[i] !== "land") continue;
    if (worldEdgeBuffer > 0 && distToWorldEdge[i] >= 0 && distToWorldEdge[i] < worldEdgeBuffer) continue;
    const q = i % width;
    const r = Math.floor(i / width);
    const rel = cubeRel(q, r, cq, cr);
    const dd = cubeDist(rel.x, rel.y, rel.z);
    if (dd > seedRadius) continue;
    isSeed[i] = 1;
    seeds.push(i);
  }
  // Fallback: if the core seed found nothing (should be rare), seed the nearest land tile.
  if (!seeds.length) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < total; i++) {
      if (!inWorld[i]) continue;
      if (tile_kind[i] !== "land") continue;
      const q = i % width;
      const r = Math.floor(i / width);
      const rel = cubeRel(q, r, cq, cr);
      const dd = cubeDist(rel.x, rel.y, rel.z);
      if (dd < bestD) { bestD = dd; best = i; }
    }
    if (best != null) {
      isSeed[best] = 1;
      seeds.push(best);
    }
  }

  // If seeds already exceed target, fail fast with a clear message.
  if (seeds.length >= landTarget) {
    return { selectedMask: null, debug: { enabled: true, error: `remask seeds >= landTarget (${seeds.length} >= ${landTarget})`, seedRadius } };
  }

  // Dijkstra expansion over land tiles.
  const INF = 0x3fffffff;
  const dist = new Int32Array(total);
  dist.fill(INF);
  const heap = new MinHeap();
  for (const s of seeds) {
    dist[s] = 0;
    heap.push([0, s]);
  }

  const selected = new Uint8Array(total);
  let selectedCount = 0;
  const dirs = defaultNeighborDirs();
  while (heap.size() && selectedCount < landTarget) {
    const node = heap.pop();
    if (!node) break;
    const d0 = node[0];
    const idx = node[1];
    if (d0 !== dist[idx]) continue;
    if (tile_kind[idx] !== "land") continue;
    if (worldEdgeBuffer > 0 && distToWorldEdge[idx] >= 0 && distToWorldEdge[idx] < worldEdgeBuffer) continue;
    if (selected[idx] === 1) continue;
    selected[idx] = 1;
    selectedCount++;

    const q = idx % width;
    const r = Math.floor(idx / width);
    for (const dir of dirs) {
      const nq = q + dir.dq;
      const nr = r + dir.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!inWorld[ni]) continue;
      if (tile_kind[ni] !== "land") continue;
      if (worldEdgeBuffer > 0 && distToWorldEdge[ni] >= 0 && distToWorldEdge[ni] < worldEdgeBuffer) continue;
      const nd = d0 + stepBase + penalty[ni];
      if (nd < dist[ni] || (nd === dist[ni] && idx < ni)) {
        dist[ni] = nd;
        heap.push([nd, ni]);
      }
    }
  }

  // Kernel keep-set: tiles that must remain selected (never trimmed / never pruned).
  // We always keep the central seed kernel, and we *also* keep a connected corridor
  // to any protected land tiles (estuary adjacency / river mouth neighborhood).
  //
  // IMPORTANT: We do *not* add protected tiles as extra Dijkstra seeds (multi-source)
  // because that can create disconnected kingdom components.
  const kernelKeep = new Uint8Array(total);
  for (const s of seeds) kernelKeep[s] = 1;

  if (protectedIdxSet && protectedIdxSet.size) {
    const required = [];
    for (const idx of protectedIdxSet) {
      if (!inWorld[idx]) continue;
      if (tile_kind[idx] !== "land") continue;
      required.push(idx);
    }
    required.sort((a, b) => a - b);

    const prev = new Int32Array(total);
    const q = new Int32Array(total);
    for (const startIdx of required) {
      if (selected[startIdx] === 1) {
        kernelKeep[startIdx] = 1;
        continue;
      }
      prev.fill(-1);
      let qh = 0, qt = 0;
      q[qt++] = startIdx;
      prev[startIdx] = startIdx;
      let found = -1;
      while (qh < qt) {
        const cur = q[qh++];
        if (selected[cur] === 1) { found = cur; break; }
        const cq = cur % width;
        const cr = Math.floor(cur / width);
        for (const d of dirs) {
          const nq = cq + d.dq;
          const nr = cr + d.dr;
          if (!inBounds(nq, nr, width, height)) continue;
          const ni = indexOf(nq, nr, width);
          if (!inWorld[ni]) continue;
          if (tile_kind[ni] !== "land") continue;
          if (prev[ni] !== -1) continue;
          prev[ni] = cur;
          q[qt++] = ni;
        }
      }
      if (found === -1) continue;
      // Walk back from the found selected tile to the required tile.
      let cur = found;
      while (cur !== startIdx) {
        if (selected[cur] !== 1) selected[cur] = 1;
        kernelKeep[cur] = 1;
        cur = prev[cur];
        if (cur === -1) break;
      }
      selected[startIdx] = 1;
      kernelKeep[startIdx] = 1;
    }
  }

  // Boundary smoothing helpers.
  const neighborCount = (mask, idx) => {
    const q = idx % width;
    const r = Math.floor(idx / width);
    let ct = 0;
    for (const d of dirs) {
      const nq = q + d.dq;
      const nr = r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!inWorld[ni]) continue;
      if (mask[ni] === 1) ct++;
    }
    return ct;
  };

  // (A) Local smoothing: fill tiny holes and prune 1-hex spikes.
  for (let pass = 0; pass < smoothPasses; pass++) {
    const toAdd = [];
    const toDel = [];
    for (let i = 0; i < total; i++) {
      if (!inWorld[i]) continue;
      if (tile_kind[i] !== "land") continue;
      const n = neighborCount(selected, i);
      if (selected[i] === 0) {
        if (n >= 5) toAdd.push(i);
      } else {
        if (kernelKeep[i] === 1) continue;
        if (n <= 1) toDel.push(i);
      }
    }
    for (const i of toAdd) selected[i] = 1;
    for (const i of toDel) selected[i] = 0;
  }

  // (B) Enforce NO ENCLAVES: any unselected land region fully enclosed by selected is filled.
  // This can increase the selected count slightly; we trim back to landTarget afterward.
  const fillHoles = () => {
    const exterior = new Uint8Array(total);
    const q = new Int32Array(total);
    let qh = 0, qt = 0;

    const enqueue = (idx) => {
      exterior[idx] = 1;
      q[qt++] = idx;
    };

    // Seed the flood-fill from unselected land that touches the world boundary.
    for (let i = 0; i < total; i++) {
      if (!inWorld[i]) continue;
      if (tile_kind[i] !== "land") continue;
      if (selected[i] === 1) continue;
      const qi = i % width;
      const ri = Math.floor(i / width);
      let touchesBoundary = false;
      for (const d of dirs) {
        const nq = qi + d.dq;
        const nr = ri + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!inWorld[ni]) { touchesBoundary = true; break; }
      }
      if (touchesBoundary) enqueue(i);
    }

    while (qh < qt) {
      const cur = q[qh++];
      const cq0 = cur % width;
      const cr0 = Math.floor(cur / width);
      for (const d of dirs) {
        const nq = cq0 + d.dq;
        const nr = cr0 + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!inWorld[ni]) continue;
        if (tile_kind[ni] !== "land") continue;
        if (selected[ni] === 1) continue;
        if (exterior[ni] === 1) continue;
        enqueue(ni);
      }
    }

    // Any unselected land not marked exterior is a hole => fill it.
    let added = 0;
    for (let i = 0; i < total; i++) {
      if (!inWorld[i]) continue;
      if (tile_kind[i] !== "land") continue;
      if (selected[i] === 1) continue;
      if (exterior[i] === 1) continue;
      selected[i] = 1;
      added++;
    }
    return added;
  };

  // Connectivity check (no exclaves).
  const connectedCount = () => {
    let start = -1;
    for (let i = 0; i < total; i++) {
      if (selected[i] !== 1) continue;
      start = i;
      break;
    }
    if (start < 0) return 0;

    const seen = new Uint8Array(total);
    const q = new Int32Array(total);
    let qh = 0, qt = 0;
    seen[start] = 1;
    q[qt++] = start;
    let count = 0;
    while (qh < qt) {
      const cur = q[qh++];
      count++;
      const cq0 = cur % width;
      const cr0 = Math.floor(cur / width);
      for (const d of dirs) {
        const nq = cq0 + d.dq;
        const nr = cr0 + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!inWorld[ni]) continue;
        if (selected[ni] !== 1) continue;
        if (seen[ni] === 1) continue;
        seen[ni] = 1;
        q[qt++] = ni;
      }
    }
    return count;
  };

  // Deterministic grow: add lowest-dist unselected land tiles adjacent to selected.
  const growToTarget = (target) => {
    let ct = 0;
    for (let i = 0; i < total; i++) if (selected[i] === 1) ct++;
    if (ct >= target) return 0;
    const cand = [];
    for (let i = 0; i < total; i++) {
      if (selected[i] === 1) continue;
      if (!inWorld[i]) continue;
      if (tile_kind[i] !== "land") continue;
      if (neighborCount(selected, i) === 0) continue;
      cand.push([dist[i], i]);
    }
    cand.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    let added = 0;
    let k = 0;
    while (ct < target && k < cand.length) {
      const i = cand[k++][1];
      if (selected[i] === 1) continue;
      selected[i] = 1;
      ct++;
      added++;
    }
    return added;
  };

  // Deterministic trim with connectivity safety.
  const trimToTarget = (target) => {
    let ct = 0;
    for (let i = 0; i < total; i++) if (selected[i] === 1) ct++;
    if (ct <= target) return 0;
    const cand = [];
    for (let i = 0; i < total; i++) {
      if (selected[i] !== 1) continue;
      if (kernelKeep[i] === 1) continue;
      cand.push([dist[i], i]);
    }
    // Highest-dist first (peel from outside in).
    cand.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]));
    let removed = 0;
    let k = 0;
    while (ct > target && k < cand.length) {
      const i = cand[k++][1];
      if (selected[i] !== 1) continue;
      // Quick reject: avoid removing core "thick" tiles first.
      // Leaves are safe to remove; bridges might not be.
      selected[i] = 0;
      // Connectivity safety: must remain single-component.
      const cc = connectedCount();
      if (cc !== (ct - 1)) {
        // Revert removal
        selected[i] = 1;
        continue;
      }
      ct--;
      removed++;
    }
    return removed;
  };


  // Border "reshave" pass: improve frontier scalloping and geographic snapping by
  // locally swapping high-cost border tiles for lower-cost neighbor tiles.
  // This is deterministic and respects: protected/kernelKeep, worldEdgeBuffer, and connectivity.
  const borderReshave = () => {
    if (!reshaveEnabled || reshaveIters <= 0) return { iters: 0, swaps: 0, adds: 0, dels: 0 };
    let ct0 = 0;
    for (let i = 0; i < total; i++) if (selected[i] === 1) ct0++;
    let ct = ct0;

    const isBoundarySel = (i) => selected[i] === 1 && neighborCount(selected, i) <= 5;
    const isFrontierUns = (i) => selected[i] === 0 && neighborCount(selected, i) > 0;

		const collectBoundary = () => {
      const out = [];
      for (let i = 0; i < total; i++) {
        if (activeBand && activeBand[i] !== 1) continue;
        if (!inWorld[i]) continue;
        if (tile_kind[i] !== "land") continue;
        if (!isBoundarySel(i)) continue;
				// Do not reshape true ocean coastline tiles.
				if (coastalExclusionK > 0 && touchesOceanSea(i)) continue;
        if (kernelKeep[i] === 1) continue;
        out.push(i);
      }
      return out;
    };




		const touchesOceanSea = (i) => {
			if (oceanConnected[i] === 1) return true;
			const iq = i % width;
			const ir = Math.floor(i / width);
			const dirs0 = defaultNeighborDirs();
			for (const d of dirs0) {
				const nq = iq + d.dq;
				const nr = ir + d.dr;
				if (!inBounds(nq, nr, width, height)) continue;
				const ni = indexOf(nq, nr, width);
				if (!inWorld[ni]) continue;
				if (oceanConnected[ni] === 1) return true;
			}
			return false;
		};

		let activeBand = null;
		const computeBandMask = (bandK) => {
			if (!(bandK > 0)) return null;
			const mask = new Uint8Array(total);
			const distBand = new Int16Array(total);
			distBand.fill(-1);
			const q = [];
			for (let i = 0; i < total; i++) {
				if (!inWorld[i]) continue;
				const tk = tile_kind[i];
				if (!(tk === "land" || (tk === "sea" && oceanConnected[i] === 0))) continue;
				if (!(isBoundarySel(i) || isFrontierUns(i))) continue;
				distBand[i] = 0;
				mask[i] = 1;
				q.push(i);
			}
			for (let qi = 0; qi < q.length; qi++) {
				const cur = q[qi];
				const cd = distBand[cur];
				if (cd >= bandK) continue;
				const cq = cur % width;
				const cr = Math.floor(cur / width);
				for (const d of defaultNeighborDirs()) {
					const nq = cq + d.dq;
					const nr = cr + d.dr;
					if (!inBounds(nq, nr, width, height)) continue;
					const ni = indexOf(nq, nr, width);
					if (!inWorld[ni]) continue;
					const tk = tile_kind[ni];
					if (!(tk === "land" || (tk === "sea" && oceanConnected[ni] === 0))) continue;
					if (distBand[ni] !== -1) continue;
					distBand[ni] = cd + 1;
					mask[ni] = 1;
					q.push(ni);
				}
			}
			return mask;
		};

		const collectFrontier = () => {
      const out = [];
      for (let i = 0; i < total; i++) {
        if (activeBand && activeBand[i] !== 1) continue;
        if (!inWorld[i]) continue;
				// Allow frontier to include inland water pockets (sea that is NOT ocean-connected),
				// but never allow reshaping the coastline or the ocean itself.
				const tk = tile_kind[i];
				if (!(tk === "land" || (tk === "sea" && oceanConnected[i] === 0))) continue;
        if (!isFrontierUns(i)) continue;
        // Keep a near-edge guard for reshave, but allow limited movement inside the buffer band.
        const reshaveEdgeGuard = Math.max(0, worldEdgeBuffer - 2);
        if (reshaveEdgeGuard > 0 && distToWorldEdge[i] >= 0 && distToWorldEdge[i] < reshaveEdgeGuard) continue;
				// Exclude true coastline/ocean-adjacent frontier, but keep inland frontier usable.
				if (coastalExclusionK > 0 && touchesOceanSea(i)) continue;
        out.push(i);
      }
      return out;
    };

		const straightPairs = (i) => {
			// Count opposite-direction selected-neighbor pairs; higher implies straighter/flat facet.
			const iq = i % width;
			const ir = Math.floor(i / width);
			const dirs0 = defaultNeighborDirs();
			let s0 = 0;
			for (let k = 0; k < 3; k++) {
				const a = dirs0[k];
				const b = dirs0[k + 3];
				const aIdx = inBounds(iq + a.dq, ir + a.dr, width, height) ? indexOf(iq + a.dq, ir + a.dr, width) : -1;
				const bIdx = inBounds(iq + b.dq, ir + b.dr, width, height) ? indexOf(iq + b.dq, ir + b.dr, width) : -1;
				const aSel = aIdx >= 0 && selected[aIdx] === 1;
				const bSel = bIdx >= 0 && selected[bIdx] === 1;
				if (aSel && bSel) s0++;
			}
			return s0;
		};

		const straightRunLen = (i) => {
			if (selected[i] !== 1) return 0;
			const iq = i % width;
			const ir = Math.floor(i / width);
			const dirs0 = defaultNeighborDirs();
			let best = 0;
			for (let k = 0; k < 3; k++) {
				const a = dirs0[k];
				const b = dirs0[k + 3];
				let len = 1;
				for (const d of [a, b]) {
					let tq = iq + d.dq;
					let tr = ir + d.dr;
					while (inBounds(tq, tr, width, height)) {
						const ti = indexOf(tq, tr, width);
						if (selected[ti] !== 1) break;
						len++;
						tq += d.dq;
						tr += d.dr;
						if (len >= 12) break;
					}
				}
				if (len > best) best = len;
			}
			return best;
		};

    const pickFromSorted = (arr, topK, iterTag) => {
      if (arr.length === 0) return -1;
      const k = Math.min(arr.length, topK);
      const j = hash2(seedU32, iterTag >>> 0, k) % k;
      return arr[j];
    };

    // Swap-first reshave to avoid ct==target stalls:
    //  A) When ct is in-range, perform paired add+del swaps each iteration.
    //     This allows border movement without requiring net growth/shrink.
    //  B) If ct drifts outside [landMin, landMax], do one-sided correction.
    //  C) If we stall, gradually widen locality to find legal nearby swaps.

    let adds = 0;
    let dels = 0;
    let swaps = 0;
    let stalledIters = 0;
    let attempts = 0;
    let rejectLocality = 0;
    let rejectDelta = 0;
    let rejectConnectivity = 0;
    let rejectNoViable = 0;

    const featureTerm = (i) => {
      let t = 0;
      if (frontierRidgeMask[i] === 1) t += reshaveRidgePenalty;
      if (frontierRiverMask[i] === 1) {
        t -= (frontierRiverFordMask[i] === 1 ? reshaveFordBonus : reshaveRiverBonus);
      }
      return t;
    };

    const score = (i) => {
      const runPenalty = selected[i] === 1 ? (lineRunPenaltyW * Math.max(0, straightRunLen(i) - 2)) : 0;
      return dist[i] + straightPenaltyW * straightPairs(i) + runPenalty + featureTerm(i);
    };

    const iterBudget = Math.max(0, Math.min(reshaveIters, 240));
    const phaseBands = reshavePhaseBands.length ? reshavePhaseBands : [10, 6, 3];
    const phaseBudgetBase = Math.max(1, Math.floor(iterBudget / phaseBands.length));
    let itGlobal = 0;
    const phaseStats = [];
    for (let p = 0; p < phaseBands.length && itGlobal < iterBudget; p++) {
      const phaseBand = phaseBands[p];
      activeBand = computeBandMask(phaseBand);
      const remaining = iterBudget - itGlobal;
      const phaseBudget = (p === phaseBands.length - 1) ? remaining : Math.min(remaining, phaseBudgetBase);
      let phaseMoves = 0;
      for (let pit = 0; pit < phaseBudget; pit++, itGlobal++) {
        const it = itGlobal;
        const frontier = collectFrontier();
        const boundary = collectBoundary();
        if (frontier.length === 0 && boundary.length === 0) break;

      frontier.sort((a, b) => (score(a) - score(b)) || (a - b));
      boundary.sort((a, b) => (score(b) - score(a)) || (a - b));

      const inBand = ct >= landMin && ct <= landMax;

      // Preferred mode: paired swap when count is healthy.
      if (inBand && frontier.length > 0 && boundary.length > 0) {
        const widenSteps = Math.floor(stalledIters / 30);
        const kABase = Math.max(1, reshaveTopK);
        const kDBasis = Math.max(1, reshaveTopK);
        const kA = Math.min(frontier.length, kABase + (widenSteps * kABase));
        const kD = Math.min(boundary.length, kDBasis + (widenSteps * kDBasis));
        const a0 = hash2(seedU32, (it + 1) * 41, kA) % kA;
        const d0 = hash2(seedU32, (it + 1) * 53, kD) % kD;
        const localityCap = Math.min(reshaveLocalityMax, reshaveLocalityBase + Math.floor(stalledIters / 40));

        let moved = false;
        for (let ao = 0; ao < kA && !moved; ao++) {
          const addIdx = frontier[(a0 + ao) % kA];
          if (addIdx < 0 || selected[addIdx] !== 0) continue;
          const aq = addIdx % width;
          const ar = Math.floor(addIdx / width);
          const addScore = score(addIdx);

          // Collect viable local deletion candidates near this add tile first.
          const viableDels = [];
          for (let doff = 0; doff < kD; doff++) {
            const delIdx = boundary[(d0 + doff) % kD];
            if (delIdx < 0 || selected[delIdx] !== 1) continue;
            if (addIdx === delIdx) continue;
            const dq = delIdx % width;
            const dr = Math.floor(delIdx / width);
            const span = axialDist(aq, ar, dq, dr);
            if (span > localityCap) {
              rejectLocality++;
              continue;
            }
            const delta = score(delIdx) - addScore;
            const minDeltaNow = Math.max(0, reshaveMinDelta - Math.floor(stalledIters / 80));
            if (delta < minDeltaNow) {
              rejectDelta++;
              continue;
            }
            viableDels.push(delIdx);
          }
          if (!viableDels.length) {
            rejectNoViable++;
            continue;
          }

          // Deterministically pick one viable local deletion candidate for this add tile.
          const pick = hash2(seedU32 ^ (addIdx >>> 0), (it + 1) * 67, viableDels.length) % viableDels.length;
          const delIdx = viableDels[pick];
          attempts++;
          const wasInlandSea = tile_kind[addIdx] === "sea" && oceanConnected[addIdx] === 0;
          if (wasInlandSea) tile_kind[addIdx] = "land";
          selected[addIdx] = 1;
          selected[delIdx] = 0;
          const cc2 = connectedCount();
          if (cc2 === ct) {
            adds++;
            dels++;
            swaps++;
            moved = true;
            phaseMoves++;
            stalledIters = 0;
            break;
          }
          rejectConnectivity++;
          // Revert on failed connectivity.
          selected[delIdx] = 1;
          selected[addIdx] = 0;
          if (wasInlandSea) tile_kind[addIdx] = "sea";
        }
        if (moved) continue;
      }

      // Count correction fallback: grow if under target band.
      if (ct < landMin && frontier.length > 0) {
        const addIdx = pickFromSorted(frontier, reshaveTopK, (it + 1) * 59);
        if (addIdx >= 0 && selected[addIdx] === 0) {
          if (tile_kind[addIdx] === "sea" && oceanConnected[addIdx] === 0) {
            tile_kind[addIdx] = "land";
          }
          selected[addIdx] = 1;
          ct++;
          adds++;
          phaseMoves++;
          stalledIters = 0;
          continue;
        }
      }

      // Count correction fallback: trim if over target band.
      if (ct > landMax && boundary.length > 0) {
        const delIdx = pickFromSorted(boundary, reshaveTopK, (it + 1) * 61);
        if (delIdx >= 0 && selected[delIdx] === 1) {
          selected[delIdx] = 0;
          const cc2 = connectedCount();
          if (cc2 === (ct - 1)) {
            ct--;
            dels++;
            phaseMoves++;
            stalledIters = 0;
            continue;
          }
          selected[delIdx] = 1;
        }
      }

      // No legal move this iteration.
      stalledIters++;
      }
      phaseStats.push({ band: phaseBand, moves: phaseMoves });
      if (phaseMoves === 0 && p >= 1) break;
    }

    return {
      iters: iterBudget,
      swaps,
      adds,
      dels,
      startCount: ct0,
      endCount: ct,
      attempts,
      rejected: {
        locality: rejectLocality,
        delta: rejectDelta,
        connectivity: rejectConnectivity,
        no_viable_pair: rejectNoViable,
      },
      phases: phaseStats,
    };
  };

  // Execute hole fill, then re-balance count, then final sanity passes.
  const holesAdded = fillHoles();

  // Re-enforce target count after hole filling.
  trimToTarget(landTarget);
  growToTarget(landTarget);

  // One last hole fill (should be 0) + one last count rebalance.
  fillHoles();
  trimToTarget(landTarget);
  growToTarget(landTarget);

  // Border reshaping (scalloping/snap): optional, deterministic.
  const reshaveSummary = borderReshave();
  // Final connectivity assertion: if somehow broken, fail fast (this is a hard invariant).
  let ct = 0;
  for (let i = 0; i < total; i++) if (selected[i] === 1) ct++;
  const cc = connectedCount();
  if (cc !== ct) {
    return { selectedMask: null, debug: { enabled: true, error: `remask connectivity failed (connected=${cc}, selected=${ct})`, seedRadius } };
  }

  // Final count.
  let finalCt = 0;
  for (let i = 0; i < total; i++) if (selected[i] === 1) finalCt++;

  return {
    selectedMask: selected,
    debug: {
      enabled: true,
      landTarget,
      nominalR,
      seedRadius,
      selected: finalCt,
      holesFilled: holesAdded,
      reshave: reshaveSummary,

      shape: {
        bins: shapeBins,
        base_radius: shapeBase,
        amp: shapeAmp,
        scale: shapeScale,
        amp2: shapeAmp2,
        scale2: shapeScale2,
        slope: shapeSlope,
        min_r: shapeMinR,
        max_r: shapeMaxR,
      },
    },
    frontier: { frontierRidgeMask, frontierRiverMask, frontierRiverFordMask }
  };
}

function assignTerrain({ width, height, hexes, estuaryIdxSet, majorRiverIdxSet, rand }) {
  const dirs = defaultNeighborDirs();
  const get = (q, r) => hexes[indexOf(q, r, width)];

  // Start: plains for all land
  for (const h of hexes) {
    if (h.tile_kind === "land") h.terrain = "plains";
  }

  // Coast: land adjacent to sea
  for (const h of hexes) {
    if (h.tile_kind !== "land") continue;
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const nh = get(nq, nr);
      if (nh.tile_kind === "sea") {
        h.terrain = "coast";
        break;
      }
    }
  }

  const landIdx = [];
  for (let i = 0; i < hexes.length; i++) if (hexes[i].tile_kind === "land") landIdx.push(i);

  // Mountains: choose 2-3 clusters far from sea/coast
  const candidates = landIdx.filter((i) => {
    const h = hexes[i];
    if (h.terrain === "coast") return false;
    // avoid near estuary and sea band
    if (h.q < 40) return false;
    if (h.r < 10 || h.r > height - 10) return false;
    return true;
  });

  const mountainSeeds = shuffled(rand, candidates).slice(0, 3);

  const setTerrain = (idx, t) => {
    const h = hexes[idx];
    if (h.tile_kind !== "land") return;
    if (h.terrain === "coast") return;
    h.terrain = t;
  };

  for (const seed of mountainSeeds) {
    const radius = pickInt(rand, 2, 4);
    const stack = [{ idx: seed, dist: 0 }];
    const seen = new Set([seed]);
    while (stack.length) {
      const cur = stack.pop();
      if (cur.dist <= radius) setTerrain(cur.idx, "mountains");
      if (cur.dist >= radius) continue;
      const h = hexes[cur.idx];
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (seen.has(ni)) continue;
        if (hexes[ni].tile_kind !== "land") continue;
        seen.add(ni);
        stack.push({ idx: ni, dist: cur.dist + 1 });
      }
    }
  }

  // Hills buffer around mountains
  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i];
    if (h.tile_kind !== "land") continue;
    if (h.terrain !== "mountains") continue;
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      const nh = hexes[ni];
      if (nh.tile_kind !== "land") continue;
      if (nh.terrain === "mountains" || nh.terrain === "coast") continue;
      nh.terrain = "hills";
    }
  }

  // Forest sprinkle
  for (const i of landIdx) {
    const h = hexes[i];
    if (h.terrain === "coast" || h.terrain === "mountains") continue;
    if (h.terrain === "hills") {
      if (rand() < 0.25) h.terrain = "forest";
    } else {
      if (rand() < 0.28) h.terrain = "forest";
    }
  }

  // Marsh boost near estuary (distance <=3)
  // Build multi-source BFS distances from estuary tiles to land tiles.
  const estuaryIdx = Array.from(estuaryIdxSet);
  if (estuaryIdx.length) {
    const dist = new Array(hexes.length).fill(Infinity);
    const q = [];
    for (const i of estuaryIdx) {
      dist[i] = 0;
      q.push(i);
    }
    while (q.length) {
      const cur = q.shift();
      const h = hexes[cur];
      const base = dist[cur];
      if (base >= 3) continue;
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (dist[ni] <= base + 1) continue;
        dist[ni] = base + 1;
        q.push(ni);
      }
    }

    for (let i = 0; i < hexes.length; i++) {
      const h = hexes[i];
      if (h.tile_kind !== "land") continue;
      const d = dist[i];
      if (d > 3) continue;
      if (h.terrain === "mountains" || h.terrain === "coast") continue;
      // higher chance closer
      const p = d === 1 ? 0.45 : d === 2 ? 0.32 : 0.2;
      if (rand() < p) {
        // Avoid marsh adjacent to mountains
        let ok = true;
        for (const dd of dirs) {
          const nq = h.q + dd.dq;
          const nr = h.r + dd.dr;
          if (!inBounds(nq, nr, width, height)) continue;
          const ni = indexOf(nq, nr, width);
          if (hexes[ni].tile_kind !== "land") continue;
          if (hexes[ni].terrain === "mountains") ok = false;
        }
        if (ok) h.terrain = "marsh";
      }
    }
  }

  // Fix disallowed adjacencies:
  // - plains next to mountains => hills
  // - marsh next to mountains => forest
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < hexes.length; i++) {
      const h = hexes[i];
      if (h.tile_kind !== "land") continue;
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        const nh = hexes[ni];
        if (nh.tile_kind !== "land") continue;
        if (h.terrain === "mountains" && nh.terrain === "plains") nh.terrain = "hills";
        if (h.terrain === "plains" && nh.terrain === "mountains") h.terrain = "hills";
        if (h.terrain === "mountains" && nh.terrain === "marsh") nh.terrain = "forest";
        if (h.terrain === "marsh" && nh.terrain === "mountains") h.terrain = "forest";
      }
    }
  }

  // Extra: keep mountains away from coast by converting any mountain adjacent to sea/coast to hills
  for (let i = 0; i < hexes.length; i++) {
    const h = hexes[i];
    if (h.tile_kind !== "land") continue;
    if (h.terrain !== "mountains") continue;
    let bad = false;
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const nh = get(nq, nr);
      if (nh.tile_kind === "sea") bad = true;
      if (nh.tile_kind === "land" && nh.terrain === "coast") bad = true;
    }
    if (bad) h.terrain = "hills";
  }

  // Apply river metadata (already in hexes) but can optionally bias terrain near lower river.
  // For commit 1, we keep it simple.
}

function partitionCounties({ width, height, hexes, landIdx, rand }) {
  // Deterministic sequential carving:
  // 1) Sort targets descending (allocate large counties early)
  // 2) Always carve a connected region from a connected component large enough
  const landSet = new Set(landIdx);
  const dirs = defaultNeighborDirs();

  const targets = [];
  for (let i = 0; i < 3; i++) targets.push(880);
  for (let i = 0; i < 8; i++) targets.push(660);
  for (let i = 0; i < 4; i++) targets.push(520);
  targets.sort((a, b) => b - a);

  const countyCount = countyIds.length;
  const countyIds = Array.from({ length: countyCount }, (_, i) => `c_${i}`);
  const countyTiles = Array.from({ length: countyCount }, () => []);

  const unassigned = new Set(landIdx);

  const computeComponents = () => {
    const seen = new Set();
    const comps = [];
    for (const start of unassigned) {
      if (seen.has(start)) continue;
      const stack = [start];
      const comp = [];
      seen.add(start);
      while (stack.length) {
        const cur = stack.pop();
        comp.push(cur);
        const h = hexes[cur];
        for (const d of dirs) {
          const nq = h.q + d.dq;
          const nr = h.r + d.dr;
          if (!inBounds(nq, nr, width, height)) continue;
          const ni = indexOf(nq, nr, width);
          if (!unassigned.has(ni)) continue;
          if (seen.has(ni)) continue;
          seen.add(ni);
          stack.push(ni);
        }
      }
      comps.push(comp);
    }
    comps.sort((a, b) => b.length - a.length);
    return comps;
  };

  const carveRegion = (seedIdx, targetSize) => {
    // "Peel" fill to reduce fragmentation: repeatedly add a frontier tile with
    // the fewest unassigned neighbors (biases toward boundary growth).
    const regionSet = new Set([seedIdx]);
    const region = [seedIdx];

    const degree = (idx) => {
      const h = hexes[idx];
      let deg = 0;
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!unassigned.has(ni)) continue;
        if (regionSet.has(ni)) continue;
        deg += 1;
      }
      return deg;
    };

    const frontier = new Set();
    const addFrontier = (idx) => {
      const h = hexes[idx];
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        if (!unassigned.has(ni)) continue;
        if (regionSet.has(ni)) continue;
        frontier.add(ni);
      }
    };
    addFrontier(seedIdx);

    let safety = 0;
    while (region.length < targetSize) {
      safety++;
      if (safety > targetSize * 200) break;
      if (!frontier.size) break;

      let bestDeg = Infinity;
      const best = [];
      for (const idx of frontier) {
        const d = degree(idx);
        if (d < bestDeg) {
          bestDeg = d;
          best.length = 0;
          best.push(idx);
        } else if (d === bestDeg) {
          best.push(idx);
        }
      }

      const pick = best.length === 1 ? best[0] : choice(rand, best);
      frontier.delete(pick);
      if (!unassigned.has(pick) || regionSet.has(pick)) continue;

      regionSet.add(pick);
      region.push(pick);
      addFrontier(pick);
    }

    return region;
  };

  const boundaryTilesOf = (comp) => {
    const compSet = new Set(comp);
    const boundary = [];
    for (const idx of comp) {
      const h = hexes[idx];
      let isBoundary = false;
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) {
          isBoundary = true;
          break;
        }
        const ni = indexOf(nq, nr, width);
        if (!unassigned.has(ni)) {
          isBoundary = true;
          break;
        }
      }
      if (isBoundary) boundary.push(idx);
    }
    return boundary.length ? boundary : comp;
  };

  // Bin-pack check: can we assign remaining county targets into the remaining
  // connected components by size capacity (connectivity ignored but necessary)?
  const canFitByComponentSize = (componentSizes, remainingTargets) => {
    const items = [...remainingTargets].sort((a, b) => b - a);
    const caps0 = [...componentSizes].sort((a, b) => b - a);
    const memo = new Map();

    const keyOf = (i, caps) => `${i}|${caps.join(",")}`;

    const dfs = (i, caps) => {
      if (i >= items.length) return true;
      const k = keyOf(i, caps);
      const prev = memo.get(k);
      if (prev !== undefined) return prev;

      const need = items[i];
      for (let c = 0; c < caps.length; c++) {
        if (caps[c] < need) continue;
        const nextCaps = caps.slice();
        nextCaps[c] -= need;
        nextCaps.sort((a, b) => b - a);
        if (dfs(i + 1, nextCaps)) {
          memo.set(k, true);
          return true;
        }
      }
      memo.set(k, false);
      return false;
    };

    return dfs(0, caps0);
  };

  for (let ci = 0; ci < countyCount; ci++) {
    const target = targets[ci];
    if (ci === countyCount - 1) {
      // last county gets the remainder
      const remaining = Array.from(unassigned);
      assert(remaining.length === target, `last county remainder mismatch; expected ${target}, got ${remaining.length}`);
      countyTiles[ci] = remaining;
      for (const idx of remaining) unassigned.delete(idx);
      break;
    }

    let placed = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const comps = computeComponents();
      const comp = comps[0];
      assert(comp, "no remaining components (unexpected)");
      assert(comp.length >= target, `largest remaining component too small for target ${target}`);

      const boundary = boundaryTilesOf(comp);
      const seed = choice(rand, boundary);
      const region = carveRegion(seed, target);
      if (region.length !== target) continue;

      // Tentatively remove
      for (const idx of region) unassigned.delete(idx);

      // Check that the remaining land can still fit the remaining targets
      // by component size capacity.
      const nextComps = computeComponents();
      const sizes = nextComps.map((c) => c.length);
      const ok = canFitByComponentSize(sizes, targets.slice(ci + 1));

      if (ok) {
        countyTiles[ci] = region;
        placed = true;
        break;
      }

      // rollback and retry
      for (const idx of region) unassigned.add(idx);
    }

    assert(placed, `failed to place county ${ci} with target ${target} without over-fragmenting`);
  }

  assert(unassigned.size === 0, `unassigned land remains after partition: ${unassigned.size}`);

  return { countyIds, targets, countyTiles };
}

function pickSeatForCounty({ width, height, hexes, countyTileIdx }) {
  // pick tile closest to centroid (q,r average)
  let sumQ = 0;
  let sumR = 0;
  for (const idx of countyTileIdx) {
    const h = hexes[idx];
    sumQ += h.q;
    sumR += h.r;
  }
  const cq = sumQ / countyTileIdx.length;
  const cr = sumR / countyTileIdx.length;

  let best = countyTileIdx[0];
  let bestScore = Infinity;
  for (const idx of countyTileIdx) {
    const h = hexes[idx];
    // avoid coast when possible
    const coastPenalty = h.terrain === "coast" ? 50 : 0;
    const dx = h.q - cq;
    const dy = h.r - cr;
    const score = dx * dx + dy * dy + coastPenalty;
    if (score < bestScore) {
      bestScore = score;
      best = idx;
    }
  }
  return best;
}

function buildSettlements({ width, height, hexes, counties, seats, estuary_head, rand, config }) {
  const dirs = defaultNeighborDirs();

  // Settlement placement should avoid open-water lakes and the harshest terrain.
  // (This is a v1 rule-set; we can relax per-settlement-kind later.)
  const isPlaceable = (h) => {
    if (!h || h.tile_kind !== "land") return false;
    const t = h.terrain;
    if (t === "lake") return false;
    if (t === "mountains") return false;
    if (t === "marsh") return false;
    return true;
  };

  const settlements = [];
  let sid = 0;

  const usedHex = new Set();
  const markUsed = (hex_id) => usedHex.add(hex_id);

  for (const s of seats) markUsed(s.hex_id);

  // Primary port: on land tile adjacent to sea, prefer near estuary head.
  // Choose the first land neighbor east of head, else search radius.
  const candidates = [];
  if (inBounds(estuary_head.q + 1, estuary_head.r, width, height)) {
    const i = indexOf(estuary_head.q + 1, estuary_head.r, width);
    const h = hexes[i];
    if (isPlaceable(h) && !usedHex.has(h.hex_id)) candidates.push(h);
  }

  if (!candidates.length) {
    for (const h of hexes) {
      if (!isPlaceable(h)) continue;
      if (usedHex.has(h.hex_id)) continue;
      // sea-adjacent
      let seaAdj = false;
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const nh = hexes[indexOf(nq, nr, width)];
        if (nh.tile_kind === "sea") seaAdj = true;
      }
      if (!seaAdj) continue;
      candidates.push(h);
    }
  }

  // Last-resort fallback: any placeable land.
  const portHex = candidates[0] ?? hexes.find((h) => isPlaceable(h) && !usedHex.has(h.hex_id));
  assert(portHex, "buildSettlements: no placeable land tile found for primary port");
  const port_id = `stl_${sid++}`;
  settlements.push({
    settlement_id: port_id,
    settlement_kind: "port",
    hex_id: portHex.hex_id,
    is_primary_port: true,
    name: "Primary Port"
  });
  markUsed(portHex.hex_id);

  // Bishoprics: 8 by default (within 7-9)
  const bishopricTarget = 8;

  // Build hex lookup
  function buildHexById() {
    const m = new Map();
    for (const h of hexes) m.set(h.hex_id, h);
    return m;
  }
  const hexesById = buildHexById();

  // pick bishopric seats spread: start with capital seat then farthest
  const capital = seats.find((s) => s.is_capital) ?? seats[0];
  const picked = [capital.hex_id];
  while (picked.length < bishopricTarget) {
    let best = null;
    let bestD = -1;
    for (const s of seats) {
      if (picked.includes(s.hex_id)) continue;
      if (s.hex_id === portHex.hex_id) continue;
      const h = hexesById.get(s.hex_id);
      if (!h) continue;
      let minD = Infinity;
      for (const pid of picked) {
        const ph = hexesById.get(pid);
        const d = axialDist(h.q, h.r, ph.q, ph.r);
        if (d < minD) minD = d;
      }
      if (minD > bestD) {
        bestD = minD;
        best = s;
      }
    }
    if (!best) break;
    picked.push(best.hex_id);
  }

  // Place bishopric settlements on those seat hexes
  for (let i = 0; i < picked.length; i++) {
    const hid = picked[i];
    const isMetro = i === 0; // capital bishopric is metropolitan
    const isCath = i === 0; // and cathedral
    settlements.push({
      settlement_id: `stl_${sid++}`,
      settlement_kind: "bishopric",
      hex_id: hid,
      is_metropolitan: isMetro,
      is_cathedral: isCath,
      name: isMetro ? "Archdiocese" : "Bishopric"
    });
    markUsed(hid);
  }

  // Abbey markers
  const abbeyBand = config?.church?.abbey_marker_count_band;
  const abbeyCount = Array.isArray(abbeyBand) ? Math.max(12, Math.min(18, abbeyBand[1])) : 18;

  const landHexes = hexes.filter(isPlaceable);

  const pickLandFar = (minDist, tries = 500) => {
    let best = null;
    for (let t = 0; t < tries; t++) {
      const h = choice(rand, landHexes);
      if (usedHex.has(h.hex_id)) continue;
      let ok = true;
      for (const used of usedHex) {
        const uh = hexesById.get(used);
        if (!uh) continue;
        const d = axialDist(h.q, h.r, uh.q, uh.r);
        if (d < minDist) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      best = h;
      break;
    }
    return best;
  };

  for (let i = 0; i < abbeyCount; i++) {
    const h = pickLandFar(3) ?? choice(rand, landHexes);
    if (usedHex.has(h.hex_id)) continue;
    settlements.push({ settlement_id: `stl_${sid++}`, settlement_kind: "abbey", hex_id: h.hex_id, name: "Abbey" });
    markUsed(h.hex_id);
  }

  // Market towns: target total 26 including port (within 22-35)
  const totalMarketBand = config?.settlements?.market_towns_total_band;
  const targetTotal = Array.isArray(totalMarketBand) ? Math.max(totalMarketBand[0], Math.min(26, totalMarketBand[1])) : 26;
  const existingMarkets = settlements.filter((s) => s.settlement_kind === "market" || s.settlement_kind === "port").length;
  const marketToAdd = Math.max(0, targetTotal - existingMarkets);

  // allocate markets per county roughly proportional to size
  const countyById = new Map();
  for (const c of counties) countyById.set(c.county_id, c);

  const countySizes = counties.map((c) => ({ county_id: c.county_id, size: c.hex_ids.length }));
  countySizes.sort((a, b) => b.size - a.size);

  // compute per-county quotas
  const quotas = new Map(countySizes.map((c) => [c.county_id, 0]));
  // minimum 1 for all counties
  for (const c of countySizes) quotas.set(c.county_id, 1);

  // distribute remaining
  let remaining = marketToAdd;
  // note: we already have port counted; this quota ignores that; ok.
  while (remaining > 0) {
    for (const c of countySizes) {
      if (remaining <= 0) break;
      const cur = quotas.get(c.county_id) ?? 0;
      if (cur >= 3 && c.size < 700) continue;
      quotas.set(c.county_id, cur + 1);
      remaining -= 1;
    }
  }

  const hexIdsByCounty = new Map();
  for (const c of counties) hexIdsByCounty.set(c.county_id, c.hex_ids);

  for (const c of counties) {
    const qn = quotas.get(c.county_id) ?? 0;
    const hexIds = hexIdsByCounty.get(c.county_id) ?? [];
    const picks = [];

    // gather hex objects
    const countyHexes = hexIds.map((hid) => hexesById.get(hid)).filter((h) => Boolean(h) && isPlaceable(h));

    for (let k = 0; k < qn; k++) {
      const h = pickLandFar(4) ?? (countyHexes.length ? choice(rand, countyHexes) : null);
      if (!h) continue;
      if (usedHex.has(h.hex_id)) continue;
      settlements.push({ settlement_id: `stl_${sid++}`, settlement_kind: "market", hex_id: h.hex_id, name: "Market" });
      markUsed(h.hex_id);
    }
  }

  // Remove any accidental duplicates by hex
  const byHex = new Map();
  const final = [];
  for (const s of settlements) {
    const key = `${s.settlement_kind}|${s.hex_id}|${s.is_primary_port ? "P" : ""}|${s.is_metropolitan ? "M" : ""}|${s.is_cathedral ? "C" : ""}`;
    if (byHex.has(key)) continue;
    byHex.set(key, true);
    final.push(s);
  }

  return final;
}

function validateSeaAdjacency({ width, height, hexes, landHexId }) {
  const dirs = defaultNeighborDirs();
  const hexById = new Map(hexes.map((h) => [h.hex_id, h]));
  const h = hexById.get(landHexId);
  if (!h) return false;
  for (const d of dirs) {
    const nq = h.q + d.dq;
    const nr = h.r + d.dr;
    if (!inBounds(nq, nr, width, height)) continue;
    const nh = hexes[indexOf(nq, nr, width)];
    if (nh.tile_kind === "sea") return true;
  }
  return false;
}

// Main
const args = parseArgs(process.argv.slice(2));
const seed = args.seed;
const configPath = args.config;
const outPath = args.out;
// Optional outputs (used by map:batch).
const publicOutPath = args.publicOut ?? "public/data/map/map_v1.json";
const metricsOutPath = args.metricsOut;
const reportOutPath = args.reportOut ?? "qa_artifacts/mapgen/report.json";

assert(typeof seed === "string" && seed.length > 0, "--seed is required");
assert(typeof configPath === "string" && configPath.length > 0, "--config is required");
assert(typeof outPath === "string" && outPath.length > 0, "--out is required");

assert(typeof publicOutPath === "string" && publicOutPath.length > 0, "--publicOut invalid");
assert(typeof reportOutPath === "string" && reportOutPath.length > 0, "--reportOut invalid");

const config = readJson(configPath);
assert(config?.schema_version === "map_v1_config_v1_1", `config.schema_version must be map_v1_config_v1_1`);

const width = config?.grid?.width;
const height = config?.grid?.height;
assert(Number.isInteger(width) && width > 0, "config.grid.width missing/invalid");
assert(Number.isInteger(height) && height > 0, "config.grid.height missing/invalid");

const landTarget = config?.scale?.realm_hexes_land_target;
assert(Number.isInteger(landTarget) && landTarget > 0, "config.scale.realm_hexes_land_target missing/invalid");
const landTargetTol = Math.max(1, Math.floor(landTarget * 0.05));

// RNG isolation: mapgen stream with versioned subkey
const seedU32 = hashStringToU32(`${seed}|map_schema_v1`);
const rand = makeMulberry32(seedU32);

const seaBandWidth = config?.mapgen?.sea_band_width ?? 20;

// --- World geometry contract (M3 lock): true mega-hex world.
//
// config.mapgen.world_radius is treated as the *kingdom anchor radius* (historically tuned
// to hit ~10k land after remask). The *world* radius must be larger to provide borderlands
// context all the way to the mega-hex edge.
//
// Requirement: world radius >= ceil(kingdom_anchor_radius * 1.05) + margin.
// (We use the anchor radius as a stable proxy for kingdom max radius; avoids a two-pass
// rebuild of the inWorld mask.)
const coreRadius = Number.isInteger(config?.mapgen?.world_radius) ? config.mapgen.world_radius : 62;
const worldMargin = Math.max(2, Math.floor(Number(config?.mapgen?.world_radius_margin ?? 2)));
const worldRadius = Math.ceil(coreRadius * 1.05) + worldMargin;

// Remask buffer still influences frontier rails / border shaping, but it does NOT expand
// the world (borderlands land fills the remainder of the world disk).
const contextBuffer = Math.max(0, Math.floor(Number(config?.mapgen?.remask?.context_buffer ?? 10)));

// Guard: expanded world must fit the grid.
{
  const cq0 = Math.floor(width / 2);
  const cr0 = Math.floor(height / 2);
  const maxR = Math.min(cq0, cr0, (width - 1) - cq0, (height - 1) - cr0);
  assert(worldRadius <= maxR, `Expanded worldRadius=${worldRadius} exceeds grid capacity maxR=${maxR}. Increase grid or reduce mapgen.remask.context_buffer.`);
}

let remaskSummary = null;
let terrainHydroSummary = null;

// Primary land mask (1 = primary kingdom land, 0 = borderlands / other land).
// Default is set after remask; if remask falls back, all land is treated as primary.
let primaryMask = null;

// Frontier rail masks (from remask) kept for later terrain/hydrology painting + debug PNGs.
let frontierRidgeMask = null;
let frontierRiverMask = null;
let frontierRiverFordMask = null;

// Estuary params (pick within configured bands)
const estLenBand = config?.coast_and_estuary?.estuary?.length_hex ?? [6, 12];
const estMouthBand = config?.coast_and_estuary?.estuary?.mouth_width_hex ?? [3, 7];
const estuaryLength = config?.mapgen?.estuary_length ?? pickInt(rand, estLenBand[0], estLenBand[1]);
const estuaryMouthWidth = config?.mapgen?.estuary_mouth_width ?? pickInt(rand, estMouthBand[0], estMouthBand[1]);

const { tile_kind, terrain, hydrology, estuary_head, river_end, estuaryTiles, world, ocean, inWorld } = carveWorldOceanAndEstuary({
  width,
  height,
  worldRadius,
  oceanRadius: coreRadius,
  seaBandWidth,
  estuaryMouthWidth,
  estuaryLength,
  seed,
  rand
});

// M2: carry forward protected tiles from coast/estuary shaping so later steps
// (seat viability, county assignment invariants, etc.) can respect them.
// Initialized during the perturbation block below.
let protectedIdxSet = null;

// PATCH A: Coastline perturbation (deterministic per seed)
// Treat inland "void" tiles as "land candidates" for coastline shaping, while protecting
// estuary tiles and a short corridor at the estuary head + river end.
{
  const dirs = defaultNeighborDirs();
  protectedIdxSet = new Set(estuaryTiles);
  // Protect river end tile (land adjacent to estuary head) and its immediate neighbors
  if (river_end && Number.isInteger(river_end.idx)) {
    const re = river_end.idx;
    protectedIdxSet.add(re);
    const rq = re % width;
    const rr = Math.floor(re / width);
    for (const d of dirs) {
      const nq = rq + d.dq;
      const nr = rr + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!inWorld[ni]) continue;
      protectedIdxSet.add(ni);
    }
  }

  // Build a temporary coast mask from tile_kind (void excluded).
  const coastTiles = new Array(width * height);
  for (let i = 0; i < coastTiles.length; i++) {
    const q = i % width;
    const r = Math.floor(i / width);
    const tk = tile_kind[i];
    if (tk === "void") {
      coastTiles[i] = { q, r, tile_kind: "void" };
    } else if (tk === "sea") {
      coastTiles[i] = { q, r, tile_kind: "sea" };
    } else {
      coastTiles[i] = { q, r, tile_kind: "land" };
    }
  }

  const neighborsOfIdx = (idx) => {
    const q = idx % width;
    const r = Math.floor(idx / width);
    const out = [];
    for (const d of dirs) {
      const nq = q + d.dq;
      const nr = r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      out.push(indexOf(nq, nr, width));
    }
    return out;
  };

  perturbCoastlineMask({
    tiles: coastTiles,
    width,
    height,
    neighborsOfIdx,
    seedStr: seed,
    coastCfg: config?.mapgen?.coast ?? {},
    protectedIdxSet,
    coastalBand: 8,
    iterations: 3
  });

  // M2: deterministic straight-run breaker to significantly increase jaggedness.
  // Uses the mapgen-only seed stream (seedStr) and respects protected tiles.
  var coastBreakReport = breakCoastStraightRunsMask({
    tiles: coastTiles,
    width,
    height,
    neighborsOfIdx,
    protectedIdxSet,
    seedStr: seed,
    coastalBand: 8,
    maxRun: Number(config?.mapgen?.coast?.max_straight_run ?? 8),
    maxBreaks: Number(config?.mapgen?.coast?.max_breaks ?? 500)
  });

  // Apply perturbation results back into tile_kind/terrain/hydrology.
  for (let i = 0; i < coastTiles.length; i++) {
    if (estuaryTiles.has(i)) continue; // keep estuary untouched
    const tk = coastTiles[i].tile_kind;
    if (tk === "sea") {
      tile_kind[i] = "sea";
      terrain[i] = "sea";
      hydrology[i] = { water_kind: "sea" };
    } else if (tk === "land") {
      tile_kind[i] = "land";
      terrain[i] = "plains";
      hydrology[i] = null;
    }
  }
}

// M2 invariant: prefer a single connected land component.
// Coastline shaping can create small islands or sever thin land bridges; those islands
// break county assignment (no seat adjacency) and read as "void holes" to players.
// Policy: keep the largest land component (tie-break by lowest index) and convert
// all other land components to sea.
{
  const forceSingle = (config?.mapgen?.land?.force_single_component ?? true) !== false;
  if (forceSingle) {
    const dirsLocal = defaultNeighborDirs();
    const visited = new Uint8Array(tile_kind.length);
    let bestComp = null;
    let bestSize = -1;
    let bestMin = Infinity;

    const bfsCollect = (start) => {
      const q = [start];
      visited[start] = 1;
      const comp = [start];
      let min = start;
      for (let qi = 0; qi < q.length; qi++) {
        const cur = q[qi];
        if (cur < min) min = cur;
        const cq = cur % width;
        const cr = Math.floor(cur / width);
        for (const d of dirsLocal) {
          const nq = cq + d.dq;
          const nr = cr + d.dr;
          if (!inBounds(nq, nr, width, height)) continue;
          const ni = indexOf(nq, nr, width);
          if (!inWorld[ni]) continue;
          if (visited[ni]) continue;
          if (tile_kind[ni] !== "land") continue;
          visited[ni] = 1;
          q.push(ni);
          comp.push(ni);
        }
      }
      return { comp, size: comp.length, min };
    };

    // Find largest component
    for (let i = 0; i < tile_kind.length; i++) {
      if (!inWorld[i]) continue;
      if (tile_kind[i] !== "land") continue;
      if (visited[i]) continue;
      const { comp, size, min } = bfsCollect(i);
      if (size > bestSize || (size === bestSize && min < bestMin)) {
        bestSize = size;
        bestMin = min;
        bestComp = comp;
      }
    }

    if (bestComp && bestSize > 0) {
      const keep = new Uint8Array(tile_kind.length);
      for (const idx of bestComp) keep[idx] = 1;
      for (let i = 0; i < tile_kind.length; i++) {
        if (!inWorld[i]) continue;
        if (tile_kind[i] !== "land") continue;
        if (keep[i]) continue;
        tile_kind[i] = "sea";
        terrain[i] = "sea";
        hydrology[i] = { water_kind: "sea" };
      }
    }
  }
}


// --- Kingdom border remask (within an expanded context ring) ---
// After this step, only the selected land hexes remain tile_kind="land"; all other world-land
// becomes tile_kind="void" (treated as off-map / neighboring realm for now).
{
  const protectedIdxSet = new Set();

  // Protect the estuary system so the major river has a stable terminus.
  if (Array.isArray(estuaryTiles)) {
    for (const idx of estuaryTiles) protectedIdxSet.add(idx);
  }
  if (river_end && Number.isInteger(river_end.idx)) protectedIdxSet.add(river_end.idx);
  if (estuary_head && Number.isInteger(estuary_head.idx)) protectedIdxSet.add(estuary_head.idx);

  // Also protect a small neighborhood around those tiles.
  const dirs = defaultNeighborDirs();
  const extra = [];
  for (const idx of protectedIdxSet) {
    const q = idx % width;
    const r = Math.floor(idx / width);
    for (const d of dirs) {
      const nq = q + d.dq;
      const nr = r + d.dr;
      if (!inBounds(nq, nr, width, height)) continue;
      const ni = indexOf(nq, nr, width);
      if (!inWorld[ni]) continue;
      extra.push(ni);
    }
  }
  for (const idx of extra) protectedIdxSet.add(idx);

  const remaskRes = remaskKingdomLand({
    width,
    height,
    inWorld,
    tile_kind,
    world,
    ocean,
    coreRadius,
    buffer: contextBuffer,
    landTarget,
    seed,
    config,
    protectedIdxSet,
  });

  // Preserve frontier masks even if debug summary is omitted.
  if (remaskRes?.frontier) {
    frontierRidgeMask = remaskRes.frontier.frontierRidgeMask;
    frontierRiverMask = remaskRes.frontier.frontierRiverMask;
    frontierRiverFordMask = remaskRes.frontier.frontierRiverFordMask;
  }

  // Capture a small summary for the JSON report.
  if (remaskRes?.debug) {
    const sum = {
      ...remaskRes.debug,
      coreRadius,
      worldRadius,
      contextBuffer,
    };
    if (remaskRes.frontier) {
      const ridge = remaskRes.frontier.frontierRidgeMask;
      const river = remaskRes.frontier.frontierRiverMask;
      const ford = remaskRes.frontier.frontierRiverFordMask;

      // Keep full masks for later terrain/hydrology painting.
      frontierRidgeMask = ridge;
      frontierRiverMask = river;
      frontierRiverFordMask = ford;

      const countOnes = (arr) => {
        if (!arr) return 0;
        let c = 0;
        for (let i = 0; i < arr.length; i++) if (arr[i] === 1) c++;
        return c;
      };
      const collectIdx = (arr) => {
        if (!arr) return [];
        const out = [];
        for (let i = 0; i < arr.length; i++) if (arr[i] === 1) out.push(i);
        return out;
      };
      sum.frontier = {
        ridge_belt_tiles: countOnes(ridge),
        river_belt_tiles: countOnes(river),
        ford_tiles: countOnes(ford),
        // Debug: index lists for QA PNG overlays (do not ship to runtime).
        ridge_idx: collectIdx(ridge),
        river_idx: collectIdx(river),
        ford_idx: collectIdx(ford),
      };
    }
    remaskSummary = sum;
  }

  if (remaskRes?.selectedMask) {
    const sel = remaskRes.selectedMask;
    primaryMask = sel;
    for (let i = 0; i < tile_kind.length; i++) {
      if (!inWorld[i]) continue;
      if (tile_kind[i] !== "land") continue;
      // Keep non-selected land as borderlands context (still land), but not part of the primary.
      // County assignment later will be restricted to primaryMask==1.
    }
  } else if (remaskRes?.debug?.error) {
    console.warn(`[remask] fallback (keeping original land mask): ${remaskRes.debug.error}`);
  }
}

// If remask did not produce a mask, treat all land as primary.
if (!primaryMask) {
  primaryMask = new Uint8Array(tile_kind.length);
  for (let i = 0; i < tile_kind.length; i++) {
    if (!inWorld[i]) continue;
    if (tile_kind[i] === "land") primaryMask[i] = 1;
  }
}


// Major river (presentation-only): deterministic BFS path from far inland to the
// river_end tile adjacent to the estuary.
const majorRiverIdxSet = new Set();
let majorRiverPathIdx = null;
let majorRiverPathsIdx = null;

// Generate the river network across all in-world land so hydrology can continue
// naturally through borderlands as well as the primary kingdom.
const tile_kind_hydro = tile_kind;

if (river_end && Number.isInteger(river_end.idx)) {
  let startIdx = null;
  let bestD = -1;
  for (let i = 0; i < tile_kind.length; i++) {
    if (!inWorld[i]) continue;
    if (tile_kind_hydro[i] !== "land") continue;
    const q = i % width;
    const r = Math.floor(i / width);
    const d = axialDist(q, r, river_end.q, river_end.r);
    if (d > bestD) { bestD = d; startIdx = i; }
  }

  if (startIdx != null) {
    const pathIdx = computeRiverPathMeandered({ width, height, inWorld, tile_kind: tile_kind_hydro, startIdx, endIdx: river_end.idx, seed, config, tag: "major" });
    if (pathIdx) {
      majorRiverPathIdx = pathIdx;
      for (const idx of pathIdx) majorRiverIdxSet.add(idx);

      // Optional: add a major tributary to create a more plausible river system
      // (still a single connected major-river component for validation).
      // This provides a second macro divider line for counties to follow.
      majorRiverPathsIdx = [pathIdx];
      if (pathIdx.length >= 10) {
        const joinIdx = pathIdx[Math.floor(pathIdx.length * 0.68)];

        // Distance to trunk (BFS on land only).
        const distToTrunk = new Int16Array(width * height);
        distToTrunk.fill(-1);
        {
          const q = [];
          for (const ii of pathIdx) {
            distToTrunk[ii] = 0;
            q.push(ii);
          }
          const dirs = defaultNeighborDirs();
          for (let qi = 0; qi < q.length; qi++) {
            const cur = q[qi];
            const cd = distToTrunk[cur];
            const cq = cur % width;
            const cr = Math.floor(cur / width);
            for (const d of dirs) {
              const nq = cq + d.dq;
              const nr = cr + d.dr;
              if (!inBounds(nq, nr, width, height)) continue;
              const ni = indexOf(nq, nr, width);
              if (!inWorld[ni]) continue;
              if (tile_kind_hydro[ni] !== "land") continue;
              if (distToTrunk[ni] !== -1) continue;
              distToTrunk[ni] = cd + 1;
              q.push(ni);
            }
          }
        }

        // Pick a tributary source far from the confluence AND not right next to the trunk.
        let tribStart = null;
        let bestScore = -1;
        const jQ = joinIdx % width;
        const jR = Math.floor(joinIdx / width);
        for (let i = 0; i < tile_kind.length; i++) {
          if (!inWorld[i]) continue;
          if (tile_kind_hydro[i] !== "land") continue;
          if (majorRiverIdxSet.has(i)) continue;
          const q = i % width;
          const r = Math.floor(i / width);
          const dJoin = axialDist(q, r, jQ, jR);
          const dTr = distToTrunk[i] >= 0 ? distToTrunk[i] : 0;
          const score = dJoin + Math.floor(dTr * 0.6);
          if (score > bestScore || (score === bestScore && (tribStart == null || i < tribStart))) {
            bestScore = score;
            tribStart = i;
          }
        }

        if (tribStart != null) {
          const tribSeed = `${seed}|tributary_v1`;
          const tribPath = computeRiverPathMeandered({ width, height, inWorld, tile_kind: tile_kind_hydro, startIdx: tribStart, endIdx: joinIdx, seed: tribSeed, config, tag: "tributary" });
          if (tribPath && tribPath.length >= 6) {
            majorRiverPathsIdx.push(tribPath);
            for (const idx of tribPath) majorRiverIdxSet.add(idx);
          }
        }
      }
    }
  }
}

// Build hexes
const total = width * height;
const hexes = new Array(total);

for (let i = 0; i < total; i++) {
  const q = i % width;
  const r = Math.floor(i / width);
  const tk = tile_kind[i];

  const h = {
    hex_id: hexId(i),
    q,
    r,
    tile_kind: tk,
    terrain: tk === "land" ? "plains" : terrain[i] ?? "sea",
    county_id: null,
    hydrology: null
  };

  if (tk === "sea") {
    h.terrain = "sea";
    h.hydrology = hydrology[i] ?? { water_kind: "sea" };
  }

  if (tk === "void") {
    h.terrain = "sea";
  }

  if (tk === "land") {
    if (majorRiverIdxSet.has(i)) {
      h.hydrology = { river_class: "major" };
    }
  }

  // Estuary tiles override (remain sea)
  if (tile_kind[i] === "sea" && hydrology[i]?.water_kind === "estuary") {
    h.tile_kind = "sea";
    h.terrain = "sea";
    h.hydrology = { water_kind: "estuary" };
  }

  hexes[i] = h;
}

// Terrain assignment (mutates hexes)
assignTerrain({ width, height, hexes, estuaryIdxSet: estuaryTiles, majorRiverIdxSet, rand, config });


// Partition counties (Patch B: County v2)
//
// Primary land = remask-selected kingdom land (primaryMask==1).
// Borderlands land = all other inWorld land (tile_kind==land but primaryMask==0), with no counties.
const landIdxAll = [];
const landIdxPrimary = [];
for (let i = 0; i < hexes.length; i++) {
  if (hexes[i].tile_kind !== "land") continue;
  landIdxAll.push(i);
  if (primaryMask[i] === 1) landIdxPrimary.push(i);
}
assert(Math.abs(landIdxPrimary.length - landTarget) <= landTargetTol, `primary land hex count out of tolerance: got ${landIdxPrimary.length}, target ${landTarget} ±${landTargetTol}`);
const landIdxSet = new Set(landIdxPrimary);

// Back-compat local alias: downstream county/seat logic expects `landIdx`.
// In M3 borderlands-context mode, county/seat logic operates on the primary kingdom only.
const landIdx = landIdxPrimary;

const dirs = defaultNeighborDirs();
const neighborIdxs = (idx) => {
  const q = hexes[idx].q;
  const r = hexes[idx].r;
  const out = [];
  for (const d of dirs) {
    const nq = q + d.dq;
    const nr = r + d.dr;
    if (!inBounds(nq, nr, width, height)) continue;
    out.push(indexOf(nq, nr, width));
  }
  return out;
};

// County ids
const countyCountCfg = Number(config?.counties?.county_count ?? 15);
assert(Number.isInteger(countyCountCfg) && countyCountCfg > 0, "config.counties.county_count missing/invalid");
const countyIds = Array.from({ length: countyCountCfg }, (_, i) => `c_${i}`);

// Seat viability inputs
// distToVoid: distance from each land tile to the land boundary (land adjacent to sea/void/out-of-bounds)
const distToVoid = new Int16Array(hexes.length);
distToVoid.fill(-1);
{
  const q = [];
  for (const idx of landIdxPrimary) {
    // boundary land if any neighbor is not land
    let boundary = false;
    for (const nb of neighborIdxs(idx)) {
      if (!landIdxSet.has(nb)) { boundary = true; break; }
    }
    if (boundary) {
      distToVoid[idx] = 0;
      q.push(idx);
    }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cd = distToVoid[cur];
    for (const nb of neighborIdxs(cur)) {
      if (!landIdxSet.has(nb)) continue;
      if (distToVoid[nb] !== -1) continue;
      distToVoid[nb] = cd + 1;
      q.push(nb);
    }
  }
}

// distToMajorRiver: distance from each land tile to nearest major river tile
const distToMajorRiver = new Int16Array(hexes.length);
distToMajorRiver.fill(-1);
{
  const q = [];
  for (const idx of landIdxPrimary) {
    const isMajor = hexes[idx]?.hydrology?.river_class === "major";
    if (isMajor) {
      distToMajorRiver[idx] = 0;
      q.push(idx);
    }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cd = distToMajorRiver[cur];
    for (const nb of neighborIdxs(cur)) {
      if (!landIdxSet.has(nb)) continue;
      if (distToMajorRiver[nb] !== -1) continue;
      distToMajorRiver[nb] = cd + 1;
      q.push(nb);
    }
  }
}

// distToSea: distance from each land tile to nearest sea-neighbor boundary.
// Used for macro skeleton style C (coastal plain + interior highlands).
const distToSea = new Int16Array(hexes.length);
distToSea.fill(-1);
{
  const q = [];
  for (const idx of landIdxPrimary) {
    let coastal = false;
    for (const nb of neighborIdxs(idx)) {
      const tk = hexes[nb]?.tile_kind;
      if (tk === "sea") { coastal = true; break; }
    }
    if (coastal) {
      distToSea[idx] = 0;
      q.push(idx);
    }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cd = distToSea[cur];
    for (const nb of neighborIdxs(cur)) {
      if (!landIdxSet.has(nb)) continue;
      if (distToSea[nb] !== -1) continue;
      distToSea[nb] = cd + 1;
      q.push(nb);
    }
  }
}

// --- Borderlands continuity helpers (all land: primary + borderlands) ---
const landIdxAllSet = new Set(landIdxAll);

// distToVoidAll: boundary distance computed over ALL land (used for borderlands terrain belts, lakes, etc.)
const distToVoidAll = new Int16Array(hexes.length);
distToVoidAll.fill(-1);
{
  const q = [];
  for (const idx of landIdxAll) {
    let boundary = false;
    for (const nb of neighborIdxs(idx)) {
      if (!landIdxAllSet.has(nb)) { boundary = true; break; }
    }
    if (boundary) {
      distToVoidAll[idx] = 0;
      q.push(idx);
    }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cd = distToVoidAll[cur];
    for (const nb of neighborIdxs(cur)) {
      if (!landIdxAllSet.has(nb)) continue;
      if (distToVoidAll[nb] !== -1) continue;
      distToVoidAll[nb] = cd + 1;
      q.push(nb);
    }
  }
}

// distToMajorRiverAll: distance over ALL land to the major river (for moisture/valley carving in borderlands).
const distToMajorRiverAll = new Int16Array(hexes.length);
distToMajorRiverAll.fill(-1);
{
  const q = [];
  for (const idx of landIdxAll) {
    const isMajor = hexes[idx]?.hydrology?.river_class === "major";
    if (isMajor) {
      distToMajorRiverAll[idx] = 0;
      q.push(idx);
    }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cd = distToMajorRiverAll[cur];
    for (const nb of neighborIdxs(cur)) {
      if (!landIdxAllSet.has(nb)) continue;
      if (distToMajorRiverAll[nb] !== -1) continue;
      distToMajorRiverAll[nb] = cd + 1;
      q.push(nb);
    }
  }
}

// distToSeaAll: distance over ALL land to sea (used for coastal lake prohibition and coastal gradients).
const distToSeaAll = new Int16Array(hexes.length);
distToSeaAll.fill(-1);
{
  const q = [];
  for (const idx of landIdxAll) {
    let coastal = false;
    for (const nb of neighborIdxs(idx)) {
      const tk = hexes[nb]?.tile_kind;
      if (tk === "sea") { coastal = true; break; }
    }
    if (coastal) {
      distToSeaAll[idx] = 0;
      q.push(idx);
    }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cd = distToSeaAll[cur];
    for (const nb of neighborIdxs(cur)) {
      if (!landIdxAllSet.has(nb)) continue;
      if (distToSeaAll[nb] !== -1) continue;
      distToSeaAll[nb] = cd + 1;
      q.push(nb);
    }
  }
}

// Macro skeleton (A/B/C): divider-cost field used by county assignment + seat scoring.
const macroStyle = parseMacroStyleFromSeed(seed);
const { styleId: macroStyleId, dividerCost: macroDividerCost, maxCost: macroMaxCost, basinId: macroBasinId, ridgeMask: macroRidgeMask, riverFordMask: macroRiverFordMask, debug: macroDebug } = generateMacroDividerCostV1({
  styleId: macroStyle,
  seed,
  width,
  height,
  hexes,
  landIdx: landIdxPrimary,
  world,
  distToSea,
  config,
  majorRiverPathIdx,
  majorRiverPathsIdx
});

// Promote macro ridges to visible hills to reinforce "borders follow geography".
// NOTE: config disallows mountains adjacent to plains/sea/coast, so we use hills.
if (macroRidgeMask) {
  for (const idx of landIdxPrimary) {
    if (macroRidgeMask[idx] !== 1) continue;
    const h = hexes[idx];
    if (h.tile_kind !== "land") continue;
    if (h.terrain === "coast") continue;
    if (h.terrain !== "mountains") h.terrain = "hills";
  }
}

// Pick seats (15) deterministically (M3.2) — basin-aware seat allocation.
//
// Motivation:
// Stronger macro dividers can "box in" seats and create very small counties if we
// over-seed a constrained basin. We therefore allocate seat *counts* per macro
// basin (capacity + water-access weighting), then place seats within each basin
// using global spacing-first greedy.
const seatWeights = {
  w_interior: 0.30,
  w_not_coast: 0.25,
  w_terrain: 0.25,
  w_river_bonus: 0.15,
  // Prefer seats away from major dividers so counties don't anchor on ridgelines.
  w_macro_avoid: 0.15
};

const seatProtect = new Set(protectedIdxSet ? Array.from(protectedIdxSet) : []);


const minCountyFloor = Math.max(1, Math.floor(Number(config?.mapgen?.counties?.min_county_size ?? 250)));

const basinSeatWCoast = Number(config?.mapgen?.counties?.basin_seat_weight_coast ?? 0.90);
const basinSeatWRiver = Number(config?.mapgen?.counties?.basin_seat_weight_river ?? 0.35);
const basinRiverAccessRadius = Math.max(0, Math.floor(Number(config?.mapgen?.counties?.basin_river_access_radius ?? 2)));

const isCoastIdx = (i) => {
  const h = hexes[i];
  if (h.tile_kind !== "land") return false;
  for (const nb of neighborIdxs(i)) {
    if (hexes[nb]?.tile_kind === "sea") return true;
  }
  return false;
};

const terrainPenalty = (t) => {
  switch (t) {
    case "marsh": return 1.0;
    case "mountains": return 1.0;
    case "hills": return 0.25;
    case "forest": return 0.35;
    default: return 0.0;
  }
};

const clamp01 = (x) => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
};

const mixU32 = (x) => {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
};

const hashU32 = (seedU32, a, b, c) => {
  let x = (seedU32 ^ (a + 0x9e3779b9)) >>> 0;
  x = mixU32(x ^ (b >>> 0));
  x = mixU32(x ^ (c >>> 0));
  return x >>> 0;
};

const seatsSeedU32 = hashStringToU32(`${seed}|seats_basin_quota_v1`);
const jitter = (i, k) => (hashU32(seatsSeedU32, i, k, 777) / 0xffffffff) * 1e-6;

// Normalize distances for scoring.
let maxInterior = 1;
let maxRiverDist = 1;
for (const i of landIdx) {
  const dv = distToVoid[i] ?? 0;
  const dr = distToMajorRiver[i] ?? 0;
  if (dv > maxInterior) maxInterior = dv;
  if (dr > maxRiverDist) maxRiverDist = dr;
}

const viability = (i) => {
  const h = hexes[i];
  const interior = (distToVoid[i] ?? 0) / maxInterior;
  const notCoast = isCoastIdx(i) ? 0.0 : 1.0;
  const terr = 1.0 - terrainPenalty(h.terrain);
  const river = 1.0 - ((distToMajorRiver[i] ?? maxRiverDist) / maxRiverDist);

  let macroAvoid = 1.0;
  if (macroDividerCost && Number.isFinite(Number(macroMaxCost)) && Number(macroMaxCost) > 0) {
    const mc = Number(macroDividerCost[i] ?? 0);
    macroAvoid = 1.0 - clamp01(mc / Number(macroMaxCost));
  }

  return (
    (seatWeights.w_interior ?? 0.3) * interior +
    (seatWeights.w_not_coast ?? 0.25) * notCoast +
    (seatWeights.w_terrain ?? 0.25) * terr +
    (seatWeights.w_river_bonus ?? 0.15) * river +
    (seatWeights.w_macro_avoid ?? 0.0) * macroAvoid
  );
};

const computeBasinSeatPlan = () => {
  if (!macroBasinId) return null;

  const basinSet = new Set();
  for (const idx of landIdx) {
    const b = macroBasinId[idx];
    if (b >= 0) basinSet.add(b);
  }
  const basins = Array.from(basinSet).sort((a, b) => a - b);

  const stats = new Map(); // basin -> { land, coast, riverAccess, weight, cap }
  for (const b of basins) stats.set(b, { land: 0, coast: 0, riverAccess: 0, weight: 0, cap: 1 });

  for (const idx of landIdx) {
    const b = macroBasinId[idx];
    if (b < 0) continue;
    const s = stats.get(b);
    if (!s) continue;
    s.land += 1;
    if (isCoastIdx(idx)) s.coast += 1;
    const dr = distToMajorRiver[idx];
    if (Number.isFinite(dr) && dr >= 0 && dr <= basinRiverAccessRadius) s.riverAccess += 1;
  }

  for (const b of basins) {
    const s = stats.get(b);
    const land = Math.max(0, s.land);
    const cap = Math.max(1, Math.floor(land / minCountyFloor));
    s.cap = cap;

    const coastFrac = land > 0 ? (s.coast / land) : 0;
    const riverFrac = land > 0 ? (s.riverAccess / land) : 0;

    // Weight model: area * (1 + coastWeight*coastFrac + riverWeight*riverFrac)
    // This allocates more seats (smaller counties) to water-access basins,
    // while respecting the hard min county floor via cap.
    s.weight = land * (1 + basinSeatWCoast * coastFrac + basinSeatWRiver * riverFrac);
  }

  // Deterministic D'Hondt apportionment with caps.
  const desired = new Map();
  let baseSum = 0;
  for (const b of basins) {
    const cap = stats.get(b)?.cap ?? 1;
    const init = Math.min(1, cap);
    desired.set(b, init);
    baseSum += init;
  }

  let rem = countyCountCfg - baseSum;
  while (rem > 0) {
    let bestB = null;
    let bestScore = -Infinity;

    for (const b of basins) {
      const s = stats.get(b);
      const cur = desired.get(b) ?? 0;
      if (cur >= (s.cap ?? 1)) continue;
      const score = (s.weight ?? 0) / (cur + 1);
      if (score > bestScore || (score === bestScore && (bestB == null || b < bestB))) {
        bestScore = score;
        bestB = b;
      }
    }

    if (bestB == null) break;
    desired.set(bestB, (desired.get(bestB) ?? 0) + 1);
    rem--;
  }

  return { basins, stats, desired };
};

const pickSeatsWithBasinQuotas = ({ plan }) => {
  const chosen = [];
  const chosenSet = new Set();

  const basins = plan?.basins ?? [];
  const desired = plan?.desired ?? new Map();

  const perBasinCt = new Map();
  for (const b of basins) perBasinCt.set(b, 0);

  let curMinSeatDist = Math.max(0, Math.floor(Number(config?.mapgen?.counties?.seat_min_dist ?? 12)));
  const maxDistNorm = Math.max(1, Math.floor((width + height) / 2));

  const nearestSeatDist = (i) => {
    if (!chosen.length) return Infinity;
    let minD = Infinity;
    for (const s of chosen) {
      const d = axialDist(hexes[i].q, hexes[i].r, hexes[s].q, hexes[s].r);
      if (d < minD) minD = d;
    }
    return minD;
  };

  const alpha = 0.15;
  const beta = 0.85;

  const totalTarget = countyCountCfg;

  while (chosen.length < totalTarget) {
    let progress = false;

    for (const b of basins) {
      const want = desired.get(b) ?? 0;
      const have = perBasinCt.get(b) ?? 0;
      if (have >= want) continue;

      let pick = null;
      let pickScore = -Infinity;

      for (const i of landIdx) {
        if (macroBasinId[i] !== b) continue;
        if (chosenSet.has(i)) continue;
        if (seatProtect.has(i)) continue;

        const dmin = nearestSeatDist(i);
        if (curMinSeatDist > 0 && Number.isFinite(dmin) && dmin < curMinSeatDist) continue;

        const dNorm = Number.isFinite(dmin) ? clamp01(dmin / maxDistNorm) : 1.0;
        const v = viability(i);
        const score = alpha * v + beta * dNorm + jitter(i, chosen.length);

        if (score > pickScore || (score === pickScore && (pick == null || i < pick))) {
          pickScore = score;
          pick = i;
        }
      }

      if (pick != null) {
        chosen.push(pick);
        chosenSet.add(pick);
        perBasinCt.set(b, have + 1);
        progress = true;
      }
    }

    if (progress) continue;

    // Deterministic relaxation if spacing makes it impossible to place all seats.
    if (curMinSeatDist > 0) {
      curMinSeatDist -= 1;
      continue;
    }

    break;
  }

  return chosen;
};

let seatsIdx = null;
const basinSeatPlan = computeBasinSeatPlan();

if (basinSeatPlan && basinSeatPlan.basins?.length) {
  seatsIdx = pickSeatsWithBasinQuotas({ plan: basinSeatPlan });
} else {
  seatsIdx = pickSeatsV2({
    width,
    height,
    hexes,
    landIdx,
    neighborIdxs,
    distToVoid,
    distToMajorRiver,
    macroDividerCost,
    macroMaxCost,
    weights: seatWeights,
    // Strong spacing bias
    alpha: 0.15,
    beta: 0.85,
    seatCount: countyCountCfg,
    minSeatDist: Number(config?.mapgen?.counties?.seat_min_dist ?? 12),
    seed
  });
}

assert(seatsIdx.length === countyCountCfg, `expected ${countyCountCfg} seats; got ${seatsIdx.length}`);

// M2: hard sizing rules
const landCount = landIdx.length;
const countyCount = countyIds.length;
const avg = landCount / countyCount;
const mu = Number(config?.mapgen?.counties?.mu ?? 1.3);
const alphaQuota = Number(config?.mapgen?.counties?.alpha ?? 0.25);
const cap = Math.ceil(mu * avg);
const seed_quota = Math.ceil(alphaQuota * avg);

// Seat viability check + deterministic relocation BEFORE assignment
// Protected tiles: estuary corridor + anything already protected by coast perturbation.
{
  const { seatsIdx: relocated } = ensureSeatViability({
    seatsIdx,
    landIdx,
    landIdxSet,
    neighborIdxs,
    hexes,
    width,
    height,
    seed,
    radiusBase: Number(config?.mapgen?.counties?.seat_viability_radius ?? 6),
    seedQuota: seed_quota,
    floorMinReach: Number(config?.mapgen?.counties?.seat_viability_floor ?? 25),
    protectedIdxSet: seatProtect,
    basinId: macroBasinId
  });
  seatsIdx = relocated;
}

// M3: Seat repair pass (optional) — if the macro divider-cost field + seed
// produces an extremely small Voronoi region for a seat, relocate that seat
// deterministically and retry a bounded number of times.
{
  const minCountySize = Math.max(0, Math.floor(Number(config?.mapgen?.counties?.min_county_size ?? 100)));
  const repairPasses = Math.max(0, Math.floor(Number(config?.mapgen?.counties?.seat_repair_passes ?? 2)));
  if (repairPasses > 0 && minCountySize > 0) {
    const { seatsIdx: repaired, repaired: didRepair } = repairSeatsForMinCountySizeCostVoronoi({
      width,
      height,
      hexes,
      landIdx,
      landIdxSet,
      neighborIdxs,
      distToVoid,
      distToMajorRiver,
      macroDividerCost,
      macroMaxCost,
      basinId: macroBasinId,
      seatsIdx,
      countyIds,
      seed,
      minSeatDist: Number(config?.mapgen?.counties?.seat_min_dist ?? 12),
      minCountySize,
      maxPasses: repairPasses,
      protectedIdxSet: seatProtect,
      // keep the same weighting model as initial selection
      weights: seatWeights,
      alpha: 0.15,
      beta: 0.85
    });
    if (didRepair) seatsIdx = repaired;
  }
}

// Derive fixed county loop order from FINAL seat positions (distance-to-center)
const centerQ = Math.floor(width / 2);
const centerR = Math.floor(height / 2);
const loopOrder = deriveCountyLoopOrder({ seatsIdx, hexes, centerQ, centerR, countyIds });

// Targets: equal split + deterministic remainder distribution by loop order
const countyTargets = computeCountyTargetsEqualSplit({ landCount, countyCount, loopOrder });

// Assign counties via cost-aware geodesic Voronoi on the land graph.
// This dramatically reduces gerrymandered "fingers" because regions are grown
// by shortest-path wavefront, biased by the macro divider-cost field.
const { assignedCounty, countySize: countySizeArr, min: countyMin, max: countyMax, avg: countyAvg, unassigned_land } = assignCountiesCostVoronoi({
  width,
  height,
  hexes,
  landIdxSet,
  neighborIdxs,
  seatsIdx,
  countyIds,
  loopOrder,
  dividerCost: macroDividerCost,
  dividerMaxCost: macroMaxCost,
  basinId: macroBasinId,
  protectedIdxSet: seatProtect,
  smooth: config?.mapgen?.counties?.voronoi_smooth
});

const countyTiles = Array.from({ length: countyIds.length }, () => []);
for (const idx of landIdx) {
  const ci = assignedCounty[idx];
  assert(ci >= 0 && ci < countyIds.length, `assignedCounty missing for land idx ${idx}`);
  countyTiles[ci].push(idx);
}

const countyNames = buildCountyNames();

const counties = [];
for (let ci = 0; ci < countyIds.length; ci++) {
  const cid = countyIds[ci];
  const tiles = countyTiles[ci];

  for (const idx of tiles) hexes[idx].county_id = cid;

  const hex_ids = tiles.map((idx) => hexes[idx].hex_id);
  hex_ids.sort();

  counties.push({
    county_id: cid,
    name: countyNames[ci] ?? `County ${ci + 1}`,
    hex_ids
  });
}

// Seats
const seats = [];
const capitalCountyId = countyIds[0];

for (let ci = 0; ci < counties.length; ci++) {
  const c = counties[ci];
  const seatIdx = seatsIdx[ci];
  // Seat must belong to its county by construction
  seats.push({
    seat_id: `seat_${c.county_id}`,
    county_id: c.county_id,
    hex_id: hexes[seatIdx].hex_id,
    is_capital: c.county_id === capitalCountyId
  });
}

// Terrain + Hydrology painting pass (M3): lakes, drainage-based marsh, and frontier belts.
// IMPORTANT: runs after seats/counties are fixed so we don't perturb county shaping.
{
  const debug = {};
  paintTerrainHydrologyV1({
    seed,
    width,
    height,
    hexes,
    landIdx: landIdxAll,
    distToSea: distToSeaAll,
    distToVoid: distToVoidAll,
    distToMajorRiver: distToMajorRiverAll,
    macroStyleId,
    macroRidgeMask,
    macroBasinId,
    frontierRidgeMask,
    frontierRiverMask,
    frontierRiverFordMask,
    estuaryIdxSet: new Set(estuaryTiles ?? []),
    majorRiverIdxSet,
    protectedIdxSet: seatProtect,
    seatsIdx,
    config,
    debugOut: debug
  });
  terrainHydroSummary = debug;
}

// Settlements (uses a helper that expects hexById)
const settlements = buildSettlements({ width, height, hexes, counties, seats, estuary_head, rand, config });

// Ensure primary port sea adjacency rule
const primaryPorts = settlements.filter((s) => s.settlement_kind === "port" && s.is_primary_port === true);
assert(primaryPorts.length === 1, `expected exactly one primary port; got ${primaryPorts.length}`);
assert(validateSeaAdjacency({ width, height, hexes, landHexId: primaryPorts[0].hex_id }), "primary port must be sea-adjacent");

// Assemble map
const map = {
  schema_version: "map_schema_v1",
  width,
  height,
  neighbor_dir_order: defaultNeighborDirs(),
  mapgen_seed: seed,
  config_sha256: sha256File(configPath),
  macro: {
    style: typeof macroStyleId !== "undefined" ? macroStyleId : null
  },
  counties,
  hexes,
  seats,
  settlements
};

// Metrics (must match validate)
const metrics = computeMapMetrics(map, config);

// Write outputs
writeJson(outPath, map);

const publicOut = path.resolve(publicOutPath);
ensureDir(path.dirname(publicOut));
writeJson(publicOut, map);

const metricsPath = (typeof metricsOutPath === "string" && metricsOutPath.length > 0)
  ? path.resolve(metricsOutPath)
  : null;

if (metricsPath) {
  ensureDir(path.dirname(metricsPath));

  // If existing metrics file exists, it should match (self-check)
  if (fs.existsSync(metricsPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(metricsPath, "utf8"));
      if (stableStringify(prev) !== stableStringify(metrics)) {
        console.warn(`WARN: existing metrics file differs at ${metricsPath}; will overwrite on generation.`);
      }
    } catch {}
  }

  writeJson(metricsPath, metrics);
} else {
  console.warn("WARN: --metricsOut not provided; metrics file not written.");
}

// Also emit a small gen report
const reportPath = path.resolve(reportOutPath);
ensureDir(path.dirname(reportPath));
{
  // County summary metrics
  let overCap = 0;
  let underSeed = 0;
  if (typeof countySizeArr !== "undefined") {
    for (let c = 0; c < countySizeArr.length; c++) {
      if (countySizeArr[c] > cap) overCap++;
      if (countySizeArr[c] < seed_quota) underSeed++;
    }
  }


  const computeRemaskBorderQuality = () => {
    const dirs = defaultNeighborDirs();
    const selected = new Uint8Array(hexes.length);
    for (let i = 0; i < hexes.length; i++) {
      const h = hexes[i];
      if (h?.tile_kind === "land" && h?.county_id) selected[i] = 1;
    }

    const straightPairs = (i) => {
      const q0 = i % width;
      const r0 = Math.floor(i / width);
      let s0 = 0;
      for (let k = 0; k < 3; k++) {
        const a = dirs[k];
        const b = dirs[k + 3];
        const aq = q0 + a.dq;
        const ar = r0 + a.dr;
        const bq = q0 + b.dq;
        const br = r0 + b.dr;
        const aSel = inBounds(aq, ar, width, height) ? (selected[indexOf(aq, ar, width)] === 1) : false;
        const bSel = inBounds(bq, br, width, height) ? (selected[indexOf(bq, br, width)] === 1) : false;
        if (aSel && bSel) s0++;
      }
      return s0;
    };

    let borderTiles = 0;
    let inlandBorderTiles = 0;
    let riverAdj = 0;
    let fordAdj = 0;
    let ridgeAdj = 0;
    let highStraightTiles = 0;

    for (let i = 0; i < hexes.length; i++) {
      if (selected[i] !== 1) continue;
      const h = hexes[i];
      const q0 = h.q;
      const r0 = h.r;
      let touchesNonPrimary = false;
      let touchesSea = false;
      let inland = true;
      for (const d of dirs) {
        const nq = q0 + d.dq;
        const nr = r0 + d.dr;
        if (!inBounds(nq, nr, width, height)) continue;
        const ni = indexOf(nq, nr, width);
        const nh = hexes[ni];
        if (!nh) continue;
        if (nh.tile_kind === "sea") {
          touchesSea = true;
          inland = false;
        }
        if (selected[ni] === 0 && nh.tile_kind !== "void") touchesNonPrimary = true;
      }
      if (!touchesNonPrimary) continue;
      borderTiles++;
      if (inland) inlandBorderTiles++;
      if (straightPairs(i) >= 2) highStraightTiles++;

      if (frontierRiverMask?.[i] === 1) {
        riverAdj++;
        if (frontierRiverFordMask?.[i] === 1) fordAdj++;
      }
      if (frontierRidgeMask?.[i] === 1) ridgeAdj++;
    }

    const cfg = config?.mapgen?.remask?.acceptance ?? {};
    const maxHighStraightShare = Number.isFinite(Number(cfg?.max_high_straight_share)) ? Number(cfg.max_high_straight_share) : 0.28;
    const minRiverAdjShare = Number.isFinite(Number(cfg?.min_river_adj_share)) ? Number(cfg.min_river_adj_share) : 0.06;
    const maxRidgeAdjShare = Number.isFinite(Number(cfg?.max_ridge_adj_share)) ? Number(cfg.max_ridge_adj_share) : 0.42;

    const highStraightShare = borderTiles > 0 ? (highStraightTiles / borderTiles) : 0;
    const riverAdjShare = inlandBorderTiles > 0 ? (riverAdj / inlandBorderTiles) : 0;
    const ridgeAdjShare = inlandBorderTiles > 0 ? (ridgeAdj / inlandBorderTiles) : 0;

    return {
      border_tiles: borderTiles,
      inland_border_tiles: inlandBorderTiles,
      high_straight_tiles: highStraightTiles,
      high_straight_share: Number(highStraightShare.toFixed(4)),
      river_adj_tiles: riverAdj,
      river_adj_share: Number(riverAdjShare.toFixed(4)),
      ford_adj_tiles: fordAdj,
      ridge_adj_tiles: ridgeAdj,
      ridge_adj_share: Number(ridgeAdjShare.toFixed(4)),
      acceptance: {
        max_high_straight_share: maxHighStraightShare,
        min_river_adj_share: minRiverAdjShare,
        max_ridge_adj_share: maxRidgeAdjShare,
      },
      pass: (
        highStraightShare <= maxHighStraightShare &&
        riverAdjShare >= minRiverAdjShare &&
        ridgeAdjShare <= maxRidgeAdjShare
      ),
    };
  };

  const borderQuality = computeRemaskBorderQuality();

  // Coast metrics (from breaker if present; otherwise compute)
  const coastMetrics = (typeof coastBreakReport !== "undefined" && coastBreakReport)
    ? coastBreakReport
    : computeCoastStraightRunMetrics({ tiles: hexes, width, height, maxRun: Number(config?.mapgen?.coast?.max_straight_run ?? 8) });

  writeJson(reportPath, {
    generated_at: new Date().toISOString(),
    map_out: outPath,
    public_out: publicOut,
    seed,
		remask: remaskSummary,
    terrain_hydro: terrainHydroSummary,
    config_path: configPath,
    config_sha256: map.config_sha256,
    metrics_path: metricsPath,
    border_quality: borderQuality,
    coast: {
      max_straight_run_overall: coastMetrics.max_straight_run_overall ?? null,
      max_straight_run_by_dir: coastMetrics.max_straight_run_by_dir ?? null,
      coast_breaks_applied: coastMetrics.coast_breaks_applied ?? 0,
      warning_unmet: coastMetrics.warning_unmet ?? false
    },
    macro: {
      style: typeof macroStyleId !== "undefined" ? macroStyleId : null,
      max_divider_cost: typeof macroMaxCost !== "undefined" ? macroMaxCost : null,
      params: (typeof macroDebug !== "undefined" && macroDebug?.params) ? macroDebug.params : null
    },
    counties: {
      min: typeof countyMin !== "undefined" ? countyMin : null,
      max: typeof countyMax !== "undefined" ? countyMax : null,
      avg: typeof countyAvg !== "undefined" ? countyAvg : null,
      counties_over_cap: overCap,
      counties_under_seed_quota: underSeed,
      unassigned_land: typeof unassigned_land !== "undefined" ? unassigned_land : null,
      cap,
      seed_quota,
      mu,
      alpha: alphaQuota
    }
  });
}

console.log(`map:gen OK — wrote ${outPath} and ${publicOut}`);
if (metricsPath) {
  console.log(`metrics: ${metricsPath}`);
}
