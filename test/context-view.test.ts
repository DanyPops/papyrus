import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { buildContextRows, renderContextBar, showContextView } from "../extension/src/context-view.ts";
import { buildContextBreakdown } from "../extension/src/context-budget.ts";
import type { ContextSegment } from "../extension/src/context-budget.ts";

const distinguishingTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as Theme;
const plainTheme = { fg: (_color: string, text: string) => text } as Theme;

function segment(key: ContextSegment["key"], estimatedTokens: number): ContextSegment {
	return { key, label: key, estimatedTokens };
}

describe("renderContextBar", () => {
	it("splits the bar proportionally to each segment's real share of the total", () => {
		const bar = renderContextBar(plainTheme, [segment("rules", 75), segment("skills", 25)], 100);
		expect(bar).toBe("█".repeat(75) + "█".repeat(25));
		expect(bar.length).toBe(100);
	});

	it("colors each segment's run with its own distinct theme color", () => {
		const bar = renderContextBar(distinguishingTheme, [segment("rules", 50), segment("tasks", 50)], 10);
		expect(bar).toContain("<accent>");
		expect(bar).toContain("<success>");
	});

	it("gives the last segment the remainder so rounding never produces a bar wider or narrower than requested", () => {
		// 33/33/34 across a width of 10 would round to 3.3/3.3/3.4 -- the last segment must
		// absorb whatever rounding leaves over so the total cell count is always exactly `width`.
		const bar = renderContextBar(plainTheme, [segment("rules", 1), segment("tasks", 1), segment("skills", 1)], 10);
		expect(bar.length).toBe(10);
	});

	it("renders a dim empty track, not a divide-by-zero, when every segment is zero", () => {
		const bar = renderContextBar(distinguishingTheme, [segment("rules", 0), segment("other", 0)], 10);
		expect(bar).toBe(`<dim>${"░".repeat(10)}</dim>`);
	});

	it("renders nothing for a non-positive width", () => {
		expect(renderContextBar(plainTheme, [segment("rules", 10)], 0)).toBe("");
	});

	it("shows the remaining, genuinely empty context window as a gray/dim track when a capacity is known", () => {
		// 50 used out of a capacity of 100, width 100 -- 50 colored cells, 50 dim/gray cells.
		const bar = renderContextBar(distinguishingTheme, [segment("rules", 50)], 100, 100);
		expect(bar).toBe(`<accent>${"█".repeat(50)}</accent><dim>${"░".repeat(50)}</dim>`);
	});

	it("falls back to filling 100% of the width when capacity is omitted, matching the pre-existing (no unused concept) behavior", () => {
		const bar = renderContextBar(plainTheme, [segment("rules", 50)], 100);
		expect(bar).toBe("█".repeat(100));
	});

	it("fills 100% used with no gray remainder once real usage has met or exceeded the known capacity (overshoot / at budget)", () => {
		const atCapacity = renderContextBar(plainTheme, [segment("rules", 100)], 100, 100);
		expect(atCapacity).toBe("█".repeat(100));
		const overCapacity = renderContextBar(plainTheme, [segment("rules", 150)], 100, 100);
		expect(overCapacity).toBe("█".repeat(100));
	});

	it("still renders an entirely gray/dim track when every segment is zero, even with a capacity given -- 0 used really is a fully empty window", () => {
		const bar = renderContextBar(distinguishingTheme, [segment("rules", 0)], 10, 500);
		expect(bar).toBe(`<dim>${"░".repeat(10)}</dim>`);
	});

	it("REGRESSION: shows a real gray remainder even when segment estimates overshoot capacity, using real usedTokens instead of the unreliable estimate sum", () => {
		// The live reported bug: header showed 549.9k/983.6k (55.9%), but the bar rendered
		// fully solid with zero gray, because estimated segments summed to ~1.57M -- far more
		// than the 983.6k capacity -- so the old `capacity > total` check failed and the bar
		// fell back to "100% used, no unused space left", contradicting the real 55.9% shown
		// right above it. messageHistory here plays the role of the real session's own
		// wildly-overestimated segment; rules/tasks are the real, comparatively tiny segments
		// that must still show as their own distinct gray-adjacent colored region.
		const segments = [segment("rules", 4309), segment("tasks", 2000), segment("messageHistory", 1_567_954)];
		const bar = renderContextBar(plainTheme, segments, 100, 983_600, 549_900);
		const usedCells = bar.replace(/░/g, "").length;
		const emptyCells = bar.length - usedCells;
		expect(emptyCells).toBeGreaterThan(0); // real gray remainder must exist -- 55.9% used means ~44% empty
		expect(Math.round((549_900 / 983_600) * 100)).toBe(usedCells); // used width matches the REAL ratio, not the inflated estimate sum
	});

	it("REGRESSION: every nonzero segment gets at least one visible cell when there is room, even one dwarfed by a much larger segment", () => {
		// The live reported bug's second symptom: "no other colors besides blue" -- a tiny
		// segment (rules) rounds to zero width and vanishes entirely when one segment
		// (messageHistory) is orders of magnitude larger, even though rules genuinely has
		// real, nonzero content that a human should be able to see in the bar.
		const segments = [segment("rules", 4309), segment("tasks", 2000), segment("messageHistory", 1_567_954)];
		const bar = renderContextBar(distinguishingTheme, segments, 60, 983_600, 549_900);
		expect(bar).toContain("<accent>"); // rules' color -- must be present, not rounded away to nothing
		expect(bar).toContain("<success>"); // tasks' color
		expect(bar).toContain("<syntaxFunction>"); // messageHistory's color, still the dominant share
	});

	it("falls back to the estimate sum as usedTokens when no real total is available, matching the pre-existing behavior", () => {
		const bar = renderContextBar(plainTheme, [segment("rules", 50), segment("tasks", 50)], 100, 200);
		expect(bar.length).toBe(100);
		expect(bar).toBe("█".repeat(50) + "░".repeat(50)); // 100 estimated out of 200 capacity -- 50% used, matches passing usedTokens explicitly
	});
});

