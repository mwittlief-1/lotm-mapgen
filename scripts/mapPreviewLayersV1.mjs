// Map preview rendering — layered PNG outputs (M3).
//
// Goals:
//  - Deterministic axial/hex rendering
//  - Separate inspectable layers (mask / political / terrain / elevation / hydrology / macro / seats)
//  - Layers are rendered with transparent backgrounds so the gallery can stack/toggle them.

import { assert } from "./mapLibV1.mjs";
import { axialToPixel, buildHexStamp, paintDot, paintHexStamp, paintLine } from "./hexRasterV1.mjs";

const DIRS_QR = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1]
];

function inBounds(q, r, w, h) {
  return q >= 0 && q < w && r >= 0 && r < h;
}

function idxOf(q, r, w) {
  return r * w + q;
}

export function pastelFromId(id, hashStringToU32) {
  const u = hashStringToU32(id);
  const r = (u & 255);
  const g = ((u >>> 8) & 255);
  const b = ((u >>> 16) & 255);
  const mix = (c) => Math.floor((c * 0.55) + (255 * 0.45));
  return [mix(r), mix(g), mix(b), 255];
}

export function colorForTerrain(t) {
  switch (t) {
    case "sea": return [40, 80, 160, 255];
    case "lake": return [60, 120, 190, 255];
    case "coast": return [120, 150, 190, 255];
    case "plains": return [120, 170, 90, 255];
    case "forest": return [50, 120, 60, 255];
    case "hills": return [120, 120, 70, 255];
    case "marsh": return [90, 120, 110, 255];
    case "mountains": return [120, 120, 130, 255];
    default: return [160, 160, 160, 255];
  }
}

export function elevationGrayFromTerrain(t) {
  // M3 elevation layer is a *visual proxy* derived from terrain class.
  // (We can promote to a stored numeric height field later if/when needed.)
  let v;
  switch (t) {
    case "mountains": v = 230; break;
    case "hills": v = 185; break;
    case "forest": v = 145; break;
    case "plains": v = 135; break;
    case "marsh": v = 110; break;
    case "coast": v = 105; break;
    case "lake": v = 95; break;
    default: v = 130; break;
  }
  return [v, v, v, 220];
}

export function buildRenderContext(map, { size = 4, includeBoundaryVoid = true } = {}) {
  assert(map && Array.isArray(map.hexes), "buildRenderContext: invalid map");

  const stamp = buildHexStamp(size);
  const centers = new Array(map.hexes.length);

  // Identify boundary void (void tiles adjacent to any non-void tile).
  const boundaryVoid = new Uint8Array(map.hexes.length);
  if (includeBoundaryVoid) {
    for (let i = 0; i < map.hexes.length; i++) {
      const h0 = map.hexes[i];
      if (h0.tile_kind !== "void") continue;
      const q0 = h0.q;
      const r0 = h0.r;
      let isBoundary = false;
      for (const [dq, dr] of DIRS_QR) {
        const q1 = q0 + dq;
        const r1 = r0 + dr;
        if (!inBounds(q1, r1, map.width, map.height)) continue;
        const j = idxOf(q1, r1, map.width);
        const h1 = map.hexes[j];
        if (h1 && h1.tile_kind !== "void") { isBoundary = true; break; }
      }
      if (isBoundary) boundaryVoid[i] = 1;
    }
  }

  // Compute bounds from non-void tiles plus boundary-void ring.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < map.hexes.length; i++) {
    const h0 = map.hexes[i];
    const p = axialToPixel(h0.q, h0.r, size);
    centers[i] = p;

    if (h0.tile_kind !== "void" || boundaryVoid[i] === 1) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }

  if (!Number.isFinite(minX)) {
    minX = 0; maxX = 0; minY = 0; maxY = 0;
  }

  const pad = Math.max(2, Math.ceil(size * 2));
  const pxMin = Math.floor(minX + stamp.minX) - pad;
  const pxMax = Math.ceil(maxX + stamp.maxX) + pad;
  const pyMin = Math.floor(minY + stamp.minY) - pad;
  const pyMax = Math.ceil(maxY + stamp.maxY) + pad;
  const w = Math.max(1, (pxMax - pxMin + 1));
  const h = Math.max(1, (pyMax - pyMin + 1));

  return { size, stamp, centers, boundaryVoid, pxMin, pyMin, w, h };
}

