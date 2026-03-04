#!/usr/bin/env node
/**
 * v0.2.3 Preflight Gate (no-deps)
 *
 * LOCKED minimum set (contract):
 * 1) ProspectsWindow schema snapshot (v1)
 * 2) Determinism smoke (same seed/decisions => same ProspectsWindow ids+fields)
 * 3) Non-perturbation when no prospects accepted (golden seeds baseline)
 *
 * No-deps compatible: uses dist_batch/ and Node built-ins only.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowIso() { return new Date().toISOString(); }
function sha256(s) { return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const QA_ARTIFACTS = path.resolve("qa_artifacts");
ensureDir(QA_ARTIFACTS);

// Map/Assets/Boundary preflight gates (no-deps)
function runGate(label, scriptRelPath, args = []) {
  const node = process.execPath;
  const scriptAbs = path.resolve(scriptRelPath);
  if (!fs.existsSync(scriptAbs)) {
    return { label, ok: false, error: `missing script: ${scriptRelPath}` };
  }
  const res = spawnSync(node, [scriptAbs, ...args], { stdio: "inherit" });
  return { label, ok: (res.status ?? 1) === 0, status: res.status ?? 1 };
}

const mapGateResults = [];
mapGateResults.push(runGate("boundary:check", "scripts/boundaryCheck.mjs"));
mapGateResults.push(runGate("assets:validate", "scripts/assetsValidateV1.mjs"));
mapGateResults.push(runGate("map:validate", "scripts/mapValidateV1.mjs"));

function loadBuildInfo() {
  try {
    const p = path.resolve("docs/BUILD_INFO.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const BUILD_INFO = loadBuildInfo();

// Import compiled sim (dist_batch) — does not require node_modules
const sim = await import(path.resolve("dist_batch/src/sim/index.js"));
const policies = await import(path.resolve("dist_batch/src/sim/policies.js"));
const { APP_VERSION } = await import(path.resolve("dist_batch/src/version.js"));

const APP_VERSION_STAMP = BUILD_INFO?.app_version || APP_VERSION || null;
const CODE_FINGERPRINT = BUILD_INFO?.code_fingerprint || "";
const SIM_VERSION = sim.SIM_VERSION ?? null;

const out = {
  gate: "preflight",
  app_version: APP_VERSION_STAMP,
  sim_version: SIM_VERSION,
  code_fingerprint: CODE_FINGERPRINT,
  started_at: nowIso(),
  tests_run: 0,
  passed: 0,
  failed: 0,
  failures: [],
  notes: [],
  map_lane_gates: mapGateResults
};

// Count map lane gates as preflight tests (fail fast but keep report complete)
for (const g of mapGateResults) {
  out.tests_run += 1;
  if (g.ok) out.passed += 1;
  else {
    out.failed += 1;
    out.failures.push({ name: g.label, error: g.error ?? `exit status ${g.status ?? "?"}` });
  }
}

async function runTest(name, fn) {
  out.tests_run += 1;
  try { await fn(); out.passed += 1; }
  catch (e) { out.failed += 1; out.failures.push({ name, error: String(e?.stack ?? e) }); }
}

/** Stable stringify (sort object keys) so determinism comparisons are robust. */
function stableStringify(value) {
  const seen = new WeakSet();
  const helper = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(helper);
    const keys = Object.keys(v).sort();
    const outObj = {};
    for (const k of keys) outObj[k] = helper(v[k]);
    return outObj;
  };
  return JSON.stringify(helper(value));
}

function isProspectsWindow(obj) {
  return Boolean(
    obj &&
      typeof obj === "object" &&
      obj.schema_version === "prospects_window_v1" &&
      typeof obj.turn_index === "number" &&
      typeof obj.generated_at_turn_index === "number" &&
      Array.isArray(obj.prospects) &&
      Array.isArray(obj.shown_ids) &&
      Array.isArray(obj.hidden_ids)
  );
}