describe("buildContextRows", () => {
	const ruleBudget = { entries: [{ id: "r1", title: "A rule", characters: 400, estimatedTokens: 100 }], totalCharacters: 400, totalEstimatedTokens: 100 };
	const emptySkills = { entries: [], totalCharacters: 0, totalEstimatedTokens: 0, scannedDirectories: [] };

	it("drops a segment entirely when it is genuinely zero (no total, no items) -- a real 0 tok / 0.0% row is pure noise", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 100, contextWindow: null, ruleBudget, taskItems: [], skills: emptySkills, basePromptEstimatedTokens: 0, messageHistoryItems: [], messageHistoryActiveTokens: 0 });
		const rows = buildContextRows(breakdown);
		expect(rows.some((row) => row.key === "tasks")).toBe(false);
		expect(rows.some((row) => row.key === "skills")).toBe(false);
	});

	it("keeps a genuinely-unknown segment visible even at zero, since hiding it would misrepresent 'not measured' as 'measured and empty'", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 100, contextWindow: null, ruleBudget, taskItems: [], skills: emptySkills, basePromptEstimatedTokens: null, messageHistoryItems: [], messageHistoryActiveTokens: 0 });
		const rows = buildContextRows(breakdown);
		const basePromptRow = rows.find((row) => row.key === "basePrompt");
		expect(basePromptRow).toBeDefined();
		expect(basePromptRow!.text).toContain("not observed yet");
	});

	it("filters individual zero-token items out of an otherwise-nonzero segment", () => {
		const zeroItemRules = { entries: [{ id: "r1", title: "Real", characters: 40, estimatedTokens: 10 }, { id: "r2", title: "Empty", characters: 0, estimatedTokens: 0 }], totalCharacters: 40, totalEstimatedTokens: 10 };
		const breakdown = buildContextBreakdown({ totalTokens: 100, contextWindow: null, ruleBudget: zeroItemRules, taskItems: [], skills: emptySkills, basePromptEstimatedTokens: null, messageHistoryItems: [], messageHistoryActiveTokens: 0 });
		const rows = buildContextRows(breakdown);
		const ruleItemRows = rows.filter((row) => row.key === "rules" && !row.isHeader);
		expect(ruleItemRows).toHaveLength(1);
		expect(ruleItemRows[0]!.text).toContain("Real");
	});

	it("produces one header row per visible segment, plus one item row per nonzero item, sorted biggest first", () => {
		const manyRules = {
			entries: [{ id: "a", title: "Small", characters: 4, estimatedTokens: 1 }, { id: "b", title: "Big", characters: 400, estimatedTokens: 100 }],
			totalCharacters: 404, totalEstimatedTokens: 101,
		};
		const breakdown = buildContextBreakdown({ totalTokens: 200, contextWindow: null, ruleBudget: manyRules, taskItems: [], skills: emptySkills, basePromptEstimatedTokens: null, messageHistoryItems: [], messageHistoryActiveTokens: 0 });
		const rows = buildContextRows(breakdown);
		const header = rows.find((row) => row.key === "rules" && row.isHeader)!;
		expect(header.text).toContain("101 tok");
		const items = rows.filter((row) => row.key === "rules" && !row.isHeader);
		expect(items.map((row) => row.text.trim().endsWith("Big") || row.text.trim().endsWith("Small"))).toEqual([true, true]);
		expect(items[0]!.text).toContain("Big"); // biggest first
		expect(items[1]!.text).toContain("Small");
	});

	it("returns an empty row list when every segment is genuinely zero and none are unknown", () => {
		const zeroRules = { entries: [], totalCharacters: 0, totalEstimatedTokens: 0 };
		const breakdown = buildContextBreakdown({ totalTokens: 0, contextWindow: null, ruleBudget: zeroRules, taskItems: [], skills: emptySkills, basePromptEstimatedTokens: 0, messageHistoryItems: [], messageHistoryActiveTokens: 0 });
		expect(buildContextRows(breakdown)).toEqual([]);
	});

	it("flattens a real item tree (Task containment, message history branches) into indented rows, parent immediately followed by its own children", () => {
		const nestedTasks = [{ label: "Parent", estimatedTokens: 20, children: [{ label: "Child", estimatedTokens: 5 }] }];
		const breakdown = buildContextBreakdown({ totalTokens: 100, contextWindow: null, ruleBudget: { entries: [], totalCharacters: 0, totalEstimatedTokens: 0 }, taskItems: nestedTasks, skills: emptySkills, basePromptEstimatedTokens: null, messageHistoryItems: [], messageHistoryActiveTokens: 0 });
		const rows = buildContextRows(breakdown);
		const header = rows.find((row) => row.key === "tasks" && row.isHeader)!;
		const parentRow = rows.find((row) => row.key === "tasks" && row.text.includes("Parent"))!;
		const childRow = rows.find((row) => row.key === "tasks" && row.text.includes("Child"))!;
		expect(header.depth).toBe(0);
		expect(parentRow.depth).toBe(1);
		expect(childRow.depth).toBe(2); // deeper than its parent, not flattened to the same level
		// parent immediately precedes its own child -- never scrambled by a global size sort
		const parentIndex = rows.indexOf(parentRow);
		expect(rows[parentIndex + 1]).toBe(childRow);
	});

	it("filters a zero-token child out of an otherwise-nonzero parent item", () => {
		const nestedTasks = [{ label: "Parent", estimatedTokens: 20, children: [{ label: "RealChild", estimatedTokens: 5 }, { label: "EmptyChild", estimatedTokens: 0 }] }];
		const breakdown = buildContextBreakdown({ totalTokens: 100, contextWindow: null, ruleBudget: { entries: [], totalCharacters: 0, totalEstimatedTokens: 0 }, taskItems: nestedTasks, skills: emptySkills, basePromptEstimatedTokens: null, messageHistoryItems: [], messageHistoryActiveTokens: 0 });
		const rows = buildContextRows(breakdown);
		expect(rows.some((row) => row.text.includes("RealChild"))).toBe(true);
		expect(rows.some((row) => row.text.includes("EmptyChild"))).toBe(false);
	});
});

