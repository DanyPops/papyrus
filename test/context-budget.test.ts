import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextBreakdown, computeContextBudget, computeRuleBudget, DEFAULT_RESERVE_TOKENS, estimateMessageHistoryTokens, formatContextBudgetReport } from "../extension/src/context-budget.ts";

function rule(id: string, title: string, extra: Record<string, unknown> = {}): { id: string; title: string; body: string; extra: Record<string, unknown> } {
	return { id, title, body: "Do the thing.", extra };
}

describe("computeRuleBudget", () => {
	it("sizes each rule via the same ruleInjectionPreview text actually injected, sorted biggest first", () => {
		const budget = computeRuleBudget([
			rule("short", "Short rule"),
			rule("long", "A rule with a much longer title that costs more characters", { condition: "always", action: "Do more things with more words" }),
		]);
		expect(budget.entries[0]!.id).toBe("long");
		expect(budget.entries[1]!.id).toBe("short");
		expect(budget.totalCharacters).toBe(budget.entries[0]!.characters + budget.entries[1]!.characters);
		expect(budget.totalEstimatedTokens).toBeGreaterThan(0);
	});

	it("reports zero for no active rules rather than throwing", () => {
		expect(computeRuleBudget([])).toEqual({ entries: [], totalCharacters: 0, totalEstimatedTokens: 0 });
	});
});

describe("computeContextBudget", () => {
	it("combines rule and skill footprints into one total", () => {
		const dir = mkdtempSync(join(tmpdir(), "papyrus-budget-"));
		const skillDir = join(dir, "home", ".pi", "agent", "skills", "example");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: example\ndescription: An example skill.\n---\n");

		const budget = computeContextBudget([rule("r1", "A rule")], join(dir, "project"), join(dir, "home"));

		expect(budget.rules.entries).toHaveLength(1);
		expect(budget.skills.entries).toHaveLength(1);
		expect(budget.totalEstimatedTokens).toBe(budget.rules.totalEstimatedTokens + budget.skills.totalEstimatedTokens);
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads settings.json's skills array and includes those directories in the scan", () => {
		const dir = mkdtempSync(join(tmpdir(), "papyrus-budget-settings-"));
		const homeDirectory = join(dir, "home");
		const externalSkills = join(dir, "external-skills", "imported");
		mkdirSync(join(homeDirectory, ".pi", "agent"), { recursive: true });
		mkdirSync(externalSkills, { recursive: true });
		writeFileSync(join(homeDirectory, ".pi", "agent", "settings.json"), JSON.stringify({ skills: [join(dir, "external-skills")] }));
		writeFileSync(join(externalSkills, "SKILL.md"), "---\nname: imported\ndescription: Configured via settings.json.\n---\n");

		const budget = computeContextBudget([], join(dir, "project"), homeDirectory);

		expect(budget.skills.entries.map((entry) => entry.name)).toEqual(["imported"]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("tolerates a missing or malformed settings.json rather than failing the whole report", () => {
		const dir = mkdtempSync(join(tmpdir(), "papyrus-budget-badsettings-"));
		const homeDirectory = join(dir, "home");
		mkdirSync(join(homeDirectory, ".pi", "agent"), { recursive: true });
		writeFileSync(join(homeDirectory, ".pi", "agent", "settings.json"), "{ not valid json");

		expect(() => computeContextBudget([], join(dir, "project"), homeDirectory)).not.toThrow();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("estimateMessageHistoryTokens", () => {
	it("sums text content across user, assistant, and tool-result messages in the branch", () => {
		const tokens = estimateMessageHistoryTokens([
			{ type: "message", message: { role: "user", content: "x".repeat(40) } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(40) }] } },
			{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "z".repeat(40) }] } },
		]);
		expect(tokens).toBe(Math.ceil(120 / 4));
	});

	it("counts thinking blocks and tool-call arguments, not just plain text", () => {
		const tokens = estimateMessageHistoryTokens([
			{ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(20) }, { type: "toolCall", arguments: { path: "b".repeat(20) } }] } },
		]);
		expect(tokens).toBeGreaterThan(0);
	});

	it("excludes bashExecution output explicitly marked excludeFromContext, matching Pi's own !! prefix behavior", () => {
		const included = estimateMessageHistoryTokens([{ type: "message", message: { role: "bashExecution", command: "ls", output: "x".repeat(100), excludeFromContext: false } }]);
		const excluded = estimateMessageHistoryTokens([{ type: "message", message: { role: "bashExecution", command: "ls", output: "x".repeat(100), excludeFromContext: true } }]);
		expect(included).toBeGreaterThan(0);
		expect(excluded).toBe(0);
	});

	it("counts compaction and branch_summary entries' summaries, since they do participate in context", () => {
		const tokens = estimateMessageHistoryTokens([{ type: "compaction", summary: "x".repeat(400) }, { type: "branch_summary", summary: "y".repeat(400) }]);
		expect(tokens).toBe(Math.ceil(800 / 4));
	});

	it("ignores non-context entry types (custom, label, model_change) entirely", () => {
		expect(estimateMessageHistoryTokens([{ type: "custom" }, { type: "label" }, { type: "model_change" }])).toBe(0);
	});

	it("returns zero for an empty branch rather than throwing", () => {
		expect(estimateMessageHistoryTokens([])).toBe(0);
	});

	it("tolerates a malformed or unexpected message shape without throwing", () => {
		expect(() => estimateMessageHistoryTokens([{ type: "message", message: null }, { type: "message", message: "not an object" }, { type: "message" }])).not.toThrow();
	});
});

