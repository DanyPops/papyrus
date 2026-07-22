import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildContextBreakdown,
	buildMessageHistoryTree,
	buildTaskItemTree,
	computeContextBudget,
	computeRuleBudget,
	DEFAULT_RESERVE_TOKENS,
	type SessionEntryLike,
	type SessionTreeNodeLike,
} from "../extension/src/context-budget.ts";
import type { TaskGraph, TaskNode } from "../src/task-service.ts";
import type { Artifact } from "../src/domain/artifact.ts";

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

function node(id: string, entry: Partial<SessionEntryLike> & { type: string }, children: SessionTreeNodeLike[] = []): SessionTreeNodeLike {
	return { entry: { id, type: entry.type, message: entry.message, summary: entry.summary }, children };
}

describe("buildMessageHistoryTree", () => {
	it("walks the real tree (not just the active branch), sizing each node's own text content", () => {
		const tree = [node("1", { type: "message", message: { role: "user", content: "x".repeat(40) } })];
		const result = buildMessageHistoryTree(tree, new Set(["1"]));
		expect(result.items).toHaveLength(1);
		expect(result.items[0]!.estimatedTokens).toBe(Math.ceil(40 / 4));
		expect(result.activeTokens).toBe(Math.ceil(40 / 4));
	});

	it("preserves real branching as nested children, matching Pi's own tree structure", () => {
		const child = node("2", { type: "message", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(40) }] } });
		const tree = [node("1", { type: "message", message: { role: "user", content: "x".repeat(40) } }, [child])];
		const result = buildMessageHistoryTree(tree, new Set(["1", "2"]));
		expect(result.items[0]!.children).toHaveLength(1);
		expect(result.items[0]!.children![0]!.estimatedTokens).toBe(Math.ceil(40 / 4));
	});

	it("labels a branch not on the active path distinctly, and excludes it from activeTokens -- content that cost real tokens to generate but isn't currently in context", () => {
		const abandoned = node("2b", { type: "message", message: { role: "assistant", content: [{ type: "text", text: "z".repeat(40) }] } });
		const active = node("2a", { type: "message", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(40) }] } });
		const tree = [node("1", { type: "message", message: { role: "user", content: "x".repeat(40) } }, [active, abandoned])];
		// Only "1" and "2a" are on the current active path; "2b" is an abandoned /tree branch.
		const result = buildMessageHistoryTree(tree, new Set(["1", "2a"]));
		const root = result.items[0]!;
		const activeChild = root.children!.find((child) => child.label.includes("assistant") && !child.label.includes("inactive"))!;
		const abandonedChild = root.children!.find((child) => child.label.includes("inactive branch"))!;
		expect(activeChild).toBeDefined();
		expect(abandonedChild).toBeDefined();
		expect(result.activeTokens).toBe(Math.ceil(40 / 4) * 2); // root + active child only, not the abandoned one
	});

	it("labels an entry excluded by compaction (still on the branch path) distinctly from a genuinely abandoned /tree branch", () => {
		// "1" was compacted away (buildContextEntries() excludes it) but IS still on the raw
		// getBranch() path -- this must read as "(compacted)", not the less accurate
		// "(inactive branch)" label reserved for content on a different path entirely.
		const compactionEntry = node("2", { type: "compaction", summary: "s".repeat(40) });
		const kept = node("3", { type: "message", message: { role: "user", content: "kept".repeat(10) } });
		const tree = [node("1", { type: "message", message: { role: "user", content: "old".repeat(40) } }, [compactionEntry])];
		compactionEntry.children.push(kept);
		const activeEntryIds = new Set(["2", "3"]); // buildContextEntries(): compaction entry + kept entries onward
		const branchEntryIds = new Set(["1", "2", "3"]); // getBranch(): every raw entry on the current path
		const result = buildMessageHistoryTree(tree, activeEntryIds, branchEntryIds);
		const compactedAway = result.items[0]!;
		expect(compactedAway.label).toContain("(compacted)");
		expect(compactedAway.label).not.toContain("inactive branch");
		expect(result.activeTokens).toBe(Math.ceil(40 / 4) + Math.ceil(40 / 4)); // compaction summary (40 chars) + kept message ("kept".repeat(10) = 40 chars) only, NOT the compacted-away original text
	});

	it("still labels a genuinely abandoned /tree branch as '(inactive branch)', not '(compacted)', when it is on neither active nor branch id sets", () => {
		const abandoned = node("2b", { type: "message", message: { role: "assistant", content: [{ type: "text", text: "z".repeat(40) }] } });
		const active = node("2a", { type: "message", message: { role: "assistant", content: [{ type: "text", text: "y".repeat(40) }] } });
		const tree = [node("1", { type: "message", message: { role: "user", content: "x".repeat(40) } }, [active, abandoned])];
		const activeEntryIds = new Set(["1", "2a"]);
		const branchEntryIds = new Set(["1", "2a"]); // "2b" is not on the current path at all
		const result = buildMessageHistoryTree(tree, activeEntryIds, branchEntryIds);
		expect(result.items[0]!.children!.some((child) => child.label.includes("(inactive branch)"))).toBe(true);
		expect(result.items[0]!.children!.some((child) => child.label.includes("(compacted)"))).toBe(false);
	});

	it("falls back to the old binary active/inactive-branch labeling when branchEntryIds is omitted (e.g. by a caller with only one set)", () => {
		const tree = [node("1", { type: "message", message: { role: "user", content: "x".repeat(40) } })];
		const result = buildMessageHistoryTree(tree, new Set()); // no third argument
		expect(result.items[0]!.label).toContain("(inactive branch)");
		expect(result.items[0]!.label).not.toContain("(compacted)");
	});

	it("counts thinking blocks and tool-call arguments, not just plain text", () => {
		const tree = [node("1", { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "a".repeat(20) }, { type: "toolCall", arguments: { path: "b".repeat(20) } }] } })];
		const result = buildMessageHistoryTree(tree, new Set(["1"]));
		expect(result.items[0]!.estimatedTokens).toBeGreaterThan(0);
	});

	it("excludes bashExecution output explicitly marked excludeFromContext, matching Pi's own !! prefix behavior", () => {
		const included = buildMessageHistoryTree([node("1", { type: "message", message: { role: "bashExecution", command: "ls", output: "x".repeat(100), excludeFromContext: false } })], new Set(["1"]));
		const excluded = buildMessageHistoryTree([node("2", { type: "message", message: { role: "bashExecution", command: "ls", output: "x".repeat(100), excludeFromContext: true } })], new Set(["2"]));
		expect(included.items).toHaveLength(1);
		expect(excluded.items).toHaveLength(0); // zero content AND zero children -- correctly dropped
	});

	it("counts compaction and branch_summary entries' summaries, since they do participate in context", () => {
		const tree = [node("1", { type: "compaction", summary: "x".repeat(400) }), node("2", { type: "branch_summary", summary: "y".repeat(400) })];
		const result = buildMessageHistoryTree(tree, new Set(["1", "2"]));
		expect(result.activeTokens).toBe(Math.ceil(800 / 4));
	});

	it("drops non-context entry types (custom, label, model_change) that have no content and no descendants", () => {
		const tree = [node("1", { type: "custom" }), node("2", { type: "label" }), node("3", { type: "model_change" })];
		expect(buildMessageHistoryTree(tree, new Set()).items).toEqual([]);
	});

	it("returns an empty tree for no roots rather than throwing", () => {
		expect(buildMessageHistoryTree([], new Set())).toEqual({ items: [], activeTokens: 0, truncated: false });
	});

	it("tolerates a malformed or unexpected message shape without throwing", () => {
		const tree = [node("1", { type: "message", message: null }), node("2", { type: "message", message: "not an object" as unknown as undefined })];
		expect(() => buildMessageHistoryTree(tree, new Set())).not.toThrow();
	});

	it("is cycle-safe: a node that (incorrectly) appears as its own descendant is not revisited, and truncated is reported", () => {
		const cyclic: SessionTreeNodeLike = node("1", { type: "message", message: { role: "user", content: "x" } });
		cyclic.children.push(cyclic); // a malformed/adversarial self-reference
		const result = buildMessageHistoryTree([cyclic], new Set(["1"]));
		expect(result.truncated).toBe(true);
		expect(result.items).toHaveLength(1); // visited once, not infinitely
	});
});

