/**
 * County v2 (Patch B)
 *
 * Seat-first selection + capacity-constrained multi-source growth using a global priority queue.
 *
 * Goals:
 * - One seat per county (15)
 * - Counties grown to exact target sizes by construction (no rebalance transfers)
 * - Soft boundaries via river/mountain crossing penalties + terrain entry costs
 * - Deterministic tie-break ordering: score → county_id → hex_id → RNG
 */

import { hashStringToU32, axialDist } from "./mapLibV1.mjs";

function mixU32(x) {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function hashU32(seedU32, a, b, c) {
  let x = (seedU32 ^ (a + 0x9e3779b9)) >>> 0;
  x = mixU32(x ^ (b >>> 0));
  x = mixU32(x ^ (c >>> 0));
  return x >>> 0;
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
    if (a.length === 0) return null;
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

function clamp01(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

function terrainPenalty(t) {
  switch (t) {
    case "marsh":
      return 1.0;
    case "mountains":
      return 1.0;
    case "hills":
      return 0.25;
    case "forest":
      return 0.35;
    default:
      return 0.0;
  }
}

function isCoastLand(hex, neighbors) {
  if (hex.tile_kind !== "land") return false;
  for (const nb of neighbors) {
    if (nb.tile_kind === "sea") return true;
  }
  return false;
}

/**
 * Seat viability scoring (B1).
 * Returns seat indices (hex array indices) length seatCount.
 */
export function pickSeatsV2({
  width,
  height,
  hexes,
  landIdx,
  neighborIdxs,
  distToVoid,
  distToMajorRiver,
  macroDividerCost = null,
  macroMaxCost = null,
  weights,
  alpha = 0.15,
  beta = 0.85,
  seatCount = 15,
  seed,
  partition = { bins_q: 4, bins_r: 4 },
  core = { use_core_bounds: true },
  minSeatDist = 0
}) {
  // Deterministic seat selection with strong spacing + optional core bounds partitioning.
  const seedU32 = hashStringToU32(`${seed}|seats_v2`);

  // Normalize distances
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
    const nbs = neighborIdxs(i).map((j) => hexes[j]);

    const interior = (distToVoid[i] ?? 0) / maxInterior;
    const notCoast = isCoastLand(h, nbs) ? 0.0 : 1.0;
    const terr = 1.0 - terrainPenalty(h.terrain);

    // River bonus: prefer near major river
    const river = 1.0 - ((distToMajorRiver[i] ?? maxRiverDist) / maxRiverDist);

    // Macro avoid: prefer being away from major dividers (ridges/escarpments).
    // 1.0 = safest/cheapest; 0.0 = on strongest divider.
    let macroAvoid = 1.0;
    if (macroDividerCost && Number.isFinite(Number(macroMaxCost)) && Number(macroMaxCost) > 0) {
      const mc = Number(macroDividerCost[i] ?? 0);
      macroAvoid = 1.0 - clamp01(mc / Number(macroMaxCost));
    }

    return (
      (weights.w_interior ?? 0.3) * interior +
      (weights.w_not_coast ?? 0.25) * notCoast +
      (weights.w_terrain ?? 0.25) * terr +
      (weights.w_river_bonus ?? 0.2) * river +
      (weights.w_macro_avoid ?? 0.0) * macroAvoid
    );
  };

  const jitter = (i, k) => (hashU32(seedU32, i, k, 999) / 0xffffffff) * 1e-6;

  // Core bounds: land > non-land by q/r stripes
  let qMin = 0, qMax = width - 1, rMin = 0, rMax = height - 1;
  if (core?.use_core_bounds) {
    const qGood = [];
    for (let q = 0; q < width; q++) {
      let land = 0, non = 0;
      for (let r = 0; r < height; r++) {
        const idx = r * width + q;
        const tk = hexes[idx]?.tile_kind;
        if (tk === "land") land++;
        else if (tk === "sea" || tk === "void") non++;
      }
      if (land > non) qGood.push(q);
    }
    const rGood = [];
    for (let r = 0; r < height; r++) {
      let land = 0, non = 0;
      for (let q = 0; q < width; q++) {
        const idx = r * width + q;
        const tk = hexes[idx]?.tile_kind;
        if (tk === "land") land++;
        else if (tk === "sea" || tk === "void") non++;
      }
      if (land > non) rGood.push(r);
    }
    if (qGood.length) { qMin = qGood[0]; qMax = qGood[qGood.length - 1]; }
    if (rGood.length) { rMin = rGood[0]; rMax = rGood[rGood.length - 1]; }
  }

  const binsQ = Math.max(1, Math.floor(partition?.bins_q ?? 4));
  const binsR = Math.max(1, Math.floor(partition?.bins_r ?? 4));
  const qSpan = Math.max(1, (qMax - qMin + 1));
  const rSpan = Math.max(1, (rMax - rMin + 1));

  const binOf = (q, r) => {
    const bq = Math.min(binsQ - 1, Math.floor(((q - qMin) / qSpan) * binsQ));
    const br = Math.min(binsR - 1, Math.floor(((r - rMin) / rSpan) * binsR));
    return br * binsQ + bq;
  };

  const bestPerBin = new Map();
  for (const i of landIdx) {
    const h = hexes[i];
    const q = h.q, r = h.r;
    if (q < qMin || q > qMax || r < rMin || r > rMax) continue;
    const b = binOf(q, r);
    const s = viability(i) + jitter(i, 17);
    const cur = bestPerBin.get(b);
    if (!cur || s > cur.score) bestPerBin.set(b, { i, score: s });
  }

  const chosen = [];
  const chosenSet = new Set();
  let curMinSeatDist = Math.max(0, Math.floor(Number(minSeatDist ?? 0)));

  // Deterministic: higher score first, then idx
  const binSeats = Array.from(bestPerBin.values()).sort((a, b) => (b.score - a.score) || (a.i - b.i));
  for (const it of binSeats) {
    if (chosen.length >= seatCount) break;
    if (curMinSeatDist > 0 && chosen.length) {
      let minD = Infinity;
      for (const c of chosen) {
        const d = axialDist(hexes[it.i].q, hexes[it.i].r, hexes[c].q, hexes[c].r);
        if (d < minD) minD = d;
      }
      if (minD < curMinSeatDist) continue;
    }
    chosen.push(it.i);
    chosenSet.add(it.i);
  }

  // Fill remaining seats with spacing-first greedy
  const maxDistNorm = Math.max(1, Math.floor((width + height) / 2));

  while (chosen.length < seatCount) {
    let pick = null;
    let pickScore = -Infinity;

    for (const i of landIdx) {
      if (chosenSet.has(i)) continue;

      let minD = Infinity;
      for (const c of chosen) {
        const d = axialDist(hexes[i].q, hexes[i].r, hexes[c].q, hexes[c].r);
        if (d < minD) minD = d;
      }
      if (curMinSeatDist > 0 && minD < curMinSeatDist) continue;
      const dNorm = clamp01(minD / maxDistNorm);
      const v = viability(i);
      const score = alpha * v + beta * dNorm + jitter(i, chosen.length);

      if (score > pickScore) {
        pickScore = score;
        pick = i;
      }
    }

    if (pick == null) {
      if (curMinSeatDist > 0) {
        curMinSeatDist -= 1;
        continue;
      }
      break;
    }
    chosen.push(pick);
    chosenSet.add(pick);
  }

  return chosen;
}

function minRadiusForCount(targetCount) {
  const t = Math.max(1, Number(targetCount ?? 1));
  let r = 0;
  while (1 + 3 * r * (r + 1) < t) r++;
  return r;
}

export function ensureSeatViability({
  seatsIdx,
  landIdx,
  landIdxSet,
  neighborIdxs,
  hexes,
  width,
  height,
  seed,
  radiusBase = 6,
  seedQuota,
  floorMinReach = 25,
  protectedIdxSet,
  basinId = null
}) {
  const minReach = Math.max(Number(seedQuota ?? 0), Number(floorMinReach ?? 0));
  const radiusEffective = Math.max(Number(radiusBase ?? 6), minRadiusForCount(minReach));

  const blocked = new Set(protectedIdxSet ? Array.from(protectedIdxSet) : []);

  const reachableAvailable = (startIdx) => {
    if (!landIdxSet.has(startIdx)) return 0;
    const b0 = basinId ? basinId[startIdx] : null;

    const q = [startIdx];
    let qi = 0;
    const depth = new Map([[startIdx, 0]]);
    const seen = new Set([startIdx]);

    let count = 0;
    while (qi < q.length) {
      const cur = q[qi++];
      const d = depth.get(cur) ?? 0;
      if (d > radiusEffective) continue;

      if (cur !== startIdx && blocked.has(cur)) continue;
      count++;

      if (d === radiusEffective) continue;
      for (const nb of neighborIdxs(cur)) {
        if (!landIdxSet.has(nb)) continue;
        if (b0 != null && b0 >= 0 && basinId && basinId[nb] !== b0) continue;
        if (seen.has(nb)) continue;
        if (nb !== startIdx && blocked.has(nb)) continue;
        seen.add(nb);
        depth.set(nb, d + 1);
        q.push(nb);
      }
    }

    return count;
  };

  const finalizeSeat = (idx) => {
    blocked.add(idx);
    for (const nb of neighborIdxs(idx)) blocked.add(nb);
  };

  const out = [];

  for (let ci = 0; ci < seatsIdx.length; ci++) {
    const s0 = seatsIdx[ci];
    let chosen = null;

    const ok = landIdxSet.has(s0) && !blocked.has(s0) && reachableAvailable(s0) >= minReach;
    if (ok) {
      chosen = s0;
    } else {
      const baseQ = hexes[s0].q;
      const baseR = hexes[s0].r;

      const candidates = [];
      for (const idx of landIdx) {
        if (!landIdxSet.has(idx)) continue;
        if (blocked.has(idx)) continue;
        if (basinId && basinId[s0] != null && basinId[s0] >= 0 && basinId[idx] !== basinId[s0]) continue;
        const d = axialDist(hexes[idx].q, hexes[idx].r, baseQ, baseR);
        candidates.push([d, idx]);
      }
      candidates.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));

      for (const [, idx] of candidates) {
        if (reachableAvailable(idx) >= minReach) { chosen = idx; break; }
      }
    }

    if (chosen == null) {
      throw new Error(`Seat viability relocation failed for countyIndex=${ci}: no viable land hex found (minReach=${minReach}, radius=${radiusEffective}).`);
    }

    out.push(chosen);
    finalizeSeat(chosen);
  }

  if (new Set(out).size !== out.length) {
    throw new Error(`Seat uniqueness violated after relocation (unique=${new Set(out).size}, seats=${out.length}).`);
  }

  return { seatsIdx: out, minReach, radiusEffective };
}

