#!/usr/bin/env node

import { execSync } from "node:child_process";

function run(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch (err) {
    const out = err?.stdout?.toString?.() || "";
    const e = err?.stderr?.toString?.() || "";
    return `${out}${e}`.trim();
  }
}

function section(title, body) {
  console.log(`\n=== ${title} ===`);
  console.log(body || "(empty)");
}

const top = run("git rev-parse --show-toplevel");
const branch = run("git branch --show-current");
const status = run("git status --short");
const remotes = run("git remote -v");
const localBranches = run("git branch --list");
const remoteBranches = run("git branch -r");
const recent = run("git log --oneline --decorate -n 12");

let fetchResult = "(skipped: no remote configured)";
let fetchOut = "";
if (remotes) {
  fetchResult = "OK";
  fetchOut = run("git fetch --all --prune 2>&1");
  if (/fatal:|error:/i.test(fetchOut)) fetchResult = fetchOut;
}

let aheadBehind = "(remote/main unavailable)";
if (remotes && !/unavailable|not found|fatal/i.test(fetchOut)) {
  aheadBehind = run("git rev-list --left-right --count HEAD...origin/main 2>&1");
}

section("Repo root", top);
section("Current branch", branch);
section("Working tree", status || "clean");
section("Remotes", remotes || "none");
section("Fetch status", fetchResult);
section("Ahead/behind vs origin/main", aheadBehind);
section("Local branches", localBranches || "none");
section("Remote branches", remoteBranches || "none");
section("Recent commits", recent || "none");

console.log("\nRecommended next step:");
if (!remotes) {
  console.log("- Configure origin remote, then run: npm run repo:health");
} else if (/fatal:|error:/i.test(fetchOut)) {
  console.log("- Fix network/auth for git fetch, then rerun npm run repo:health");
} else {
  console.log("- If ahead/behind is not '0 0', rebase feature branch on origin/main before new PRs.");
}