describe("showContextView", () => {
	const ruleBudget = { entries: [{ id: "r1", title: "A rule", characters: 400, estimatedTokens: 100 }], totalCharacters: 400, totalEstimatedTokens: 100 };
	const skills = { entries: [], totalCharacters: 0, totalEstimatedTokens: 0, scannedDirectories: [] };

	it("falls back to a readable notification outside interactive mode, including real usage and the total", async () => {
		const notifications: string[] = [];
		const ctx = { mode: "rpc", hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
		const breakdown = buildContextBreakdown({ totalTokens: 5000, contextWindow: 200_000, ruleBudget, taskItems: [], skills, basePromptEstimatedTokens: null, messageHistoryItems: [], messageHistoryActiveTokens: 0 });

		await showContextView(ctx, breakdown);

		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("Real usage: 5000 tokens");
		expect(notifications[0]).toContain("Unaccounted (tool definitions, framework overhead)");
		// basePrompt stays visible even at 0 tok because it's genuinely unknown (not yet observed),
		// but a real, measured zero (Tasks and message history here) is correctly hidden as noise.
		expect(notifications[0]).toContain("Base system prompt (not observed yet)");
		expect(notifications[0]).not.toContain("Conversation message history");
		expect(notifications[0]).not.toContain("Papyrus Tasks");
		expect(notifications[0]).toContain("A rule");
	});

	it("reports usage as not yet available, rather than a misleading zero, when Pi has no usage yet", async () => {
		const notifications: string[] = [];
		const ctx = { mode: "rpc", hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
		const breakdown = buildContextBreakdown({ totalTokens: null, contextWindow: null, ruleBudget, taskItems: [], skills, basePromptEstimatedTokens: null, messageHistoryItems: [], messageHistoryActiveTokens: 0 });

		await showContextView(ctx, breakdown);

		expect(notifications[0]).toContain("Real usage: not yet reported");
	});
});