function findProspectsWindows(root, maxDepth = 8) {
  const found = [];
  const seen = new WeakSet();

  const walk = (node, depth) => {
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (isProspectsWindow(node)) {
      found.push(node);
      // continue walking; there should normally be 1, but don't assume.
    }

    if (depth <= 0) return;

    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth - 1);
      return;
    }

    for (const k of Object.keys(node)) {
      // avoid descending into giant registries too deeply
      if (k === "people" || k === "houses") continue;
      walk(node[k], depth - 1);
    }
  };

  // Try common bindings first (fast path)
  try {
    if (root && typeof root === "object") {
      const r = root;
      const cand = r.prospects_window ?? r.prospectsWindow ?? r.prospects ?? null;
      if (isProspectsWindow(cand)) return [cand];
      const rep = r.report ?? null;
      const repCand = rep?.prospects_window ?? rep?.prospectsWindow ?? null;
      if (isProspectsWindow(repCand)) return [repCand];
    }
  } catch {}

  walk(root, maxDepth);
  return found;
}

function validateProspectsWindow(w) {
  const errs = [];

  const reqStr = (v, label) => {
    if (typeof v !== "string" || !v) errs.push(`${label} must be non-empty string`);
  };
  const reqNum = (v, label) => {
    if (!Number.isFinite(v)) errs.push(`${label} must be a finite number`);
  };

  if (!w || typeof w !== "object") return ["ProspectsWindow is not an object"];
  if (w.schema_version !== "prospects_window_v1") errs.push("schema_version must equal prospects_window_v1");
  reqNum(w.turn_index, "turn_index");
  reqNum(w.generated_at_turn_index, "generated_at_turn_index");

  if (!Array.isArray(w.prospects)) errs.push("prospects must be array");
  if (Array.isArray(w.prospects) && w.prospects.length > 3) errs.push("prospects length must be <= 3 (LOCKED)");
  if (!Array.isArray(w.shown_ids)) errs.push("shown_ids must be array");
  if (!Array.isArray(w.hidden_ids)) errs.push("hidden_ids must be array");

  const ids = [];
  if (Array.isArray(w.prospects)) {
    for (let i = 0; i < w.prospects.length; i++) {
      const p = w.prospects[i];
      const prefix = `prospects[${i}]`;
      if (!p || typeof p !== "object") { errs.push(`${prefix} must be object`); continue; }

      reqStr(p.id, `${prefix}.id`);
      ids.push(String(p.id));
      if (!["marriage","grant","inheritance_claim"].includes(String(p.type))) errs.push(`${prefix}.type invalid`);

      reqStr(p.from_house_id, `${prefix}.from_house_id`);
      reqStr(p.to_house_id, `${prefix}.to_house_id`);

      const sp = p.subject_person_id;
      if (!(sp === null || typeof sp === "string")) errs.push(`${prefix}.subject_person_id must be string|null`);
      if (String(p.type) === "marriage" && (typeof sp !== "string" || !sp)) errs.push(`${prefix}.subject_person_id required for marriage`);

      reqStr(p.summary, `${prefix}.summary`);

      if (!Array.isArray(p.requirements)) errs.push(`${prefix}.requirements must be array`);
      if (!p.costs || typeof p.costs !== "object") errs.push(`${prefix}.costs must be object`);
      if (!p.predicted_effects || typeof p.predicted_effects !== "object") errs.push(`${prefix}.predicted_effects must be object`);

      if (!["known","likely","possible"].includes(String(p.uncertainty))) errs.push(`${prefix}.uncertainty invalid`);
      reqNum(p.expires_turn, `${prefix}.expires_turn`);

      if (!Array.isArray(p.actions)) errs.push(`${prefix}.actions must be array`);
      else {
        for (const a of p.actions) {
          if (!["accept","reject"].includes(String(a))) errs.push(`${prefix}.actions contains invalid action: ${String(a)}`);
        }
      }
    }
  }

  // shown/hidden partition sanity
  const uniq = (arr) => [...new Set(arr.map(String))];
  const shown = Array.isArray(w.shown_ids) ? w.shown_ids.map(String) : [];
  const hidden = Array.isArray(w.hidden_ids) ? w.hidden_ids.map(String) : [];
  if (uniq(shown).length !== shown.length) errs.push("shown_ids contains duplicates");
  if (uniq(hidden).length !== hidden.length) errs.push("hidden_ids contains duplicates");

  const idSet = new Set(ids);
  for (const sid of shown) if (!idSet.has(sid)) errs.push(`shown_ids references unknown id: ${sid}`);
  for (const hid of hidden) if (!idSet.has(hid)) errs.push(`hidden_ids references unknown id: ${hid}`);

  const both = shown.filter((x) => hidden.includes(x));
  if (both.length) errs.push(`ids present in both shown_ids and hidden_ids: ${both.join(",")}`);

  const union = new Set([...shown, ...hidden]);
  if (union.size !== idSet.size) errs.push("shown_ids ∪ hidden_ids must equal prospect ids (partition)");

  return errs;
}

