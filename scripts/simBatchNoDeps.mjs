#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Import compiled sim core (no deps)
import { createNewRun, proposeTurn, applyDecisions } from "../dist_batch/src/sim/index.js";
import { decide, canonicalizePolicyId, sanitizePolicyIdForArtifacts } from "../dist_batch/src/sim/policies.js";
import { IMPROVEMENT_IDS } from "../dist_batch/src/content/improvements.js";
import { relationshipBounds } from "../dist_batch/src/sim/relationships.js";
import { APP_VERSION } from "../dist_batch/src/version.js";

const PROSPECT_POLICIES = ["reject-all", "accept-all", "accept-if-net-positive"];
const PROSPECT_TYPES = ["marriage", "grant", "inheritance_claim"];

function initProspectsByType() {
  return { marriage: 0, grant: 0, inheritance_claim: 0 };
}

function initProspectsCounters() {
  return {
    generated: initProspectsByType(),
    shown: initProspectsByType(),
    hidden: initProspectsByType(),
    accepted: initProspectsByType(),
    rejected: initProspectsByType(),
    expired: initProspectsByType(),
    shown_but_expired: initProspectsByType()
  };
}

function addProspectsCounters(into, add) {
  for (const k of Object.keys(into)) {
    for (const t of PROSPECT_TYPES) {
      into[k][t] += add[k][t];
    }
  }
}

function sumProspectsByType(c) {
  return PROSPECT_TYPES.reduce((s, t) => s + (c[t] ?? 0), 0);
}

function parseProspectPolicy(raw) {
  const v = raw || "reject-all";
  if (!PROSPECT_POLICIES.includes(v)) {
    throw new Error(`Invalid --prospectPolicy value: ${raw}. Allowed: ${PROSPECT_POLICIES.join("|")}`);
  }
  return v;
}

function prospectTypeFromWindow(window, prospectId) {
  if (!window || !Array.isArray(window.prospects)) return null;
  for (const p of window.prospects) {
    if (p && p.id === prospectId) return p.type;
  }
  return null;
}

function computeProspectsActions(window, prospectPolicy) {
  if (!window || window.schema_version !== "prospects_window_v1") return [];
  if (!Array.isArray(window.shown_ids) || window.shown_ids.length === 0) return [];

  const shownSet = new Set(window.shown_ids.map(String));
  const indexed = (Array.isArray(window.prospects) ? window.prospects : [])
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p && shownSet.has(String(p.id)))
    // LOCKED tie-break: prospect_i
    .sort((a, b) => a.i - b.i);

  const out = [];
  for (const { p } of indexed) {
    let action = "reject";
    if (prospectPolicy === "accept-all") action = "accept";
    else if (prospectPolicy === "reject-all") action = "reject";
    else {
      const coinDeltaRaw = p?.predicted_effects?.coin_delta;
      const costCoinRaw = p?.costs?.coin;
      const coinDelta = typeof coinDeltaRaw === "number" && Number.isFinite(coinDeltaRaw) ? Math.trunc(coinDeltaRaw) : 0;
      const costCoin = typeof costCoinRaw === "number" && Number.isFinite(costCoinRaw) ? Math.trunc(costCoinRaw) : 0;
      const net = coinDelta - costCoin;
      action = net > 0 ? "accept" : "reject";
    }

    const allowed = Array.isArray(p?.actions) ? p.actions.map(String) : ["accept", "reject"];
    if (!allowed.includes(action)) {
      if (allowed.includes("reject")) action = "reject";
      else continue;
    }

    out.push({ prospect_id: String(p.id), action });
  }

  return out;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