/**
 * Seat repair pass (M3): after an initial cost-Voronoi assignment, relocate
 * any seats whose resulting counties fall below a minimum size.
 *
 * This is deliberately conservative:
 * - deterministic candidate scoring + stable ties
 * - preserves seat count (no merges)
 * - respects minSeatDist and protected tiles
 * - bounded number of passes
 */
export function repairSeatsForMinCountySizeCostVoronoi({
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
  basinId = null,
  seatsIdx,
  countyIds,
  seed,
  minSeatDist = 0,
  minCountySize = 100,
  maxPasses = 2,
  protectedIdxSet = null,
  weights = {
    w_interior: 0.30,
    w_not_coast: 0.25,
    w_terrain: 0.25,
    w_river_bonus: 0.15,
    w_macro_avoid: 0.05
  },
  alpha = 0.15,
  beta = 0.85
}) {
  const n = seatsIdx.length;
  if (n <= 0) return { seatsIdx, passes: 0, repaired: false };
  const minSize = Math.max(1, Math.floor(Number(minCountySize ?? 1)));
  const passes = Math.max(0, Math.floor(Number(maxPasses ?? 0)));

  // Normalize distances for scoring.
  let maxInterior = 1;
  let maxRiverDist = 1;
  for (const i of landIdx) {
    const dv = distToVoid?.[i] ?? 0;
    const dr = distToMajorRiver?.[i] ?? 0;
    if (dv > maxInterior) maxInterior = dv;
    if (dr > maxRiverDist) maxRiverDist = dr;
  }

  const seedU32 = hashStringToU32(`${seed}|seat_repair_min_county_v1`);

  const jitter = (i, k) => (hashU32(seedU32, i, k, 424242) / 0xffffffff) * 1e-6;

  const viability = (i) => {
    const h = hexes[i];
    const nbs = neighborIdxs(i).map((j) => hexes[j]);
    const interior = (distToVoid?.[i] ?? 0) / maxInterior;
    const notCoast = isCoastLand(h, nbs) ? 0.0 : 1.0;
    const terr = 1.0 - terrainPenalty(h.terrain);
    const river = 1.0 - ((distToMajorRiver?.[i] ?? maxRiverDist) / maxRiverDist);
    let macroAvoid = 1.0;
    if (macroDividerCost && Number.isFinite(Number(macroMaxCost)) && Number(macroMaxCost) > 0) {
      const mc = Number(macroDividerCost[i] ?? 0);
      macroAvoid = 1.0 - clamp01(mc / Number(macroMaxCost));
    }
    return (
      (weights.w_interior ?? 0.3) * interior +
      (weights.w_not_coast ?? 0.25) * notCoast +
      (weights.w_terrain ?? 0.25) * terr +
      (weights.w_river_bonus ?? 0.15) * river +
      (weights.w_macro_avoid ?? 0.0) * macroAvoid
    );
  };

  const maxDistNorm = Math.max(1, Math.floor((width + height) / 2));

  const protect = new Set(protectedIdxSet ? Array.from(protectedIdxSet) : []);

  const pickReplacement = (excludeCounty, curSeats) => {
    let curMin = Math.max(0, Math.floor(Number(minSeatDist ?? 0)));

    // Precompute seats excluding the one being replaced.
    const others = [];
    for (let c = 0; c < curSeats.length; c++) {
      if (c === excludeCounty) continue;
      others.push(curSeats[c]);
    }

    const isSeat = new Set(curSeats);

    // Avoid placing seats on extreme divider peaks (strong ridges/escarpments)
    // unless there is no alternative.
    const avoidDivider = (macroDividerCost && Number.isFinite(Number(macroMaxCost)) && Number(macroMaxCost) > 0)
      ? Math.floor(Number(macroMaxCost) * 0.85)
      : null;

    for (;;) {
      let bestIdx = null;
      let bestScore = -Infinity;

      for (const i of landIdx) {
        if (!landIdxSet.has(i)) continue;
        if (protect.has(i)) continue;
        if (isSeat.has(i)) continue;
        if (basinId && basinId[curSeats[excludeCounty]] != null && basinId[curSeats[excludeCounty]] >= 0 && basinId[i] !== basinId[curSeats[excludeCounty]]) continue;
        if (avoidDivider != null && Number(macroDividerCost?.[i] ?? 0) >= avoidDivider) continue;

        let minD = Infinity;
        for (const s of others) {
          const d = axialDist(hexes[i].q, hexes[i].r, hexes[s].q, hexes[s].r);
          if (d < minD) minD = d;
        }
        if (curMin > 0 && minD < curMin) continue;
        const dNorm = clamp01(minD / maxDistNorm);
        const v = viability(i);
        const score = alpha * v + beta * dNorm + jitter(i, excludeCounty);
        if (score > bestScore || (score === bestScore && bestIdx != null && i < bestIdx)) {
          bestScore = score;
          bestIdx = i;
        }
      }

      if (bestIdx != null) return bestIdx;

      // Deterministic relaxation
      if (curMin > 0) {
        curMin -= 1;
        continue;
      }

      // Absolute fallback: pick any unprotected land tile not already a seat.
      for (const i of landIdx) {
        if (!landIdxSet.has(i)) continue;
        if (protect.has(i)) continue;
        if (isSeat.has(i)) continue;
        if (basinId && basinId[curSeats[excludeCounty]] != null && basinId[curSeats[excludeCounty]] >= 0 && basinId[i] !== basinId[curSeats[excludeCounty]]) continue;
        return i;
      }
      return curSeats[excludeCounty];
    }
  };

  let curSeats = seatsIdx.slice();
  let repaired = false;

  // Deterministic center for loop order ranking.
  const centerQ = Math.floor(width / 2);
  const centerR = Math.floor(height / 2);

  for (let pass = 0; pass < passes; pass++) {
    const loopOrder = deriveCountyLoopOrder({ seatsIdx: curSeats, hexes, centerQ, centerR, countyIds });

    const { countySize, min } = assignCountiesCostVoronoi({
      width,
      height,
      hexes,
      landIdxSet,
      neighborIdxs,
      seatsIdx: curSeats,
      countyIds,
      loopOrder,
      dividerCost: macroDividerCost,
      dividerMaxCost: macroMaxCost,
      basinId,
      protectedIdxSet: protect,
      smooth: { passes: 0 }
    });

    if (min >= minSize) break;

    // Collect bad counties (size < minSize), smallest first.
    const bad = [];
    for (let c = 0; c < n; c++) {
      const s = countySize[c] ?? 0;
      if (s < minSize) bad.push({ c, s });
    }
    bad.sort((a, b) => (a.s - b.s) || (a.c - b.c));

    for (const it of bad) {
      const c = it.c;
      const repl = pickReplacement(c, curSeats);
      if (repl !== curSeats[c]) {
        curSeats[c] = repl;
        repaired = true;
      }
    }
  }

  return { seatsIdx: curSeats, passes, repaired };
}