describe("buildContextBreakdown", () => {
	const ruleBudget = { entries: [{ id: "r1", title: "Big rule", characters: 400, estimatedTokens: 100 }], totalCharacters: 400, totalEstimatedTokens: 100 };
	const skills = { entries: [{ name: "commit", description: "x", location: "/x", characters: 200, estimatedTokens: 50 }], totalCharacters: 200, totalEstimatedTokens: 50, scannedDirectories: ["/home/user/.claude/skills"] };

	it("derives 'everything else' as the remainder between the real total and Papyrus's own known segments", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 1000, contextWindow: 200_000, ruleBudget, taskEstimatedTokens: 20, skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });
		const other = breakdown.segments.find((segment) => segment.key === "other")!;
		expect(other.estimatedTokens).toBe(1000 - (100 + 20 + 50)); // 830
		expect(breakdown.totalTokens).toBe(1000);
	});

	it("clamps 'everything else' to zero instead of going negative when estimates overshoot the real total", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 50, contextWindow: null, ruleBudget, taskEstimatedTokens: 20, skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 }); // known segments alone already sum to 170 > 50
		const other = breakdown.segments.find((segment) => segment.key === "other")!;
		expect(other.estimatedTokens).toBe(0);
	});

	it("reports zero for 'everything else' and preserves null totalTokens when real usage is unavailable, rather than treating a partial sum as ground truth", () => {
		const breakdown = buildContextBreakdown({ totalTokens: null, contextWindow: null, ruleBudget, taskEstimatedTokens: 20, skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });
		expect(breakdown.totalTokens).toBeNull();
		expect(breakdown.segments.find((segment) => segment.key === "other")!.estimatedTokens).toBe(0);
	});

	it("computes effectiveBudget as contextWindow minus the reserve, mirroring Pi's own compaction trigger formula", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 1000, contextWindow: 200_000, ruleBudget, taskEstimatedTokens: 0, skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });
		expect(breakdown.effectiveBudget).toBe(200_000 - DEFAULT_RESERVE_TOKENS);
	});

	it("honors an explicit reserveTokens override instead of the default", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 1000, contextWindow: 100_000, reserveTokens: 5000, ruleBudget, taskEstimatedTokens: 0, skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });
		expect(breakdown.effectiveBudget).toBe(95_000);
	});

	it("reports effectiveBudget as null when the context window itself is unknown", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 1000, contextWindow: null, ruleBudget, taskEstimatedTokens: 0, skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });
		expect(breakdown.effectiveBudget).toBeNull();
	});

	it("carries per-rule and per-skill drill-down items on their respective segments, but not on tasks or other", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 1000, contextWindow: null, ruleBudget, taskEstimatedTokens: 20, skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });
		expect(breakdown.segments.find((segment) => segment.key === "rules")!.items).toEqual([{ label: "Big rule", estimatedTokens: 100 }]);
		expect(breakdown.segments.find((segment) => segment.key === "skills")!.items).toEqual([{ label: "commit", estimatedTokens: 50 }]);
		expect(breakdown.segments.find((segment) => segment.key === "tasks")!.items).toBeUndefined();
		expect(breakdown.segments.find((segment) => segment.key === "other")!.items).toBeUndefined();
	});

	it("includes base prompt and message history as their own segments, both without drill-down items", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 10_000, contextWindow: null, ruleBudget, taskEstimatedTokens: 0, skills, basePromptEstimatedTokens: 500, messageHistoryEstimatedTokens: 8000 });
		const basePrompt = breakdown.segments.find((segment) => segment.key === "basePrompt")!;
		const messageHistory = breakdown.segments.find((segment) => segment.key === "messageHistory")!;
		expect(basePrompt.estimatedTokens).toBe(500);
		expect(basePrompt.items).toBeUndefined();
		expect(messageHistory.estimatedTokens).toBe(8000);
		expect(messageHistory.items).toBeUndefined();
		// message history correctly absorbed into "known" tokens, shrinking the unaccounted remainder
		const other = breakdown.segments.find((segment) => segment.key === "other")!;
		expect(other.estimatedTokens).toBe(10_000 - (100 + 0 + 50 + 500 + 8000));
	});

	it("labels the base prompt segment as not-yet-observed when its size is unknown, rather than silently showing zero as if it were measured", () => {
		const unobserved = buildContextBreakdown({ totalTokens: 1000, contextWindow: null, ruleBudget, taskEstimatedTokens: 0, skills, basePromptEstimatedTokens: null, messageHistoryEstimatedTokens: 0 });
		expect(unobserved.segments.find((segment) => segment.key === "basePrompt")!.label).toContain("not observed yet");
		const observed = buildContextBreakdown({ totalTokens: 1000, contextWindow: null, ruleBudget, taskEstimatedTokens: 0, skills, basePromptEstimatedTokens: 200, messageHistoryEstimatedTokens: 0 });
		expect(observed.segments.find((segment) => segment.key === "basePrompt")!.label).not.toContain("not observed yet");
	});
});

