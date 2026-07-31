import { describe, expect, it } from "bun:test";
import { validateContextSegment } from "@danypops/jittor";
import { papyrusContextSegment } from "../extension/src/context-hub-contribution.ts";
import type { ContextBudget } from "../extension/src/context-budget.ts";

function ruleBudget(entries: ContextBudget["rules"]["entries"] = []): ContextBudget["rules"] {
	return { entries, totalCharacters: entries.reduce((sum, e) => sum + e.characters, 0), totalEstimatedTokens: entries.reduce((sum, e) => sum + e.estimatedTokens, 0) };
}

function skills(entries: import("../extension/src/skill-catalog-footprint.ts").SkillCatalogEntry[] = []): import("../extension/src/skill-catalog-footprint.ts").SkillCatalogFootprint {
	return { entries, totalCharacters: entries.reduce((sum, e) => sum + e.characters, 0), totalEstimatedTokens: entries.reduce((sum, e) => sum + e.estimatedTokens, 0), scannedDirectories: [] };
}

describe("papyrusContextSegment", () => {
	it("bundles rules, tasks, and skills as three drill-down item groups under one segment", () => {
		const segment = papyrusContextSegment(
			ruleBudget([{ id: "r1", title: "Big rule", characters: 400, estimatedTokens: 100 }]),
			[{ label: "Ship it", estimatedTokens: 20 }],
			skills([{ name: "commit", description: "x", location: "/x", characters: 200, estimatedTokens: 50 }]),
		);
		expect(segment.key).toBe("papyrus");
		expect(segment.confidence).toBe("exact-cooperative");
		expect(segment.estimatedTokens).toBe(170); // 100 + 20 + 50
		expect(segment.items?.map((item) => item.label)).toEqual(["Active Rules", "Open Tasks", "Pi Skills catalog"]);
	});

	it("omits an empty category rather than showing a zero-token placeholder item", () => {
		const segment = papyrusContextSegment(ruleBudget([{ id: "r1", title: "R", characters: 40, estimatedTokens: 10 }]), [], skills());
		expect(segment.items?.map((item) => item.label)).toEqual(["Active Rules"]);
	});

	it("reports zero tokens and no items when Papyrus has nothing to contribute, rather than throwing", () => {
		const segment = papyrusContextSegment(ruleBudget(), [], skills());
		expect(segment.estimatedTokens).toBe(0);
		expect(segment.items).toBeUndefined();
	});

	it("sums the WHOLE task tree for the Tasks group total, not just top-level items", () => {
		const nestedTasks = [{ label: "Parent", estimatedTokens: 20, children: [{ label: "Child", estimatedTokens: 5 }] }];
		const segment = papyrusContextSegment(ruleBudget(), nestedTasks, skills());
		expect(segment.items?.[0]!.estimatedTokens).toBe(25);
	});

	it("round-trips through Jittor's own validateContextSegment -- the exact shape the Context Hub expects", () => {
		const segment = papyrusContextSegment(
			ruleBudget([{ id: "r1", title: "R", characters: 40, estimatedTokens: 10 }]),
			[{ label: "T", estimatedTokens: 5 }],
			skills([{ name: "s", description: "x", location: "/x", characters: 40, estimatedTokens: 10 }]),
		);
		expect(() => validateContextSegment(segment)).not.toThrow();
	});
});