export function deriveCountyLoopOrder({ seatsIdx, hexes, centerQ, centerR, countyIds }) {
  const order = countyIds.map((cid, i) => {
    const s = seatsIdx[i];
    const d = axialDist(hexes[s].q, hexes[s].r, centerQ, centerR);
    return { cid, i, d };
  });
  order.sort((a, b) => (a.d - b.d) || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  return order.map((x) => x.i);
}

export function computeCountyTargetsEqualSplit({ landCount, countyCount, loopOrder }) {
  const base = Math.floor(landCount / countyCount);
  const rem = landCount - base * countyCount;
  const targets = new Array(countyCount).fill(base);
  for (let k = 0; k < rem; k++) {
    const ci = loopOrder[k % loopOrder.length];
    targets[ci] += 1;
  }
  return targets;
}

function ringCoords(centerQ, centerR, radius) {
  if (radius === 0) return [{ q: centerQ, r: centerR }];
  const dirs = [
    { dq: 1, dr: 0 },
    { dq: 1, dr: -1 },
    { dq: 0, dr: -1 },
    { dq: -1, dr: 0 },
    { dq: -1, dr: 1 },
    { dq: 0, dr: 1 }
  ];
  let q = centerQ + dirs[3].dq * radius;
  let r = centerR + dirs[3].dr * radius;
  const out = [];
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      out.push({ q, r });
      q += dirs[side].dq;
      r += dirs[side].dr;
    }
  }
  return out;
}

