#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createNewRun, proposeTurn, applyDecisions } from "../src/sim/index";
import type { ProspectType, ProspectsWindow, RunState, TurnDecisions } from "../src/sim/types";
import { decide, canonicalizePolicyId, sanitizePolicyIdForArtifacts, type PolicyId } from "../src/sim/policies";
import { IMPROVEMENT_IDS } from "../src/content/improvements";
import { relationshipBounds } from "../src/sim/relationships";
import { buildRunSummary } from "../src/sim/exports";

type ProspectPolicy = "reject-all" | "accept-all" | "accept-if-net-positive";
const PROSPECT_POLICIES: ProspectPolicy[] = ["reject-all", "accept-all", "accept-if-net-positive"];
const PROSPECT_TYPES: ProspectType[] = ["marriage", "grant", "inheritance_claim"];

type ProspectsByTypeCounters = Record<ProspectType, number>;
type ProspectsBatchCounters = {
  generated: ProspectsByTypeCounters;
  shown: ProspectsByTypeCounters;
  hidden: ProspectsByTypeCounters;
  accepted: ProspectsByTypeCounters;
  rejected: ProspectsByTypeCounters;
  expired: ProspectsByTypeCounters;
  shown_but_expired: ProspectsByTypeCounters;
};

function initProspectsByType(): ProspectsByTypeCounters {
  return { marriage: 0, grant: 0, inheritance_claim: 0 };
}

function initProspectsCounters(): ProspectsBatchCounters {
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

function addProspectsCounters(into: ProspectsBatchCounters, add: ProspectsBatchCounters): void {
  for (const k of Object.keys(into) as Array<keyof ProspectsBatchCounters>) {
    for (const t of PROSPECT_TYPES) {
      into[k][t] += add[k][t];
    }
  }
}

function sumProspectsByType(c: ProspectsByTypeCounters): number {
  return PROSPECT_TYPES.reduce((s, t) => s + (c[t] ?? 0), 0);
}

function parseProspectPolicy(raw: string | undefined): ProspectPolicy {
  const v = (raw ?? "reject-all") as ProspectPolicy;
  if (!PROSPECT_POLICIES.includes(v)) {
    throw new Error(`Invalid --prospectPolicy value: ${raw}. Allowed: ${PROSPECT_POLICIES.join("|")}`);
  }
  return v;
}

function prospectTypeFromWindow(window: ProspectsWindow, prospectId: string): ProspectType | null {
  for (const p of window.prospects) {
    if (p.id === prospectId) return p.type;
  }
  return null;
}

function computeProspectsActions(window: ProspectsWindow, prospectPolicy: ProspectPolicy): Array<{ prospect_id: string; action: "accept" | "reject" }> {
  if (!Array.isArray(window.shown_ids) || window.shown_ids.length === 0) return [];

  const shownSet = new Set(window.shown_ids);

  const indexed = window.prospects
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => shownSet.has(p.id))
    // LOCKED tie-break: prospect_i
    .sort((a, b) => a.i - b.i);

  const out: Array<{ prospect_id: string; action: "accept" | "reject" }> = [];

  for (const { p } of indexed) {
    let action: "accept" | "reject" = "reject";
    if (prospectPolicy === "accept-all") action = "accept";
    else if (prospectPolicy === "reject-all") action = "reject";
    else {
      const coinDeltaRaw = (p.predicted_effects as any)?.coin_delta;
      const costCoinRaw = (p.costs as any)?.coin;
      const coinDelta = typeof coinDeltaRaw === "number" && Number.isFinite(coinDeltaRaw) ? Math.trunc(coinDeltaRaw) : 0;
      const costCoin = typeof costCoinRaw === "number" && Number.isFinite(costCoinRaw) ? Math.trunc(costCoinRaw) : 0;
      const net = coinDelta - costCoin;
      action = net > 0 ? "accept" : "reject";
    }

    // Safety: only emit actions that are allowed by the prospect payload.
    const allowed = Array.isArray((p as any).actions) ? (p as any).actions.map(String) : ["accept", "reject"];
    if (!allowed.includes(action)) {
      if (allowed.includes("reject")) action = "reject";
      else continue;
    }

    out.push({ prospect_id: p.id, action });
  }

  return out;
}

