import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { renderContextBar, showContextView } from "../extension/src/context-view.ts";
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

describe("showContextView", () => {
	const ruleBudget = { entries: [{ id: "r1", title: "A rule", characters: 400, estimatedTokens: 100 }], totalCharacters: 400, totalEstimatedTokens: 100 };
	const skills = { entries: [], totalCharacters: 0, totalEstimatedTokens: 0, scannedDirectories: [] };

	it("falls back to a readable notification outside interactive mode, including real usage and the total", async () => {
		const notifications: string[] = [];
		const ctx = { mode: "rpc", hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
		const breakdown = buildContextBreakdown({ totalTokens: 5000, contextWindow: 200_000, ruleBudget, taskEstimatedTokens: 0, skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });

		await showContextView(ctx, breakdown, ruleBudget);

		expect(notifications).toHaveLength(1);
		expect(notifications[0]).toContain("Real usage: 5000 tokens");
		expect(notifications[0]).toContain("Unaccounted (tool definitions, framework overhead)");
		expect(notifications[0]).toContain("Base system prompt (not observed yet)");
		expect(notifications[0]).toContain("Conversation message history");
		expect(notifications[0]).toContain("A rule");
	});

	it("reports usage as not yet available, rather than a misleading zero, when Pi has no usage yet", async () => {
		const notifications: string[] = [];
		const ctx = { mode: "rpc", hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
		const breakdown = buildContextBreakdown({ totalTokens: null, contextWindow: null, ruleBudget, taskEstimatedTokens: 0, skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });

		await showContextView(ctx, breakdown, ruleBudget);

		expect(notifications[0]).toContain("Real usage: not yet reported");
	});
});
