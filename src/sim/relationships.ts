import type { RelationshipEdge, RunState } from "./types";
import { clampInt } from "./util";

export function ensureEdge(state: RunState, fromId: string, toId: string): RelationshipEdge {
  const edges = state.relationships;
  const found = edges.find((e) => e.from_id === fromId && e.to_id === toId);
  if (found) return found;
  const e: RelationshipEdge = { from_id: fromId, to_id: toId, allegiance: 50, respect: 50, threat: 20 };
  edges.push(e);
  return e;
}

export function adjustEdge(state: RunState, fromId: string, toId: string, delta: { allegiance?: number; respect?: number; threat?: number }): void {
  const e = ensureEdge(state, fromId, toId);
  if (delta.allegiance !== undefined) e.allegiance = clampInt(e.allegiance + delta.allegiance, 0, 100);
  if (delta.respect !== undefined) e.respect = clampInt(e.respect + delta.respect, 0, 100);
  if (delta.threat !== undefined) e.threat = clampInt(e.threat + delta.threat, 0, 100);
}

export function relationshipBounds(state: RunState): {
  min_allegiance: number; max_allegiance: number;
  min_respect: number; max_respect: number;
  min_threat: number; max_threat: number;
} {
  let minA = 100, maxA = 0, minR = 100, maxR = 0, minT = 100, maxT = 0;
  for (const e of state.relationships) {
    minA = Math.min(minA, e.allegiance); maxA = Math.max(maxA, e.allegiance);
    minR = Math.min(minR, e.respect); maxR = Math.max(maxR, e.respect);
    minT = Math.min(minT, e.threat); maxT = Math.max(maxT, e.threat);
  }
  if (state.relationships.length === 0) {
    minA = 0; maxA = 0; minR = 0; maxR = 0; minT = 0; maxT = 0;
  }
  return { min_allegiance: minA, max_allegiance: maxA, min_respect: minR, max_respect: maxR, min_threat: minT, max_threat: maxT };
}