function taskGraph(nodes: TaskNode[], rootIds: string[]): TaskGraph {
	return { nodes, rootIds };
}

function task(id: string, title: string, status = "todo", body = ""): Artifact {
	return { id, title, status, kind: "task", subtype: "", body, labels: [], extra: {}, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z" };
}

function taskNode(id: string, title: string, options: { status?: string; parentIds?: string[]; childIds?: string[]; body?: string } = {}): TaskNode {
	return {
		task: task(id, title, options.status ?? "todo", options.body ?? ""),
		parentIds: options.parentIds ?? [],
		childIds: options.childIds ?? [],
		dependencyIds: [],
	};
}

describe("buildTaskItemTree", () => {
	it("nests tasks by real containment (parentIds/childIds), not a flat list", () => {
		const graph = taskGraph([taskNode("parent", "Parent", { childIds: ["child"] }), taskNode("child", "Child", { parentIds: ["parent"] })], ["parent"]);
		const items = buildTaskItemTree(graph);
		expect(items).toHaveLength(1);
		expect(items[0]!.label).toBe("Parent");
		expect(items[0]!.children).toEqual([{ label: "Child", estimatedTokens: expect.any(Number) }]);
	});

	it("filters done and canceled tasks -- only open work matters for the injected context, matching taskContext()'s own rule", () => {
		const graph = taskGraph([taskNode("a", "Open", { status: "todo" }), taskNode("b", "Finished", { status: "done" }), taskNode("c", "Dropped", { status: "canceled" })], ["a", "b", "c"]);
		const items = buildTaskItemTree(graph);
		expect(items.map((item) => item.label)).toEqual(["Open"]);
	});

	it("promotes an open task to a root in this projection when its real parent is done/canceled/filtered, instead of dropping it", () => {
		const graph = taskGraph([taskNode("parent", "Finished parent", { status: "done", childIds: ["child"] }), taskNode("child", "Still open", { parentIds: ["parent"] })], ["parent"]);
		const items = buildTaskItemTree(graph);
		expect(items.map((item) => item.label)).toEqual(["Still open"]);
	});

	it("shows a multi-parent task once, under whichever open parent is reached first, matching the task widget's own spanning-tree compromise", () => {
		const graph = taskGraph(
			[
				taskNode("a", "Parent A", { childIds: ["shared"] }),
				taskNode("b", "Parent B", { childIds: ["shared"] }),
				taskNode("shared", "Shared child", { parentIds: ["a", "b"] }),
			],
			["a", "b"],
		);
		const items = buildTaskItemTree(graph);
		const totalSharedAppearances = items.reduce((count, item) => count + (item.children?.some((child) => child.label === "Shared child") ? 1 : 0), 0);
		expect(totalSharedAppearances).toBe(1);
	});

	it("returns an empty tree when there are no open tasks", () => {
		expect(buildTaskItemTree(taskGraph([], []))).toEqual([]);
	});
});

describe("buildContextBreakdown", () => {
	const ruleBudget = { entries: [{ id: "r1", title: "Big rule", characters: 400, estimatedTokens: 100 }], totalCharacters: 400, totalEstimatedTokens: 100 };
	const skills = { entries: [{ name: "commit", description: "x", location: "/x", characters: 200, estimatedTokens: 50 }], totalCharacters: 200, totalEstimatedTokens: 50, scannedDirectories: ["/home/user/.claude/skills"] };
	const twentyTokenTask = [{ label: "Ship", estimatedTokens: 20 }];
	const noTasks: Array<{ label: string; estimatedTokens: number }> = [];
	const noHistory: Array<{ label: string; estimatedTokens: number }> = [];

	it("derives 'everything else' as the remainder between the real total and Papyrus's own known segments", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 1000, contextWindow: 200_000, ruleBudget, taskItems: twentyTokenTask, skills, basePromptEstimatedTokens: null, messageHistoryItems: noHistory, messageHistoryActiveTokens: 0 });
		const other = breakdown.segments.find((segment) => segment.key === "other")!;
		expect(other.estimatedTokens).toBe(1000 - (100 + 20 + 50)); // 830
		expect(breakdown.totalTokens).toBe(1000);
		expect(breakdown.overshootTokens).toBe(0);
	});

	it("clamps 'everything else' to zero instead of going negative when estimates overshoot the real total, but preserves the overshoot amount rather than discarding it", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 50, contextWindow: null, ruleBudget, taskItems: twentyTokenTask, skills, basePromptEstimatedTokens: null, messageHistoryItems: noHistory, messageHistoryActiveTokens: 0 }); // known segments alone already sum to 170 > 50
		const other = breakdown.segments.find((segment) => segment.key === "other")!;
		expect(other.estimatedTokens).toBe(0);
		expect(breakdown.overshootTokens).toBe(170 - 50); // 120
		expect(other.label).toContain("estimate overshoot");
		expect(other.label).toContain("120 tokens");
	});

	it("does not mention overshoot in the label when there isn't one", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 1000, contextWindow: null, ruleBudget, taskItems: twentyTokenTask, skills, basePromptEstimatedTokens: null, messageHistoryItems: noHistory, messageHistoryActiveTokens: 0 });
		expect(breakdown.segments.find((segment) => segment.key === "other")!.label).not.toContain("overshoot");
	});

	it("reports zero for 'everything else' and preserves null totalTokens when real usage is unavailable, rather than treating a partial sum as ground truth", () => {
		const breakdown = buildContextBreakdown({ totalTokens: null, contextWindow: null, ruleBudget, taskItems: twentyTokenTask, skills, basePromptEstimatedTokens: null, messageHistoryItems: noHistory, messageHistoryActiveTokens: 0 });
		expect(breakdown.totalTokens).toBeNull();
		expect(breakdown.segments.find((segment) => segment.key === "other")!.estimatedTokens).toBe(0);
		expect(breakdown.overshootTokens).toBe(0);
	});

	it("computes effectiveBudget as contextWindow minus the reserve, mirroring Pi's own compaction trigger formula", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 1000, contextWindow: 200_000, ruleBudget, taskItems: noTasks, skills, basePromptEstimatedTokens: null, messageHistoryItems: noHistory, messageHistoryActiveTokens: 0 });
		expect(breakdown.effectiveBudget).toBe(200_000 - DEFAULT_RESERVE_TOKENS);
	});

	it("honors an explicit reserveTokens override instead of the default", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 1000, contextWindow: 100_000, reserveTokens: 5000, ruleBudget, taskItems: noTasks, skills, basePromptEstimatedTokens: null, messageHistoryItems: noHistory, messageHistoryActiveTokens: 0 });
		expect(breakdown.effectiveBudget).toBe(95_000);
	});

	it("reports effectiveBudget as null when the context window itself is unknown", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 1000, contextWindow: null, ruleBudget, taskItems: noTasks, skills, basePromptEstimatedTokens: null, messageHistoryItems: noHistory, messageHistoryActiveTokens: 0 });
		expect(breakdown.effectiveBudget).toBeNull();
	});

	it("carries per-rule, per-skill, per-task, AND per-message drill-down items -- every segment with real underlying content is expandable", () => {
		const nestedTask = [{ label: "Parent", estimatedTokens: 20, children: [{ label: "Child", estimatedTokens: 5 }] }];
		const historyItems = [{ label: "user: hi", estimatedTokens: 10 }];
		const breakdown = buildContextBreakdown({ totalTokens: 1000, contextWindow: null, ruleBudget, taskItems: nestedTask, skills, basePromptEstimatedTokens: null, messageHistoryItems: historyItems, messageHistoryActiveTokens: 10 });
		expect(breakdown.segments.find((segment) => segment.key === "rules")!.items).toEqual([{ label: "Big rule", estimatedTokens: 100 }]);
		expect(breakdown.segments.find((segment) => segment.key === "skills")!.items).toEqual([{ label: "commit", estimatedTokens: 50 }]);
		expect(breakdown.segments.find((segment) => segment.key === "tasks")!.items).toEqual(nestedTask);
		expect(breakdown.segments.find((segment) => segment.key === "tasks")!.estimatedTokens).toBe(25); // sums the WHOLE tree, not just top-level
		expect(breakdown.segments.find((segment) => segment.key === "messageHistory")!.items).toEqual(historyItems);
		expect(breakdown.segments.find((segment) => segment.key === "other")!.items).toBeUndefined();
	});

	it("includes base prompt as its own segment", () => {
		const breakdown = buildContextBreakdown({ totalTokens: 10_000, contextWindow: null, ruleBudget, taskItems: noTasks, skills, basePromptEstimatedTokens: 500, messageHistoryItems: noHistory, messageHistoryActiveTokens: 8000 });
		const basePrompt = breakdown.segments.find((segment) => segment.key === "basePrompt")!;
		const messageHistory = breakdown.segments.find((segment) => segment.key === "messageHistory")!;
		expect(basePrompt.estimatedTokens).toBe(500);
		expect(basePrompt.items).toBeUndefined();
		expect(messageHistory.estimatedTokens).toBe(8000);
		// message history correctly absorbed into "known" tokens, shrinking the unaccounted remainder
		const other = breakdown.segments.find((segment) => segment.key === "other")!;
		expect(other.estimatedTokens).toBe(10_000 - (100 + 0 + 50 + 500 + 8000));
	});

	it("carries the structural base-prompt sub-breakdown as items when provided, for drill-down in /context", () => {
		const basePromptItems = [{ label: "Tool snippets (4 tools)", estimatedTokens: 120 }, { label: "Base template, guidelines, and formatting", estimatedTokens: 380 }];
		const breakdown = buildContextBreakdown({ totalTokens: 10_000, contextWindow: null, ruleBudget, taskItems: noTasks, skills, basePromptEstimatedTokens: 500, basePromptItems, messageHistoryItems: noHistory, messageHistoryActiveTokens: 0 });
		const basePrompt = breakdown.segments.find((segment) => segment.key === "basePrompt")!;
		expect(basePrompt.items).toEqual(basePromptItems);
	});

	it("labels the base prompt segment as not-yet-observed when its size is unknown, rather than silently showing zero as if it were measured", () => {
		const unobserved = buildContextBreakdown({ totalTokens: 1000, contextWindow: null, ruleBudget, taskItems: noTasks, skills, basePromptEstimatedTokens: null, messageHistoryItems: noHistory, messageHistoryActiveTokens: 0 });
		expect(unobserved.segments.find((segment) => segment.key === "basePrompt")!.label).toContain("not observed yet");
		const observed = buildContextBreakdown({ totalTokens: 1000, contextWindow: null, ruleBudget, taskItems: noTasks, skills, basePromptEstimatedTokens: 200, messageHistoryItems: noHistory, messageHistoryActiveTokens: 0 });
		expect(observed.segments.find((segment) => segment.key === "basePrompt")!.label).not.toContain("not observed yet");
	});
});
