#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { IMPROVEMENTS } from "../src/content/improvements";
import { EVENT_DECK } from "../src/content/events";
import { APP_VERSION } from "../src/version";
import { SIM_VERSION } from "../src/sim/version";
import { POLICY_IDS, sanitizePolicyIdForArtifacts } from "../src/sim/policies";
import { createNewRun } from "../src/sim/state";
import type { RunState } from "../src/sim/types";
import { Rng } from "../src/sim/rng";
import {
  SPOILAGE_RATE_BASE,
  SPOILAGE_RATE_GRANARY,
  YIELD_MULT_FIELD_ROTATION,
  YIELD_MULT_DRAINAGE_DITCHES,
  SELL_MULT_MILL_EFFICIENCY,
  DRAINAGE_WEATHER_SOFTEN_BONUS,
  VILLAGE_FEAST_UNREST_REDUCTION,
  MORTALITY_MULT_WITH_PHYSICIAN
} from "../src/sim/constants";

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
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

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function writeMarkdownTable(filePath: string, headers: string[], rows: string[][], title?: string) {
  const out: string[] = [];
  if (title) {
    out.push(title);
    out.push("");
  }
  out.push(`APP_VERSION: ${APP_VERSION}`);
  out.push(`SIM_VERSION: ${SIM_VERSION}`);
  out.push(`Generated at (UTC): ${new Date().toISOString()}`);
  out.push("");

  out.push(`| ${headers.map(mdEscape).join(" | ")} |`);
  out.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const r of rows) {
    out.push(`| ${r.map((c) => mdEscape(c)).join(" | ")} |`);
  }

  fs.writeFileSync(filePath, out.join("\n"), "utf-8");
}

function cloneState(s: RunState): RunState {
  // For docs only. RunState is JSON-serializable by contract.
  return JSON.parse(JSON.stringify(s)) as RunState;
}

function improvementEffectSummary(id: string): string {
  switch (id) {
    case "granary_upgrade":
      return `Spoilage rate: ${SPOILAGE_RATE_BASE} → ${SPOILAGE_RATE_GRANARY} per turn.`;
    case "field_rotation":
      return `Yield ×${YIELD_MULT_FIELD_ROTATION}; blight risk reduced (event weights).`;
    case "drainage_ditches":
      return `Yield ×${YIELD_MULT_DRAINAGE_DITCHES}; if weather<1.0 then +${DRAINAGE_WEATHER_SOFTEN_BONUS} weather softening; winter/drought pressure reduced (event weights).`;
    case "mill_efficiency":
      return `Sell price ×${SELL_MULT_MILL_EFFICIENCY}.`;
    case "watch_ward":
      return `Banditry/raids weights reduced (event deck).`;
    case "physician":
      return `Illness weights reduced (event deck); mortality ×${MORTALITY_MULT_WITH_PHYSICIAN} (when applicable).`;
    case "village_feast":
      return `On completion: unrest -${VILLAGE_FEAST_UNREST_REDUCTION}.`;
    case "retinue_drills":
      return `No direct mechanical hook yet (placeholder); intended as security mitigation content hook.`;
    default:
      return `See description; no structured effect metadata.`;
  }
}

function formatDelta(before: RunState, after: RunState): string {
  const deltas: Array<[string, number]> = [
    ["bushels", after.manor.bushels_stored - before.manor.bushels_stored],
    ["coin", after.manor.coin - before.manor.coin],
    ["unrest", after.manor.unrest - before.manor.unrest],
    ["pop", after.manor.population - before.manor.population],
    ["arrears_coin", after.manor.obligations.arrears.coin - before.manor.obligations.arrears.coin],
    ["arrears_bushels", after.manor.obligations.arrears.bushels - before.manor.obligations.arrears.bushels]
  ];
  const parts = deltas.filter(([, d]) => d !== 0).map(([k, d]) => `${k}:${d > 0 ? "+" : ""}${d}`);
  return parts.length ? parts.join("; ") : "—";
}