function loadBuildInfo() {
  try {
    const p = path.join(PROJECT_ROOT, "docs", "BUILD_INFO.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const BUILD_INFO = loadBuildInfo();
const APP_VERSION_STAMP = BUILD_INFO?.app_version || APP_VERSION;
const CODE_FINGERPRINT = BUILD_INFO?.code_fingerprint || "";


function parseArgs(argv) {
  const a = { policy: "prudent-builder", prospectPolicy: "reject-all", runs: 250, turns: 15, outdir: "", baseSeed: "" };
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [k, v] = arg.slice(2).split("=");
    if (!k) continue;
    if (k === "policy" && v) a.policy = v;
    if (k === "prospectPolicy" && v) a.prospectPolicy = parseProspectPolicy(v);
    if (k === "runs" && v) a.runs = Number(v);
    if (k === "turns" && v) a.turns = Number(v);
    if (k === "outdir" && v) a.outdir = v;
    if (k === "baseSeed" && v) a.baseSeed = v;
  }
  return a;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath, headers, rows) {
  const lines = [];
  lines.push(headers.map(csvEscape).join(","));
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function median(sorted) {
  return percentile(sorted, 0.5);
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function runPolicy(seed, policy, turns, prospectPolicy) {
  let state = createNewRun(seed);

  // v0.2.3 Prospects rehydration requires prospect payload history, but we must
  // keep state bounded for large batches. We keep a minimal "history" containing
  // only `prospect_generated` events (payloads), and discard full turn logs.
  const prospectsHistory = [];
  const generatedSeen = new Set();

  const prospects = initProspectsCounters();
  const shownEver = new Set();

  // Prospects windows telemetry
  const windowsByTurn = Array.from({ length: turns }, () => 0);
  let windowsTotal = 0;

  let lastFullEntry = null;

  for (let t = 0; t < turns; t++) {
    if (state.game_over) break;

    // Provide bounded history for prospect rehydration.
    state.log = prospectsHistory.slice();

    const ctx = proposeTurn(state);
    const pw = ctx?.prospects_window ?? null;

    // Prospects exposure counters (by type)
    if (pw && pw.schema_version === "prospects_window_v1") {
      windowsTotal += 1;
      if (t >= 0 && t < windowsByTurn.length) windowsByTurn[t] += 1;
      for (const id of pw.shown_ids ?? []) {
        const sid = String(id);
        shownEver.add(sid);
        const pt = prospectTypeFromWindow(pw, sid);
        if (PROSPECT_TYPES.includes(pt)) prospects.shown[pt] += 1;
      }
      for (const id of pw.hidden_ids ?? []) {
        const sid = String(id);
        const pt = prospectTypeFromWindow(pw, sid);
        if (PROSPECT_TYPES.includes(pt)) prospects.hidden[pt] += 1;
      }
    }

    const decisions = decide(policy, state, ctx);

    // v0.2.3.1 headless prospects policy hook (tooling-only)
    if (pw && pw.schema_version === "prospects_window_v1") {
      const actions = computeProspectsActions(pw, prospectPolicy);
      decisions.prospects = { kind: "prospects", actions };
    }

    state = applyDecisions(state, decisions);

    // Extract authoritative outcomes from this turn's log entry
    lastFullEntry = Array.isArray(state.log) && state.log.length ? state.log[state.log.length - 1] : null;

    const plog = lastFullEntry?.report?.prospects_log;
    const genEvents = [];
    if (Array.isArray(plog)) {
      for (const ev of plog) {
        if (!ev || typeof ev !== "object") continue;
        const kind = ev.kind;
        const type = ev.type;
        const pid = ev.prospect_id;
        if (!PROSPECT_TYPES.includes(type)) continue;

        if (kind === "prospect_generated") {
          prospects.generated[type] += 1;
          const pidStr = String(pid);
          if (!generatedSeen.has(pidStr)) {
            generatedSeen.add(pidStr);
            genEvents.push(ev);
          }
        }
        if (kind === "prospect_accepted") prospects.accepted[type] += 1;
        if (kind === "prospect_rejected") prospects.rejected[type] += 1;
        if (kind === "prospect_expired") {
          prospects.expired[type] += 1;
          const pidStr = String(pid);
          if (shownEver.has(pidStr)) prospects.shown_but_expired[type] += 1;
        }
      }
    }

    // Keep only the payload history needed for rehydration
    if (genEvents.length > 0) {
      prospectsHistory.push({ report: { prospects_log: genEvents } });
      // hard bound: in v0.2.3, active prospects <= 3
      if (prospectsHistory.length > 3) prospectsHistory.splice(0, prospectsHistory.length - 3);
    }

    // Drop the full log to keep memory bounded (we keep `lastFullEntry` separately).
    state.log = [];
  }

  // Restore a small log footprint for downstream summary selection (previous behavior).
  state.log = lastFullEntry ? [lastFullEntry] : [];

  return { state, prospects, prospects_windows_total: windowsTotal, prospects_windows_by_turn: windowsByTurn };
}

function pickExports(statesBySeed) {
  // select good/bad/weird by a simple score and heuristics
  const arr = Object.values(statesBySeed);
  const scored = arr.map((s) => {
    const score = s.manor.bushels_stored + s.manor.coin * 50 - s.manor.unrest * 20 - s.manor.obligations.arrears.bushels * 0.5;
    return { seed: s.run_seed, state: s, score };
  }).sort((a,b) => b.score - a.score);

  const good = scored[0] ?? null;

  // bad = worst score (or first dispossessed if exists)
  const badCand = [...scored].reverse().find((x) => x.state.game_over) ?? scored[scored.length-1] ?? null;

  // weird = has war levy or succession or extreme swings
  const weirdCand = scored.find((x) => {
    const notes = Array.isArray(x.state.log) ? x.state.log.flatMap((e) => e.report?.notes || []) : [];
    const hasSucc = notes.some((n) => String(n).includes("Succession"));
    const hasLevy = notes.some((n) => String(n).includes("War levy"));
    const unrests = Array.isArray(x.state.log) ? x.state.log.map((e) => e.snapshot_after?.manor?.unrest).filter((n) => Number.isFinite(n)) : [];
    const maxUnrest = unrests.length ? Math.max(...unrests) : -1;
    return hasSucc || hasLevy || maxUnrest >= 90;
  }) ?? scored[Math.floor(scored.length/2)] ?? null;

  return { good, bad: badCand, weird: weirdCand };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policyCanonical = canonicalizePolicyId(args.policy);
  const prospectPolicy = parseProspectPolicy(args.prospectPolicy);
  const runs = Math.max(1, Math.trunc(args.runs));
  const turns = Math.max(1, Math.trunc(args.turns));
  const policySanitized = sanitizePolicyIdForArtifacts(policyCanonical);

  // NOTE (v0.2.6 harness contract): prospectPolicy is a required grid dimension.
  // Default outdir MUST include prospectPolicy to avoid overwriting evidence runs.
  // Seed does NOT include prospectPolicy by default so that prospect policy variants
  // are directly comparable under identical seeds.
  const baseSeed = args.baseSeed || `batch_${APP_VERSION_STAMP}_${policySanitized}`;
  const outdir =
    args.outdir ||
    path.join(
      "artifacts",
      APP_VERSION_STAMP,
      policySanitized,
      `prospects_${prospectPolicy}`,
      `turns_${turns}`
    );

  ensureDir(outdir);

  const runRows = [];
  const eventCounts = {};
  const byReason = {};
  let completed = 0;

  let stableFinish = 0;
  let tail_unrest_ge_80 = 0;
  let tail_arrears_bushels_ge_1000 = 0;
  let tail_min_bushels_eq_0 = 0;

  let runsWithActiveConstruction = 0;
  let totalTurnsConstructionActive = 0;

  const endBushels = [];
  const endCoin = [];
  const endUnrest = [];
  const endArrearsCoin = [];
  const endArrearsBushels = [];
  const eventsPerTurn = [];

  // v0.2.3.1 Prospects KPIs (headless)
  const prospectsAgg = initProspectsCounters();
  let windowsAggTotal = 0;
  const windowsAggByTurn = Array.from({ length: turns }, () => 0);

  const statesBySeed = {};

  for (let i = 0; i < runs; i++) {
    const seed = `${baseSeed}_${String(i).padStart(4,"0")}`;
    const { state, prospects, prospects_windows_total, prospects_windows_by_turn } = runPolicy(seed, policyCanonical, turns, prospectPolicy);

    windowsAggTotal += (prospects_windows_total ?? 0);
    if (Array.isArray(prospects_windows_by_turn)) {
      for (let i = 0; i < windowsAggByTurn.length; i++) windowsAggByTurn[i] += (prospects_windows_by_turn[i] ?? 0);
    }
    addProspectsCounters(prospectsAgg, prospects);
    statesBySeed[seed] = state;

    const isComplete = !state.game_over && state.turn_index >= turns;
    if (isComplete) completed += 1;

    if (!state.game_over && state.manor.unrest <= 40 && state.manor.obligations.arrears.bushels <= 100) stableFinish += 1;
    if (state.manor.unrest >= 80) tail_unrest_ge_80 += 1;
    if (state.manor.obligations.arrears.bushels >= 1000) tail_arrears_bushels_ge_1000 += 1;

    const reason = state.game_over?.reason ?? "";
    if (reason) byReason[reason] = (byReason[reason] ?? 0) + 1;

    endBushels.push(state.manor.bushels_stored);
    endCoin.push(state.manor.coin);
    endUnrest.push(state.manor.unrest);
    endArrearsCoin.push(state.manor.obligations.arrears.coin);
    endArrearsBushels.push(state.manor.obligations.arrears.bushels);

    const eCount = state.log.reduce((s, l) => s + (l.report.events?.length ?? 0), 0);
    eventsPerTurn.push(state.log.length > 0 ? eCount / state.log.length : 0);

    for (const entry of state.log) {
      for (const ev of (entry.report.events ?? [])) {
        eventCounts[ev.id] = (eventCounts[ev.id] ?? 0) + 1;
      }
    }

    const impSet = new Set(state.manor.improvements);

    const energies = state.log.map((l) => l.snapshot_after.house.energy.available);
    const minEnergy = energies.length ? Math.min(...energies) : state.house.energy.available;
    const maxEnergy = energies.length ? Math.max(...energies) : state.house.energy.available;
    const relBounds = relationshipBounds(state);

    const turnsWithConstructionActive = state.log.reduce((acc, l) => acc + (l.snapshot_after.manor.construction ? 1 : 0), 0);
    const hadActiveConstruction = turnsWithConstructionActive > 0 || !!state.manor.construction;
    if (hadActiveConstruction) runsWithActiveConstruction += 1;
    totalTurnsConstructionActive += turnsWithConstructionActive;

    const unrestSeries = state.log.map((l) => l.snapshot_after.manor.unrest);
    const maxUnrest = unrestSeries.length ? Math.max(...unrestSeries) : state.manor.unrest;
    const minUnrest = unrestSeries.length ? Math.min(...unrestSeries) : state.manor.unrest;

    const busSeries = state.log.map((l) => l.snapshot_after.manor.bushels_stored);
    const coinSeries = state.log.map((l) => l.snapshot_after.manor.coin);
    const arrearsBusSeries = state.log.map((l) => l.snapshot_after.manor.obligations.arrears.bushels);
    const minBushels = busSeries.length ? Math.min(...busSeries) : state.manor.bushels_stored;
    const minCoin = coinSeries.length ? Math.min(...coinSeries) : state.manor.coin;
    const maxArrearsBushels = arrearsBusSeries.length ? Math.max(...arrearsBusSeries) : state.manor.obligations.arrears.bushels;
    if (minBushels === 0) tail_min_bushels_eq_0 += 1;

    const row = {
      seed,
      policy_logical: args.policy,
      policy_canonical: policyCanonical,
      policy_artifact_folder: policySanitized,
      horizon_turns: turns,
      turns_played: state.turn_index,
      completed: isComplete ? 1 : 0,
      game_over_reason: reason,
      game_over_turn: state.game_over?.turn_index ?? "",
      end_bushels: state.manor.bushels_stored,
      end_coin: state.manor.coin,
      end_unrest: state.manor.unrest,
      end_arrears_coin: state.manor.obligations.arrears.coin,
      end_arrears_bushels: state.manor.obligations.arrears.bushels,
      avg_events_per_turn: eventsPerTurn[eventsPerTurn.length - 1] ?? 0,
      had_active_construction: hadActiveConstruction ? 1 : 0,
      turns_construction_active: turnsWithConstructionActive,
      max_unrest: maxUnrest,
      min_unrest: minUnrest,
      min_bushels: minBushels,
      min_coin: minCoin,
      max_arrears_bushels: maxArrearsBushels,
      min_energy: minEnergy,
      max_energy: maxEnergy,
      ...relBounds
    };

    for (const impId of IMPROVEMENT_IDS) {
      row[`imp_${impId}`] = impSet.has(impId) ? 1 : 0;
    }

    const completedMap = {
      completed_granary: "granary_upgrade",
      completed_rotation: "field_rotation",
      completed_drainage: "drainage_ditches",
      completed_watch: "watch_ward",
      completed_mill: "mill_efficiency",
      completed_physician: "physician",
      completed_feast: "village_feast",
      completed_retinue: "retinue_drills"
    };
    for (const [col, impId] of Object.entries(completedMap)) {
      row[col] = impSet.has(impId) ? 1 : 0;
    }

    runRows.push(row);
  }

  const attempted = runs;
  const completionRate = completed / attempted;

  const bSorted = [...endBushels].sort((a,b)=>a-b);
  const cSorted = [...endCoin].sort((a,b)=>a-b);
  const uSorted = [...endUnrest].sort((a,b)=>a-b);
  const abSorted = [...endArrearsBushels].sort((a,b)=>a-b);

  const topEvents = Object.entries(eventCounts)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,10)
    .map(([id,count])=>({id,count}));

  const summary = {
    app_version: APP_VERSION_STAMP,
    ...(CODE_FINGERPRINT ? { code_fingerprint: CODE_FINGERPRINT } : {}),
    policy_logical: args.policy,
    policy_canonical: policyCanonical,
    policy_sanitized: policySanitized,
    prospect_policy: prospectPolicy,
    horizon_turns: turns,
    attempted,
    completed,
    completion_rate: completionRate,
    stable_finish: {
      definition: "end_unrest<=40 AND end_arrears_bushels<=100 AND not game_over",
      count: stableFinish,
      rate: stableFinish / attempted
    },
    tails: {
      pct_end_unrest_ge_80: tail_unrest_ge_80 / attempted,
      pct_end_arrears_bushels_ge_1000: tail_arrears_bushels_ge_1000 / attempted,
      pct_min_bushels_eq_0: tail_min_bushels_eq_0 / attempted
    },
    construction_path: {
      pct_runs_had_active_construction: runsWithActiveConstruction / attempted,
      avg_turns_construction_active: totalTurnsConstructionActive / attempted
    },
    ending_median: {
      bushels: median(bSorted),
      coin: median(cSorted),
      unrest: median(uSorted),
      arrears_bushels: median(abSorted)
    },
    ending_avg: {
      bushels: mean(endBushels),
      coin: mean(endCoin),
      unrest: mean(endUnrest),
      arrears_bushels: mean(endArrearsBushels)
    },
    avg_events_per_turn: mean(eventsPerTurn),
    top_events: topEvents,
    game_over_reasons: byReason,
    prospects: {
      generated: { total: sumProspectsByType(prospectsAgg.generated), by_type: prospectsAgg.generated },
      shown: { total: sumProspectsByType(prospectsAgg.shown), by_type: prospectsAgg.shown },
      hidden: { total: sumProspectsByType(prospectsAgg.hidden), by_type: prospectsAgg.hidden },
      windows_total: windowsAggTotal,
      windows_by_turn: windowsAggByTurn,
      outcomes: {
        accepted: { total: sumProspectsByType(prospectsAgg.accepted), by_type: prospectsAgg.accepted },
        rejected: { total: sumProspectsByType(prospectsAgg.rejected), by_type: prospectsAgg.rejected },
        expired: { total: sumProspectsByType(prospectsAgg.expired), by_type: prospectsAgg.expired },
        shown_but_expired: { total: sumProspectsByType(prospectsAgg.shown_but_expired), by_type: prospectsAgg.shown_but_expired }
      }
    }
  };

  // write outputs
  fs.writeFileSync(path.join(outdir, "batch_summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  const headers = Object.keys(runRows[0] ?? {});
  writeCsv(path.join(outdir, "runs.csv"), headers, runRows);

  const evRows = Object.entries(eventCounts).sort((a,b)=>b[1]-a[1]).map(([event_id,count])=>({event_id,count}));
  if (evRows.length) writeCsv(path.join(outdir, "event_counts.csv"), ["event_id","count"], evRows);

  const { good, bad, weird } = pickExports(statesBySeed);
  const exportsDir = path.join(outdir, "exports");
  ensureDir(exportsDir);
  if (good) fs.writeFileSync(path.join(exportsDir, "good_run.json"), JSON.stringify(good.state, null, 2), "utf-8");
  if (bad) fs.writeFileSync(path.join(exportsDir, "bad_run.json"), JSON.stringify(bad.state, null, 2), "utf-8");
  if (weird) fs.writeFileSync(path.join(exportsDir, "weird_run.json"), JSON.stringify(weird.state, null, 2), "utf-8");
}

main();