import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function nowIso() { return new Date().toISOString(); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function clampCheck(n, lo, hi) { assert(Number.isFinite(n), `non-finite number: ${n}`); assert(n >= lo && n <= hi, `out of range ${n} not in [${lo},${hi}]`); }
function nonNegInt(n, label) { assert(Number.isFinite(n), `${label} non-finite`); assert(Number.isInteger(n), `${label} not int`); assert(n >= 0, `${label} negative`); }

const QA_ARTIFACTS = path.resolve("qa_artifacts");
ensureDir(QA_ARTIFACTS);

const { APP_VERSION } = await import(path.resolve("dist_batch/src/version.js"));
const out = {
  gate: "qa_no_deps",
  app_version: null,
  sim_version: null,
  started_at: nowIso(),
  tests_run: 0,
  passed: 0,
  failed: 0,
  failures: [],
  notes: []
};

function runGate(label, scriptRelPath, args = []) {
  const node = process.execPath;
  const scriptAbs = path.resolve(scriptRelPath);
  if (!fs.existsSync(scriptAbs)) {
    out.tests_run += 1;
    out.failed += 1;
    out.failures.push({ name: label, error: `missing script: ${scriptRelPath}` });
    return;
  }
  const res = spawnSync(node, [scriptAbs, ...args], { stdio: "inherit" });
  out.tests_run += 1;
  if ((res.status ?? 1) === 0) out.passed += 1;
  else {
    out.failed += 1;
    out.failures.push({ name: label, error: `exit status ${res.status ?? 1}` });
  }
}

// Map lane gates (must run in CI / QA)
runGate("boundary:check", "scripts/boundaryCheck.mjs");
runGate("assets:validate", "scripts/assetsValidateV1.mjs");
runGate("map:validate", "scripts/mapValidateV1.mjs");

// Import compiled sim (dist_batch) — does not require node_modules
const sim = await import(path.resolve("dist_batch/src/sim/index.js"));
const policies = await import(path.resolve("dist_batch/src/sim/policies.js"));
out.sim_version = sim.SIM_VERSION ?? null;

// best-effort app version from src/version.ts (string parse)
try {
  const verText = fs.readFileSync(path.resolve("src/version.ts"), "utf8");
  const m = verText.match(/APP_VERSION\s*=\s*["'`]([^"'`]+)["'`]/);
  out.app_version = m ? m[1] : null;
} catch {}

// Determinism seeds: load if present (prefer version-matched file)
let goldenSeeds = [];
try {
  const candidates = [];
  if (APP_VERSION) candidates.push(`docs/golden_seeds_${APP_VERSION}.json`);
  candidates.push("docs/golden_seeds_v0.2.1.json");
  candidates.push("docs/golden_seeds_v0.1.0.json");
  candidates.push("docs/golden_seeds_v0.0.9.json");

  let loadedPath = null;
  for (const c of candidates) {
    const p = path.resolve(c);
    if (!fs.existsSync(p)) continue;
    const gs = JSON.parse(fs.readFileSync(p, "utf8"));
    goldenSeeds = (gs.golden_seeds ?? gs.seeds ?? []).map((x) => (typeof x === "string" ? x : x.seed)).filter(Boolean);
    loadedPath = c;
    break;
  }
  if (!loadedPath || goldenSeeds.length === 0) throw new Error("no seeds loaded");
  out.notes.push(`golden seeds loaded: ${loadedPath} (n=${goldenSeeds.length})`);
} catch {
  goldenSeeds = ["lotm_v007_seed_001","lotm_v007_seed_002","lotm_v007_seed_003","lotm_v007_seed_004","lotm_v007_seed_005","lotm_v007_seed_006","lotm_v007_seed_007","lotm_v007_seed_008"];
  out.notes.push("golden seeds file not found; used fallback list");
}

function runPolicy(seed, policyId, turns=15) {
  let state = sim.createNewRun(seed);
  if (state && typeof state === "object") state.app_version = out.app_version ?? state.app_version ?? null;
  const canonical = policies.canonicalizePolicyId(policyId);
  for (let i=0;i<turns;i++) {
    if (state.game_over) break;
    const ctx = sim.proposeTurn(state);
    const decisions = policies.decide(canonical, state, ctx);
    state = sim.applyDecisions(state, decisions);
  }
  return state;
}

function checkBoundedSnapshot(entry) {
  const allowed = new Set(["turn_index","manor","house","relationships","flags","game_over","people","houses","player_house_id","kinship","kinship_edges"]);
  for (const key of Object.keys(entry.snapshot_before ?? {})) assert(allowed.has(key), `snapshot_before forbidden key: ${key}`);
  for (const key of Object.keys(entry.snapshot_after ?? {})) assert(allowed.has(key), `snapshot_after forbidden key: ${key}`);
  assert(!("log" in (entry.snapshot_before ?? {})), "snapshot_before contains log");
  assert(!("log" in (entry.snapshot_after ?? {})), "snapshot_after contains log");
}

function checkInvariants(state) {
  const m = state.manor;
  nonNegInt(m.population, "population");
  nonNegInt(m.farmers, "farmers");
  nonNegInt(m.builders, "builders");
  assert(m.farmers + m.builders <= m.population, "labor exceeds population");
  nonNegInt(m.bushels_stored, "bushels_stored");
  nonNegInt(m.coin, "coin");
  clampCheck(m.unrest, 0, 100);

  const ob = m.obligations;
  nonNegInt(ob.arrears.coin, "arrears.coin");
  nonNegInt(ob.arrears.bushels, "arrears.bushels");

  const e = state.house.energy;
  nonNegInt(e.max, "energy.max");
  nonNegInt(e.available, "energy.available");
  assert(e.available <= e.max, "energy available > max");

  for (const rel of state.relationships) {
    clampCheck(rel.allegiance, 0, 100);
    clampCheck(rel.respect, 0, 100);
    clampCheck(rel.threat, 0, 100);
  }

  if (state.game_over) {
    assert(["Dispossessed","DeathNoHeir"].includes(state.game_over.reason), `invalid game over reason: ${state.game_over.reason}`);
  }

  for (const e2 of state.log ?? []) checkBoundedSnapshot(e2);
}

async function runTest(name, fn) {
  out.tests_run += 1;
  try { await fn(); out.passed += 1; }
  catch (e) { out.failed += 1; out.failures.push({ name, error: String(e?.stack ?? e) }); }
}

await runTest("policy_registry_ids", async () => {
  const ids = policies.POLICY_IDS ?? [];
  assert(ids.includes("prudent-builder"), "missing prudent-builder");
  assert(ids.includes("builder-forward"), "missing builder-forward");
  assert(ids.includes("builder-forward/buffered"), "missing builder-forward/buffered");
  assert(policies.canonicalizePolicyId("good-faith") === "prudent-builder", "alias good-faith wrong");
  assert(policies.sanitizePolicyIdForArtifacts("builder-forward/buffered") === "builder-forward__buffered", "sanitizer wrong");

  // Drift prevention: BUILD_INFO.policy_ids must match registry
  const buildInfo = JSON.parse(fs.readFileSync(path.resolve("docs/BUILD_INFO.json"), "utf8"));
  const declared = Array.isArray(buildInfo?.policy_ids) ? buildInfo.policy_ids : [];
  const sort = (a) => [...new Set(a.map(String))].sort();
  const d = sort(declared);
  const r = sort(ids);
  assert(JSON.stringify(d) === JSON.stringify(r), `BUILD_INFO.policy_ids drift: declared=${JSON.stringify(d)} registry=${JSON.stringify(r)}`);

});

await runTest("builder_forward_prioritizes_rotation", async () => {
  const s = sim.createNewRun("lotm_v007_policy_test");
  const ctx = sim.proposeTurn(s);
  const dec = policies.decide("builder-forward", s, ctx);
  assert(dec.construction && dec.construction.action !== "none", "no construction decision");
  assert(dec.construction.improvement_id === "field_rotation", "builder-forward should start field_rotation first when viable");
});

await runTest("determinism_same_seed_same_policy", async () => {
  const seed = goldenSeeds[0] ?? "lotm_v007_seed_001";
  const a = runPolicy(seed, "builder-forward", 15);
  const b = runPolicy(seed, "builder-forward", 15);
  const ha = sha256(JSON.stringify(a.log));
  const hb = sha256(JSON.stringify(b.log));
  assert(ha === hb, "log hash mismatch");
});

await runTest("golden_seeds_invariants_prudent_builder", async () => {
  for (const seed of goldenSeeds.slice(0, 8)) checkInvariants(runPolicy(seed, "prudent-builder", 15));
});

await runTest("golden_seeds_invariants_builder_forward", async () => {
  for (const seed of goldenSeeds.slice(0, 8)) checkInvariants(runPolicy(seed, "builder-forward", 15));
});

await runTest("bounded_snapshots", async () => {
  checkInvariants(runPolicy("lotm_v007_snapshot_test", "builder-forward", 6));
});
await runTest("migration_fixture_v0.1.0_to_v0.2.1_people_first", async () => {
  const fixturePath = path.resolve("tests/fixtures/v0.1.0_state_fixture.json");
  if (!fs.existsSync(fixturePath)) {
    out.notes.push("migration fixture missing; skipped");
    return;
  }
  const oldState = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  // If v0.2.1+ expects People-First fields, proposeTurn/applyDecisions must still accept v0.1.0 state.
  const ctx = sim.proposeTurn(oldState);
  const migrated = ctx?.preview_state ?? null;
  assert(migrated && typeof migrated === "object", "migration/proposeTurn did not return preview_state");

  if (String(out.app_version ?? "").startsWith("v0.2.1")) {
    assert(migrated.people && typeof migrated.people === "object", "missing people registry after migration");
    assert(migrated.houses && typeof migrated.houses === "object", "missing houses registry after migration");
    assert(typeof migrated.player_house_id === "string" && migrated.player_house_id.length > 0, "missing player_house_id after migration");
    assert(migrated.houses[migrated.player_house_id], "houses[player_house_id] missing after migration");

    // kinship edges are expected to exist under `kinship` or `kinship_edges` (array of edges)
    const kin = migrated.kinship ?? migrated.kinship_edges ?? [];
    assert(Array.isArray(kin), "kinship edges missing (expected array)");
  }
});


out.finished_at = nowIso();
out.ok = out.failed === 0;

const outPath = path.join(QA_ARTIFACTS, `${APP_VERSION}_no_deps_gate.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");

console.log(`qa_no_deps: ${out.ok ? "PASS" : "FAIL"} (passed ${out.passed}/${out.tests_run})`);
if (!out.ok) process.exitCode = 1;