export function assignCountiesSpiralCaps({
  width,
  height,
  hexes,
  landIdxSet,
  neighborIdxs,
  seatsIdx,
  countyIds,
  targets,
  cap,
  capHard = null,
  seedQuota,
  loopOrder
}) {
  const n = countyIds.length;
  const capSoft = Number(cap);
  const capHardEff = Number.isInteger(capHard) ? Number(capHard) : capSoft;

  const assignedCounty = new Int16Array(hexes.length);
  assignedCounty.fill(-1);
  const countySize = new Int32Array(n);

  // Track tiles per county to support deterministic rebalancing in fallback.
  const countyTiles = Array.from({ length: n }, () => new Set());
  const isSeatIdx = new Uint8Array(hexes.length);

  // Scratch for connectivity checks (avoid Set allocations inside tight loops).
  const visitMark = new Int32Array(hexes.length);
  let visitEpoch = 1;

  for (let c = 0; c < n; c++) {
    const s = seatsIdx[c];
    assignedCounty[s] = c;
    countySize[c] = 1;
    countyTiles[c].add(s);
    isSeatIdx[s] = 1;
  }

  const frontier = Array.from({ length: n }, () => new Set());
  const pushFrontier = (c, idx) => {
    for (const nb of neighborIdxs(idx)) {
      if (!landIdxSet.has(nb)) continue;
      if (assignedCounty[nb] !== -1) continue;
      frontier[c].add(nb);
    }
  };
  for (let c = 0; c < n; c++) pushFrontier(c, seatsIdx[c]);

  // Selection heuristic:
  // Prefer “constrained” frontier tiles first to avoid creating unassignable pockets.
  // Constrained = fewer alternate adjacent counties that are still under-cap.
  // Tie-break: altCount → distToSeat → idx.
  const nextClaim = (c) => {
    const seat = seatsIdx[c];
    const sq = hexes[seat].q;
    const sr = hexes[seat].r;
    let best = null;
    let bestAlt = null;
    let bestD = null;

    for (const idx of frontier[c]) {
      if (assignedCounty[idx] !== -1) continue;

      // Must remain contiguous.
      let ok = false;
      const altSet = new Set();
      for (const nb of neighborIdxs(idx)) {
        const oc = assignedCounty[nb];
        if (oc === c) ok = true;
        if (oc !== -1 && oc !== c && countySize[oc] < capSoft) altSet.add(oc);
      }
      if (!ok) continue;

      const alt = altSet.size;
      const d = axialDist(hexes[idx].q, hexes[idx].r, sq, sr);
      if (
        best == null ||
        alt < bestAlt ||
        (alt === bestAlt && (d < bestD || (d === bestD && idx < best)))
      ) {
        best = idx;
        bestAlt = alt;
        bestD = d;
      }
    }
    return best;
  };

  const wantSeed = new Array(n).fill(0).map((_, c) => Math.min(seedQuota, targets[c], cap));

  // Phase 1: fair seeding (round-robin) until each county reaches seedQuota (or cap/target).
  // This avoids late-loop starvation where early counties steal the entire local basin.
  const anyUnderSeed = () => loopOrder.some((c) => countySize[c] < wantSeed[c] && countySize[c] < capSoft);
  while (anyUnderSeed()) {
    let progressed = false;
    for (const c of loopOrder) {
      const maxNeed = wantSeed[c];
      if (countySize[c] >= maxNeed || countySize[c] >= capSoft) continue;
      const idx = nextClaim(c);
      if (idx == null) continue;
      assignedCounty[idx] = c;
      countySize[c] += 1;
      if (countySize[c] > cap) throw new Error(`Hard cap exceeded in Phase1: county=${countyIds[c]} size=${countySize[c]} cap=${cap}`);
      countyTiles[c].add(idx);
      pushFrontier(c, idx);
      progressed = true;
    }
    if (!progressed) break;
  }

  const landTotal = landIdxSet.size;
  const anyUnder = () => loopOrder.some((c) => countySize[c] < targets[c] && countySize[c] < capSoft);

  const recomputeUnassigned = () => {
    let c = 0;
    for (const idx of landIdxSet) if (assignedCounty[idx] === -1) c++;
    return c;
  };

  // Phase 2: round-robin batch=1
  let unassigned = recomputeUnassigned();
  while (unassigned > 0 && anyUnder()) {
    let progressed = false;
    for (const c of loopOrder) {
      if (countySize[c] >= targets[c] || countySize[c] >= capSoft) continue;
      const idx = nextClaim(c);
      if (idx == null) continue;
      assignedCounty[idx] = c;
      countySize[c] += 1;
      if (countySize[c] > cap) throw new Error(`Hard cap exceeded in Phase2: county=${countyIds[c]} size=${countySize[c]} cap=${cap}`);
      countyTiles[c].add(idx);
      pushFrontier(c, idx);
      unassigned -= 1;
      progressed = true;
      if (unassigned <= 0) break;
    }
    if (!progressed) break;
  }

  // Phase 3: if land remains unassigned (often because some counties are boxed-in
  // below target), continue claiming using *all* under-cap counties.
  // We iterate least-filled first to distribute remainder and avoid cap-saturating
  // a single county that may be the sole neighbor of a pocket.
  if (unassigned > 0) {
    const loopRank = new Int16Array(n);
    loopRank.fill(0);
    for (let k = 0; k < loopOrder.length; k++) loopRank[loopOrder[k]] = k;

    const anyCanClaim = () => {
      for (let c = 0; c < n; c++) {
        if (countySize[c] >= capSoft) continue;
        if (nextClaim(c) != null) return true;
      }
      return false;
    };

    while (unassigned > 0 && anyCanClaim()) {
      // Stable dynamic order: smallest counties first, tie-break by loop order.
      const order = Array.from({ length: n }, (_, c) => c);
      order.sort((a, b) => (countySize[a] - countySize[b]) || (loopRank[a] - loopRank[b]) || (a - b));

      let progressed = false;
      for (const c of order) {
        if (unassigned <= 0) break;
        if (countySize[c] >= capSoft) continue;
        const idx = nextClaim(c);
        if (idx == null) continue;
        assignedCounty[idx] = c;
        countySize[c] += 1;
        if (countySize[c] > cap) throw new Error(`Hard cap exceeded in Phase3: county=${countyIds[c]} size=${countySize[c]} cap=${cap}`);
        countyTiles[c].add(idx);
        pushFrontier(c, idx);
        unassigned -= 1;
        progressed = true;
      }
      if (!progressed) break;
    }
  }

  // Fallback: adjacent under-cap only; if none adjacent, attempt deterministic bridge through unassigned land
  if (unassigned > 0) {
    const remaining = [];
    for (const idx of landIdxSet) if (assignedCounty[idx] === -1) remaining.push(idx);
    remaining.sort((a, b) => a - b);

    // --- Capacity relief (fallback only) ---
    // If we encounter an unassigned pocket that is only adjacent to capped counties,
    // we deterministically "make room" by transferring a boundary tile from a capped
    // county to a neighboring under-cap county (preserving contiguity).
    const minDonorSize = Math.max(2, Math.min(seedQuota, cap));

    const degreeInCounty = (idx, c) => {
      let k = 0;
      for (const nb of neighborIdxs(idx)) if (assignedCounty[nb] === c) k++;
      return k;
    };

    const canRemoveWithoutDisconnect = (donor, removeIdx) => {
      if (isSeatIdx[removeIdx]) return false;
      if (countySize[donor] - 1 < minDonorSize) return false;

      // Leaf tiles (deg <= 1) are always safe to remove.
      const deg = degreeInCounty(removeIdx, donor);
      if (deg <= 1) return true;

      // Connectivity check via BFS from the donor's seat.
      const start = seatsIdx[donor];
      if (start === removeIdx) return false;
      visitEpoch += 1;
      const epoch = visitEpoch;
      const stack = [start];
      visitMark[start] = epoch;
      let seen = 0;
      while (stack.length) {
        const cur = stack.pop();
        seen += 1;
        for (const nb of neighborIdxs(cur)) {
          if (nb === removeIdx) continue;
          if (assignedCounty[nb] !== donor) continue;
          if (visitMark[nb] === epoch) continue;
          visitMark[nb] = epoch;
          stack.push(nb);
        }
      }
      return seen === (countySize[donor] - 1);
    };

    const doTransfer = ({ idx, from, to }) => {
      // Preconditions:
      if (assignedCounty[idx] !== from) throw new Error(`Internal: transfer idx not owned by donor (idx=${idx} from=${from} got=${assignedCounty[idx]})`);
      if (countySize[to] >= capHardEff) throw new Error(`Internal: transfer receiver already at cap (to=${to} size=${countySize[to]} cap=${cap})`);

      assignedCounty[idx] = to;
      countySize[from] -= 1;
      countySize[to] += 1;
      countyTiles[from].delete(idx);
      countyTiles[to].add(idx);
      if (countySize[to] > capHardEff) throw new Error(`Hard cap exceeded in Transfer: county=${countyIds[to]} size=${countySize[to]} cap=${cap}`);
    };

    const undoTransfer = ({ idx, from, to }) => {
      if (assignedCounty[idx] !== to) throw new Error(`Internal: undo idx not owned by receiver (idx=${idx} to=${to} got=${assignedCounty[idx]})`);
      assignedCounty[idx] = from;
      countySize[from] += 1;
      countySize[to] -= 1;
      countyTiles[to].delete(idx);
      countyTiles[from].add(idx);
    };

    // Deterministic ordering helper: county loop rank derived from final seats.
    const loopRank = new Int16Array(n);
    loopRank.fill(0);
    for (let k = 0; k < loopOrder.length; k++) loopRank[loopOrder[k]] = k;

    const countyNeighborList = (c) => {
      const s = new Set();
      for (const idx of countyTiles[c]) {
        for (const nb of neighborIdxs(idx)) {
          const oc = assignedCounty[nb];
          if (oc === -1 || oc === c) continue;
          s.add(oc);
        }
      }
      const out = Array.from(s);
      out.sort((a, b) => (loopRank[a] - loopRank[b]) || (a - b));
      return out;
    };

    // Pick a single tile transfer move from `from` → `to` (does not execute).
    // Receiver cap is not checked here because in chain-transfers the receiver is
    // guaranteed to be under-cap at execution time.
    const pickTransferMove = (from, to) => {
      if (from === to) return null;
      if (countySize[from] - 1 < minDonorSize) return null;

      const fromSeat = seatsIdx[from];
      const fsq = hexes[fromSeat].q;
      const fsr = hexes[fromSeat].r;
      const toSeat = seatsIdx[to];
      const tsq = hexes[toSeat].q;
      const tsr = hexes[toSeat].r;

      const candidates = [];
      for (const idx of countyTiles[from]) {
        if (isSeatIdx[idx]) continue;

        let adjacent = false;
        for (const nb of neighborIdxs(idx)) {
          if (assignedCounty[nb] === to) { adjacent = true; break; }
        }
        if (!adjacent) continue;

        const deg = degreeInCounty(idx, from);
        const distFrom = axialDist(hexes[idx].q, hexes[idx].r, fsq, fsr);
        const distTo = axialDist(hexes[idx].q, hexes[idx].r, tsq, tsr);
        candidates.push({ idx, from, to, deg, distFrom, distTo });
      }

      if (!candidates.length) return null;
      candidates.sort((a, b) =>
        (a.deg - b.deg) ||
        (b.distFrom - a.distFrom) ||
        (a.distTo - b.distTo) ||
        (a.idx - b.idx)
      );

      for (const mv of candidates) {
        if (!canRemoveWithoutDisconnect(from, mv.idx)) continue;
        return { idx: mv.idx, from: mv.from, to: mv.to };
      }
      return null;
    };

    // Direct relief: move 1 tile from `donor` into an adjacent *under-cap* county.
    // Executes the move and returns [move], or null.
    const makeRoomDirect = (donor) => {
      if (countySize[donor] - 1 < minDonorSize) return null;

      const donorSeat = seatsIdx[donor];
      const dsq = hexes[donorSeat].q;
      const dsr = hexes[donorSeat].r;

      const candidates = [];
      for (const idx of countyTiles[donor]) {
        if (isSeatIdx[idx]) continue;

        // Gather adjacent receiver counties that are under-cap.
        const recv = new Set();
        for (const nb of neighborIdxs(idx)) {
          const oc = assignedCounty[nb];
          if (oc === -1 || oc === donor) continue;
          if (countySize[oc] >= capHardEff) continue;
          recv.add(oc);
        }
        if (!recv.size) continue;

        const deg = degreeInCounty(idx, donor);
        const distDonor = axialDist(hexes[idx].q, hexes[idx].r, dsq, dsr);

        for (const to of recv) {
          const rSeat = seatsIdx[to];
          const distRecv = axialDist(hexes[idx].q, hexes[idx].r, hexes[rSeat].q, hexes[rSeat].r);
          candidates.push({ idx, from: donor, to, recvSize: countySize[to], recvRank: loopRank[to], deg, distDonor, distRecv });
        }
      }

      if (!candidates.length) return null;

      // Deterministic: prefer filling the smallest neighbor first; prefer leaf removals;
      // remove tiles far from donor seat; give tiles close to receiver seat.
      candidates.sort((a, b) =>
        (a.recvSize - b.recvSize) ||
        (a.recvRank - b.recvRank) ||
        (a.deg - b.deg) ||
        (b.distDonor - a.distDonor) ||
        (a.distRecv - b.distRecv) ||
        (a.idx - b.idx)
      );

      for (const mv of candidates) {
        if (!canRemoveWithoutDisconnect(donor, mv.idx)) continue;
        doTransfer(mv);
        return [{ idx: mv.idx, from: mv.from, to: mv.to }];
      }

      return null;
    };

    // Chain relief: push 1 tile from `start` through a sequence of counties to some county
    // that still has slack (< capHardEff). This frees 1 capacity in `start` without ever exceeding
    // cap in intermediate counties.
    const makeRoomViaChain = (start) => {
      if (countySize[start] - 1 < minDonorSize) return null;

      // Quick check: if no slack anywhere, impossible.
      let anySlack = false;
      for (let c = 0; c < n; c++) {
        if (c === start) continue;
        if (countySize[c] < capHardEff) { anySlack = true; break; }
      }
      if (!anySlack) return null;

      const maxDepth = n; // avoid cycles
      const queue = [[start]];
      for (let qi = 0; qi < queue.length; qi++) {
        const path = queue[qi];
        const cur = path[path.length - 1];

        // Success condition: reach a slack county (not the start).
        if (cur !== start && countySize[cur] < capHardEff) {
          const moves = [];
          let ok = true;
          // Execute transfers from end → start so receivers are guaranteed under-cap.
          for (let i = path.length - 2; i >= 0; i--) {
            const from = path[i];
            const to = path[i + 1];
            if (countySize[to] >= capHardEff) { ok = false; break; }
            const mv = pickTransferMove(from, to);
            if (!mv) { ok = false; break; }
            doTransfer(mv);
            moves.push(mv);
          }
          if (ok) return moves;
          for (let j = moves.length - 1; j >= 0; j--) undoTransfer(moves[j]);
        }

        if (path.length >= maxDepth) continue;

        // Expand along directed edges where the current county can donate 1 tile to neighbor.
        const nbs = countyNeighborList(cur);
        for (const nb of nbs) {
          if (path.includes(nb)) continue;
          if (!pickTransferMove(cur, nb)) continue;
          queue.push(path.concat([nb]));
        }
      }
      return null;
    };

    // Make 1 unit of room in `donor` (reduce size by 1), returning the list of executed transfers.
    const makeRoomUnit = (donor) => {
      const direct = makeRoomDirect(donor);
      if (direct) return direct;
      const chained = makeRoomViaChain(donor);
      if (chained) return chained;
      return null;
    };

    // Ensure `donor` has room for `needed` additional claims (i.e., reduce its size by `needed`).
    // Transactional: if we can't free enough, revert and return false.
    const ensureRoom = (donor, needed) => {
      if (needed <= 0) return true;
      const allMoves = [];
      for (let k = 0; k < needed; k++) {
        const unitMoves = makeRoomUnit(donor);
        if (!unitMoves) {
          for (let j = allMoves.length - 1; j >= 0; j--) undoTransfer(allMoves[j]);
          return false;
        }
        for (const mv of unitMoves) allMoves.push(mv);
      }
      return true;
    };

    const tryBridgeAssign = (startIdx) => {
      // BFS through unassigned land until we find a node adjacent to a county that can
      // absorb the whole bridge path. If the only adjacent counties are at cap, we will
      // deterministically make room by transferring boundary tiles out of that county.
      const q = [startIdx];
      const prev = new Map();
      prev.set(startIdx, -1);

      for (let qi = 0; qi < q.length; qi++) {
        const cur = q[qi];

        // Collect adjacent counties (cap-safe selection handled below)
        const candSet = new Set();
        for (const nb of neighborIdxs(cur)) {
          const c = assignedCounty[nb];
          if (c === -1) continue;
          candSet.add(c);
        }

        if (candSet.size) {
          // Path length from startIdx -> cur
          let pathLen = 1;
          for (let p = cur; p !== startIdx; ) {
            const pr = prev.get(p);
            if (pr == null || pr === -1) break;
            pathLen += 1;
            p = pr;
          }

          const uniq = Array.from(candSet);
          // Prefer counties that require the least "room making", then least-filled.
          uniq.sort((a, b) => {
            const needA = Math.max(0, countySize[a] + pathLen - capHardEff);
            const needB = Math.max(0, countySize[b] + pathLen - capHardEff);
            return (needA - needB) || (countySize[a] - countySize[b]) || (countyIds[a] < countyIds[b] ? -1 : 1);
          });

          // Pick the first county that can absorb the path, potentially after making room.
          let chosen = -1;
          for (const c of uniq) {
            const need = Math.max(0, countySize[c] + pathLen - capHardEff);
            if (!ensureRoom(c, need)) continue;
            if (countySize[c] + pathLen <= capHardEff) { chosen = c; break; }
          }

          if (chosen !== -1) {
            // Assign bridge path from cur back to startIdx so each step is contiguous to already assigned
            const path = [];
            for (let p = cur; p !== -1; p = prev.get(p)) {
              path.push(p);
              if (p === startIdx) break;
            }
            for (const p of path) {
              if (assignedCounty[p] !== -1) continue;
              assignedCounty[p] = chosen;
              countySize[chosen] += 1;
              if (countySize[chosen] > capHardEff) throw new Error(`Hard cap exceeded in Bridge: county=${countyIds[chosen]} size=${countySize[chosen]} cap=${cap}`);
              countyTiles[chosen].add(p);
              pushFrontier(chosen, p);
              unassigned -= 1;
            }
            return true;
          }
        }

        // Expand BFS through unassigned land only
        for (const nb of neighborIdxs(cur)) {
          if (!landIdxSet.has(nb)) continue;
          if (assignedCounty[nb] !== -1) continue;
          if (prev.has(nb)) continue;
          prev.set(nb, cur);
          q.push(nb);
        }
      }
      return false;
    };

    for (const idx of remaining) {
      if (assignedCounty[idx] !== -1) continue;

      const cand = [];
      for (const nb of neighborIdxs(idx)) {
        const c = assignedCounty[nb];
        if (c === -1) continue;
        if (countySize[c] >= capHardEff) continue;
        cand.push(c);
      }
      const uniq = Array.from(new Set(cand));
      uniq.sort((a, b) => (countySize[a] - countySize[b]) || (countyIds[a] < countyIds[b] ? -1 : 1));

      if (uniq.length) {
        const c = uniq[0];
        assignedCounty[idx] = c;
        countySize[c] += 1;
        if (countySize[c] > capHardEff) throw new Error(`Hard cap exceeded in Fallback: county=${countyIds[c]} size=${countySize[c]} cap=${cap}`);
        countyTiles[c].add(idx);
        pushFrontier(c, idx);
        unassigned -= 1;
        continue;
      }

      // No adjacent under-cap county: attempt bridge
      const ok = tryBridgeAssign(idx);
      if (!ok) {
        throw new Error(`Fallback+Bridge failed: unassigned land idx ${idx} has no path to any under-cap county.`);
      }
    }
  }


  // Assertions
  let min = Infinity, max = -Infinity, sum = 0;
  for (let c = 0; c < n; c++) {
    const s = countySize[c];
    if (s < min) min = s;
    if (s > max) max = s;
    sum += s;
    if (s > capHardEff) throw new Error(`Hard cap violated at end: county=${countyIds[c]} size=${s} cap=${cap}`);
    if (s === 1) throw new Error(`County ended size 1: county=${countyIds[c]} seatIdx=${seatsIdx[c]}`);
  }
  if (sum !== landTotal) throw new Error(`Total assignment mismatch: sum=${sum} land=${landTotal}`);

  return { assignedCounty, countySize, min, max, avg: sum / n, unassigned_land: 0 };
}

