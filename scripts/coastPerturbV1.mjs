/**
 * Coastline perturbation v1 (Patch A)
 *
 * Deterministically perturbs the sea/land boundary within a coastal band.
 *
 * - Uses coordinate-hashed value noise (no dependence on iteration order)
 * - Runs a few erode/dilate-style passes near the boundary
 * - Optionally carves 1–2 deeper inlets per seed
 *
 * IMPORTANT: Caller should protect estuary tiles and the river-end corridor by
 * passing `protectedIdxSet`.
 */

function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mixU32(x) {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function hash2u32(a, b) {
  return mixU32((a ^ (b + 0x9e3779b9)) >>> 0);
}

function hash3u32(a, b, c) {
  return mixU32(hash2u32(hash2u32(a, b), c));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}

function valueNoise2D(seedU32, x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const a = (hash3u32(seedU32, xi >>> 0, yi >>> 0) / 0xffffffff);
  const b = (hash3u32(seedU32, (xi + 1) >>> 0, yi >>> 0) / 0xffffffff);
  const c = (hash3u32(seedU32, xi >>> 0, (yi + 1) >>> 0) / 0xffffffff);
  const d = (hash3u32(seedU32, (xi + 1) >>> 0, (yi + 1) >>> 0) / 0xffffffff);

  const u = smoothstep(xf);
  const v = smoothstep(yf);
  const x1 = lerp(a, b, u);
  const x2 = lerp(c, d, u);
  return (lerp(x1, x2, v) * 2) - 1; // [-1, +1]
}

/**
 * tiles: Array<{q,r,tile_kind}>, indexed row-major
 * neighborsOfIdx: (idx)=>number[] (includes only in-bounds neighbors)
 */
export function perturbCoastlineMask({
  tiles,
  width,
  height,
  neighborsOfIdx,
  seedStr,
  coastCfg,
  protectedIdxSet,
  coastalBand = 8,
  iterations = 3
}) {
  const seedU32 = fnv1a32(`${seedStr}|coast_v1`);

  const noiseStrength = Number(coastCfg?.noise_strength ?? 0.4);
  const noiseScale = Number(coastCfg?.noise_scale ?? 0.09);
  const minInlet = Number.isInteger(coastCfg?.min_inlet_depth) ? coastCfg.min_inlet_depth : 2;
  const maxInlet = Number.isInteger(coastCfg?.max_inlet_depth) ? coastCfg.max_inlet_depth : 8;

  const isProtected = (idx) => protectedIdxSet?.has?.(idx) === true;

  const isBoundaryIdx = (idx) => {
    const tk = tiles[idx].tile_kind;
    if (tk === "void") return false;
    for (const n of neighborsOfIdx(idx)) {
      const ntk = tiles[n].tile_kind;
      if (tk === "land" && ntk === "sea") return true;
      if (tk === "sea" && ntk === "land") return true;
    }
    return false;
  };

  // BFS distance to boundary, capped at coastalBand
  const computeBandDist = () => {
    const dist = new Int16Array(tiles.length);
    dist.fill(-1);
    const q = [];

    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i].tile_kind === "void") continue;
      if (isBoundaryIdx(i)) {
        dist[i] = 0;
        q.push(i);
      }
    }

    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const cd = dist[cur];
      if (cd >= coastalBand) continue;
      for (const n of neighborsOfIdx(cur)) {
        if (tiles[n].tile_kind === "void") continue;
        if (dist[n] !== -1) continue;
        dist[n] = cd + 1;
        q.push(n);
      }
    }

    return dist;
  };

  const flipStep = (distToBoundary) => {
    const flips = [];

    for (let i = 0; i < tiles.length; i++) {
      if (isProtected(i)) continue;
      const tk = tiles[i].tile_kind;
      if (tk === "void") continue;
      const d = distToBoundary[i];
      if (d < 0 || d > coastalBand) continue;
      if (!isBoundaryIdx(i)) continue;

      const n = valueNoise2D(seedU32, tiles[i].q * noiseScale, tiles[i].r * noiseScale);
      const push = n * noiseStrength;

      if (tk === "land") {
        // Erode land to sea on negative push if adjacent sea exists
        let hasSea = false;
        for (const nb of neighborsOfIdx(i)) {
          if (tiles[nb].tile_kind === "sea") {
            hasSea = true;
            break;
          }
        }
        if (hasSea && push < -0.15) flips.push([i, "sea"]);
      } else if (tk === "sea") {
        // Dilate sea to land on positive push if adjacent land exists
        let hasLand = false;
        for (const nb of neighborsOfIdx(i)) {
          if (tiles[nb].tile_kind === "land") {
            hasLand = true;
            break;
          }
        }
        if (hasLand && push > 0.15) flips.push([i, "land"]);
      }
    }

    for (const [idx, kind] of flips) tiles[idx].tile_kind = kind;
  };

  const carveInlets = (distToBoundary) => {
    const candidates = [];
    for (let i = 0; i < tiles.length; i++) {
      if (isProtected(i)) continue;
      if (tiles[i].tile_kind !== "land") continue;
      const d = distToBoundary[i];
      if (d < 0 || d > coastalBand) continue;

      let hasSea = false;
      for (const nb of neighborsOfIdx(i)) {
        if (tiles[nb].tile_kind === "sea") {
          hasSea = true;
          break;
        }
      }
      if (hasSea) candidates.push(i);
    }

    if (!candidates.length) return;

    const pickCount = 2;
    const depthSpan = Math.max(1, maxInlet - minInlet + 1);

    for (let p = 0; p < pickCount; p++) {
      const h = hash3u32(seedU32, (p + 17) >>> 0, candidates.length >>> 0);
      const startIdx = candidates[h % candidates.length];
      const depth = minInlet + (hash3u32(seedU32, startIdx >>> 0, (p + 99) >>> 0) % depthSpan);

      let cur = startIdx;
      for (let d = 0; d < depth; d++) {
        if (isProtected(cur)) break;
        tiles[cur].tile_kind = "sea";

        const opts = [];
        for (const nb of neighborsOfIdx(cur)) {
          if (tiles[nb].tile_kind === "land" && !isProtected(nb)) opts.push(nb);
        }
        if (!opts.length) break;
        const hh = hash3u32(seedU32, cur >>> 0, (d + 777) >>> 0);
        cur = opts[hh % opts.length];
      }
    }
  };

  for (let it = 0; it < iterations; it++) {
    const dist = computeBandDist();
    flipStep(dist);
  }

  carveInlets(computeBandDist());
}

