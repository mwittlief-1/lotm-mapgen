import type { RunState } from "./types";
import { asNonNegInt, clampInt } from "./util";

export function normalizeState(state: RunState): void {
  const m = state.manor;

  m.population = asNonNegInt(m.population);
  m.farmers = clampInt(asNonNegInt(m.farmers), 0, m.population);
  m.builders = clampInt(asNonNegInt(m.builders), 0, m.population);
  if (m.farmers + m.builders > m.population) {
    m.builders = Math.max(0, m.population - m.farmers);
  }

  m.bushels_stored = asNonNegInt(m.bushels_stored);
  m.coin = asNonNegInt(m.coin);
  m.unrest = clampInt(asNonNegInt(m.unrest), 0, 100);

  const ob = m.obligations;
  ob.tax_due_coin = asNonNegInt(ob.tax_due_coin);
  ob.tithe_due_bushels = asNonNegInt(ob.tithe_due_bushels);
  ob.arrears.coin = asNonNegInt(ob.arrears.coin);
  ob.arrears.bushels = asNonNegInt(ob.arrears.bushels);

  const cons = m.construction;
  if (cons) {
    cons.progress = asNonNegInt(cons.progress);
    cons.required = Math.max(1, asNonNegInt(cons.required));
  }

  const h = state.house;
  h.energy.max = asNonNegInt(h.energy.max);
  h.energy.available = clampInt(asNonNegInt(h.energy.available), 0, h.energy.max);

  // relationship clamp
  for (const e of state.relationships) {
    e.allegiance = clampInt(asNonNegInt(e.allegiance), 0, 100);
    e.respect = clampInt(asNonNegInt(e.respect), 0, 100);
    e.threat = clampInt(asNonNegInt(e.threat), 0, 100);
  }
}
