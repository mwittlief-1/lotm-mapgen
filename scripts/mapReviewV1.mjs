#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const batchScript = path.resolve("scripts", "mapBatchV1.mjs");
const batchRun = spawnSync(process.execPath, [batchScript], { stdio: "inherit" });
if (typeof batchRun.status === "number" && batchRun.status !== 0) {
  process.exit(batchRun.status);
}
if (batchRun.error) {
  console.error(`[map:review] Failed to run batch script: ${batchRun.error.message}`);
  process.exit(1);
}

const candidates = [
  path.resolve("qa_runs", "map_seed_batch", "seed_gallery.html"),
  path.resolve("qa_runs", "gallery", "index.html")
];

const galleryPath = candidates.find((candidate) => fs.existsSync(candidate));
if (!galleryPath) {
  console.log("[map:review] Gallery HTML not found. Checked:");
  for (const candidate of candidates) console.log(`- ${candidate}`);
  process.exit(0);
}

console.log(`[map:review] Gallery: ${galleryPath}`);

let openCmd;
let openArgs;
if (process.platform === "darwin") {
  openCmd = "open";
  openArgs = [galleryPath];
} else if (process.platform === "win32") {
  openCmd = "cmd";
  openArgs = ["/c", "start", "", galleryPath];
} else {
  openCmd = "xdg-open";
  openArgs = [galleryPath];
}

const opened = spawnSync(openCmd, openArgs, { stdio: "ignore" });
if (opened.error || opened.status !== 0) {
  const reason = opened.error ? opened.error.message : `exit code ${opened.status}`;
  console.log(`[map:review] Could not open browser automatically (${reason}).`);
  console.log("[map:review] Open the gallery manually using the path above.");
}

process.exit(0);