// ---- M2 straight-run breaker ----

function neighborByDirIdx(idx, dirIndex, width, height) {
  const q = idx % width;
  const r = Math.floor(idx / width);
  // LOCKED order: E, NE, NW, W, SW, SE
  const dirs = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1]
  ];
  const d = dirs[dirIndex];
  const nq = q + d[0];
  const nr = r + d[1];
  if (nq < 0 || nq >= width || nr < 0 || nr >= height) return -1;
  return nr * width + nq;
}

function isBoundaryLandEdge(tiles, idx, dirIndex, width, height) {
  if (tiles[idx].tile_kind !== "land") return false;
  const nb = neighborByDirIdx(idx, dirIndex, width, height);
  if (nb < 0) return false;
  return tiles[nb].tile_kind === "sea";
}

export function computeCoastStraightRunMetrics({
  tiles,
  width,
  height,
  maxRun = 8
}) {
  const maxByDir = new Array(6).fill(0);
  let maxOverall = 0;

  // For each direction, scan boundary edges and count run lengths along tangents.
  for (let d = 0; d < 6; d++) {
    const tA = (d + 1) % 6;
    const tB = (d + 5) % 6;

    const visited = new Set();

    for (let idx = 0; idx < tiles.length; idx++) {
      if (!isBoundaryLandEdge(tiles, idx, d, width, height)) continue;
      const key = `${idx}|${d}`;
      if (visited.has(key)) continue;

      // Walk back to run start along tB
      let start = idx;
      for (;;) {
        const prev = neighborByDirIdx(start, tB, width, height);
        if (prev < 0) break;
        if (!isBoundaryLandEdge(tiles, prev, d, width, height)) break;
        start = prev;
      }

      // Walk forward along tA
      let len = 0;
      let cur = start;
      for (;;) {
        if (!isBoundaryLandEdge(tiles, cur, d, width, height)) break;
        visited.add(`${cur}|${d}`);
        len++;
        const nxt = neighborByDirIdx(cur, tA, width, height);
        if (nxt < 0) break;
        if (!isBoundaryLandEdge(tiles, nxt, d, width, height)) break;
        cur = nxt;
      }

      if (len > maxByDir[d]) maxByDir[d] = len;
      if (len > maxOverall) maxOverall = len;
    }
  }

  return {
    max_straight_run_overall: maxOverall,
    max_straight_run_by_dir: maxByDir,
    max_run_threshold: maxRun
  };
}

