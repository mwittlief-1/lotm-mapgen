/**
 * Macro Skeleton v1
 *
 * Purpose:
 * - Produce a deterministic, seed-driven "macro geography" signal that can be used
 *   as a movement/divider cost field for county partitioning.
 *
 * This is intentionally NOT micro-terrain (forest/plains/etc.). It's a coarse
 * structure: ridges, basin divides, coastal escarpments.
 *
 * Styles (v1):
 *   A: Spine-and-basins
 *   B: Tri-basin watershed
 *   C: Coastal plain + interior highlands
 */

import { assert, hashStringToU32, axialDist } from "./mapLibV1.mjs";

function mixU32(x) {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2(seedU32, x, y) {
  // 2D integer hash → u32
  let h = (seedU32 ^ (x + 0x9e3779b9)) >>> 0;
  h = mixU32(h ^ (y >>> 0));
  return h >>> 0;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep01(t) {
  // cubic smoothstep
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

function valueNoise2D(seedU32, q, r, scale) {
  // Smooth-ish noise on the integer grid by interpolating a coarse lattice.
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

function jitterInt(seedU32, q, r, scale, amp) {
  const a = Math.max(0, Math.floor(Number(amp ?? 0)));
  if (a <= 0) return 0;
  const s = Math.max(1, Number(scale ?? 1));
  const n = valueNoise2D(seedU32, q, r, s); // 0..1
  const x = (n * 2) - 1; // -1..1
  // Deterministic integer in [-a, +a]
  return clampInt(Math.round(x * a), -a, +a);
}

function meander1D(seedU32, t, scale, amp) {
  // 1D meander signal by sampling valueNoise2D along a line.
  // This avoids the "pepper" effect of full 2D jitter when used for macro
  // dividers (ridge lines / basin splits).
  const a = Math.max(0, Math.floor(Number(amp ?? 0)));
  if (a <= 0) return 0;
  const s = Math.max(1, Number(scale ?? 1));
  const n = valueNoise2D(seedU32, t, 0, s);
  const x = (n * 2) - 1;
  return clampInt(Math.round(x * a), -a, +a);
}

function ensureBasinConnectivity({ basinId, landIdx, hexes, width, height }) {
  // Ensure each basin is a single connected component.
  // Any non-primary components are reassigned to a neighboring basin by plurality.
  const dirs = [
    { dq: 1, dr: 0 },
    { dq: 1, dr: -1 },
    { dq: 0, dr: -1 },
    { dq: -1, dr: 0 },
    { dq: -1, dr: 1 },
    { dq: 0, dr: 1 }
  ];
  const inBounds = (q, r) => q >= 0 && q < width && r >= 0 && r < height;
  const idxOf = (q, r) => r * width + q;

  const basinSet = new Set();
  for (const idx of landIdx) {
    const b = basinId[idx];
    if (b >= 0) basinSet.add(b);
  }
  const basins = Array.from(basinSet).sort((a, b) => a - b);

  const visited = new Uint8Array(basinId.length);
  const keep = new Uint8Array(basinId.length);
  const stack = [];
  const comp = [];

  for (const b of basins) {
    let best = null;
    let bestSize = -1;
    let bestMin = Infinity;

    for (const start of landIdx) {
      if (basinId[start] !== b) continue;
      if (visited[start]) continue;
      // DFS
      stack.length = 0;
      comp.length = 0;
      stack.push(start);
      visited[start] = 1;
      let min = start;

      while (stack.length) {
        const cur = stack.pop();
        comp.push(cur);
        if (cur < min) min = cur;
        const h = hexes[cur];
        for (const d of dirs) {
          const nq = h.q + d.dq;
          const nr = h.r + d.dr;
          if (!inBounds(nq, nr)) continue;
          const ni = idxOf(nq, nr);
          if (visited[ni]) continue;
          if (basinId[ni] !== b) continue;
          visited[ni] = 1;
          stack.push(ni);
        }
      }

      const size = comp.length;
      if (size > bestSize || (size === bestSize && min < bestMin)) {
        bestSize = size;
        bestMin = min;
        best = comp.slice();
      }
    }

    if (best && best.length) {
      for (const idx of best) keep[idx] = 1;
    }
  }

  // Reassign non-kept tiles.
  for (const idx of landIdx) {
    const b0 = basinId[idx];
    if (b0 < 0) continue;
    if (keep[idx]) continue;

    const h = hexes[idx];
    const counts = new Map();
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr)) continue;
      const ni = idxOf(nq, nr);
      const bb = basinId[ni];
      if (bb < 0 || bb === b0) continue;
      counts.set(bb, (counts.get(bb) ?? 0) + 1);
    }
    if (counts.size === 0) continue;
    const best = Array.from(counts.entries())
      .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))[0][0];
    basinId[idx] = best;
  }
}