function runPolicy(seed, policyId, turns = 15) {
  let state = sim.createNewRun(seed);
  const canonical = policies.canonicalizePolicyId(policyId);
  for (let i = 0; i < turns; i++) {
    if (state.game_over) break;
    const ctx = sim.proposeTurn(state);
    const decisions = policies.decide(canonical, state, ctx);
    state = sim.applyDecisions(state, decisions);
  }
  return state;
}

function coreEconomySig(state) {
  return {
    turn_index: state.turn_index,
    game_over_reason: state.game_over?.reason ?? null,
    manor: {
      population: state.manor.population,
      farmers: state.manor.farmers,
      builders: state.manor.builders,
      bushels_stored: state.manor.bushels_stored,
      coin: state.manor.coin,
      unrest: state.manor.unrest,
      arrears_coin: state.manor.obligations?.arrears?.coin ?? 0,
      arrears_bushels: state.manor.obligations?.arrears?.bushels ?? 0,
      improvements: [...(state.manor.improvements ?? [])].slice().sort()
    },
    energy: {
      max: state.house?.energy?.max ?? null,
      available: state.house?.energy?.available ?? null
    }
  };
}

await runTest("schema_snapshot_v1_present", async () => {
  const p = path.resolve("docs/schemas/prospects_window_v1.schema.json");
  assert(fs.existsSync(p), "missing docs/schemas/prospects_window_v1.schema.json");
  const schema = JSON.parse(fs.readFileSync(p, "utf8"));
  const constVer = schema?.properties?.schema_version?.const ?? null;
  assert(constVer === "prospects_window_v1", `schema_version const mismatch: ${constVer}`);
});