export function breakCoastStraightRunsMask({
  tiles,
  width,
  height,
  neighborsOfIdx,
  protectedIdxSet,
  seedStr,
  coastalBand = 8,
  maxRun = 8,
  maxBreaks = 500
}) {
  const seedU32 = fnv1a32(`${seedStr}|coast_breaker_v1`);
  const isProtected = (idx) => protectedIdxSet?.has?.(idx) === true;

  // Precompute distance to boundary to keep flips in a coastal band.
  const isBoundaryIdx = (idx) => {
    const tk = tiles[idx].tile_kind;
    if (tk === "void") return false;
    for (const n of neighborsOfIdx(idx)) {
      const ntk = tiles[n].tile_kind;
      if (tk === "land" && ntk === "sea") return true;
      if (tk === "sea" && ntk === "land") return true;
    }
    return false;
  };

  const dist = new Int16Array(tiles.length);
  dist.fill(-1);
  const q = [];
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i].tile_kind === "void") continue;
    if (isBoundaryIdx(i)) {
      dist[i] = 0;
      q.push(i);
    }
  }
  for (let qi = 0; qi < q.length; qi++) {
    const cur = q[qi];
    const cd = dist[cur];
    if (cd >= coastalBand) continue;
    for (const n of neighborsOfIdx(cur)) {
      if (tiles[n].tile_kind === "void") continue;
      if (dist[n] !== -1) continue;
      dist[n] = cd + 1;
      q.push(n);
    }
  }

  const canFlipLandToSea = (idx) => {
    if (tiles[idx].tile_kind !== "land") return false;
    if (isProtected(idx)) return false;
    const d = dist[idx];
    if (d < 0 || d > coastalBand) return false;
    // must have adjacent sea
    let hasSea = false;
    for (const nb of neighborsOfIdx(idx)) {
      if (tiles[nb].tile_kind === "sea") { hasSea = true; break; }
    }
    return hasSea;
  };

  let breaks = 0;

  // Iterate until we meet the threshold or hit break limit.
  for (let iter = 0; iter < 6 && breaks < maxBreaks; iter++) {
    const metrics = computeCoastStraightRunMetrics({ tiles, width, height, maxRun });
    const maxOverall = metrics.max_straight_run_overall;
    if (maxOverall <= maxRun) {
      return { ...metrics, coast_breaks_applied: breaks, warning_unmet: false };
    }

    // For each direction with long runs, break them deterministically.
    for (let d = 0; d < 6 && breaks < maxBreaks; d++) {
      const runMax = metrics.max_straight_run_by_dir[d];
      if (runMax <= maxRun) continue;

      const tA = (d + 1) % 6;
      const tB = (d + 5) % 6;
      const visited = new Set();

      for (let idx = 0; idx < tiles.length && breaks < maxBreaks; idx++) {
        if (!isBoundaryLandEdge(tiles, idx, d, width, height)) continue;
        const key = `${idx}|${d}`;
        if (visited.has(key)) continue;

        // find run start
        let start = idx;
        for (;;) {
          const prev = neighborByDirIdx(start, tB, width, height);
          if (prev < 0) break;
          if (!isBoundaryLandEdge(tiles, prev, d, width, height)) break;
          start = prev;
        }

        // collect run tiles
        const run = [];
        let cur = start;
        for (;;) {
          if (!isBoundaryLandEdge(tiles, cur, d, width, height)) break;
          visited.add(`${cur}|${d}`);
          run.push(cur);
          const nxt = neighborByDirIdx(cur, tA, width, height);
          if (nxt < 0) break;
          if (!isBoundaryLandEdge(tiles, nxt, d, width, height)) break;
          cur = nxt;
        }

        if (run.length <= maxRun) continue;

        // Break every maxRun tiles: flip a land tile near the middle of each segment.
        for (let k = maxRun; k < run.length && breaks < maxBreaks; k += maxRun) {
          const mid = Math.min(run.length - 1, k + Math.floor(maxRun / 2));
          const candidate = run[mid];
          const h = hash3u32(seedU32, candidate >>> 0, (d + 17) >>> 0);
          const pick = run[h % run.length];

          const toFlip = canFlipLandToSea(pick) ? pick : (canFlipLandToSea(candidate) ? candidate : -1);
          if (toFlip >= 0) {
            tiles[toFlip].tile_kind = "sea";
            breaks++;
          }
        }
      }
    }
  }

  const final = computeCoastStraightRunMetrics({ tiles, width, height, maxRun });
  return { ...final, coast_breaks_applied: breaks, warning_unmet: final.max_straight_run_overall > maxRun };
}
