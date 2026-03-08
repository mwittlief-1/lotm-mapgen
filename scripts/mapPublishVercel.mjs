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

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
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

async function main() {
  // 1) Generate the seed batch (no node_modules required)
  run("node", ["scripts/mapBatchV1.mjs"]);

  // 2) Build a static dist/ that Vercel can serve (no Vite required)
  await rimraf(DIST);
  await ensureDir(path.join(DIST, "map_seed_batch"));

  // Copy the generated batch artifacts into dist
  await copyDir(SEED_BATCH, path.join(DIST, "map_seed_batch"));

  // Index pages
  const seeds = (await fs.readdir(SEED_BATCH, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const rows = seeds
    .map((seed) => {
      const base = `map_seed_batch/${encodeURIComponent(seed)}`;
      return `<li><a href="/${base}/map_v1.json">${esc(seed)}</a> — <a href="/${base}/map_validate_report.json">validate</a></li>`;
    })
    .join("\n");

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
  <h2>Seeds</h2>
  <ul>
    ${rows}
  </ul>
</body>
</html>`;

  const galleryHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>LoTM MapGen Seed Gallery</title>
  <style>body{font-family:system-ui,Arial,sans-serif;margin:24px} li{margin:6px 0}</style>
</head>
<body>
  <h1>LoTM MapGen Seed Gallery</h1>
  <p><a href="/map_gallery_index.html">Back to index</a></p>
  <ul>
    ${rows}
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
