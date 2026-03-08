#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const srcRoot = path.resolve(ROOT, "qa_runs", "map_seed_batch");
const publicDstRoot = path.resolve(ROOT, "public", "map_seed_batch");
const distDstRoot = path.resolve(ROOT, "dist", "map_seed_batch");

const runBatch = !process.argv.includes("--no-batch");

function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dst, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

if (runBatch) {
  const batchScript = path.resolve(ROOT, "scripts", "mapBatchV1.mjs");
  const res = spawnSync(process.execPath, [batchScript], { stdio: "inherit" });
  if (res.error) {
    console.error(`[map:publish] failed to run map batch: ${res.error.message}`);
    process.exit(1);
  }
  if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);
}

if (!fs.existsSync(srcRoot)) {
  console.error(`[map:publish] source not found: ${srcRoot}`);
  console.error("Run `npm run map:batch` first, or omit --no-batch.");
  process.exit(1);
}

for (const dstRoot of [publicDstRoot, distDstRoot]) {
  if (fs.existsSync(dstRoot)) fs.rmSync(dstRoot, { recursive: true, force: true });
  copyRecursive(srcRoot, dstRoot);

  const gallery = path.join(dstRoot, "seed_gallery.html");
  if (!fs.existsSync(gallery)) {
    console.error(`[map:publish] gallery missing after publish: ${gallery}`);
    process.exit(1);
  }
}

const indexHtml = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=/map_seed_batch/seed_gallery.html"><title>Map Gallery</title><p>Redirecting to <a href="/map_seed_batch/seed_gallery.html">map gallery</a>…</p>`;
fs.writeFileSync(path.resolve(ROOT, "public", "map_gallery_index.html"), indexHtml);
fs.mkdirSync(path.resolve(ROOT, "dist"), { recursive: true });
fs.writeFileSync(path.resolve(ROOT, "dist", "map_gallery_index.html"), indexHtml);

console.log(`[map:publish] published gallery to ${publicDstRoot}`);
console.log(`[map:publish] mirrored gallery to ${distDstRoot}`);
console.log(`[map:publish] hosted path: /map_seed_batch/seed_gallery.html`);
console.log(`[map:publish] convenience index: /map_gallery_index.html`);