describe("formatContextBudgetReport", () => {
	it("renders a readable report with per-item breakdown and a combined total", () => {
		const report = formatContextBudgetReport({
			rules: { entries: [{ id: "r1", title: "Never mention Papyrus in project docs", characters: 2603, estimatedTokens: 651 }], totalCharacters: 2603, totalEstimatedTokens: 651 },
			skills: {
				entries: [{ name: "ptp-weekly-ci", description: "x", location: "/x/SKILL.md", characters: 472, estimatedTokens: 118 }],
				totalCharacters: 472, totalEstimatedTokens: 118, scannedDirectories: ["/home/user/.claude/skills"],
			},
			totalEstimatedTokens: 769,
		});
		expect(report).toContain("Rules (active, injected every relevant turn): 1 rules · 2603 chars · ~651 tokens");
		expect(report).toContain("Never mention Papyrus in project docs");
		expect(report).toContain("Skills (Pi-native catalog, injected at startup): 1 skills · 472 chars · ~118 tokens");
		expect(report).toContain("ptp-weekly-ci");
		expect(report).toContain("Scanned: /home/user/.claude/skills");
		expect(report).toContain("Total passive tax: ~769 tokens across 2 items");
	});

	it("reports plainly when nothing is found, instead of an empty or confusing section", () => {
		const report = formatContextBudgetReport({
			rules: { entries: [], totalCharacters: 0, totalEstimatedTokens: 0 },
			skills: { entries: [], totalCharacters: 0, totalEstimatedTokens: 0, scannedDirectories: [] },
			totalEstimatedTokens: 0,
		});
		expect(report).toContain("No skill directories found");
		expect(report).toContain("Total passive tax: ~0 tokens across 0 items");
	});
});