function main() {
  const outDir = path.join(process.cwd(), "docs", "matrices");
  ensureDir(outDir);

  // --- Improvements matrix (CSV) ---
  const improvementsRows = Object.values(IMPROVEMENTS)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => ({
      id: d.id,
      name: d.name,
      coin_cost: d.coin_cost,
      energy_cost: d.energy_cost,
      required: d.required,
      description: d.description
    }));

  writeCsv(
    path.join(outDir, "improvements_matrix.csv"),
    ["id", "name", "coin_cost", "energy_cost", "required", "description"],
    improvementsRows
  );

  // --- Improvements effects (MD) ---
  const improvementsMdRows = Object.values(IMPROVEMENTS)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => [
      d.id,
      d.name,
      String(d.coin_cost),
      String(d.energy_cost),
      String(d.required),
      d.description,
      improvementEffectSummary(d.id)
    ]);

  writeMarkdownTable(
    path.join(outDir, "improvements_effects.md"),
    ["id", "name", "coin_cost", "energy_cost", "required", "description", "effect_summary"],
    improvementsMdRows,
    "# Improvements Effects Matrix"
  );

  // --- Events matrix (CSV) ---
  const eventsRows = EVENT_DECK.map((e) => ({
    id: e.id,
    title: e.title,
    category: e.category,
    cooldown: e.cooldown
  })).sort((a, b) => a.id.localeCompare(b.id));

  writeCsv(path.join(outDir, "events_matrix.csv"), ["id", "title", "category", "cooldown"], eventsRows);

  // --- Events effects (MD; sample run on a probe state) ---
  const probe = createNewRun("matrix_probe_seed_v007");
  // Make the probe state moderately “active” so notes/effects are illustrative.
  probe.manor.bushels_stored = 1400;
  probe.manor.coin = 14;
  probe.manor.unrest = 25;
  probe.manor.obligations.tax_due_coin = 2;
  probe.manor.obligations.tithe_due_bushels = 30;

  const eventMdRows = EVENT_DECK
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((def) => {
      const w = def.getWeight(probe);
      const before = cloneState(probe);
      const after = cloneState(probe);

      // Sample apply on a cloned state so docs show representative effects text.
      const rng = new Rng(after.run_seed, "events", 0, `matrix:${def.id}`);
      const effects = def.apply(after, rng).slice(0, 3); // keep readable
      const delta = formatDelta(before, after);

      const why = [`weight@probe=${w.weight.toFixed(2)}`, ...w.notes].slice(0, 4).join(" • ");
      return [
        def.id,
        def.title,
        def.category,
        String(def.cooldown),
        why || "—",
        effects.length ? effects.join(" / ") : "—",
        delta
      ];
    });

  writeMarkdownTable(
    path.join(outDir, "events_effects.md"),
    ["id", "title", "category", "cooldown", "trigger_summary (probe)", "sample_effects (probe)", "sample_deltas (probe)"],
    eventMdRows,
    "# Events Effects Matrix"
  );

  // --- Policies matrix (markdown) ---
  const builderForwardPriority = [
    "field_rotation",
    "drainage_ditches",
    "granary_upgrade",
    "mill_efficiency",
    "watch_ward",
    "physician",
    "retinue_drills",
    "village_feast"
  ];

  const md: string[] = [];
  md.push(`# Policy Matrix — ${APP_VERSION}`);
  md.push("");
  md.push(`SIM_VERSION: ${SIM_VERSION}`);
  md.push(`Generated at (UTC): ${new Date().toISOString()}`);
  md.push("");
  md.push("## Policies");
  md.push("");
  for (const id of POLICY_IDS) {
    const folder = sanitizePolicyIdForArtifacts(id);
    md.push(`- **${id}** → artifacts folder: \`${folder}\``);
  }
  md.push("");
  md.push("## builder-forward improvement priority (WP-11 LOCK)");
  md.push("");
  for (let i = 0; i < builderForwardPriority.length; i++) {
    md.push(`${i + 1}. ${builderForwardPriority[i]}`);
  }
  md.push("");
  md.push("Notes:");
  md.push("- `builder-forward` is the canonical temptation path (no food-buffer stall rule).");
  md.push("- `builder-forward/buffered` is the diagnostic variant that may stall builders under a food buffer floor and selects the *cheapest viable* improvement.");

  fs.writeFileSync(path.join(outDir, "policies_matrix.md"), md.join("\n"), "utf-8");

  console.log(`Matrices written to ${outDir}`);
}

main();
