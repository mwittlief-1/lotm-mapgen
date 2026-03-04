/*
  Render a quick pixel-grid preview PNG for a single generated map.

  Usage:
    node scripts/renderOnePreviewV1.mjs \
      --in=path/to/map.json \
      --out=path/to/preview.png \
      --mode=terrain_counties

    Or render a *single layer* (transparent background):
      node scripts/renderOnePreviewV1.mjs \
        --in=path/to/map.json \
        --out=path/to/layer_hydrology.png \
        --layer=hydrology

  Modes:
    - terrain
    - counties
    - terrain_counties (terrain + county tint overlay)
*/

import fs from "fs";
import path from "path";

import { writePngRGBA } from "./pngWrite.mjs";
import { parseArgs } from "./mapLibV1.mjs";
import { axialToPixel, buildHexStamp, paintDot, paintHexStamp, paintLine } from "./hexRasterV1.mjs";
import { buildRenderContext, renderLayer } from "./mapPreviewLayersV1.mjs";

function pastelFromId(id) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const r = 140 + (h & 0x3f);
  const g = 140 + ((h >>> 6) & 0x3f);
  const b = 140 + ((h >>> 12) & 0x3f);
  return [r, g, b, 255];
}

function colorForTerrain(t) {
  switch (t) {
    case "sea": return [40, 80, 160, 255];
    case "lake": return [60, 120, 190, 255];
    case "coast": return [120, 150, 190, 255];
    case "plains": return [120, 170, 90, 255];
    case "forest": return [50, 120, 60, 255];
    case "hills": return [120, 120, 70, 255];
    case "marsh": return [80, 120, 90, 255];
    case "mountains": return [140, 140, 140, 255];
    default: return [160, 160, 160, 255];
  }
}

function blendRGBA(a, b, alpha) {
  const ia = 1 - alpha;
  return [
    Math.round(a[0] * ia + b[0] * alpha),
    Math.round(a[1] * ia + b[1] * alpha),
    Math.round(a[2] * ia + b[2] * alpha),
    255
  ];
}

function renderPreview({ map, mode, outPath }) {
  // Axial hex rendering (pointy-top) instead of cartesian q/r squares.
  // Keep this modest for batch previews.
  const size = 4;
  const stamp = buildHexStamp(size);

  // Compute bounds from non-void tiles (land+sea) to avoid the outer storage rectangle.
  const centers = new Array(map.hexes.length);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < map.hexes.length; i++) {
    const h0 = map.hexes[i];
    const p = axialToPixel(h0.q, h0.r, size);
    centers[i] = p;
    if (h0.tile_kind === "void") continue;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
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

  const buf = Buffer.alloc(w * h * 4);

  // Background: void/parchment.
  for (let i = 0; i < buf.length; i += 4) {
    buf[i + 0] = 235;
    buf[i + 1] = 235;
    buf[i + 2] = 235;
    buf[i + 3] = 255;
  }

  const countyColor = new Map();
  for (const c of (map.counties ?? [])) countyColor.set(c.county_id, pastelFromId(c.county_id));

  const NEIGHBOR_LAND = [206, 198, 182, 255]; // distinct from default gray

  for (let i = 0; i < map.hexes.length; i++) {
    const hex = map.hexes[i];
    if (hex.tile_kind === "void") continue;

    const p = centers[i];
    const cx = p.x - pxMin;
    const cy = p.y - pyMin;
    const x0 = Math.round(cx) + stamp.minX;
    const y0 = Math.round(cy) + stamp.minY;

    let rgba;
    if (mode === "counties") {
      if (hex.tile_kind === "sea") rgba = [35, 70, 150, 255];
      else if (hex.tile_kind === "land" && !hex.county_id) rgba = NEIGHBOR_LAND;
      else rgba = countyColor.get(hex.county_id ?? "") ?? [200, 200, 200, 255];
    } else if (mode === "terrain_counties") {
      rgba = colorForTerrain(hex.terrain);

      if (hex.tile_kind === "land") {
        if (hex.county_id) {
          const cc = countyColor.get(hex.county_id) ?? [200, 200, 200, 255];
          rgba = blendRGBA(rgba, cc, 0.38);
        } else {
          // Outside-kingdom land: subtle wash so it reads distinct without hiding terrain.
          rgba = blendRGBA(rgba, NEIGHBOR_LAND, 0.28);
        }
      }
    } else {
      rgba = colorForTerrain(hex.terrain);
    }

    paintHexStamp(buf, w, h, x0, y0, stamp, rgba);
  }

  // Hydrology overlay: render major rivers as connected line segments + nodes.
  if (mode !== "counties") {
    const col = [0, 80, 180, 255];
    const dirs = [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1]
    ];

    for (let i = 0; i < map.hexes.length; i++) {
      const a = map.hexes[i];
      if (a.tile_kind !== "land") continue;
      if (a.hydrology?.river_class !== "major") continue;
      const pa = centers[i];
      const ax = Math.round(pa.x - pxMin);
      const ay = Math.round(pa.y - pyMin);
      for (const [dq, dr] of dirs) {
        const nq = a.q + dq;
        const nr = a.r + dr;
        if (nq < 0 || nq >= map.width || nr < 0 || nr >= map.height) continue;
        const j = nr * map.width + nq;
        if (j <= i) continue;
        const b = map.hexes[j];
        if (!b || b.tile_kind !== "land") continue;
        if (b.hydrology?.river_class !== "major") continue;
        const pb = centers[j];
        const bx = Math.round(pb.x - pxMin);
        const by = Math.round(pb.y - pyMin);
        paintLine(buf, w, h, ax, ay, bx, by, 1, col);
      }
    }

    for (let i = 0; i < map.hexes.length; i++) {
      const a = map.hexes[i];
      if (a.tile_kind !== "land") continue;
      if (a.hydrology?.river_class !== "major") continue;
      const p = centers[i];
      const cx = Math.round(p.x - pxMin);
      const cy = Math.round(p.y - pyMin);
      paintDot(buf, w, h, cx, cy, 2, col);
    }
  }

  writePngRGBA({ filepath: outPath, width: w, height: h, rgba: buf });
}

const args = parseArgs(process.argv.slice(2));
const inPath = String(args.in ?? args.input ?? "");
const outPath = String(args.out ?? "");
const mode = String(args.mode ?? "terrain_counties");
const layer = args.layer ? String(args.layer) : null;

if (!inPath || !outPath) {
  console.error("Usage: node scripts/renderOnePreviewV1.mjs --in=map.json --out=preview.png [--mode=terrain_counties]");
  process.exit(2);
}

const raw = fs.readFileSync(inPath, "utf8");
const map = JSON.parse(raw);

fs.mkdirSync(path.dirname(outPath), { recursive: true });

if (layer) {
  // Layer render path (preferred for gallery-style inspection)
  // Precompute deterministic county colors for political layer.
  const countyColor = new Map();
  for (const c of map.counties ?? []) countyColor.set(c.county_id, pastelFromId(c.county_id));
  map._countyColor = countyColor;
  const ctx = buildRenderContext(map, { size: 4, includeBoundaryVoid: true });
  const rgba = renderLayer({ map, ctx, layer, overlay: null });
  writePngRGBA({ filepath: outPath, width: ctx.w, height: ctx.h, rgba });
} else {
  renderPreview({ map, mode, outPath });
}

console.log(`Wrote ${outPath}`);
