import { IMPROVEMENTS } from "../content/improvements.js";
/**
 * v0.0.7 Policy Registry (LOCKED IDs + alias mapping)
 *
 * Canonical IDs:
 * - prudent-builder
 * - builder-forward
 * - builder-forward/buffered
 *
 * Aliases:
 * - good-faith -> prudent-builder
 */
export const POLICY_IDS = ["prudent-builder", "builder-forward", "builder-forward/buffered"];
export const POLICY_ALIASES = {
    "prudent-builder": "prudent-builder",
    "builder-forward": "builder-forward",
    "builder-forward/buffered": "builder-forward/buffered",
    // locked alias
    "good-faith": "prudent-builder",
    // convenience: allow passing sanitized ID via CLI (not canonical)
    "builder-forward__buffered": "builder-forward/buffered"
};
export function canonicalizePolicyId(id) {
    const raw = String(id ?? "").trim();
    if (!raw)
        return "prudent-builder";
    const direct = POLICY_ALIASES[raw];
    if (direct)
        return direct;
    // If someone passed a sanitized folder name, try reversing it.
    if (raw.includes("__") && !raw.includes("/")) {
        const unsanitized = raw.replace(/__/g, "/");
        const mapped = POLICY_ALIASES[unsanitized];
        if (mapped)
            return mapped;
    }
    return "prudent-builder";
}
/** Policy sanitizer (WP-10 LOCK): replace '/' -> '__' for artifact folders. */
export function sanitizePolicyIdForArtifacts(policyId) {
    return String(policyId).replaceAll("/", "__");
}
function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
function withLaborCap(curF, curB, desiredF, desiredB, maxShift) {
    const dF = desiredF - curF;
    const dB = desiredB - curB;
    const total = Math.abs(dF) + Math.abs(dB);
    if (total <= maxShift)
        return { f: desiredF, b: desiredB };
    // scale deltas down proportionally
    const scale = maxShift / Math.max(1, total);
    const newF = curF + Math.round(dF * scale);
    const newB = curB + Math.round(dB * scale);
    return { f: newF, b: newB };
}
function chooseImprovementPrudent(state) {
    const have = new Set(state.manor.improvements);
    // simple priority order
    const order = [
        "granary_upgrade",
        "field_rotation",
        "drainage_ditches",
        "watch_ward",
        "physician",
        "mill_efficiency",
        "retinue_drills",
        "village_feast"
    ];
    for (const id of order) {
        if (have.has(id))
            continue;
        const def = IMPROVEMENTS[id];
        if (!def)
            continue;
        if (state.manor.coin >= def.coin_cost)
            return id;
    }
    return null;
}
/**
 * WP-11 LOCK:
 * Canonical builder-forward improvement priority (first viable):
 * 1) Field Rotation
 * 2) Drainage & Ditches
 * 3) Granary
 * 4) Mill Efficiency
 * 5) Watch & Ward
 * then Physician -> Retinue -> Feast
 *
 * Viable = not built AND no active project AND coin >= cost.
 * Tie-break if needed: (coin_cost, required, energy_cost, improvement_id)
 */
