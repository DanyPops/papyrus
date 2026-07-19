import { describe, expect, it } from "bun:test";
import { projectTaskGraph } from "../src/task-graph-view.ts";
import type { Artifact } from "../src/domain/artifact.ts";
import type { TaskGraph, TaskNode } from "../src/task-service.ts";
import { BeautifulMermaidRenderer, mermaidSource } from "../extension/src/beautiful-mermaid-renderer.ts";

function artifact(id: string, title: string): Artifact {
	return {
		id,
		kind: "task",
		title,
		status: "pending",
		subtype: "",
		body: "",
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	};
}

function node(id: string, title: string, relationships: Partial<Omit<TaskNode, "task">> = {}): TaskNode {
	return {
		task: artifact(id, title),
		parentIds: relationships.parentIds ?? [],
		childIds: relationships.childIds ?? [],
		dependencyIds: relationships.dependencyIds ?? [],
	};
}

const graph: TaskGraph = {
	nodes: [
		node("epic", "Jittor router", { childIds: ["policy", "actuator"] }),
		node("policy", "Budget policy", { parentIds: ["epic"], dependencyIds: ["telemetry"] }),
		node("telemetry", "OpenRouter telemetry"),
		node("actuator", "Pi actuator", { parentIds: ["epic"], dependencyIds: ["policy"] }),
		node("unrelated", "Unrelated task"),
	],
	rootIds: ["epic", "telemetry", "unrelated"],
};

describe("task graph projection", () => {
	it("renders dependencies in executable prerequisite-to-dependent order", () => {
		const display = projectTaskGraph(graph, "dependencies");

		expect(display.nodes.map((entry) => entry.id)).toEqual(["policy", "telemetry", "actuator"]);
		expect(display.edges).toEqual([
			{ from: "telemetry", to: "policy", label: "unlocks" },
			{ from: "policy", to: "actuator", label: "unlocks" },
		]);
	});

	it("projects execution layers and readiness across non-linear dependencies", () => {
		const executionGraph: TaskGraph = {
			...graph,
			nodes: graph.nodes.map((entry) => ({
				...entry,
				task: { ...entry.task, status: entry.task.id === "telemetry" ? "done" : entry.task.status },
			})),
		};

		const display = projectTaskGraph(executionGraph, "execution");

		expect(display.nodes.find((entry) => entry.id === "telemetry")).toMatchObject({
			label: "■ OpenRouter telemetry · layer 1 · done",
			status: "done",
		});
		expect(display.nodes.find((entry) => entry.id === "policy")).toMatchObject({
			label: "◇ Budget policy · layer 2 · ready",
			status: "ready",
		});
		expect(display.nodes.find((entry) => entry.id === "actuator")).toMatchObject({
			label: "○ Pi actuator · layer 3 · blocked",
			status: "blocked",
		});
		expect(display.edges).toEqual([
			{ from: "telemetry", to: "policy", label: "unlocks" },
			{ from: "policy", to: "actuator", label: "unlocks" },
		]);
	});

	it("renders composition once without inverse part_of edges", () => {
		const display = projectTaskGraph(graph, "composition");

		expect(display.nodes.map((entry) => entry.id)).toEqual(["epic", "policy", "actuator"]);
		expect(display.edges).toEqual([
			{ from: "epic", to: "policy" },
			{ from: "epic", to: "actuator" },
		]);
	});
});

describe("Beautiful Mermaid graph renderer", () => {
	it("aliases domain IDs and renders a terminal Unicode cell grid", () => {
		const display = projectTaskGraph(graph, "dependencies");
		const source = mermaidSource(display);
		expect(source).toContain('n0["Budget policy"]');
		expect(source).toContain("n1 -->|unlocks| n0");
		expect(source).not.toContain("telemetry -->");

		const rendered = new BeautifulMermaidRenderer().render(display);
		expect(rendered.lines.join("\n")).toContain("OpenRouter telemetry");
		expect(rendered.lines.join("\n")).toContain("Budget policy");
		expect(rendered.lines.join("\n")).toContain("unlocks");
	});
});
