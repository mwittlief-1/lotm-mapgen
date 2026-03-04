#!/usr/bin/env node
/**
 * assets:validate — validates assets/asset_manifest_v1.json exists and is complete.
 *
 * Contract:
 * - Source of truth: assets/asset_manifest_v1.json
 * - required_keys.P0 and required_keys.MapP0 must all exist in assets
 * - All referenced asset paths must exist on disk
 * - fallbacks and kind_icon_map must reference valid asset keys
 */
import fs from "node:fs";
import path from "node:path";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function validateManifest(manifestPath) {
  const errors = [];
  const warnings = [];

  const pushErr = (m, ctx) => errors.push({ message: m, ...(ctx ? { ctx } : {}) });
  const pushWarn = (m, ctx) => warnings.push({ message: m, ...(ctx ? { ctx } : {}) });

  if (!fs.existsSync(manifestPath)) {
    pushErr("asset manifest missing", { manifestPath });
    return { errors, warnings };
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (e) {
    pushErr("failed to parse asset manifest JSON", { manifestPath, error: String(e) });
    return { errors, warnings };
  }

  if (manifest.schema_version !== "asset_manifest_v1") pushErr("schema_version must be asset_manifest_v1", { got: manifest.schema_version });

  const assets = manifest.assets;
  if (!assets || typeof assets !== "object") pushErr("assets must be object");

  const required_keys = manifest.required_keys;
  if (!required_keys || typeof required_keys !== "object") pushErr("required_keys must be object");

  const requiredSets = ["P0", "MapP0"];
  for (const setName of requiredSets) {
    const arr = required_keys?.[setName];
    if (!Array.isArray(arr)) {
      pushErr(`required_keys.${setName} must be array`);
      continue;
    }
    for (const k of arr) {
      if (typeof k !== "string") {
        pushErr(`required_keys.${setName} contains non-string`, { key: k });
        continue;
      }
      if (!assets?.[k]) pushErr(`missing required asset key: ${k}`, { set: setName });
    }
  }

  // fallbacks
  const fallbacks = manifest.fallbacks;
  if (!fallbacks || typeof fallbacks !== "object") pushErr("fallbacks must be object");
  else {
    for (const [k, v] of Object.entries(fallbacks)) {
      if (typeof v !== "string" || !v) pushErr("fallback value must be string", { fallback: k, value: v });
      else if (!assets?.[v]) pushErr("fallback references missing asset key", { fallback: k, asset_key: v });
    }
  }

  // kind_icon_map
  const kindMap = manifest.kind_icon_map;
  if (!kindMap || typeof kindMap !== "object") pushErr("kind_icon_map must be object");
  else {
    for (const [kind, assetKey] of Object.entries(kindMap)) {
      if (typeof assetKey !== "string" || !assetKey) {
        pushErr("kind_icon_map value must be string", { kind, assetKey });
        continue;
      }
      if (!assets?.[assetKey]) {
        // Special case: optional tokens may be present, but still must exist if referenced.
        pushErr("kind_icon_map references missing asset key", { kind, asset_key: assetKey });
      }
    }

    // Lock the taxonomy strings to prevent drift.
    const expectedKinds = ["seat", "hamlet", "village", "town", "market", "abbey", "bishopric", "port", "archdiocese", "_fallback"];
    for (const k of expectedKinds) {
      if (!(k in kindMap)) pushWarn("kind_icon_map missing expected kind", { kind: k });
    }
  }

  // Validate each asset path exists
  if (assets && typeof assets === "object") {
    for (const [key, entry] of Object.entries(assets)) {
      if (!entry || typeof entry !== "object") {
        pushErr("asset entry must be object", { key });
        continue;
      }
      const p = entry.path;
      if (typeof p !== "string" || !p) {
        pushErr("asset entry.path must be non-empty string", { key });
        continue;
      }
      const abs = path.resolve(p);
      if (!fs.existsSync(abs)) {
        pushErr("asset file missing on disk", { key, path: p });
      }
      const t = entry.type;
      if (typeof t !== "string" || !t) pushWarn("asset entry.type missing", { key });
    }
  }

  return { errors, warnings };
}

const manifestPath = path.resolve("assets/asset_manifest_v1.json");
const { errors, warnings } = validateManifest(manifestPath);

const report = {
  gate: "assets_validate",
  manifest_path: "assets/asset_manifest_v1.json",
  ok: errors.length === 0,
  errors,
  warnings,
  generated_at: new Date().toISOString()
};

const outPath = path.resolve("qa_artifacts/assets_validate/report.json");
writeJson(outPath, report);

if (!report.ok) {
  console.error(`assets:validate FAIL — see ${outPath}`);
  for (const e of errors.slice(0, 12)) console.error(" -", e.message);
  process.exit(1);
}

console.log(`assets:validate OK — ${outPath}`);
process.exit(0);
