#!/usr/bin/env node
/**
 * Map v1 — Seed Batch Pack (M1.5)
 *
 * Usage:
 *   npm run map:batch -- --config=data/map/map_v1_config.json \
 *     --seeds=qa_artifacts/map_seed_batch/seeds_styles_ABC_v0_1.json \
 *     --out=qa_artifacts/map_seed_batch
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { assert, ensureDir, parseArgs, readJson, writeJson, hashStringToU32 } from "./mapLibV1.mjs";
import { writePngRGBA } from "./pngWrite.mjs";
import { buildRenderContext, pastelFromId, renderLayer } from "./mapPreviewLayersV1.mjs";

function nowUtcIso() {
  return new Date().toISOString();
}

function writeLayerPng({ map, ctx, layer, outPath, overlay }) {
  const rgba = renderLayer({ map, ctx, layer, overlay });
  ensureDir(path.dirname(outPath));
  writePngRGBA({ filepath: outPath, width: ctx.w, height: ctx.h, rgba });
}

function runNodeScript(scriptRel, args) {
  const node = process.execPath;
  const script = path.resolve("scripts", scriptRel);
  const res = spawnSync(node, [script, ...args], { stdio: "inherit" });
  return res.status === 0;
}

const args = parseArgs(process.argv.slice(2));
const configPath = String(args.config ?? "data/map/map_v1_config.json");
const seedsFile = String(args.seeds ?? "qa_artifacts/map_seed_batch/seeds_styles_ABC_v0_1.json");
const outRoot = String(args.out ?? "qa_artifacts/map_seed_batch");

assert(fs.existsSync(configPath), `config not found: ${configPath}`);
assert(fs.existsSync(seedsFile), `seeds file not found: ${seedsFile}`);

const seedsDoc = readJson(seedsFile);
assert(Array.isArray(seedsDoc?.seeds), "seeds file must have {seeds:[...]}" );
const seeds = seedsDoc.seeds.map(String);
assert(seeds.length === 15, `seed list must contain exactly 15 seeds; got ${seeds.length}`);
// Seed lists are allowed to vary per test batch; determinism is per-seed.

ensureDir(outRoot);

const summary = {
  schema_version: "map_seed_batch_summary_v1",
  config_path: configPath,
  seeds_file: seedsFile,
  generated_at_utc: nowUtcIso(),
  seeds: []
};

for (const seed of seeds) {
  const seedDir = path.join(outRoot, seed);
  ensureDir(seedDir);
  const mapOut = path.join(seedDir, "map_v1.json");
  const metricsOut = path.join(seedDir, "mapgen_metrics.json");
  const reportOut = path.join(seedDir, "map_validate_report.json");

  const genOk = runNodeScript("mapGenV1.mjs", [
    `--seed=${seed}`,
    `--config=${configPath}`,
    `--out=${mapOut}`,
    `--publicOut=${mapOut}`,
    `--metricsOut=${metricsOut}`,
    `--reportOut=${path.join(seedDir, "mapgen_report.json")}`
  ]);

  let validateOk = false;
  let warnings = [];
  let metrics = null;

  if (genOk) {
    validateOk = runNodeScript("mapValidateV1.mjs", [
      `--map=${mapOut}`,
      `--config=${configPath}`,
      `--metricsOut=${metricsOut}`,
      `--reportOut=${reportOut}`
    ]);
  }

  try {
    if (fs.existsSync(metricsOut)) metrics = JSON.parse(fs.readFileSync(metricsOut, "utf8"));
  } catch {}
  try {
    if (fs.existsSync(reportOut)) {
      const rep = JSON.parse(fs.readFileSync(reportOut, "utf8"));
      warnings = rep?.warnings ?? [];
    }
  } catch {}

  // Layer outputs (transparent backgrounds; intended to be stacked/toggled in gallery).
  const thumbPng = path.join(seedDir, "preview_thumb.png");
  const layerMaskPng = path.join(seedDir, "layer_mask.png");
  const layerTerrainPng = path.join(seedDir, "layer_terrain.png");
  const layerElevationPng = path.join(seedDir, "layer_elevation.png");
  const layerPoliticalPng = path.join(seedDir, "layer_political.png");
  const layerHydrologyPng = path.join(seedDir, "layer_hydrology.png");
  const layerMacroPng = path.join(seedDir, "layer_macro.png");
  const layerSeatsPng = path.join(seedDir, "layer_seats.png");

  if (validateOk) {
    const map = JSON.parse(fs.readFileSync(mapOut, "utf8"));

    // Precompute deterministic county colors for political layer.
    const countyColor = new Map();
    for (const c of map.counties ?? []) countyColor.set(c.county_id, pastelFromId(c.county_id, hashStringToU32));
    // Attach to map for renderLayer (not written to disk).
    map._countyColor = countyColor;

    // Read mapgen report for macro debug overlays (frontier rails).
    let overlay = null;
    try {
      const genReportPath = path.join(seedDir, "mapgen_report.json");
      if (fs.existsSync(genReportPath)) {
        const genRep = JSON.parse(fs.readFileSync(genReportPath, "utf8"));
        const f = genRep?.remask?.frontier;
        if (f && (Array.isArray(f.ridge_idx) || Array.isArray(f.river_idx) || Array.isArray(f.ford_idx))) {
          overlay = {
            ridge_idx: Array.isArray(f.ridge_idx) ? f.ridge_idx : [],
            river_idx: Array.isArray(f.river_idx) ? f.river_idx : [],
            ford_idx: Array.isArray(f.ford_idx) ? f.ford_idx : []
          };
        }
      }
    } catch {}

    const ctx = buildRenderContext(map, { size: 4, includeBoundaryVoid: true });

    // Thumb for quick scanning: just use the mask layer (high-contrast border + void).
    writeLayerPng({ map, ctx, layer: "mask", outPath: thumbPng, overlay });

    // Layer outputs
    writeLayerPng({ map, ctx, layer: "mask", outPath: layerMaskPng, overlay });
    writeLayerPng({ map, ctx, layer: "terrain", outPath: layerTerrainPng, overlay });
    writeLayerPng({ map, ctx, layer: "elevation", outPath: layerElevationPng, overlay });
    writeLayerPng({ map, ctx, layer: "political", outPath: layerPoliticalPng, overlay });
    writeLayerPng({ map, ctx, layer: "hydrology", outPath: layerHydrologyPng, overlay });
    writeLayerPng({ map, ctx, layer: "macro", outPath: layerMacroPng, overlay });
    writeLayerPng({ map, ctx, layer: "seats", outPath: layerSeatsPng, overlay });
  }

  const m = metrics?.counts ?? {};
  const coast = metrics?.coastline ?? {};
  const settlements = m?.settlement_counts ?? {};

  summary.seeds.push({
    seed,
    paths: {
      map: mapOut,
      metrics: metricsOut,
      thumb_png: thumbPng,
      layer_mask_png: layerMaskPng,
      layer_terrain_png: layerTerrainPng,
      layer_elevation_png: layerElevationPng,
      layer_political_png: layerPoliticalPng,
      layer_hydrology_png: layerHydrologyPng,
      layer_macro_png: layerMacroPng,
      layer_seats_png: layerSeatsPng
    },
    metrics: {
      land_hexes: m.land_hex_count,
      sea_hexes: m.sea_hex_count,
      void_hexes: m.void_hex_count,
      coast_share: coast.coastline_share,
      left_edge_coast_share: coast.left_edge_coast_share,
      avg_sea_neighbors_on_coast: coast.avg_sea_neighbors_on_coast,
      lake_count: metrics?.lakes?.lake_count,
      lake_hexes: metrics?.lakes?.lake_hex_count,
      lake_sizes: metrics?.lakes?.sizes_desc,
      water_access_radius: metrics?.water_access?.radius,
      water_access_within_any: metrics?.water_access?.within?.any,
      water_access_within_coast: metrics?.water_access?.within?.coast,
      water_access_within_river: metrics?.water_access?.within?.river,
      water_access_within_lake: metrics?.water_access?.within?.lake,
      county_count: m.county_count,
      market_count: settlements.market_total,
      compactness_avg: metrics?.derived?.county_compactness_avg,
      seat_spacing_min: metrics?.derived?.seat_spacing_min,
      seat_spacing_avg: metrics?.derived?.seat_spacing_avg
    },
    validate_pass: validateOk,
    warnings
  });
}

writeJson(path.join(outRoot, "seed_batch_summary.json"), summary);

// Optional gallery
const html = [
  "<!doctype html>",
  "<html><head><meta charset='utf-8'><title>LoM Map Seed Gallery</title>",
  "<style>body{font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:16px} .controls{position:sticky;top:0;background:#fff;padding:10px;border:1px solid #eee;border-radius:10px;margin-bottom:14px} .controls label{margin-right:12px;user-select:none} .grid{display:flex;flex-wrap:wrap;gap:14px} .card{border:1px solid #ddd;border-radius:10px;padding:10px;width:700px} .seed{font-weight:700;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center} .stack{position:relative;border:1px solid #eee;border-radius:8px;overflow:hidden;background:#fff} .stack img{position:absolute;left:0;top:0;width:100%;height:auto} .stack img.base{position:relative;visibility:hidden} .meta{font-size:12px;line-height:1.3;color:#333;margin-top:8px;white-space:pre-wrap}</style>",
  "</head><body>",
  "<h1>Map v1 Seed Batch</h1>",
  `<p>Generated at ${summary.generated_at_utc}</p>`,
  "<div class='controls'>",
  "<strong>Layers:</strong> ",
  "<label><input type='checkbox' data-layer='mask' checked> Mask</label>",
  "<label><input type='checkbox' data-layer='terrain' checked> Terrain</label>",
  "<label><input type='checkbox' data-layer='elevation'> Elevation</label>",
  "<label><input type='checkbox' data-layer='political' checked> Political</label>",
  "<label><input type='checkbox' data-layer='hydrology' checked> Hydrology</label>",
  "<label><input type='checkbox' data-layer='seats' checked> Seats</label>",
  "<label><input type='checkbox' data-layer='macro'> Macro (debug)</label>",
  "</div>",
  "<div class='grid'>"
];

for (const s of summary.seeds) {
  const rel = (p) => path.relative(outRoot, p).split(path.sep).join("/");
  html.push("<div class='card'>");
  html.push(`<div class='seed'><span>${s.seed}</span><a href='${rel(s.paths.map)}'>map.json</a></div>`);

  html.push("<div class='stack'>");
  // Spacer establishes the size; it is always present but hidden.
  html.push(`<img class='base' src='${rel(s.paths.layer_mask_png)}' alt='base'>`);
  html.push(`<img data-layer='mask' src='${rel(s.paths.layer_mask_png)}' alt='mask'>`);
  html.push(`<img data-layer='terrain' src='${rel(s.paths.layer_terrain_png)}' alt='terrain'>`);
  html.push(`<img data-layer='elevation' style='display:none' src='${rel(s.paths.layer_elevation_png)}' alt='elevation'>`);
  html.push(`<img data-layer='political' src='${rel(s.paths.layer_political_png)}' alt='political'>`);
  html.push(`<img data-layer='hydrology' src='${rel(s.paths.layer_hydrology_png)}' alt='hydrology'>`);
  html.push(`<img data-layer='seats' src='${rel(s.paths.layer_seats_png)}' alt='seats'>`);
  html.push(`<img data-layer='macro' style='display:none' src='${rel(s.paths.layer_macro_png)}' alt='macro'>`);
  html.push("</div>");
  html.push(`<div class='meta'>validate_pass: ${s.validate_pass}\ncoast_share: ${s.metrics.coast_share}\nmarket_count: ${s.metrics.market_count}\nland/sea/void: ${s.metrics.land_hexes}/${s.metrics.sea_hexes}/${s.metrics.void_hexes}</div>`);
  if (Array.isArray(s.warnings) && s.warnings.length) {
    html.push(`<div class='meta'>warnings:\n${s.warnings.map(w=>w.message ?? JSON.stringify(w)).join("\n")}</div>`);
  }
  html.push("</div>");
}

html.push("</div>");
html.push(`<script>
(function(){
  function sync(){
    document.querySelectorAll('.controls input[data-layer]').forEach(function(cb){
      var layer = cb.getAttribute('data-layer');
      var show = cb.checked;
      document.querySelectorAll('img[data-layer="' + layer + '"]').forEach(function(img){
        img.style.display = show ? 'block' : 'none';
      });
    });
  }
  document.querySelectorAll('.controls input[data-layer]').forEach(function(cb){
    cb.addEventListener('change', sync);
  });
  sync();
})();
</script>`);

html.push("</body></html>");

fs.writeFileSync(path.join(outRoot, "seed_gallery.html"), html.join("\n"));

console.log(`map:batch OK — wrote ${summary.seeds.length} seeds to ${outRoot}`);