function clampInt(x, lo, hi) {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return Math.max(a, Math.min(b, Math.floor(x)));
}

function cubeRel(q, r, cq, cr) {
  const x = q - cq;
  const z = r - cr;
  const y = -x - z;
  return { x, y, z };
}

function cubeToAxial(cq, cr, x, y, z) {
  // Given our cubeRel definition, q maps to x and r maps to z.
  return { q: cq + x, r: cr + z };
}

export function parseMacroStyleFromSeed(seed) {
  const m = /^PLAY_([ABC])_/i.exec(String(seed));
  if (m) return m[1].toUpperCase();
  const u = hashStringToU32(`${seed}|macro_style_v1`);
  return ["A", "B", "C"][u % 3];
}

function pickStyleParamInt(seed, key, lo, hi) {
  const u = hashStringToU32(`${seed}|macro_${key}`);
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  const span = (b - a + 1);
  return a + (u % span);
}

function nearestLandToAxial({ landIdx, hexes, tq, tr }) {
  // Deterministic nearest: axialDist then idx
  let best = null;
  let bestD = Infinity;
  for (const i of landIdx) {
    const h = hexes[i];
    const d = axialDist(h.q, h.r, tq, tr);
    if (d < bestD || (d === bestD && (best == null || i < best))) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Generates a per-tile integer "divider cost" field.
 *
 * - Higher cost means harder to cross / more likely to become a county border.
 * - Used by multi-source Dijkstra (geodesic Voronoi).
 */
export function generateMacroDividerCostV1({
  styleId,
  seed,
  width,
  height,
  hexes,
  landIdx,
  world,
  distToSea,
  config,
  majorRiverPathIdx = null,
  majorRiverPathsIdx = null
}) {
  const total = width * height;
  const out = new Int16Array(total);
  out.fill(0);

  // Basin ids (macro regions). Used to create near-hard ridge dividers.
  // -1 for non-land.
  const basinId = new Int16Array(total);
  basinId.fill(-1);

  // Ridge boundary mask: 1 where tile touches a different basin.
  const ridgeMask = new Uint8Array(total);
  ridgeMask.fill(0);

  // River fords: a small number of river tiles where crossing is easier.
  const riverFordMask = new Uint8Array(total);
  riverFordMask.fill(0);

  const sid = String(styleId ?? "A").toUpperCase();
  assert(sid === "A" || sid === "B" || sid === "C", `unknown macro style: ${sid}`);

  const seedU32 = hashStringToU32(`${seed}|macro_divider_cost_${sid}_v1`);
  const noiseScale = Number(config?.mapgen?.macro?.noise_scale ?? 16);
  const noiseAmp = Number(config?.mapgen?.macro?.noise_amp ?? 4);

// Secondary/tertiary "roughness" fields: low-frequency friction variation to
// break long straight Voronoi bisectors without adding hard constraints.
const secondaryNoiseScale = Number(config?.mapgen?.macro?.secondary_noise_scale ?? Math.max(24, Math.floor(noiseScale * 2.0)));
const secondaryNoiseAmp = Number(config?.mapgen?.macro?.secondary_noise_amp ?? 6);
const tertiaryNoiseScale = Number(config?.mapgen?.macro?.tertiary_noise_scale ?? Math.max(10, Math.floor(noiseScale * 0.65)));
const tertiaryNoiseAmp = Number(config?.mapgen?.macro?.tertiary_noise_amp ?? 2);

  // Meander controls: create wavy ridges / basin divides instead of ruler-straight planes.
  // NOTE: defaults here are intentionally stronger than earlier experiments.
  const meanderScale = Number(config?.mapgen?.macro?.meander_scale ?? Math.max(14, Math.floor(noiseScale * 1.1)));
  const meanderAmp = Number(config?.mapgen?.macro?.meander_amp ?? 12);

  // Ridge belt width (dilation radius in tiles). Wider belts create more
  // realistic "mountain chain" dividers and reduce straight-line artifacts.
  const ridgeBeltRadius = Math.max(0, Math.floor(Number(config?.mapgen?.macro?.ridge_belt_radius ?? 2)));
  const ridgePassCount = Math.max(0, Math.floor(Number(config?.mapgen?.macro?.ridge_pass_count ?? 1)));
  const ridgePassRadius = Math.max(0, Math.floor(Number(config?.mapgen?.macro?.ridge_pass_radius ?? Math.max(1, ridgeBeltRadius))));

  // Strong divider costs (ridges + major rivers). Defaults intentionally high.
  const ridgeLineCost = Math.max(0, Math.floor(Number(config?.mapgen?.macro?.ridge_line_cost ?? 200)));
  const ridgePassCost = Math.max(0, Math.floor(Number(config?.mapgen?.macro?.ridge_pass_cost ?? 24)));
  const riverLineCost = Math.max(0, Math.floor(Number(config?.mapgen?.macro?.river_line_cost ?? 180)));
  const riverFordCost = Math.max(0, Math.floor(Number(config?.mapgen?.macro?.river_ford_cost ?? 24)));
  const riverFordCount = Math.max(0, Math.floor(Number(config?.mapgen?.macro?.river_ford_count ?? 2)));

  // Optional widening of the river divider band (in tiles).
  const riverBeltRadius = Math.max(0, Math.floor(Number(config?.mapgen?.macro?.river_belt_radius ?? 0)));

  // Clamp large enough to support strong dividers.
  const maxClamp = Number(config?.mapgen?.macro?.max_cost ?? Math.max(60, ridgeLineCost, riverLineCost));

  const dbg = { style: sid, params: {} };

  if (sid === "A") {
    // Spine-and-basins: a high-cost ridge band defined by one cube coordinate plane.
    const planeIdx = hashStringToU32(`${seed}|macroA_plane`) % 3; // 0:x,1:y,2:z
    const planeName = planeIdx === 0 ? "x" : planeIdx === 1 ? "y" : "z";
    const offsetRange = Math.max(1, Math.floor((world?.radius ?? 60) / 8));
    const offset = pickStyleParamInt(seed, "macroA_offset", -offsetRange, offsetRange);

    const ridgeAmp = Number(config?.mapgen?.macro?.A?.ridge_amp ?? 26);
    const ridgeFalloff = Number(config?.mapgen?.macro?.A?.ridge_falloff ?? 4);

    // Secondary split to produce 3 basins overall.
    const planeIdx2 = (planeIdx + 1) % 3;
    const planeName2 = planeIdx2 === 0 ? "x" : planeIdx2 === 1 ? "y" : "z";
    const offset2 = pickStyleParamInt(seed, "macroA_offset2", -offsetRange, offsetRange);
    const splitSide = (hashStringToU32(`${seed}|macroA_splitSide`) % 2); // 0 or 1

    dbg.params = {
      plane: planeName,
      offset,
      plane2: planeName2,
      offset2,
      splitSide,
      ridgeAmp,
      ridgeFalloff,
      meanderScale,
      meanderAmp,
      ridgeBeltRadius,
      ridgePassCount,
      ridgePassRadius,
      riverBeltRadius,
      ridgeLineCost,
      ridgePassCost,
      riverLineCost,
      riverFordCost,
      riverFordCount,
      noiseScale,
      noiseAmp
    };

    for (const idx of landIdx) {
      const h = hexes[idx];
      const rel = cubeRel(h.q, h.r, world.cq, world.cr);
      const v = planeIdx === 0 ? rel.x : planeIdx === 1 ? rel.y : rel.z;
      const v2 = planeIdx2 === 0 ? rel.x : planeIdx2 === 1 ? rel.y : rel.z;
      // Meandered divider: use 1D meander signal along the ridge direction so
      // basin boundaries look like a continuous, wavy ridge line (not "speckled").
      const t1 = planeIdx === 2 ? rel.x : rel.z;
      const t2 = planeIdx2 === 2 ? rel.x : rel.z;
      const j1 = meander1D(seedU32 ^ 0xa1b2c3d4, t1, meanderScale, meanderAmp);
      const j2 = meander1D(seedU32 ^ 0x1c2d3e4f, t2, meanderScale, Math.max(1, Math.floor(meanderAmp * 0.75)));
      const off1 = offset + j1;
      const off2 = offset2 + j2;
      const f = v - off1;
      const d = Math.abs(f);
      const ridge = Math.max(0, Math.floor(ridgeAmp - d * ridgeFalloff));
      const n = valueNoise2D(seedU32, h.q, h.r, noiseScale);
      const base = Math.floor(n * noiseAmp);
      const n2 = valueNoise2D(seedU32 ^ 0x5a5a5a5a, h.q, h.r, secondaryNoiseScale);
      const base2 = Math.floor(n2 * secondaryNoiseAmp);
      const n3 = valueNoise2D(seedU32 ^ 0xa5a5a5a5, h.q, h.r, tertiaryNoiseScale);
      const base3 = Math.floor(n3 * tertiaryNoiseAmp);
      out[idx] = clampInt(base + base2 + base3 + ridge, 0, maxClamp);

      // Basins: split by primary plane; then split one side by secondary plane.
      const side = (v < off1) ? 0 : 1;
      if (side !== splitSide) basinId[idx] = side === 0 ? 0 : 1;
      else {
        // produce two basins on the split side
        const sub = (v2 < off2) ? 0 : 1;
        basinId[idx] = (side === 0)
          ? (sub === 0 ? 0 : 2)
          : (sub === 0 ? 1 : 2);
      }
    }
  } else if (sid === "B") {
    // Tri-basin watershed: 3 basin centers; ridges appear along near-equal-distance divides.
    const radius = world?.radius ?? 60;
    const kBase = Math.max(6, Math.floor(radius * 0.35));
    const kJit = pickStyleParamInt(seed, "macroB_kjit", -3, 3);
    const k = Math.max(6, kBase + kJit);

    // Ideal basin points in cube offsets (120° apart).
    const p0 = { x: +k, y: -k, z: 0 };
    const p1 = { x: 0, y: +k, z: -k };
    const p2 = { x: -k, y: 0, z: +k };

    const a0 = cubeToAxial(world.cq, world.cr, p0.x, p0.y, p0.z);
    const a1 = cubeToAxial(world.cq, world.cr, p1.x, p1.y, p1.z);
    const a2 = cubeToAxial(world.cq, world.cr, p2.x, p2.y, p2.z);

    const c0 = nearestLandToAxial({ landIdx, hexes, tq: a0.q, tr: a0.r });
    const c1 = nearestLandToAxial({ landIdx, hexes, tq: a1.q, tr: a1.r });
    const c2 = nearestLandToAxial({ landIdx, hexes, tq: a2.q, tr: a2.r });

    const ridgeBand = Number(config?.mapgen?.macro?.B?.ridge_band ?? 2);
    const ridgeAmp = Number(config?.mapgen?.macro?.B?.ridge_amp ?? 14);
    const meanderAmpB = Number(config?.mapgen?.macro?.B?.meander_amp ?? Math.max(2, Math.floor(meanderAmp * 0.8)));
    dbg.params = {
      k,
      centers: [c0, c1, c2],
      ridgeBand,
      ridgeAmp,
      meanderScale,
      meanderAmp: meanderAmpB,
      ridgeBeltRadius,
      ridgePassCount,
      ridgePassRadius,
      riverBeltRadius,
      ridgeLineCost,
      ridgePassCost,
      riverLineCost,
      riverFordCost,
      riverFordCount,
      noiseScale,
      noiseAmp
    };

    const hc0 = hexes[c0], hc1 = hexes[c1], hc2 = hexes[c2];

    for (const idx of landIdx) {
      const h = hexes[idx];
      // Noisy distances create meandering watershed boundaries.
      const d0 = axialDist(h.q, h.r, hc0.q, hc0.r) + jitterInt(seedU32 ^ 0xb001, h.q, h.r, meanderScale, meanderAmpB);
      const d1 = axialDist(h.q, h.r, hc1.q, hc1.r) + jitterInt(seedU32 ^ 0xb101, h.q, h.r, meanderScale, meanderAmpB);
      const d2 = axialDist(h.q, h.r, hc2.q, hc2.r) + jitterInt(seedU32 ^ 0xb201, h.q, h.r, meanderScale, meanderAmpB);

      // Basin id: nearest of 3 centers (deterministic).
      let b = 0;
      let bd = d0;
      if (d1 < bd) { b = 1; bd = d1; }
      if (d2 < bd) { b = 2; bd = d2; }
      basinId[idx] = b;

      // Find best + second best distances.
      let best = d0, second = d1;
      if (best > second) { const t = best; best = second; second = t; }
      if (d2 < best) { second = best; best = d2; }
      else if (d2 < second) { second = d2; }

      const diff = second - best;
      const ridge = diff <= ridgeBand ? Math.floor((ridgeBand - diff + 1) * ridgeAmp) : 0;
      const n = valueNoise2D(seedU32, h.q, h.r, noiseScale);
      const base = Math.floor(n * noiseAmp);
      const n2 = valueNoise2D(seedU32 ^ 0x5a5a5a5a, h.q, h.r, secondaryNoiseScale);
      const base2 = Math.floor(n2 * secondaryNoiseAmp);
      const n3 = valueNoise2D(seedU32 ^ 0xa5a5a5a5, h.q, h.r, tertiaryNoiseScale);
      const base3 = Math.floor(n3 * tertiaryNoiseAmp);
      out[idx] = clampInt(base + base2 + base3 + ridge, 0, maxClamp);
    }
  } else if (sid === "C") {
    // Coastal plain + interior highlands.
    // Use distToSea (0 at coast land). Create an escarpment band and increasing interior cost.
    const radius = world?.radius ?? 60;
    const plainLo = Number(config?.mapgen?.macro?.C?.plain_width_min ?? Math.floor(radius * 0.18));
    const plainHi = Number(config?.mapgen?.macro?.C?.plain_width_max ?? Math.floor(radius * 0.28));
    const plainWidth = pickStyleParamInt(seed, "macroC_plain", plainLo, plainHi);

    const escWidth = Number(config?.mapgen?.macro?.C?.escarpment_width ?? 3);
    const escAmp = Number(config?.mapgen?.macro?.C?.escarpment_amp ?? 22);
    const escFalloff = Number(config?.mapgen?.macro?.C?.escarpment_falloff ?? 6);
    const inlandAmp = Number(config?.mapgen?.macro?.C?.inland_amp ?? 12);
    const inlandSlope = Number(config?.mapgen?.macro?.C?.inland_slope ?? 1);

    // Secondary split of interior to produce 3 basins overall.
    const planeIdx = hashStringToU32(`${seed}|macroC_plane`) % 3;
    const planeName = planeIdx === 0 ? "x" : planeIdx === 1 ? "y" : "z";
    const offsetRange = Math.max(1, Math.floor((world?.radius ?? 60) / 8));
    const offset = pickStyleParamInt(seed, "macroC_offset", -offsetRange, offsetRange);

    dbg.params = {
      plainWidth,
      escWidth,
      escAmp,
      escFalloff,
      inlandAmp,
      inlandSlope,
      plane: planeName,
      offset,
      meanderScale,
      meanderAmp,
      ridgeBeltRadius,
      ridgePassCount,
      ridgePassRadius,
      riverBeltRadius,
      ridgeLineCost,
      ridgePassCost,
      riverLineCost,
      riverFordCost,
      riverFordCount,
      noiseScale,
      noiseAmp
    };

    for (const idx of landIdx) {
      const h = hexes[idx];
      let d = distToSea?.[idx] ?? -1;
      if (!Number.isFinite(d) || d < 0) d = plainWidth + 8;

      // Meander the escarpment / plain boundary so it isn't a ruler contour.
      const pwLocal = plainWidth + jitterInt(seedU32 ^ 0xc0c1c2c3, h.q, h.r, meanderScale, meanderAmp);
      const pw = Math.max(1, pwLocal);

      const inland = Math.max(0, Math.min(inlandAmp, Math.floor((d - pw) * inlandSlope)));
      const escD = Math.abs(d - pw);
      const esc = escD <= escWidth ? Math.max(0, Math.floor(escAmp - escD * escFalloff)) : 0;
      const n = valueNoise2D(seedU32, h.q, h.r, noiseScale);
      const base = Math.floor(n * noiseAmp);
      const n2 = valueNoise2D(seedU32 ^ 0x5a5a5a5a, h.q, h.r, secondaryNoiseScale);
      const base2 = Math.floor(n2 * secondaryNoiseAmp);
      const n3 = valueNoise2D(seedU32 ^ 0xa5a5a5a5, h.q, h.r, tertiaryNoiseScale);
      const base3 = Math.floor(n3 * tertiaryNoiseAmp);
      out[idx] = clampInt(base + base2 + base3 + inland + esc, 0, maxClamp);

      // Basin id: coastal plain = 0; interior split by a plane.
      if (d < pw) basinId[idx] = 0;
      else {
        const rel = cubeRel(h.q, h.r, world.cq, world.cr);
        const v = planeIdx === 0 ? rel.x : planeIdx === 1 ? rel.y : rel.z;
        const t = planeIdx === 2 ? rel.x : rel.z;
        const j = meander1D(seedU32 ^ 0xcafe1234, t, meanderScale, Math.max(2, Math.floor(meanderAmp * 0.85)));
        basinId[idx] = (v < (offset + j)) ? 1 : 2;
      }
    }
  }

  // Ensure basin regions are connected (prevents tiny enclaves that create hard-straight borders).
  ensureBasinConnectivity({ basinId, landIdx, hexes, width, height });

  // River fords selection (deterministic): choose N ford tiles per river path.
  // - If multiple paths are provided (trunk + tributary), we pick per-path.
  // - Else we fall back to a stable-sorted scan of major-river tiles.
  if (riverFordCount > 0) {
    const paths = [];
    if (Array.isArray(majorRiverPathsIdx) && majorRiverPathsIdx.length) {
      for (const p of majorRiverPathsIdx) {
        if (!Array.isArray(p)) continue;
        const cleaned = p.filter((x) => Number.isInteger(x));
        if (cleaned.length >= 4) paths.push(cleaned);
      }
    } else if (Array.isArray(majorRiverPathIdx)) {
      const cleaned = majorRiverPathIdx.filter((x) => Number.isInteger(x));
      if (cleaned.length >= 4) paths.push(cleaned);
    }

    if (!paths.length) {
      const riverTiles = [];
      for (const idx of landIdx) {
        if (hexes[idx]?.hydrology?.river_class === "major") riverTiles.push(idx);
      }
      riverTiles.sort((a, b) => a - b);
      if (riverTiles.length >= 4) paths.push(riverTiles);
    }

    for (const path of paths) {
      const picks = [];
      if (riverFordCount === 1) {
        picks.push(path[Math.floor(path.length * 0.5)]);
      } else {
        // N>=2: spread picks evenly, skipping extreme endpoints.
        for (let k = 1; k <= riverFordCount; k++) {
          const t = (k / (riverFordCount + 1));
          picks.push(path[Math.floor(path.length * t)]);
        }
      }
      for (const idx of picks) {
        if (idx != null) riverFordMask[idx] = 1;
      }
    }
  }

  // Ridge boundary mask: land tile adjacent to a different basin.
  // Deterministic neighbor directions locked.
  const dirs = [
    { dq: 1, dr: 0 },
    { dq: 1, dr: -1 },
    { dq: 0, dr: -1 },
    { dq: -1, dr: 0 },
    { dq: -1, dr: 1 },
    { dq: 0, dr: 1 }
  ];
  const inBounds = (q, r) => q >= 0 && q < width && r >= 0 && r < height;
  const idxOf = (q, r) => r * width + q;

  for (const idx of landIdx) {
    const b0 = basinId[idx];
    if (b0 < 0) continue;
    const h = hexes[idx];
    for (const d of dirs) {
      const nq = h.q + d.dq;
      const nr = h.r + d.dr;
      if (!inBounds(nq, nr)) continue;
      const ni = idxOf(nq, nr);
      if (basinId[ni] < 0) continue;
      if (basinId[ni] !== b0) { ridgeMask[idx] = 1; break; }
    }
  }

  // Widen ridge boundary into a ridge "belt" (dilation). This both looks
  // more realistic and creates stronger county-divider behavior without hard
  // constraints.
  const ridgeBeltMask = new Uint8Array(total);
  ridgeBeltMask.fill(0);
  if (ridgeBeltRadius > 0) {
    const q = [];
    const dist = new Int16Array(total);
    dist.fill(-1);
    for (const idx of landIdx) {
      if (ridgeMask[idx] === 1) {
        ridgeBeltMask[idx] = 1;
        dist[idx] = 0;
        q.push(idx);
      }
    }
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cd = dist[cur];
      if (cd >= ridgeBeltRadius) continue;
      const h = hexes[cur];
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr)) continue;
        const nb = idxOf(nq, nr);
        if (basinId[nb] < 0) continue;
        if (dist[nb] !== -1) continue;
        dist[nb] = cd + 1;
        ridgeBeltMask[nb] = 1;
        q.push(nb);
      }
    }
  } else {
    for (const idx of landIdx) if (ridgeMask[idx] === 1) ridgeBeltMask[idx] = 1;
  }

  // Ridge pass selection (deterministic): pick a single pass tile near the
  // world center, then widen it to punch through the ridge belt.
  const ridgePassMask = new Uint8Array(total);
  ridgePassMask.fill(0);
  if (ridgePassCount > 0 && ridgePassRadius > 0) {
    let best = null;
    let bestD = Infinity;
    for (const idx of landIdx) {
      if (ridgeMask[idx] !== 1) continue;
      const h = hexes[idx];
      const d = axialDist(h.q, h.r, world.cq, world.cr);
      if (d < bestD || (d === bestD && (best == null || idx < best))) {
        bestD = d;
        best = idx;
      }
    }
    if (best != null) {
      // Flood within ridge belt to ensure the pass actually cuts the belt.
      const q = [best];
      const dist = new Int16Array(total);
      dist.fill(-1);
      dist[best] = 0;
      ridgePassMask[best] = 1;
      for (let qi = 0; qi < q.length; qi++) {
        const cur = q[qi];
        const cd = dist[cur];
        if (cd >= ridgePassRadius) continue;
        const h = hexes[cur];
        for (const d of dirs) {
          const nq = h.q + d.dq;
          const nr = h.r + d.dr;
          if (!inBounds(nq, nr)) continue;
          const nb = idxOf(nq, nr);
          if (basinId[nb] < 0) continue;
          if (ridgeBeltMask[nb] !== 1) continue;
          if (dist[nb] !== -1) continue;
          dist[nb] = cd + 1;
          ridgePassMask[nb] = 1;
          q.push(nb);
        }
      }
    }
  }

  // Apply strong divider costs.
  // - Ridge belt is near-impassable except where a ridge pass is stamped.
  // - Rivers can optionally be widened into a divider belt; fords lower the
  //   cost locally.
  const isMajorRiverTile = (i) => hexes[i]?.hydrology?.river_class === "major";

  const riverBeltMask2 = new Uint8Array(total);
  riverBeltMask2.fill(0);
  if (riverBeltRadius > 0) {
    const q = [];
    const dist = new Int16Array(total);
    dist.fill(-1);
    for (const idx of landIdx) {
      if (isMajorRiverTile(idx)) {
        riverBeltMask2[idx] = 1;
        dist[idx] = 0;
        q.push(idx);
      }
    }
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cd = dist[cur];
      if (cd >= riverBeltRadius) continue;
      const h = hexes[cur];
      for (const d of dirs) {
        const nq = h.q + d.dq;
        const nr = h.r + d.dr;
        if (!inBounds(nq, nr)) continue;
        const ni = idxOf(nq, nr);
        if (basinId[ni] < 0) continue;
        if (dist[ni] !== -1) continue;
        dist[ni] = cd + 1;
        riverBeltMask2[ni] = 1;
        q.push(ni);
      }
    }
  }

  for (const idx of landIdx) {
    const isRidge = ridgeBeltMask[idx] === 1;
    const isPass = ridgePassMask[idx] === 1;
    const isRiver = riverBeltRadius > 0 ? (riverBeltMask2[idx] === 1) : isMajorRiverTile(idx);
    const isFord = riverFordMask[idx] === 1;

    if (isRidge) out[idx] = clampInt(Math.max(out[idx], ridgeLineCost), 0, maxClamp);
    if (isPass) out[idx] = clampInt(Math.min(out[idx], ridgePassCost), 0, maxClamp);
    if (isRiver) out[idx] = clampInt(Math.max(out[idx], isFord ? riverFordCost : riverLineCost), 0, maxClamp);

    // If a tile is both ridge + ford/pass (rare), prefer the lower of ridge pass and ford.
    if (isRidge && (isFord || isPass)) out[idx] = clampInt(Math.min(ridgePassCost, riverFordCost), 0, maxClamp);
  }

  // Report max for seat scoring normalization.
  let maxCost = 0;
  for (const idx of landIdx) {
    const c = out[idx];
    if (c > maxCost) maxCost = c;
  }
  dbg.maxCost = maxCost;

  // Basin stats for debug.
  const basinSizes = new Map();
  for (const idx of landIdx) {
    const b = basinId[idx];
    if (b < 0) continue;
    basinSizes.set(b, (basinSizes.get(b) ?? 0) + 1);
  }
  dbg.basins = Array.from(basinSizes.entries()).sort((a, b) => a[0] - b[0]).map(([b, ct]) => ({ basin: b, land: ct }));

  return {
    styleId: sid,
    dividerCost: out,
    maxCost,
    basinId,
    // Expose the widened ridge belt for terrain visualization.
    ridgeMask: ridgeBeltMask,
    riverFordMask,
    debug: dbg
  };
}
