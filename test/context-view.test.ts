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
});

describe("buildContextRows", () => {
	const ruleBudget = { entries: [{ id: "r1", title: "A rule", characters: 400, estimatedTokens: 100 }], totalCharacters: 400, totalEstimatedTokens: 100 };
	const emptySkills = { entries: [], totalCharacters: 0, totalEstimatedTokens: 0, scannedDirectories: [] };

	it("drops a segment entirely when it is genuinely zero (no total, no items) -- a real 0 tok / 0.0% row is pure noise", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 100, contextWindow: null, ruleBudget, taskItems: [], skills: emptySkills, basePromptEstimatedTokens: 0, messageHistoryEstimatedTokens: 0 });
		const rows = buildContextRows(breakdown);
		expect(rows.some((row) => row.key === "tasks")).toBe(false);
		expect(rows.some((row) => row.key === "skills")).toBe(false);
	});

	it("keeps a genuinely-unknown segment visible even at zero, since hiding it would misrepresent 'not measured' as 'measured and empty'", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 100, contextWindow: null, ruleBudget, taskItems: [], skills: emptySkills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });
		const rows = buildContextRows(breakdown);
		const basePromptRow = rows.find((row) => row.key === "basePrompt");
		expect(basePromptRow).toBeDefined();
		expect(basePromptRow!.text).toContain("not observed yet");
	});

	it("filters individual zero-token items out of an otherwise-nonzero segment", () => {
		const zeroItemRules = { entries: [{ id: "r1", title: "Real", characters: 40, estimatedTokens: 10 }, { id: "r2", title: "Empty", characters: 0, estimatedTokens: 0 }], totalCharacters: 40, totalEstimatedTokens: 10 };
		const breakdown = buildContextBreakdown({ totalTokens: 100, contextWindow: null, ruleBudget: zeroItemRules, taskItems: [], skills: emptySkills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });
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
		const breakdown = buildContextBreakdown({ totalTokens: 200, contextWindow: null, ruleBudget: manyRules, taskItems: [], skills: emptySkills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });
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
		const breakdown = buildContextBreakdown({ totalTokens: 0, contextWindow: null, ruleBudget: zeroRules, taskItems: [], skills: emptySkills, basePromptEstimatedTokens: 0, messageHistoryEstimatedTokens: 0 });
		expect(buildContextRows(breakdown)).toEqual([]);
	});
});

describe("showContextView", () => {
	const ruleBudget = { entries: [{ id: "r1", title: "A rule", characters: 400, estimatedTokens: 100 }], totalCharacters: 400, totalEstimatedTokens: 100 };
	const skills = { entries: [], totalCharacters: 0, totalEstimatedTokens: 0, scannedDirectories: [] };

	it("falls back to a readable notification outside interactive mode, including real usage and the total", async () => {
		const notifications: string[] = [];
		const ctx = { mode: "rpc", hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
		const breakdown = buildContextBreakdown({ totalTokens: 5000, contextWindow: 200_000, ruleBudget, taskItems: [], skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });

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
		const breakdown = buildContextBreakdown({ totalTokens: null, contextWindow: null, ruleBudget, taskItems: [], skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });

		await showContextView(ctx, breakdown);

		expect(notifications[0]).toContain("Real usage: not yet reported");
	});
});