/**
 * County assignment v3 (M3): Cost-aware geodesic Voronoi on the land graph.
 *
 * - Uses multi-source Dijkstra where edge costs are derived from a per-tile
 *   "divider cost" field (macro skeleton).
 * - Produces connected regions by construction (each tile label is propagated
 *   from an already-labeled predecessor).
 * - No exact targets: sizes are allowed to vary; optional caps can be enforced
 *   post-pass if desired.
 */
export function assignCountiesCostVoronoi({
  width,
  height,
  hexes,
  landIdxSet,
  neighborIdxs,
  seatsIdx,
  countyIds,
  loopOrder,
  dividerCost,
  dividerMaxCost = 0,
  basinId = null,
  protectedIdxSet = null,
  smooth = {
    passes: 2,
    radius: 3,
    support_frac: 0.28,
    min_support: 8,
    protect_cost_frac: 0.70
  }
}) {
  const n = countyIds.length;
  const total = width * height;
  const INF = 0x3fffffff;

  if (!dividerCost) {
    throw new Error("assignCountiesCostVoronoi requires dividerCost");
  }

  // loopOrder gives a deterministic county precedence order; convert to rank.
  const rank = new Int16Array(n);
  rank.fill(0);
  for (let k = 0; k < loopOrder.length; k++) rank[loopOrder[k]] = k;

  const bestDist = new Int32Array(total);
  bestDist.fill(INF);
  const bestCounty = new Int16Array(total);
  bestCounty.fill(-1);

  const heap = new MinHeap((a, b) => {
    if (a.dist !== b.dist) return a.dist < b.dist ? -1 : 1;
    if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
    if (a.idx !== b.idx) return a.idx < b.idx ? -1 : 1;
    return 0;
  });

  // Initialize sources.
  // NOTE (M3.1): basinId is kept purely as a *debug/seat-balancing* signal.
  // County assignment is NOT hard-constrained to basins; macro dividers are
  // modeled as high traversal costs in the geodesic Voronoi field.
  for (let c = 0; c < n; c++) {
    const s = seatsIdx[c];
    bestDist[s] = 0;
    bestCounty[s] = c;
    heap.push({ dist: 0, rank: rank[c], idx: s, c });
  }

  const edgeCost = (aIdx, bIdx) => {
    // base step cost + average divider cost (integer)
    const ca = dividerCost[aIdx] ?? 0;
    const cb = dividerCost[bIdx] ?? 0;
    return 1 + ((ca + cb) >> 1);
  };

  while (heap.size > 0) {
    const cur = heap.pop();
    if (!cur) break;
    const idx = cur.idx;
    if (cur.dist !== bestDist[idx]) continue;
    if (cur.c !== bestCounty[idx]) continue;

    for (const nb of neighborIdxs(idx)) {
      if (!landIdxSet.has(nb)) continue;

      const nd = cur.dist + edgeCost(idx, nb);
      const cd = bestDist[nb];
      const cc = bestCounty[nb];
      if (nd < cd) {
        bestDist[nb] = nd;
        bestCounty[nb] = cur.c;
        heap.push({ dist: nd, rank: rank[cur.c], idx: nb, c: cur.c });
      } else if (nd === cd) {
        // Deterministic tie-break by county rank.
        if (cc === -1 || rank[cur.c] < rank[cc]) {
          bestCounty[nb] = cur.c;
          heap.push({ dist: nd, rank: rank[cur.c], idx: nb, c: cur.c });
        }
      }
    }
  }

  // Verify assignment + compute sizes.
  const assignedCounty = bestCounty;
  const countySize = new Int32Array(n);
  let unassigned = 0;
  for (let i = 0; i < total; i++) {
    if (!landIdxSet.has(i)) continue;
    const c = assignedCounty[i];
    if (c < 0 || c >= n) { unassigned++; continue; }
    countySize[c] += 1;
  }
  if (unassigned > 0) {
    throw new Error(`CostVoronoi failed: unassigned land tiles=${unassigned}`);
  }

  // Protected tiles: caller-provided protected set + seats + ring-1 around seats.
  // This set is used by both min-size enforcement and optional smoothing.
  const protect = new Set(protectedIdxSet ? Array.from(protectedIdxSet) : []);
  const dirs = [
    { dq: 1, dr: 0 },
    { dq: 1, dr: -1 },
    { dq: 0, dr: -1 },
    { dq: -1, dr: 0 },
    { dq: -1, dr: 1 },
    { dq: 0, dr: 1 }
  ];
  for (let c = 0; c < n; c++) {
    const s = seatsIdx[c];
    protect.add(s);
    const q0 = hexes[s].q;
    const r0 = hexes[s].r;
    for (const d of dirs) {
      const q1 = q0 + d.dq;
      const r1 = r0 + d.dr;
      if (q1 < 0 || q1 >= width || r1 < 0 || r1 >= height) continue;
      protect.add(r1 * width + q1);
    }
  }

  // Connectivity check helper used by both min-size enforcement and smoothing.
  const donorConnectedAfterRemoval = (county, removeIdx) => {
    if (countySize[county] <= 1) return false;
    const seat = seatsIdx[county];
    if (seat === removeIdx) return false;

    // BFS from seat over county tiles excluding removeIdx.
    const q = [seat];
    const seen = new Set([seat]);
    while (q.length) {
      const cur = q.pop();
      for (const nb of neighborIdxs(cur)) {
        if (nb === removeIdx) continue;
        if (!landIdxSet.has(nb)) continue;
        if (assignedCounty[nb] !== county) continue;
        if (seen.has(nb)) continue;
        seen.add(nb);
        q.push(nb);
      }
    }
    return seen.size === (countySize[county] - 1);
  };

  // Enforce a minimum county size by deterministic boundary acquisition.
  // Prevents tiny Voronoi pockets that slip past seat repair.
  const minFloor = Math.max(0, Math.floor(Number(smooth?.min_county_size ?? 0)));
  if (minFloor > 0) {
    const maxMoves = Math.max(1000, n * minFloor * 2);
    let moves = 0;
    while (moves < maxMoves) {
      // Find smallest under-floor county.
      let sc = -1;
      let scSize = 1e9;
      for (let c = 0; c < n; c++) {
        const sz = countySize[c];
        if (sz >= minFloor) continue;
        if (sz < scSize || (sz === scSize && c < sc)) {
          sc = c; scSize = sz;
        }
      }
      if (sc < 0) break;

      // Collect unique candidate tiles adjacent to sc by expanding from sc tiles.
      const candSet = new Set();
      for (let i = 0; i < total; i++) {
        if (!landIdxSet.has(i)) continue;
        if (assignedCounty[i] !== sc) continue;
        for (const nb of neighborIdxs(i)) {
          if (!landIdxSet.has(nb)) continue;
          if (assignedCounty[nb] === sc) continue;
          candSet.add(nb);
        }
      }
      const candidates = Array.from(candSet);
      candidates.sort((a, b) => a - b);

      // Avoid stealing very-high divider tiles (ridges / escarpments / major river cores)
      // during min-size growth unless there is absolutely no alternative.
      const avoidDivider = (Number.isFinite(Number(dividerMaxCost)) && Number(dividerMaxCost) > 0)
        ? Math.floor(Number(dividerMaxCost) * 0.85)
        : null;

      let best = null;
      for (const idx of candidates) {
        if (protect.has(idx)) continue;

        if (avoidDivider != null && Number(dividerCost?.[idx] ?? 0) >= avoidDivider) continue;

        const donor = assignedCounty[idx];
        if (donor < 0 || donor >= n) continue;
        if (donor === sc) continue;

        if (countySize[donor] <= minFloor) continue;
        if (!donorConnectedAfterRemoval(donor, idx)) continue;

        let recvN = 0;
        let donorN = 0;
        for (const nb of neighborIdxs(idx)) {
          if (!landIdxSet.has(nb)) continue;
          if (assignedCounty[nb] === sc) recvN++;
          if (assignedCounty[nb] === donor) donorN++;
        }
        if (recvN <= 0) continue;

        const cost = Number.isFinite(dividerCost[idx]) ? dividerCost[idx] : 0;
        const score = { recvN, cost, donorSize: countySize[donor], donorN, donor, idx };

        if (!best) best = score;
        else {
          // recvN desc, cost asc, donorSize desc, donorN asc, donor asc, idx asc
          if (score.recvN > best.recvN) best = score;
          else if (score.recvN === best.recvN) {
            if (score.cost < best.cost) best = score;
            else if (score.cost === best.cost) {
              if (score.donorSize > best.donorSize) best = score;
              else if (score.donorSize === best.donorSize) {
                if (score.donorN < best.donorN) best = score;
                else if (score.donorN === best.donorN) {
                  if (score.donor < best.donor) best = score;
                  else if (score.donor === best.donor) {
                    if (score.idx < best.idx) best = score;
                  }
                }
              }
            }
          }
        }
      }

      if (!best) break;
      assignedCounty[best.idx] = sc;
      countySize[sc] += 1;
      countySize[best.donor] -= 1;
      moves++;
    }
  }

  // Optional smoothing: deterministic majority filter on border tiles
  // while preserving: protected + high divider-cost (ridges).

  const smoothPasses = Math.max(0, Math.floor(Number(smooth?.passes ?? 0)));
  const smoothRadius = Math.max(1, Math.floor(Number(smooth?.radius ?? 3)));
  const supportFrac = Number(smooth?.support_frac ?? 0.28);
  const minSupport = Math.max(1, Math.floor(Number(smooth?.min_support ?? 8)));
  const minCountySize = Math.max(0, Math.floor(Number(smooth?.min_county_size ?? 0)));
  const protectCostFrac = Number(smooth?.protect_cost_frac ?? 0.70);
  const protectCost = (Number.isFinite(Number(dividerMaxCost)) && Number(dividerMaxCost) > 0)
    ? Math.floor(Number(dividerMaxCost) * protectCostFrac)
    : INF;

  const ringNeighborhood = (startIdx, radius) => {
    // Collect unique land tiles within given radius (graph distance).
    // Deterministic ordering by increasing dist then idx.
    const seen = new Set([startIdx]);
    const out = [startIdx];
    const q = [{ idx: startIdx, d: 0 }];
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      if (cur.d >= radius) continue;
      for (const nb of neighborIdxs(cur.idx)) {
        if (!landIdxSet.has(nb)) continue;
        if (seen.has(nb)) continue;
        seen.add(nb);
        q.push({ idx: nb, d: cur.d + 1 });
        out.push(nb);
      }
    }
    out.sort((a, b) => a - b);
    return out;
  };

  // donorConnectedAfterRemoval defined above (shared with min-size enforcement)

  for (let pass = 0; pass < smoothPasses; pass++) {
    // Candidate border tiles in stable order.
    const candidates = [];
    for (let i = 0; i < total; i++) {
      if (!landIdxSet.has(i)) continue;
      if (protect.has(i)) continue;
      if ((dividerCost[i] ?? 0) >= protectCost) continue;
      const c0 = assignedCounty[i];

      // border if any neighbor differs
      let border = false;
      let sameN = 0;
      for (const nb of neighborIdxs(i)) {
        if (!landIdxSet.has(nb)) continue;
        if (assignedCounty[nb] !== c0) border = true;
        else sameN++;
      }
      if (!border) continue;
      // Only bother if locally thin-ish; reduces cost of connectivity checks.
      if (sameN >= 5) continue;
      candidates.push(i);
    }
    candidates.sort((a, b) => a - b);

    let moved = 0;
    for (const idx of candidates) {
      const c0 = assignedCounty[idx];
      if (c0 < 0) continue;

      // Neighborhood county histogram.
      const neigh = ringNeighborhood(idx, smoothRadius);
      const counts = new Map();
      let totalN = 0;
      for (const ni of neigh) {
        if (!landIdxSet.has(ni)) continue;
        const cc = assignedCounty[ni];
        if (cc < 0) continue;
        counts.set(cc, (counts.get(cc) ?? 0) + 1);
        totalN++;
      }
      if (counts.size <= 2) continue;
      const own = counts.get(c0) ?? 0;
      const need = Math.max(minSupport, Math.floor(totalN * supportFrac));
      if (own >= need) continue;

      // Pick best adjacent alternative county by immediate-neighbor plurality,
      // tie-breaking by rank.
      const adjCounts = new Map();
      for (const nb of neighborIdxs(idx)) {
        if (!landIdxSet.has(nb)) continue;
        const cc = assignedCounty[nb];
        if (cc < 0 || cc === c0) continue;
        adjCounts.set(cc, (adjCounts.get(cc) ?? 0) + 1);
      }
      if (!adjCounts.size) continue;

      let bestC = null;
      let bestCt = -1;
      for (const [cc, ct] of adjCounts.entries()) {
        if (ct > bestCt) { bestCt = ct; bestC = cc; continue; }
        if (ct === bestCt && bestC != null && rank[cc] < rank[bestC]) {
          bestC = cc;
        }
      }
      if (bestC == null || bestC === c0) continue;

      // Never shrink a county below the configured minimum size.
      if (minCountySize > 0 && (countySize[c0] - 1) < minCountySize) continue;

      // Connectivity safety for donor.
      // If tile is a leaf (<=1 same neighbor), it's safe.
      let sameN = 0;
      for (const nb of neighborIdxs(idx)) {
        if (!landIdxSet.has(nb)) continue;
        if (assignedCounty[nb] === c0) sameN++;
      }
      const safe = sameN <= 1 ? true : donorConnectedAfterRemoval(c0, idx);
      if (!safe) continue;

      assignedCounty[idx] = bestC;
      countySize[c0] -= 1;
      countySize[bestC] += 1;
      moved++;
    }
    if (moved === 0) break;
  }

  // Stats
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let c = 0; c < n; c++) {
    const s = countySize[c];
    if (s < min) min = s;
    if (s > max) max = s;
    sum += s;
  }
  const avg = sum / n;

  return {
    assignedCounty,
    countySize,
    min,
    max,
    avg,
    unassigned_land: 0
  };
}