await runTest("determinism_smoke_prospects_window", async () => {
  // Scan baseline seeds for at least one prospects window within a bounded horizon.
  const baselinePath = path.resolve(
    String(APP_VERSION_STAMP ?? "").startsWith("v0.2.6")
      ? "docs/qa/v0.2.6_non_perturbation_baseline_v0.2.6.json"
      : String(APP_VERSION_STAMP ?? "").startsWith("v0.2.5")
        ? "docs/qa/v0.2.5_non_perturbation_baseline_v0.2.5.json"
      : String(APP_VERSION_STAMP ?? "").startsWith("v0.2.4")
        ? "docs/qa/v0.2.4_non_perturbation_baseline_v0.2.4.json"
        : "docs/qa/v0.2.3_non_perturbation_baseline_v0.2.2.json"
  );
  assert(fs.existsSync(baselinePath), `missing preflight baseline file (${baselinePath})`);
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const seeds = Array.isArray(baseline?.seeds) ? baseline.seeds : [];
  assert(seeds.length > 0, "baseline seeds empty");

  const policyId = "prudent-builder";
  const canonical = policies.canonicalizePolicyId(policyId);

  let chosenSeed = null;
  let chosenTurns = 12;

  for (const seed of seeds.slice(0, 8)) {
    let state = sim.createNewRun(seed);
    let found = 0;
    for (let t = 0; t < chosenTurns; t++) {
      const ctx = sim.proposeTurn(state);
      const wins = findProspectsWindows(ctx);
      if (wins.length) { found += wins.length; break; }
      const decisions = policies.decide(canonical, state, ctx);
      state = sim.applyDecisions(state, decisions);
      if (state.game_over) break;
    }
    if (found > 0) { chosenSeed = seed; break; }
  }

  assert(chosenSeed, `no ProspectsWindow found in scan window (seeds<=8, turns=${chosenTurns}). Ensure prospects engine is wired and exposes ProspectsWindow v1.`);

  function collectWindows(seed) {
    let state = sim.createNewRun(seed);
    const windows = [];
    for (let t = 0; t < chosenTurns; t++) {
      const ctx = sim.proposeTurn(state);
      const wins = findProspectsWindows(ctx);
      for (const w of wins) {
        const errs = validateProspectsWindow(w);
        assert(errs.length === 0, `ProspectsWindow schema violations:\n- ${errs.join("\n- ")}`);
        windows.push({ turn_index: ctx.report?.turn_index ?? state.turn_index, window: w });
      }
      const decisions = policies.decide(canonical, state, ctx);
      state = sim.applyDecisions(state, decisions);
      if (state.game_over) break;
    }
    return windows;
  }

  const a = collectWindows(chosenSeed);
  const b = collectWindows(chosenSeed);

  const ha = sha256(stableStringify(a));
  const hb = sha256(stableStringify(b));
  assert(ha === hb, `ProspectsWindow determinism mismatch (hash A=${ha} B=${hb})`);
  out.notes.push(`determinism seed: ${chosenSeed} (turns scanned=${chosenTurns}, windows seen=${a.length})`);
});

await runTest("non_perturbation_golden_seeds_no_accepts", async () => {
  const baselinePath = path.resolve(
    String(APP_VERSION_STAMP ?? "").startsWith("v0.2.6")
      ? "docs/qa/v0.2.6_non_perturbation_baseline_v0.2.6.json"
      : String(APP_VERSION_STAMP ?? "").startsWith("v0.2.5")
        ? "docs/qa/v0.2.5_non_perturbation_baseline_v0.2.5.json"
      : String(APP_VERSION_STAMP ?? "").startsWith("v0.2.4")
        ? "docs/qa/v0.2.4_non_perturbation_baseline_v0.2.4.json"
        : "docs/qa/v0.2.3_non_perturbation_baseline_v0.2.2.json"
  );
  assert(fs.existsSync(baselinePath), "missing preflight baseline file");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

  const turns = Number(baseline?.turns ?? 15);
  const expected = baseline?.expected ?? {};
  const seeds = Array.isArray(baseline?.seeds) ? baseline.seeds : [];
  const policyIds = Array.isArray(baseline?.policies) ? baseline.policies : [];

  assert(seeds.length > 0, "baseline seeds empty");
  assert(policyIds.length > 0, "baseline policies empty");

  const mismatches = [];

  for (const pid of policyIds) {
    for (const seed of seeds) {
      const exp = expected?.[pid]?.[seed] ?? null;
      assert(exp, `missing baseline entry for policy=${pid} seed=${seed}`);
      const got = coreEconomySig(runPolicy(seed, pid, turns));
      const e = stableStringify(exp);
      const g = stableStringify(got);
      if (e !== g) {
        mismatches.push({ policy: pid, seed, expected: exp, got });
      }
    }
  }

  if (mismatches.length) {
    const head = mismatches.slice(0, 3).map((m) => `- ${m.policy} / ${m.seed}`).join("\n");
    throw new Error(`non-perturbation FAIL: ${mismatches.length} mismatches vs baseline (showing first 3):\n${head}`);
  }
});

out.finished_at = nowIso();
out.ok = out.failed === 0;

const outPath = path.join(QA_ARTIFACTS, `${APP_VERSION_STAMP || "unknown"}_preflight.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");

console.log(`preflight: ${out.ok ? "PASS" : "FAIL"} (passed ${out.passed}/${out.tests_run})`);
if (!out.ok) process.exitCode = 1;
