#!/usr/bin/env node

import { execSync } from "node:child_process";

function run(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim() };
  } catch (err) {
    const out = err?.stdout?.toString?.() || "";
    const e = err?.stderr?.toString?.() || "";
    return { ok: false, out: `${out}${e}`.trim() };
  }
}

function lines(s) {
  return (s || "").split("\n").map((x) => x.trim()).filter(Boolean);
}

const protectedBranches = new Set(["main", "master"]);

const current = run("git branch --show-current").out;
const remotes = run("git remote -v").out;
const localRaw = run("git branch --format='%(refname:short)'").out;
const localBranches = lines(localRaw);

let fetchOk = false;
let fetchOut = "(skipped: no remote configured)";
if (remotes) {
  const f = run("git fetch --all --prune 2>&1");
  fetchOk = f.ok;
  fetchOut = f.out || (f.ok ? "OK" : "fetch failed");
}

const remoteRaw = remotes ? run("git branch -r --format='%(refname:short)'").out : "";
const remoteBranches = lines(remoteRaw)
  .filter((b) => !b.includes("->"))
  .map((b) => b.replace(/^origin\//, ""));

const uniqueRemote = new Set(remoteBranches);
const staleLocal = remotes
  ? localBranches.filter((b) => !protectedBranches.has(b) && !uniqueRemote.has(b))
  : [];

const base = uniqueRemote.has("main") ? "main" : (uniqueRemote.has("master") ? "master" : "main");

console.log("# Repo Cleanup Plan\n");
console.log(`- Current branch: ${current || "(unknown)"}`);
console.log(`- Remote configured: ${remotes ? "yes" : "no"}`);
console.log(`- Fetch status: ${fetchOk ? "OK" : fetchOut}`);
console.log(`- Local branches (${localBranches.length}): ${localBranches.join(", ") || "none"}`);
console.log(`- Remote branches (${remoteBranches.length}): ${[...uniqueRemote].join(", ") || "none"}`);
console.log(`- Candidate stale local branches: ${staleLocal.join(", ") || "none"}`);

console.log("\n## Suggested sequence");
console.log("1) Ensure clean working tree:");
console.log("   git status --short");

if (!remotes) {
  console.log("\n2) Add remote:");
  console.log("   git remote add origin <repo-url>");
  console.log("   git fetch --all --prune");
} else if (!fetchOk) {
  console.log("\n2) Fix remote auth/network, then fetch:");
  console.log("   git fetch --all --prune");
} else {
  console.log("\n2) Sync base branch:");
  console.log(`   git checkout ${base}`);
  console.log(`   git pull --ff-only origin ${base}`);
}

console.log("\n3) Create a fresh work branch for the next task:");
console.log("   git checkout -b fix/<topic>");

if (staleLocal.length) {
  console.log("\n4) Optional local cleanup (after verifying no needed work):");
  for (const b of staleLocal) {
    if (b !== current) console.log(`   git branch -D ${b}`);
  }
}

console.log("\n5) PR discipline:");
console.log("   - One branch per topic");
console.log("   - Open PR into main");
console.log("   - Squash merge and delete branch");