type Args = {
  policy: string;
  prospectPolicy: ProspectPolicy;
  runs: number;
  turns: number;
  outdir?: string;
  baseSeed?: string;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { policy: "prudent-builder", prospectPolicy: "reject-all", runs: 250, turns: 15 };
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


type BuildInfo = {
  app_version?: string;
  sim_version?: string;
  code_fingerprint?: string;
};

function loadBuildInfo(): BuildInfo | null {
  try {
    const p = path.resolve("docs", "BUILD_INFO.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as BuildInfo;
  } catch {
    return null;
  }
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
  return sorted[idx]!;
}

function median(sorted: number[]): number {
  return percentile(sorted, 0.5);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath: string, headers: string[], rows: Array<Record<string, unknown>>) {
  const lines: string[] = [];
  lines.push(headers.map(csvEscape).join(","));
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h])).join(","));
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

function runPolicy(seed: string, policy: PolicyId, turns: number, prospectPolicy: ProspectPolicy): { state: RunState; prospects: ProspectsBatchCounters; prospects_windows_total: number; prospects_windows_by_turn: number[] } {
  let state = createNewRun(seed);

  const prospects = initProspectsCounters();
  const shownEver = new Set<string>();

  // Prospects windows telemetry
  const windowsByTurn = Array.from({ length: turns }, () => 0);
  let windowsTotal = 0;

  for (let t = 0; t < turns; t++) {
    const ctx = proposeTurn(state);

    // Prospects window exposure counters (by type)
    const pw = ctx.prospects_window ?? null;
    if (pw && pw.schema_version === "prospects_window_v1") {
      windowsTotal += 1;
      if (t >= 0 && t < windowsByTurn.length) windowsByTurn[t] += 1;
      for (const id of pw.shown_ids) {
        shownEver.add(id);
        const pt = prospectTypeFromWindow(pw, id);
        if (pt) prospects.shown[pt] += 1;
      }
      for (const id of pw.hidden_ids) {
        const pt = prospectTypeFromWindow(pw, id);
        if (pt) prospects.hidden[pt] += 1;
      }
    }

    const decisions: TurnDecisions = decide(policy, state, ctx);

    // v0.2.3.1 headless prospects policy hook (tooling-only)
    if (pw && pw.schema_version === "prospects_window_v1") {
      const actions = computeProspectsActions(pw, prospectPolicy);
      (decisions as any).prospects = { kind: "prospects", actions };
    }

    state = applyDecisions(state, decisions);

    // Outcome counters from log (authoritative)
    const last = state.log[state.log.length - 1];
    const plog: any[] = (last?.report as any)?.prospects_log ?? [];
    if (Array.isArray(plog)) {
      for (const ev of plog) {
        if (!ev || typeof ev !== "object") continue;
        const kind = (ev as any).kind;
        const type = (ev as any).type as ProspectType;
        const pid = (ev as any).prospect_id as string;
        if (!PROSPECT_TYPES.includes(type)) continue;
        if (kind === "prospect_generated") prospects.generated[type] += 1;
        if (kind === "prospect_accepted") prospects.accepted[type] += 1;
        if (kind === "prospect_rejected") prospects.rejected[type] += 1;
        if (kind === "prospect_expired") {
          prospects.expired[type] += 1;
          if (typeof pid === "string" && shownEver.has(pid)) prospects.shown_but_expired[type] += 1;
        }
      }
    }

    if (state.game_over) break;
  }
  return { state, prospects, prospects_windows_total: windowsTotal, prospects_windows_by_turn: windowsByTurn };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = canonicalizePolicyId(args.policy);
  const prospectPolicy = parseProspectPolicy(args.prospectPolicy);
  const runs = Math.max(1, Math.trunc(args.runs));
  const turns = Math.max(1, Math.trunc(args.turns));
  const policySanitized = sanitizePolicyIdForArtifacts(policy);
  const buildInfo = loadBuildInfo();
  const appVersion = buildInfo?.app_version ?? "unknown";
  const codeFingerprint = buildInfo?.code_fingerprint ?? "";

  // NOTE (v0.2.6 harness contract): prospectPolicy is a required grid dimension.
  // Default outdir MUST include prospectPolicy to avoid overwriting evidence runs.
  // Seed does NOT include prospectPolicy by default so that prospect policy variants
  // are directly comparable under identical seeds.
  const baseSeed = args.baseSeed ?? `batch_${appVersion}_${policySanitized}`;
  const outdir =
    args.outdir ??
    path.join(
      "artifacts",
      appVersion,
      policySanitized,
      `prospects_${prospectPolicy}`,
      `turns_${turns}`
    );

  ensureDir(outdir);

  const runRows: Array<Record<string, unknown>> = [];
  const eventCounts: Record<string, number> = {};
  const gameOverTurns: number[] = [];
  const endBushels: number[] = [];
  const endCoin: number[] = [];
  const endUnrest: number[] = [];
  const endArrearsCoin: number[] = [];
  const endArrearsBushels: number[] = [];
  const eventsPerTurn: number[] = [];

  const byReason: Record<string, number> = {};
  const gameOverByTurn: Record<string, number> = { "6": 0, "9": 0, "12": 0, "15": 0 };

  let completed = 0;

  // v0.0.9 evaluation contract KPIs
  let stableFinish = 0;
  let tail_unrest_ge_80 = 0;
  let tail_arrears_bushels_ge_1000 = 0;
  let tail_min_bushels_eq_0 = 0;

  // v0.0.7 harness telemetry (construction path verification)
  let runsWithActiveConstruction = 0;
  let totalTurnsConstructionActive = 0;
  let totalProjectsStarted = 0;
  let totalProjectsCompleted = 0;

  // v0.2.3.1 Prospects KPIs (headless)
  const prospectsAgg = initProspectsCounters();
  let windowsAggTotal = 0;
  const windowsAggByTurn = Array.from({ length: turns }, () => 0);

  const fullExports: Array<{ seed: string; state: RunState; score: number }> = [];

  for (let i = 0; i < runs; i++) {
    const seed = `${baseSeed}_${String(i).padStart(4, "0")}`;
    const { state, prospects, prospects_windows_total, prospects_windows_by_turn } = runPolicy(seed, policy, turns, prospectPolicy);
    windowsAggTotal += (prospects_windows_total ?? 0);
    if (Array.isArray(prospects_windows_by_turn)) {
      for (let i = 0; i < windowsAggByTurn.length; i++) windowsAggByTurn[i] += (prospects_windows_by_turn[i] ?? 0);
    }
    addProspectsCounters(prospectsAgg, prospects);

    const isComplete = !state.game_over && state.turn_index >= turns;
    if (isComplete) completed += 1;

    const reason = state.game_over?.reason ?? "";
    if (reason) byReason[reason] = (byReason[reason] ?? 0) + 1;

    const goTurn = state.game_over?.turn_index ?? turns;
    if (state.game_over) {
      gameOverTurns.push(goTurn);
      if (goTurn <= 6) gameOverByTurn["6"] += 1;
      if (goTurn <= 9) gameOverByTurn["9"] += 1;
      if (goTurn <= 12) gameOverByTurn["12"] += 1;
      if (goTurn <= 15) gameOverByTurn["15"] += 1;
    }

    endBushels.push(state.manor.bushels_stored);
    endCoin.push(state.manor.coin);
    endUnrest.push(state.manor.unrest);
    endArrearsCoin.push(state.manor.obligations.arrears.coin);
    endArrearsBushels.push(state.manor.obligations.arrears.bushels);

    // v0.0.9 Stable Finish + tails
    const isStableFinish = !state.game_over && state.manor.unrest <= 40 && state.manor.obligations.arrears.bushels <= 100;
    if (isStableFinish) stableFinish += 1;
    if (state.manor.unrest >= 80) tail_unrest_ge_80 += 1;
    if (state.manor.obligations.arrears.bushels >= 1000) tail_arrears_bushels_ge_1000 += 1;

    // event counts
    const eCount = state.log.reduce((s, l) => s + l.report.events.length, 0);
    eventsPerTurn.push(state.log.length > 0 ? eCount / state.log.length : 0);
    for (const entry of state.log) {
      for (const e of entry.report.events) {
        eventCounts[e.id] = (eventCounts[e.id] ?? 0) + 1;
      }
    }

    // improvements booleans
    const impSet = new Set(state.manor.improvements);

    // energy & relationship clamps (for QA convenience)
    const energies = state.log.map((l) => l.snapshot_after.house.energy.available);
    const minEnergy = energies.length > 0 ? Math.min(...energies) : state.house.energy.available;
    const maxEnergy = energies.length > 0 ? Math.max(...energies) : state.house.energy.available;
    const relBounds = relationshipBounds(state);


    // Construction telemetry (policy/harness correctness)
    const turnsWithConstructionActive = state.log.reduce((acc, l) => acc + (l.snapshot_after.manor.construction ? 1 : 0), 0);
    const projectsStarted = state.log.reduce((acc, l) => acc + (!l.snapshot_before.manor.construction && l.snapshot_after.manor.construction ? 1 : 0), 0);
    const projectsCompleted = state.log.reduce((acc, l) => acc + (l.report.construction.completed_improvement_id ? 1 : 0), 0);
    const hadActiveConstruction = turnsWithConstructionActive > 0 || !!state.manor.construction;

    // Extremes (for gating analysis)
    const unrestSeries = state.log.map((l) => l.snapshot_after.manor.unrest);
    const maxUnrest = unrestSeries.length > 0 ? Math.max(...unrestSeries) : state.manor.unrest;
    const minUnrest = unrestSeries.length > 0 ? Math.min(...unrestSeries) : state.manor.unrest;
    const minBushels = state.log.length > 0 ? Math.min(...state.log.map((l) => l.snapshot_after.manor.bushels_stored)) : state.manor.bushels_stored;
    if (minBushels === 0) tail_min_bushels_eq_0 += 1;
    const minCoin = state.log.length > 0 ? Math.min(...state.log.map((l) => l.snapshot_after.manor.coin)) : state.manor.coin;
    const arrearsCoinSeries = state.log.map((l) => l.snapshot_after.manor.obligations.arrears.coin);
    const arrearsBushelsSeries = state.log.map((l) => l.snapshot_after.manor.obligations.arrears.bushels);
    const maxArrearsCoin = arrearsCoinSeries.length > 0 ? Math.max(...arrearsCoinSeries) : state.manor.obligations.arrears.coin;
    const minArrearsCoin = arrearsCoinSeries.length > 0 ? Math.min(...arrearsCoinSeries) : state.manor.obligations.arrears.coin;
    const maxArrearsBushels = arrearsBushelsSeries.length > 0 ? Math.max(...arrearsBushelsSeries) : state.manor.obligations.arrears.bushels;
    const minArrearsBushels = arrearsBushelsSeries.length > 0 ? Math.min(...arrearsBushelsSeries) : state.manor.obligations.arrears.bushels;

    if (hadActiveConstruction) runsWithActiveConstruction += 1;
    totalTurnsConstructionActive += turnsWithConstructionActive;
    totalProjectsStarted += projectsStarted;
    totalProjectsCompleted += projectsCompleted;

    const row: Record<string, unknown> = {
      seed,

      policy_logical: args.policy,
      policy_canonical: policy,
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
      projects_started: projectsStarted,
      projects_completed: projectsCompleted,
      max_unrest: maxUnrest,
      min_unrest: minUnrest,
      min_bushels: minBushels,
      min_coin: minCoin,
      max_arrears_coin: maxArrearsCoin,
      min_arrears_coin: minArrearsCoin,
      max_arrears_bushels: maxArrearsBushels,
      min_arrears_bushels: minArrearsBushels,
      min_energy: minEnergy,
      max_energy: maxEnergy,
      ...relBounds
    };

    for (const impId of IMPROVEMENT_IDS) {
      row[`imp_${impId}`] = impSet.has(impId) ? 1 : 0;
    }

    // Friendly improvement booleans (stable column names for balance gating)
    const completedMap: Record<string, string> = {
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

    // Keep a few full exports for "good/bad/weird" selection
    const score = state.manor.bushels_stored + state.manor.coin * 50 - state.manor.unrest * 20;
    fullExports.push({ seed, state, score });
  }

  // summary stats
  const attempted = runs;
  const completionRate = completed / attempted;

  const goSorted = [...gameOverTurns].sort((a, b) => a - b);
  const bSorted = [...endBushels].sort((a, b) => a - b);
  const cSorted = [...endCoin].sort((a, b) => a - b);
  const uSorted = [...endUnrest].sort((a, b) => a - b);
  const acSorted = [...endArrearsCoin].sort((a, b) => a - b);
  const abSorted = [...endArrearsBushels].sort((a, b) => a - b);

  const topEvents = Object.entries(eventCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([id, count]) => ({ id, count }));

  const summary = {
    app_version: appVersion,
    ...(codeFingerprint ? { code_fingerprint: codeFingerprint } : {}),
    policy,
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
      avg_turns_construction_active: totalTurnsConstructionActive / attempted,
      avg_projects_started: totalProjectsStarted / attempted,
      avg_projects_completed: totalProjectsCompleted / attempted
    },
    game_over_by_turn: gameOverByTurn,
    game_over_reasons: Object.entries(byReason)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => ({ reason, count, pct: count / attempted })),
    game_over_turn: {
      median: median(goSorted),
      p10: percentile(goSorted, 0.1),
      p90: percentile(goSorted, 0.9)
    },
    ending: {
      avg_bushels: mean(endBushels),
      med_bushels: median(bSorted),
      avg_coin: mean(endCoin),
      med_coin: median(cSorted),
      avg_unrest: mean(endUnrest),
      med_unrest: median(uSorted),
      avg_arrears_coin: mean(endArrearsCoin),
      med_arrears_coin: median(acSorted),
      avg_arrears_bushels: mean(endArrearsBushels),
      med_arrears_bushels: median(abSorted)
    },
    events: {
      avg_events_per_turn: mean(eventsPerTurn),
      top10: topEvents
    },
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
    },
    allowed_game_over_reasons: ["Dispossessed", "DeathNoHeir"]
  };

  fs.writeFileSync(path.join(outdir, "batch_summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  // event histogram csv
  const eventRows = Object.entries(eventCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({ event_id: id, count }));
  writeCsv(path.join(outdir, "event_counts.csv"), ["event_id", "count"], eventRows);

  // runs csv
  const headers = Object.keys(runRows[0] ?? { seed: "", policy: "" });
  writeCsv(path.join(outdir, "runs.csv"), headers, runRows);

  // Select exports
  fullExports.sort((a, b) => b.score - a.score);
  const good = fullExports[0];
  const bad = fullExports[fullExports.length - 1];
  const weird = fullExports.find((x) => x.state.game_over?.reason === "Dispossessed") ?? fullExports[Math.floor(fullExports.length / 2)];

  if (good) fs.writeFileSync(path.join(outdir, "good_run.json"), JSON.stringify(good.state, null, 2), "utf-8");
  if (bad) fs.writeFileSync(path.join(outdir, "bad_run.json"), JSON.stringify(bad.state, null, 2), "utf-8");
  if (weird) fs.writeFileSync(path.join(outdir, "weird_run.json"), JSON.stringify(weird.state, null, 2), "utf-8");

  // Also write run summaries for fast scan
  const summaries = [good, bad, weird].filter(Boolean).map((x: any) => buildRunSummary(x.state));
  fs.writeFileSync(path.join(outdir, "run_summaries.json"), JSON.stringify(summaries, null, 2), "utf-8");

  console.log(`Done. Wrote artifacts to ${outdir}`);
}

main();
