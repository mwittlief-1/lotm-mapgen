import type { RunState, RunSummaryExport } from "./types";

export function buildRunSummary(state: RunState): RunSummaryExport {
  const keyFlags: string[] = [];
  for (const k of Object.keys(state.flags)) {
    if (k.startsWith("_")) continue;
    keyFlags.push(k);
  }
  return {
    seed: state.run_seed,
    app_version: state.app_version,
    sim_version: state.version,
    turns_played: state.turn_index,
    game_over_reason: state.game_over?.reason ?? null,
    ending_resources: {
      bushels: state.manor.bushels_stored,
      coin: state.manor.coin,
      unrest: state.manor.unrest,
      arrears_coin: state.manor.obligations.arrears.coin,
      arrears_bushels: state.manor.obligations.arrears.bushels
    },
    key_flags: keyFlags
  };
}
