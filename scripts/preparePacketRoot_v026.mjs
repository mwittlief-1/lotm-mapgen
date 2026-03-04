#!/usr/bin/env node
/**
 * v0.2.6 Packet Root Preparer (Dev B)
 *
 * Creates a folder suitable to become the root of a playtest packet zip.
 * This is *packaging hygiene* only; it does not run the sim.
 *
 * Contract requires packet root contains:
 * - BUILD_INFO.json
 * - golden seeds file for app_version
 * - KNOBS_<app_version>.json
 * - KNOWN_ISSUES.md
 *
 * Optionally copies artifacts for the stamped app_version.
 *
 * Usage:
 *   node scripts/preparePacketRoot_v026.mjs
 *   node scripts/preparePacketRoot_v026.mjs --outdir=playtest_packet_root
 *   node scripts/preparePacketRoot_v026.mjs --includeArtifacts=1
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { outdir: "", includeArtifacts: false };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [kRaw, vRaw] = arg.slice(2).split("=");
    const k = String(kRaw || "").trim();
    const v = vRaw === undefined ? "1" : String(vRaw);
    if (!k) continue;
    if (k === "outdir") out.outdir = v;
    if (k === "includeArtifacts") out.includeArtifacts = v === "1" || v.toLowerCase() === "true";
  }
  return out;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function copyDirRecursive(srcDir, dstDir) {
  ensureDir(dstDir);
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name);
    const dst = path.join(dstDir, ent.name);
    if (ent.isDirectory()) copyDirRecursive(src, dst);
    else if (ent.isFile()) copyFile(src, dst);
  }
}

function loadBuildInfo() {
  try {
    const p = path.join(PROJECT_ROOT, "docs", "BUILD_INFO.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

async function getAppVersionStamp() {
  const bi = loadBuildInfo();
  if (bi?.app_version) return String(bi.app_version);
  try {
    const mod = await import(pathToFileURL(path.join(PROJECT_ROOT, "dist_batch", "src", "version.js")).href);
    if (mod?.APP_VERSION) return String(mod.APP_VERSION);
  } catch {
    // ignore
  }
  return "unknown";
}

function pickFirstExisting(paths) {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appVersion = await getAppVersionStamp();

  const outdir = args.outdir
    ? path.resolve(PROJECT_ROOT, args.outdir)
    : path.resolve(PROJECT_ROOT, `playtest_packet_root_${appVersion}`);

  ensureDir(outdir);

  // Required root files
  const buildInfoSrc = pickFirstExisting([
    path.join(PROJECT_ROOT, "docs", "BUILD_INFO.json"),
    path.join(PROJECT_ROOT, "BUILD_INFO.json")
  ]);
  if (!buildInfoSrc) throw new Error("Missing BUILD_INFO.json (expected docs/BUILD_INFO.json)");
  copyFile(buildInfoSrc, path.join(outdir, "BUILD_INFO.json"));

  const goldenSeedsSrc = pickFirstExisting([
    path.join(PROJECT_ROOT, "docs", `golden_seeds_${appVersion}.json`),
    path.join(PROJECT_ROOT, "docs", "golden_seeds_v0.2.6.json"),
    path.join(PROJECT_ROOT, "docs", "golden_seeds_v0.2.5.json"),
    path.join(PROJECT_ROOT, "docs", "golden_seeds_v0.2.2.json"),
    path.join(PROJECT_ROOT, "docs", "golden_seeds_v0.2.1.json")
  ]);
  if (!goldenSeedsSrc) throw new Error("Missing golden seeds file under docs/");
  copyFile(goldenSeedsSrc, path.join(outdir, path.basename(goldenSeedsSrc)));

  const knobsSrc = pickFirstExisting([
    path.join(PROJECT_ROOT, `KNOBS_${appVersion}.json`),
    path.join(PROJECT_ROOT, "docs", `KNOBS_${appVersion}.json`),
    path.join(PROJECT_ROOT, "docs", "KNOBS_v0.2.6.json")
  ]);
  if (!knobsSrc) throw new Error("Missing KNOBS file (expected KNOBS_<app_version>.json or docs/KNOBS_<app_version>.json)");
  copyFile(knobsSrc, path.join(outdir, path.basename(knobsSrc)));

  const issuesSrc = pickFirstExisting([
    path.join(PROJECT_ROOT, "KNOWN_ISSUES.md"),
    path.join(PROJECT_ROOT, "docs", "KNOWN_ISSUES.md")
  ]);
  if (!issuesSrc) throw new Error("Missing KNOWN_ISSUES.md (expected docs/KNOWN_ISSUES.md)");
  copyFile(issuesSrc, path.join(outdir, "KNOWN_ISSUES.md"));

  // Optional: include artifacts tree for this app_version
  if (args.includeArtifacts) {
    const artSrc = path.join(PROJECT_ROOT, "artifacts", appVersion);
    if (!fs.existsSync(artSrc)) {
      console.warn(`[packet-root] artifacts folder not found: ${artSrc}`);
    } else {
      console.log(`[packet-root] copying artifacts/${appVersion} -> ${path.join(outdir, "artifacts", appVersion)}`);
      copyDirRecursive(artSrc, path.join(outdir, "artifacts", appVersion));
    }
  }

  console.log(`[packet-root] wrote packet root scaffold to: ${outdir}`);
}

main();
