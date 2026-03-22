import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const QA_RUNS = path.join(ROOT, "qa_runs");
const SEED_BATCH = path.join(QA_RUNS, "map_seed_batch");
const DIST = path.join(ROOT, "dist");
const MIN_SUCCESS = Number.parseInt(process.env.MIN_SUCCESS ?? "8", 10) || 8;

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...(options.env ?? {}) }
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function rimraf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyDir(src, dst) {
  await ensureDir(dst);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

function buildSeedRow(seed) {
  const base = `map_seed_batch/${encodeURIComponent(seed.seed)}`;
  const status = seed?.failure_reason ? `<strong>failed</strong>: ${esc(seed.failure_reason)}` : "<strong>ok</strong>";
  const mapLink = seed?.missing_output ? "map unavailable" : `<a href="/${base}/map_v1.json">map</a>`;
  const validateLink = `<a href="/${base}/map_validate_report.json">validate</a>`;
  return `<li>${esc(seed.seed)} — ${status} — ${mapLink} — ${validateLink}</li>`;
}

async function main() {
  // 1) Generate the seed batch in thresholded non-failhard mode for deploys.
  run(
    "node",
    [
      "scripts/mapBatchV1.mjs",
      "--nonFailHard=1",
      `--minSuccess=${MIN_SUCCESS}`,
      "--syntaxPreflight=1"
    ],
    { env: { MAP_BATCH_NON_FAILHARD: "1", MAP_BATCH_MIN_SUCCESS: String(MIN_SUCCESS), MAP_BATCH_SYNTAX_PREFLIGHT: "1" } }
  );

  const summaryPath = path.join(SEED_BATCH, "seed_batch_summary.json");
  const summary = await readJson(summaryPath);
  const missingArtifactMessages = [];
  for (const seed of summary?.seeds ?? []) {
    if (seed?.failure_reason) continue;
    const required = [
      seed?.paths?.map,
      seed?.paths?.thumb_png,
      seed?.paths?.layer_mask_png,
      seed?.paths?.layer_terrain_png,
      seed?.paths?.layer_elevation_png,
      seed?.paths?.layer_political_png,
      seed?.paths?.layer_hydrology_png,
      seed?.paths?.layer_macro_png,
      seed?.paths?.layer_seats_png,
    ].filter(Boolean);
    const missing = [];
    for (const p of required) {
      try {
        await fs.access(path.resolve(ROOT, p));
      } catch {
        missing.push(path.basename(p));
      }
    }
    if (seed?.missing_output || missing.length > 0) {
      missingArtifactMessages.push(`${seed?.seed ?? "unknown"}: missing_output=${seed?.missing_output} missing=[${missing.join(", ")}]`);
    }
  }
  if (missingArtifactMessages.length > 0) {
    throw new Error(`map:publish refusing to write gallery index because successful seeds are missing required artifacts:\n${missingArtifactMessages.join("\n")}`);
  }

  const summaryPath = path.join(SEED_BATCH, "seed_batch_summary.json");
  const summary = await readJson(summaryPath);
  const missingArtifactMessages = [];
  for (const seed of summary?.seeds ?? []) {
    const required = [
      seed?.paths?.map,
      seed?.paths?.thumb_png,
      seed?.paths?.layer_mask_png,
      seed?.paths?.layer_terrain_png,
      seed?.paths?.layer_elevation_png,
      seed?.paths?.layer_political_png,
      seed?.paths?.layer_hydrology_png,
      seed?.paths?.layer_macro_png,
      seed?.paths?.layer_seats_png,
    ].filter(Boolean);
    const missing = [];
    for (const p of required) {
      try {
        await fs.access(path.resolve(ROOT, p));
      } catch {
        missing.push(path.basename(p));
      }
    }
    if (seed?.missing_output || missing.length > 0) {
      missingArtifactMessages.push(`${seed?.seed ?? "unknown"}: missing_output=${seed?.missing_output} missing=[${missing.join(", ")}]`);
    }
  }
  if (missingArtifactMessages.length > 0) {
    throw new Error(`map:publish refusing to write gallery index because required per-seed artifacts are missing:\n${missingArtifactMessages.join("\n")}`);
  }

  // 2) Build a static dist/ that Vercel can serve (no Vite required)
  await rimraf(DIST);
  await ensureDir(path.join(DIST, "map_seed_batch"));

  // Copy the generated batch artifacts into dist
  await copyDir(SEED_BATCH, path.join(DIST, "map_seed_batch"));

  const successfulSeeds = (summary?.seeds ?? []).filter((seed) => !seed?.failure_reason);
  const failedSeeds = (summary?.seeds ?? []).filter((seed) => !!seed?.failure_reason);
  const successfulRows = successfulSeeds.map(buildSeedRow).join("\n") || "<li>None</li>";
  const failedRows = failedSeeds.map(buildSeedRow).join("\n") || "<li>None</li>";

  const indexHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>LoTM MapGen Gallery Index</title>
  <style>body{font-family:system-ui,Arial,sans-serif;margin:24px} li{margin:6px 0}</style>
</head>
<body>
  <h1>LoTM MapGen Gallery Index</h1>
  <p><a href="/map_seed_batch/seed_gallery.html">Seed gallery page</a></p>
  <p>Validated successes: ${esc(summary?.success_count ?? 0)} / ${esc(summary?.seeds?.length ?? 0)} (minimum required: ${esc(summary?.min_success_required ?? MIN_SUCCESS)})</p>
  <h2>Successful seeds</h2>
  <ul>
    ${successfulRows}
  </ul>
  <h2>Failed seeds</h2>
  <ul>
    ${failedRows}
  </ul>
</body>
</html>`;

  await fs.writeFile(path.join(DIST, "map_gallery_index.html"), indexHtml, "utf8");

  console.log("map:publish OK — wrote dist/map_gallery_index.html and dist/map_seed_batch/seed_gallery.html");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
