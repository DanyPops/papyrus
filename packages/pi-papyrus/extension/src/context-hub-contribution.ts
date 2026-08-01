import type { ContextSegment, ContextSegmentItem } from "@danypops/jittor";
import { type ContextBudget, sumItemTree } from "./context-budget.ts";
import type { SkillCatalogFootprint } from "./skill-catalog-footprint.ts";

/** Human-readable producer identity on Jittor's Context Hub bus -- distinct from PAPYRUS_CONTEXT_INJECTION_CHANNEL's own opaque per-process producerId, which identifies a specific injection stream rather than "which extension". */
export const PAPYRUS_CONTEXT_HUB_PRODUCER_NAME = "papyrus";

/**
 * Bundles Rules + Tasks + Skills catalog into ONE contributed ContextSegment. Jittor's
 * ContextHubCapability keeps only the latest segment per producer (a producer re-emits every
 * turn, mirroring papyrus.context-injection.v1's own cadence), so contributing three separate
 * top-level segments would need three fake producer identities instead of Papyrus's one real
 * one -- nested as up to three drill-down item groups under a single "papyrus" segment instead,
 * preserving the same per-category fidelity the original local /context breakdown had.
 */
export function papyrusContextSegment(
	ruleBudget: ContextBudget["rules"],
	taskItems: ContextSegmentItem[],
	skills: SkillCatalogFootprint,
): ContextSegment {
	const items: ContextSegmentItem[] = [];
	if (ruleBudget.entries.length > 0) {
		items.push({
			label: "Active Rules",
			estimatedTokens: ruleBudget.totalEstimatedTokens,
			children: ruleBudget.entries.map((entry) => ({ label: entry.title, estimatedTokens: entry.estimatedTokens })),
		});
	}
	if (taskItems.length > 0) {
		items.push({ label: "Open Tasks", estimatedTokens: sumItemTree(taskItems), children: taskItems });
	}
	if (skills.entries.length > 0) {
		items.push({
			label: "Pi Skills catalog",
			estimatedTokens: skills.totalEstimatedTokens,
			children: skills.entries.map((entry) => ({ label: entry.name, estimatedTokens: entry.estimatedTokens })),
		});
	}
	return {
		key: "papyrus",
		label: "Papyrus (Rules, Tasks, Skills)",
		estimatedTokens: items.reduce((sum, item) => sum + item.estimatedTokens, 0),
		confidence: "exact-cooperative",
		...(items.length > 0 ? { items } : {}),
	};
}