function chooseImprovementBuilderForward(state) {
    const have = new Set(state.manor.improvements);
    const priority = [
        "field_rotation",
        "drainage_ditches",
        "granary_upgrade",
        "mill_efficiency",
        "watch_ward",
        "physician",
        "retinue_drills",
        "village_feast"
    ];
    const rank = new Map();
    for (let i = 0; i < priority.length; i++)
        rank.set(priority[i], i);
    const viable = Object.values(IMPROVEMENTS)
        .filter((def) => !have.has(def.id) && state.manor.coin >= def.coin_cost)
        .sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : 1e9;
        const rb = rank.has(b.id) ? rank.get(b.id) : 1e9;
        if (ra !== rb)
            return ra - rb;
        // tie-breaks (future-proof)
        if (a.coin_cost !== b.coin_cost)
            return a.coin_cost - b.coin_cost;
        if (a.required !== b.required)
            return a.required - b.required;
        if (a.energy_cost !== b.energy_cost)
            return a.energy_cost - b.energy_cost;
        return a.id.localeCompare(b.id);
    });
    return viable.length > 0 ? viable[0].id : null;
}
function chooseImprovementCheapestViable(state) {
    const have = new Set(state.manor.improvements);
    const viable = Object.values(IMPROVEMENTS)
        .filter((def) => !have.has(def.id) && state.manor.coin >= def.coin_cost)
        .sort((a, b) => {
        if (a.coin_cost !== b.coin_cost)
            return a.coin_cost - b.coin_cost;
        if (a.required !== b.required)
            return a.required - b.required;
        if (a.energy_cost !== b.energy_cost)
            return a.energy_cost - b.energy_cost;
        return a.id.localeCompare(b.id);
    });
    return viable.length > 0 ? viable[0].id : null;
}
export function decide(policy, state, ctx) {
    const s = ctx.preview_state; // includes this-turn resolution pre-decisions
    const maxShift = ctx.max_labor_shift;
    const pop = s.manor.population;
    const curF = s.manor.farmers;
    const curB = s.manor.builders;
    // Defaults
    let desiredF = curF;
    let desiredB = curB;
    let sellBushels = 0;
    let payCoin = 0;
    let payBushels = 0;
    let warChoice = undefined;
    // --- Policy-specific logic ---
    if (policy === "prudent-builder") {
        // keep a buffer; only build if stable
        const stable = !s.game_over &&
            s.manor.bushels_stored > 1200 &&
            s.manor.obligations.arrears.coin === 0 &&
            s.manor.obligations.arrears.bushels === 0 &&
            s.manor.unrest < 60;
        desiredB = s.manor.construction ? clamp(Math.floor(pop * 0.12), 2, 10) : 0;
        desiredF = clamp(pop - desiredB, 10, pop);
        // Sell surplus above reserve (respect sell cap later)
        const reserve = 1300;
        sellBushels = Math.max(0, s.manor.bushels_stored - reserve);
        // Pay obligations aggressively
        payCoin = Math.min(s.manor.coin, s.manor.obligations.tax_due_coin + s.manor.obligations.arrears.coin);
        payBushels = Math.min(s.manor.bushels_stored, s.manor.obligations.tithe_due_bushels + s.manor.obligations.arrears.bushels);
        if (s.manor.obligations.war_levy_due) {
            const levy = s.manor.obligations.war_levy_due;
            if (levy && levy.kind === "men_or_coin") {
                if (s.manor.coin >= levy.coin)
                    warChoice = "coin";
                else if (s.manor.farmers >= levy.men + 5)
                    warChoice = "men";
                else
                    warChoice = "coin"; // try coin; fallback applies
            }
        }
        // Construction: start only if stable and no active project
        let constructionAction = { kind: "construction", action: "none" };
        if (stable && !s.manor.construction) {
            const imp = chooseImprovementPrudent(s);
            if (imp)
                constructionAction = { kind: "construction", action: "start", improvement_id: imp };
        }
        // Marriage: accept best non-negative dowry if any eligible
        let marriageAction = { kind: "marriage", action: "none" };
        if (ctx.marriage_window && ctx.marriage_window.eligible_child_ids.length > 0) {
            const offers = ctx.marriage_window.offers;
            let bestIdx = -1;
            let bestScore = -1e9;
            for (let i = 0; i < offers.length; i++) {
                const o = offers[i];
                // conservative: avoid negative dowry unless affordable
                if (o.dowry_coin_net < 0 && s.manor.coin < Math.abs(o.dowry_coin_net))
                    continue;
                const score = o.dowry_coin_net * 3 + o.relationship_delta.respect * 2 + o.relationship_delta.allegiance;
                if (score > bestScore) {
                    bestScore = score;
                    bestIdx = i;
                }
            }
            if (bestIdx >= 0) {
                marriageAction = { kind: "marriage", action: "accept", child_id: ctx.marriage_window.eligible_child_ids[0], offer_index: bestIdx };
            }
        }
        const capped = withLaborCap(curF, curB, desiredF, desiredB, maxShift);
        return {
            labor: { kind: "labor", desired_farmers: clamp(capped.f, 0, pop), desired_builders: clamp(capped.b, 0, pop) },
            sell: { kind: "sell", sell_bushels: sellBushels },
            obligations: { kind: "pay_obligations", pay_coin: payCoin, pay_bushels: payBushels, war_levy_choice: warChoice },
            construction: constructionAction,
            marriage: marriageAction
        };
    }
    if (policy === "builder-forward") {
        // Canonical builder-forward (CEO LOCK): temptation productivity path.
        // - Allocate builders aggressively (≈20% pop within labor delta caps).
        // - NO buffer-floor stall rule (that behavior belongs only to builder-forward/buffered).
        // - Start construction whenever possible; pick improvements via WP-11 priority list.
        const consumptionEst = ctx.report?.consumption_bushels && ctx.report.consumption_bushels > 0 ? ctx.report.consumption_bushels : pop * 12 * 3;
        // Aggressive builders target (bounded by labor cap below).
        desiredB = s.manor.construction ? clamp(Math.floor(pop * 0.22), 3, 20) : clamp(Math.floor(pop * 0.20), 3, 18);
        desiredF = clamp(pop - desiredB, 8, pop);
        // Selling: keep a small operating reserve; sell surplus to fund improvements.
        const reserve = Math.ceil(consumptionEst * 0.9); // ~0.9 turns
        sellBushels = Math.max(0, s.manor.bushels_stored - reserve);
        // Pay obligations but tolerate some arrears (stress policy).
        payCoin = Math.min(s.manor.coin, Math.max(0, s.manor.obligations.tax_due_coin));
        payBushels = Math.min(s.manor.bushels_stored, Math.max(0, s.manor.obligations.tithe_due_bushels));
        if (s.manor.obligations.war_levy_due)
            warChoice = s.manor.coin > 4 ? "coin" : "men";
        // Construction: start whenever possible if none active
        let constructionAction = { kind: "construction", action: "none" };
        if (!s.manor.construction) {
            const imp = chooseImprovementBuilderForward(s);
            if (imp)
                constructionAction = { kind: "construction", action: "start", improvement_id: imp };
        }
        // Marriage: accept best dowry (avoid negative if unaffordable)
        let marriageAction = { kind: "marriage", action: "none" };
        if (ctx.marriage_window && ctx.marriage_window.eligible_child_ids.length > 0) {
            const offers = ctx.marriage_window.offers;
            let bestIdx = 0;
            let bestScore = -1e9;
            for (let i = 0; i < offers.length; i++) {
                const o = offers[i];
                if (o.dowry_coin_net < 0 && s.manor.coin < Math.abs(o.dowry_coin_net))
                    continue;
                const score = o.dowry_coin_net * 4 + o.relationship_delta.respect;
                if (score > bestScore) {
                    bestScore = score;
                    bestIdx = i;
                }
            }
            marriageAction = { kind: "marriage", action: "accept", child_id: ctx.marriage_window.eligible_child_ids[0], offer_index: bestIdx };
        }
        const capped = withLaborCap(curF, curB, desiredF, desiredB, maxShift);
        return {
            labor: { kind: "labor", desired_farmers: clamp(capped.f, 0, pop), desired_builders: clamp(capped.b, 0, pop) },
            sell: { kind: "sell", sell_bushels: sellBushels },
            obligations: { kind: "pay_obligations", pay_coin: payCoin, pay_bushels: payBushels, war_levy_choice: warChoice },
            construction: constructionAction,
            marriage: marriageAction
        };
    }
    if (policy === "builder-forward/buffered") {
        // Diagnostic buffered builder-forward (WP-08/WP-09 LOCK):
        // - Stall builders to 0 if food buffer is below 1.2 turns of consumption.
        // - Choose cheapest viable improvement (tie-breaks deterministic).
        const consumptionEst = ctx.report?.consumption_bushels && ctx.report.consumption_bushels > 0 ? ctx.report.consumption_bushels : pop * 12 * 3;
        const foodBufferTurns = 1.2;
        const shouldStallForFood = s.manor.bushels_stored < foodBufferTurns * consumptionEst;
        if (shouldStallForFood) {
            desiredB = 0;
            desiredF = clamp(pop, 0, pop);
        }
        else {
            desiredB = s.manor.construction ? clamp(Math.floor(pop * 0.34), 8, 22) : clamp(Math.floor(pop * 0.28), 6, 18);
            desiredF = clamp(pop - desiredB, 8, pop);
        }
        const reserve = Math.ceil(foodBufferTurns * consumptionEst);
        sellBushels = shouldStallForFood ? 0 : Math.max(0, s.manor.bushels_stored - reserve);
        payCoin = Math.min(s.manor.coin, Math.max(0, s.manor.obligations.tax_due_coin));
        payBushels = Math.min(s.manor.bushels_stored, Math.max(0, s.manor.obligations.tithe_due_bushels));
        if (s.manor.obligations.war_levy_due)
            warChoice = s.manor.coin > 4 ? "coin" : "men";
        let constructionAction = { kind: "construction", action: "none" };
        if (!s.manor.construction) {
            const imp = chooseImprovementCheapestViable(s);
            if (imp)
                constructionAction = { kind: "construction", action: "start", improvement_id: imp };
        }
        let marriageAction = { kind: "marriage", action: "none" };
        if (ctx.marriage_window && ctx.marriage_window.eligible_child_ids.length > 0) {
            const offers = ctx.marriage_window.offers;
            let bestIdx = 0;
            let bestScore = -1e9;
            for (let i = 0; i < offers.length; i++) {
                const o = offers[i];
                if (o.dowry_coin_net < 0 && s.manor.coin < Math.abs(o.dowry_coin_net))
                    continue;
                const score = o.dowry_coin_net * 4 + o.relationship_delta.respect;
                if (score > bestScore) {
                    bestScore = score;
                    bestIdx = i;
                }
            }
            marriageAction = { kind: "marriage", action: "accept", child_id: ctx.marriage_window.eligible_child_ids[0], offer_index: bestIdx };
        }
        const capped = withLaborCap(curF, curB, desiredF, desiredB, maxShift);
        return {
            labor: { kind: "labor", desired_farmers: clamp(capped.f, 0, pop), desired_builders: clamp(capped.b, 0, pop) },
            sell: { kind: "sell", sell_bushels: sellBushels },
            obligations: { kind: "pay_obligations", pay_coin: payCoin, pay_bushels: payBushels, war_levy_choice: warChoice },
            construction: constructionAction,
            marriage: marriageAction
        };
    }
    // Fallback (should be unreachable with canonicalizePolicyId)
    return decide("prudent-builder", state, ctx);
}
