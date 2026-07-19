import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showTaskGraph } from "../extension/src/task-graph.ts";
import type { Artifact } from "../src/domain/artifact.ts";
import type { TaskGraph, TaskNode } from "../src/task-service.ts";

function task(id: string, title: string): Artifact {
	return {
		id, kind: "task", title, status: "todo", subtype: "", body: "", labels: [], extra: {},
		created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
	};
}

function node(id: string, title: string, relations: Partial<Omit<TaskNode, "task">> = {}): TaskNode {
	return {
		task: task(id, title),
		parentIds: relations.parentIds ?? [],
		childIds: relations.childIds ?? [],
		dependencyIds: relations.dependencyIds ?? [],
	};
}

const graph: TaskGraph = {
	nodes: [
		node("epic", "Router epic", { childIds: ["policy"] }),
		node("policy", "Budget policy", { parentIds: ["epic"], dependencyIds: ["telemetry"] }),
		node("telemetry", "OpenRouter telemetry"),
	],
	rootIds: ["epic", "telemetry"],
};

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

describe("task graph TUI", () => {
	it("opens a width-safe viewport and switches semantic views with Tab", async () => {
		let closed = false;
		let widthSafe = true;
		let executionLines: string[] = [];
		let dependencyLines: string[] = [];
		let compositionLines: string[] = [];
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				notify() {},
				async custom(factory: any) {
					const component = await factory(
						{ terminal: { rows: 24 }, requestRender() {} }, theme, {}, () => { closed = true; },
					);
					executionLines = component.render(50);
					for (const width of [40, 80, 120]) widthSafe &&= component.render(width).every((line: string) => visibleWidth(line) <= width);
					component.handleInput("\t");
					dependencyLines = component.render(50);
					for (const width of [40, 80, 120]) widthSafe &&= component.render(width).every((line: string) => visibleWidth(line) <= width);
					component.handleInput("\t");
					compositionLines = component.render(50);
					for (const width of [40, 80, 120]) widthSafe &&= component.render(width).every((line: string) => visibleWidth(line) <= width);
					component.handleInput("\x1b");
				},
			},
		} as unknown as ExtensionCommandContext;

		await showTaskGraph(ctx, graph);

		expect(executionLines.join("\n")).toContain("Task graph · execution");
		expect(executionLines.join("\n")).toContain("ready");
		expect(dependencyLines.join("\n")).toContain("Task graph · dependencies");
		expect(dependencyLines.join("\n")).toContain("OpenRouter telemetry");
		expect(compositionLines.join("\n")).toContain("Task graph · composition");
		expect(compositionLines.join("\n")).toContain("Router epic");
		expect([...executionLines, ...dependencyLines, ...compositionLines].every((line) => visibleWidth(line) <= 50)).toBe(true);
		expect(widthSafe).toBe(true);
		expect(closed).toBe(true);
	});
});
