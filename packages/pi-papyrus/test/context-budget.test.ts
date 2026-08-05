import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

import type { Artifact, TaskGraph, TaskNode } from "@danypops/papyrus";
import { buildTaskItemTree, computeContextBudget, computeRuleBudget } from "../extension/src/context/context-budget.ts";

function rule(
	id: string,
	title: string,
	extra: Record<string, unknown> = {},
): { id: string; title: string; body: string; extra: Record<string, unknown> } {
	return { id, title, body: "Do the thing.", extra };
}

describe("computeRuleBudget", () => {
	it("sizes each rule via the same ruleInjectionPreview text actually injected, sorted biggest first", () => {
		const budget = computeRuleBudget([
			rule("short", "Short rule"),
			rule("long", "A rule with a much longer title that costs more characters", {
				condition: "always",
				action: "Do more things with more words",
			}),
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
		const dir = tempDir("papyrus-budget-");
		const skillDir = join(dir, "home", ".pi", "agent", "skills", "example");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: example\ndescription: An example skill.\n---\n");

		const budget = computeContextBudget([rule("r1", "A rule")], join(dir, "project"), join(dir, "home"));

		expect(budget.rules.entries).toHaveLength(1);
		expect(budget.skills.entries).toHaveLength(1);
		expect(budget.totalEstimatedTokens).toBe(budget.rules.totalEstimatedTokens + budget.skills.totalEstimatedTokens);
	});

	it("reads settings.json's skills array and includes those directories in the scan", () => {
		const dir = tempDir("papyrus-budget-settings-");
		const homeDirectory = join(dir, "home");
		const externalSkills = join(dir, "external-skills", "imported");
		mkdirSync(join(homeDirectory, ".pi", "agent"), { recursive: true });
		mkdirSync(externalSkills, { recursive: true });
		writeFileSync(join(homeDirectory, ".pi", "agent", "settings.json"), JSON.stringify({ skills: [join(dir, "external-skills")] }));
		writeFileSync(join(externalSkills, "SKILL.md"), "---\nname: imported\ndescription: Configured via settings.json.\n---\n");

		const budget = computeContextBudget([], join(dir, "project"), homeDirectory);

		expect(budget.skills.entries.map((entry) => entry.name)).toEqual(["imported"]);
	});

	it("tolerates a missing or malformed settings.json rather than failing the whole report", () => {
		const dir = tempDir("papyrus-budget-badsettings-");
		const homeDirectory = join(dir, "home");
		mkdirSync(join(homeDirectory, ".pi", "agent"), { recursive: true });
		writeFileSync(join(homeDirectory, ".pi", "agent", "settings.json"), "{ not valid json");

		expect(() => computeContextBudget([], join(dir, "project"), homeDirectory)).not.toThrow();
	});
});

function taskGraph(nodes: TaskNode[], rootIds: string[]): TaskGraph {
	return { nodes, rootIds };
}

function task(id: string, title: string, status = "todo", body = ""): Artifact {
	return {
		id,
		title,
		status,
		kind: "task",
		subtype: "",
		body,
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		alias: id,
	};
}

function taskNode(
	id: string,
	title: string,
	options: { status?: string; parentIds?: string[]; childIds?: string[]; body?: string } = {},
): TaskNode {
	return {
		task: task(id, title, options.status ?? "todo", options.body ?? ""),
		parentIds: options.parentIds ?? [],
		childIds: options.childIds ?? [],
		dependencyIds: [],
	};
}

describe("buildTaskItemTree", () => {
	it("nests tasks by real containment (parentIds/childIds), not a flat list", () => {
		const graph = taskGraph(
			[taskNode("parent", "Parent", { childIds: ["child"] }), taskNode("child", "Child", { parentIds: ["parent"] })],
			["parent"],
		);
		const items = buildTaskItemTree(graph);
		expect(items).toHaveLength(1);
		expect(items[0]!.label).toBe("Parent");
		expect(items[0]!.children).toEqual([{ label: "Child", estimatedTokens: expect.any(Number) }]);
	});

	it("filters done and canceled tasks -- only open work matters for the injected context, matching taskContext()'s own rule", () => {
		const graph = taskGraph(
			[
				taskNode("a", "Open", { status: "todo" }),
				taskNode("b", "Finished", { status: "done" }),
				taskNode("c", "Dropped", { status: "canceled" }),
			],
			["a", "b", "c"],
		);
		const items = buildTaskItemTree(graph);
		expect(items.map((item) => item.label)).toEqual(["Open"]);
	});

	it("promotes an open task to a root in this projection when its real parent is done/canceled/filtered, instead of dropping it", () => {
		const graph = taskGraph(
			[
				taskNode("parent", "Finished parent", { status: "done", childIds: ["child"] }),
				taskNode("child", "Still open", { parentIds: ["parent"] }),
			],
			["parent"],
		);
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
		const totalSharedAppearances = items.reduce(
			(count, item) => count + (item.children?.some((child) => child.label === "Shared child") ? 1 : 0),
			0,
		);
		expect(totalSharedAppearances).toBe(1);
	});

	it("returns an empty tree when there are no open tasks", () => {
		expect(buildTaskItemTree(taskGraph([], []))).toEqual([]);
	});
});