function paintHexAtIdx({ map, ctx, idx, rgba, buf }) {
  const p = ctx.centers[idx];
  const cx = p.x - ctx.pxMin;
  const cy = p.y - ctx.pyMin;
  const x0 = Math.round(cx) + ctx.stamp.minX;
  const y0 = Math.round(cy) + ctx.stamp.minY;
  paintHexStamp(buf, ctx.w, ctx.h, x0, y0, ctx.stamp, rgba);
}

export function renderLayer({ map, ctx, layer, overlay = null }) {
  const buf = Buffer.alloc(ctx.w * ctx.h * 4);
  // default: fully transparent

  // Palette choices for M3 inspection.
  const VOID = [25, 25, 25, 255];
  const SEA = [25, 70, 160, 255];
  const KINGDOM_LAND = [230, 226, 214, 255];
  const NEIGHBOR_LAND = [85, 85, 85, 255]; // bold, non-overlapping with terrain/politics

  if (layer === "mask") {
    for (let i = 0; i < map.hexes.length; i++) {
      const h0 = map.hexes[i];
      if (h0.tile_kind === "void") {
        // IMPORTANT: In M3, the area *outside the selected kingdom mask* (but still inside
        // the rendered bounds) may be marked as tile_kind="void" by remask.
        // For inspection, we want that region to be *visible* as "external realm context"
        // rather than transparent background.
        //
        // Policy:
        //  - Paint ALL void tiles inside bounds as NEIGHBOR_LAND (external context)
        //  - If a void tile is on the boundary between void and non-void, paint a darker
        //    outline color to make the boundary crisp.
        paintHexAtIdx({ map, ctx, idx: i, rgba: NEIGHBOR_LAND, buf });
        if (ctx.boundaryVoid[i] === 1) paintHexAtIdx({ map, ctx, idx: i, rgba: VOID, buf });
        continue;
      }
      if (h0.tile_kind === "sea") {
        paintHexAtIdx({ map, ctx, idx: i, rgba: SEA, buf });
        continue;
      }
      // land
      if (!h0.county_id) paintHexAtIdx({ map, ctx, idx: i, rgba: NEIGHBOR_LAND, buf });
      else paintHexAtIdx({ map, ctx, idx: i, rgba: KINGDOM_LAND, buf });
    }
    return buf;
  }

  if (layer === "terrain") {
    for (let i = 0; i < map.hexes.length; i++) {
      const h0 = map.hexes[i];
      if (h0.tile_kind === "void") continue;
      // Terrain layer is full-coverage for non-void so it can stand alone.
      const rgba = colorForTerrain(h0.terrain);
      paintHexAtIdx({ map, ctx, idx: i, rgba, buf });
    }
    return buf;
  }

  if (layer === "elevation") {
    for (let i = 0; i < map.hexes.length; i++) {
      const h0 = map.hexes[i];
      if (h0.tile_kind !== "land") continue;
      // Elevation should cover all in-world land, including borderlands outside counties.
      const rgba = elevationGrayFromTerrain(h0.terrain);
      paintHexAtIdx({ map, ctx, idx: i, rgba, buf });
    }
    return buf;
  }

  if (layer === "political") {
    // Semi-transparent county tint, meant to overlay terrain/elevation.
    // Caller may provide map._countyColor (Map<string,[r,g,b,a]>).
    const countyColor = map._countyColor;
    for (let i = 0; i < map.hexes.length; i++) {
      const h0 = map.hexes[i];
      if (h0.tile_kind !== "land") continue;
      if (!h0.county_id) continue;
      const c = (countyColor && countyColor.get(h0.county_id)) ? countyColor.get(h0.county_id) : [200, 200, 200, 255];
      const rgba = [c[0], c[1], c[2], 190];
      paintHexAtIdx({ map, ctx, idx: i, rgba, buf });
    }
    return buf;
  }

  if (layer === "hydrology") {
    // Lakes + major river network (major + tributaries currently share river_class="major").
    const LAKE = [60, 140, 220, 255];
    for (let i = 0; i < map.hexes.length; i++) {
      const h0 = map.hexes[i];
      if (h0.tile_kind === "void") continue;
      if (h0.terrain === "lake" || h0.hydrology?.water_kind === "lake" || h0.hydrology?.water_kind === "border_river") {
        paintHexAtIdx({ map, ctx, idx: i, rgba: LAKE, buf });
      }
    }

    const col = [0, 80, 200, 255];

    // Lines between adjacent river tiles.
    for (let i = 0; i < map.hexes.length; i++) {
      const a = map.hexes[i];
      if (a.tile_kind !== "land") continue;
      if (a.hydrology?.river_class !== "major") continue;
      const pa = ctx.centers[i];
      const ax = Math.round(pa.x - ctx.pxMin);
      const ay = Math.round(pa.y - ctx.pyMin);
      for (const [dq, dr] of DIRS_QR) {
        const nq = a.q + dq;
        const nr = a.r + dr;
        if (!inBounds(nq, nr, map.width, map.height)) continue;
        const j = idxOf(nq, nr, map.width);
        if (j <= i) continue;
        const b = map.hexes[j];
        if (!b || b.tile_kind !== "land") continue;
        if (b.hydrology?.river_class !== "major") continue;
        const pb = ctx.centers[j];
        const bx = Math.round(pb.x - ctx.pxMin);
        const by = Math.round(pb.y - ctx.pyMin);
        paintLine(buf, ctx.w, ctx.h, ax, ay, bx, by, 1, col);
      }
    }
    // Nodes.
    for (let i = 0; i < map.hexes.length; i++) {
      const a = map.hexes[i];
      if (a.tile_kind !== "land") continue;
      if (a.hydrology?.river_class !== "major") continue;
      const p = ctx.centers[i];
      const cx = Math.round(p.x - ctx.pxMin);
      const cy = Math.round(p.y - ctx.pyMin);
      paintDot(buf, ctx.w, ctx.h, cx, cy, 2, col);
    }

    // Estuary markers.
    for (let i = 0; i < map.hexes.length; i++) {
      const h0 = map.hexes[i];
      if (h0.tile_kind !== "sea") continue;
      if (h0.hydrology?.water_kind !== "estuary") continue;
      const p = ctx.centers[i];
      const cx = Math.round(p.x - ctx.pxMin);
      const cy = Math.round(p.y - ctx.pyMin);
      paintDot(buf, ctx.w, ctx.h, cx, cy, 3, [0, 220, 255, 255]);
    }
    return buf;
  }

  if (layer === "macro") {
    if (!overlay) return buf;
    const paintIdx = (idx, col) => {
      if (idx < 0 || idx >= map.hexes.length) return;
      const h0 = map.hexes[idx];
      // Macro layer intentionally shows over void/sea/land alike.
      if (h0.tile_kind === "void" && ctx.boundaryVoid[idx] !== 1) return;
      paintHexAtIdx({ map, ctx, idx, rgba: [col[0], col[1], col[2], 230], buf });
    };
    const RIDGE = [200, 60, 210];
    const RIVER = [0, 210, 255];
    const FORD = [255, 220, 0];
    if (Array.isArray(overlay.ridge_idx)) for (const idx of overlay.ridge_idx) paintIdx(idx, RIDGE);
    if (Array.isArray(overlay.river_idx)) for (const idx of overlay.river_idx) paintIdx(idx, RIVER);
    if (Array.isArray(overlay.ford_idx)) for (const idx of overlay.ford_idx) paintIdx(idx, FORD);
    return buf;
  }

  if (layer === "seats") {
    if (!Array.isArray(map.seats)) return buf;

    const hexIdToIdx = new Map();
    for (let i = 0; i < map.hexes.length; i++) hexIdToIdx.set(map.hexes[i].hex_id, i);

    const paintIdx = (idx) => {
      if (idx < 0 || idx >= map.hexes.length) return;
      const h0 = map.hexes[idx];
      if (h0.tile_kind === "void") return;
      paintHexAtIdx({ map, ctx, idx, rgba: [0, 0, 0, 255], buf });
    };

    for (const s of map.seats) {
      const idx = hexIdToIdx.get(s.hex_id);
      if (idx == null) continue;
      paintIdx(idx);
      const q0 = map.hexes[idx].q;
      const r0 = map.hexes[idx].r;
      for (const [dq, dr] of DIRS_QR) {
        const q1 = q0 + dq;
        const r1 = r0 + dr;
        if (!inBounds(q1, r1, map.width, map.height)) continue;
        paintIdx(idxOf(q1, r1, map.width));
      }
    }

    // Temporary visual marker for external-kingdom tripoint placeholder.
    if (Number.isInteger(overlay?.tripoint_idx)) {
      const tIdx = overlay.tripoint_idx;
      if (tIdx >= 0 && tIdx < map.hexes.length && map.hexes[tIdx].tile_kind !== "void") {
        paintHexAtIdx({ map, ctx, idx: tIdx, rgba: [255, 0, 180, 255], buf });
      }
    }
    return buf;
  }

  return buf;
}
