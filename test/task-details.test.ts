import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showTaskDetails, taskDetailsText } from "../extension/src/tasks.ts";
import type { Artifact } from "../src/domain/artifact.ts";
import type { TaskGraph } from "../src/task-service.ts";

const task: Artifact = {
	id: "build-router-n23w",
	kind: "task",
	title: "Build token router",
	status: "active",
	subtype: "",
	body: "Route requests without overspending.",
	labels: ["jittor"],
	extra: { checklist: ["Observe budget", "Choose route"] },
	created_at: "2026-01-01T00:00:00.000Z",
	updated_at: "2026-01-02T00:00:00.000Z",
	edges: [{ from: "build-router-n23w", relation: "depends_on", to: "telemetry-2dlj" }],
};

const graph: TaskGraph = {
	nodes: [
		{ task: { ...task, edges: undefined }, parentIds: [], childIds: [], dependencyIds: ["telemetry-2dlj"] },
		{
			task: { ...task, id: "telemetry-2dlj", title: "Telemetry collection", edges: undefined },
			parentIds: [], childIds: [], dependencyIds: [],
		},
	],
	rootIds: ["build-router-n23w", "telemetry-2dlj"],
};

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

describe("task details", () => {
	it("renders checklist proofs and validation gates as first-class sections", () => {
		const text = taskDetailsText({
			...task,
			extra: {
				checklist: {
					"Write failing tests": { proof: [{ type: "test", target: "test/skills.test.ts", expect: "skill row" }] },
					"Implement browser": { proof: [{ type: "symbol", target: "extension/src/skills.ts#showSkills" }] },
				},
				gates: [{ type: "file-exists", target: "/tmp/skills.ts" }],
				owner: "frontend",
			},
		}, ["┌ relationship graph ┐", "└────────────────────┘"]);

		expect(text).toContain("Checklist:\n  • Write failing tests\n    proof:\n      - test · test/skills.test.ts · skill row");
		expect(text).toContain("  • Implement browser\n    proof:\n      - symbol · extension/src/skills.ts#showSkills");
		expect(text).toContain("Validation gates:\n  ○ file-exists · /tmp/skills.ts");
		expect(text).toContain("Metadata:\n  owner: frontend");
		expect(text).not.toContain("Metadata:\n  checklist:");
		expect(text).not.toContain("Metadata:\n  gates:");
		expect(text).not.toContain("--depends_on-->");
		expect(text.indexOf("Relationships:")).toBeGreaterThan(text.indexOf("Metadata:"));
		expect(text).toContain("Relationships:\n  Dependencies point prerequisite → dependent.\n┌ relationship graph ┐");
	});

	it("marks legacy checklist rows as missing proof rather than inventing evidence", () => {
		const text = taskDetailsText(task);
		expect(text).toContain("Checklist:\n  • Observe budget\n    proof: missing (legacy item)");
		expect(text).not.toContain("Metadata:");
	});

	it("keeps Show details open in a navigable custom view until the user closes it", async () => {
		let customCalls = 0;
		let closed = false;
		let rendered: string[] = [];
		let narrowGraph: string[] = [];
		let pannedGraph: string[] = [];
		const notifications: string[] = [];
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				notify(message: string) { notifications.push(message); },
				async custom(factory: any) {
					customCalls += 1;
					const component = await factory(
						{ terminal: { rows: 30 }, requestRender() {} },
						theme,
						{},
						() => { closed = true; },
					);
					rendered = component.render(80);
					component.render(16);
					for (let index = 0; index < 50; index++) component.handleInput?.("\x1b[B");
					narrowGraph = component.render(16);
					component.handleInput?.("\x1b[C");
					pannedGraph = component.render(16);
					component.handleInput?.("\x1b");
				},
			},
		} as unknown as ExtensionCommandContext;

		await showTaskDetails(ctx, task, graph);

		expect(customCalls).toBe(1);
		expect(notifications).toEqual([]);
		expect(rendered.join("\n")).toContain("Build token router");
		expect(rendered.join("\n")).toContain("Route requests without overspending.");
		expect(rendered.join("\n")).toContain("Telemetry collection");
		expect(rendered.join("\n")).toContain("unlocks");
		expect(rendered.join("\n")).toContain("Observe budget");
		expect(rendered.join("\n").indexOf("Relationships:")).toBeGreaterThan(rendered.join("\n").indexOf("Checklist:"));
		expect(narrowGraph.some((line) => line.includes("┌") || line.includes("└") || line.includes("│"))).toBe(true);
		expect(narrowGraph.every((line) => visibleWidth(line) <= 16)).toBe(true);
		expect(pannedGraph).not.toEqual(narrowGraph);
		expect(closed).toBe(true);
	});
});