/**
 * County assignment by global PQ (B3/B4).
 * Returns { assignedCounty: Int16Array, countySize: Int32Array } where
 * assignedCounty[i] = countyIndex for land tiles; -1 for non-land.
 */
export function assignCountiesPQ({
  width,
  height,
  hexes,
  landIdxSet,
  neighborIdxs,
  seats,
  countyIds,
  countyTargets,
  costs,
  seed
}) {
  const seedU32 = hashStringToU32(`${seed}|county_pq_v2`);
  const n = seats.length;

  const assignedCounty = new Int16Array(hexes.length);
  assignedCounty.fill(-1);
  const countySize = new Int32Array(n);

  // Assign seats
  for (let c = 0; c < n; c++) {
    const s = seats[c];
    assignedCounty[s] = c;
    countySize[c] = 1;
  }

  const terrainEntryCost = (i) => {
    const t = hexes[i].terrain;
    const m = costs?.terrain_entry_cost ?? {};
    return Number(m[t] ?? 0);
  };

  const isMajorRiver = (i) => hexes[i].tile_kind === "land" && hexes[i]?.hydrology?.river_class === "major";
  const riverCross = (fromIdx, toIdx) => (isMajorRiver(fromIdx) !== isMajorRiver(toIdx) ? 1 : 0);
  const mountainCross = (fromIdx, toIdx) => (hexes[fromIdx].terrain === "mountains") !== (hexes[toIdx].terrain === "mountains") ? 1 : 0;

  const kNeighborsInCounty = (toIdx, c) => {
    let k = 0;
    for (const nb of neighborIdxs(toIdx)) {
      if (assignedCounty[nb] === c) k++;
    }
    return k;
  };

  const scoreClaim = (c, fromIdx, toIdx) => {
    const seatIdx = seats[c];
    const dist = axialDist(hexes[toIdx].q, hexes[toIdx].r, hexes[seatIdx].q, hexes[seatIdx].r);
    const k = kNeighborsInCounty(toIdx, c);
    const perimeterProxy = 6 - 2 * k;

    return (
      Number(costs.dist_w ?? 1.0) * dist +
      Number(costs.perimeter_w ?? 0.35) * perimeterProxy +
      Number(costs.river_cross_penalty ?? 2.25) * riverCross(fromIdx, toIdx) +
      Number(costs.mountain_cross_penalty ?? 3.5) * mountainCross(fromIdx, toIdx) +
      terrainEntryCost(toIdx)
    );
  };

  const tieKey = (c, toIdx) => {
    // deterministic "RNG" (does not depend on push order)
    return hashU32(seedU32, c, toIdx, 12345);
  };

  const heap = new MinHeap((a, b) => {
    if (a.score !== b.score) return a.score < b.score ? -1 : 1;
    if (a.c !== b.c) return a.c < b.c ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    if (a.tie !== b.tie) return a.tie < b.tie ? -1 : 1;
    return 0;
  });

  // Push initial frontier claims
  for (let c = 0; c < n; c++) {
    const s = seats[c];
    for (const nb of neighborIdxs(s)) {
      if (!landIdxSet.has(nb)) continue;
      if (assignedCounty[nb] !== -1) continue;
      const sc = scoreClaim(c, s, nb);
      heap.push({ score: sc, c, from: s, to: nb, tie: tieKey(c, nb) });
    }
  }

  const landTotal = landIdxSet.size;
  const targetTotal = countyTargets.reduce((a, x) => a + x, 0);
  if (landTotal !== targetTotal) {
    throw new Error(`County targets sum ${targetTotal} != land tiles ${landTotal}`);
  }

  let assignedCount = n; // seats already assigned

  while (heap.size > 0) {
    const claim = heap.pop();
    const c = claim.c;
    const toIdx = claim.to;
    const fromIdx = claim.from;

    if (assignedCounty[toIdx] !== -1) continue;
    if (countySize[c] >= countyTargets[c]) continue;

    assignedCounty[toIdx] = c;
    countySize[c] += 1;
    assignedCount += 1;

    // Expand frontier
    for (const nb of neighborIdxs(toIdx)) {
      if (!landIdxSet.has(nb)) continue;
      if (assignedCounty[nb] !== -1) continue;
      const sc = scoreClaim(c, toIdx, nb);
      heap.push({ score: sc, c, from: toIdx, to: nb, tie: tieKey(c, nb) });
    }

    if (assignedCount === landTotal) break;
  }

  if (assignedCount !== landTotal) {
    const deficits = [];
    for (let c = 0; c < n; c++) {
      if (countySize[c] !== countyTargets[c]) {
        deficits.push({ county_id: countyIds[c], size: countySize[c], target: countyTargets[c] });
      }
    }
    throw new Error(`CountyPQ failed: assigned=${assignedCount}/${landTotal}; deficits=${JSON.stringify(deficits)}`);
  }

  return { assignedCounty, countySize };
}
