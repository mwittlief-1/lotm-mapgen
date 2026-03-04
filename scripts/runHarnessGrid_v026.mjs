#!/usr/bin/env node
/**
 * v0.2.6 Harness Grid Runner (Dev B)
 *
 * Contract: produce evidence batches for:
 * - run policies: prudent-builder, builder-forward, builder-forward/buffered
 * - prospect policies: reject-all, accept-all, accept-if-net-positive
 * - horizons: 250×15 and 120×30
 *
 * Default runner is the no-deps batch runner (dist_batch + Node built-ins only):
 *   node scripts/simBatchNoDeps.mjs
 *
 * Usage:
 *   node scripts/runHarnessGrid_v026.mjs
 *   node scripts/runHarnessGrid_v026.mjs --dryRun=1
 *   node scripts/runHarnessGrid_v026.mjs --turns=15
 *   node scripts/runHarnessGrid_v026.mjs --policies=prudent-builder,builder-forward
 *   node scripts/runHarnessGrid_v026.mjs --prospectPolicies=reject-all
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = {
    dryRun: false,
    runner: "no-deps", // 'no-deps' | 'tsx'
    turnsFilter: null,
    policies: null,
    prospectPolicies: null,
    runs15: 250,
    runs30: 120,
    continueOnError: false
  };

  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [kRaw, vRaw] = arg.slice(2).split("=");
    const k = String(kRaw || "").trim();
    const v = vRaw === undefined ? "1" : String(vRaw);
    if (!k) continue;

    if (k === "dryRun") out.dryRun = v === "1" || v.toLowerCase() === "true";
    if (k === "runner") out.runner = v;
    if (k === "turns") out.turnsFilter = v.split(",").map((x) => Number(x)).filter((n) => Number.isFinite(n));
    if (k === "policies") out.policies = v.split(",").map((x) => x.trim()).filter(Boolean);
    if (k === "prospectPolicies") out.prospectPolicies = v.split(",").map((x) => x.trim()).filter(Boolean);
    if (k === "runs15") out.runs15 = Number(v);
    if (k === "runs30") out.runs30 = Number(v);
    if (k === "continueOnError") out.continueOnError = v === "1" || v.toLowerCase() === "true";
  }

  return out;
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

function sanitizePolicyIdForArtifacts(policyId) {
  return String(policyId).split("/").join("__");
}

function expectedOutdir(appVersion, policyId, prospectPolicy, turns) {
  const policySanitized = sanitizePolicyIdForArtifacts(policyId);
  return path.join(PROJECT_ROOT, "artifacts", appVersion, policySanitized, `prospects_${prospectPolicy}`, `turns_${turns}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appVersion = await getAppVersionStamp();

  const POLICIES_DEFAULT = ["prudent-builder", "builder-forward", "builder-forward/buffered"];
  const PROSPECT_POLICIES_DEFAULT = ["reject-all", "accept-all", "accept-if-net-positive"];
  const HORIZONS_DEFAULT = [
    { turns: 15, runs: args.runs15 },
    { turns: 30, runs: args.runs30 }
  ];

  const policies = args.policies ?? POLICIES_DEFAULT;
  const prospectPolicies = args.prospectPolicies ?? PROSPECT_POLICIES_DEFAULT;
  const horizons =
    Array.isArray(args.turnsFilter) && args.turnsFilter.length
      ? HORIZONS_DEFAULT.filter((h) => args.turnsFilter.includes(h.turns))
      : HORIZONS_DEFAULT;

  const total = policies.length * prospectPolicies.length * horizons.length;
  let done = 0;
  let failed = 0;

  console.log(`[v0.2.6 harness] app_version=${appVersion}`);
  console.log(`[v0.2.6 harness] runner=${args.runner} dryRun=${args.dryRun ? "yes" : "no"}`);
  console.log(`[v0.2.6 harness] combos=${total} (policies=${policies.length}, prospectPolicies=${prospectPolicies.length}, horizons=${horizons.length})`);

  for (const policy of policies) {
    for (const pp of prospectPolicies) {
      for (const h of horizons) {
        const turns = h.turns;
        const runs = h.runs;

        const cmd =
          args.runner === "tsx"
            ? ["npm", "run", "sim:batch", "--", `--policy=${policy}`, `--prospectPolicy=${pp}`, `--runs=${runs}`, `--turns=${turns}`]
            : ["node", path.join(PROJECT_ROOT, "scripts", "simBatchNoDeps.mjs"), `--policy=${policy}`, `--prospectPolicy=${pp}`, `--runs=${runs}`, `--turns=${turns}`];

        const pretty = cmd.map((x) => (x.includes(" ") ? JSON.stringify(x) : x)).join(" ");
        console.log(`\n[${done + 1}/${total}] ${policy} × ${pp} × ${turns}T (${runs} runs)`);
        console.log(pretty);

        if (args.dryRun) {
          done += 1;
          continue;
        }

        const res = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", cwd: PROJECT_ROOT });

        try {
          assert(res.status === 0, `Command failed (exit=${res.status ?? "?"}): ${pretty}`);

          const outdir = expectedOutdir(appVersion, policy, pp, turns);
          const summaryPath = path.join(outdir, "batch_summary.json");
          assert(fs.existsSync(summaryPath), `Missing batch_summary.json at expected outdir: ${summaryPath}`);

          done += 1;
        } catch (e) {
          failed += 1;
          console.error(String(e?.stack ?? e));
          if (!args.continueOnError) process.exitCode = 1;
          if (!args.continueOnError) return;
          done += 1;
        }
      }
    }
  }

  console.log(`\n[v0.2.6 harness] done=${done} failed=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main();
