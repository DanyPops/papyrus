import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { artifactDetailsText, showArtifactDetails } from "../extension/src/artifact-browser.ts";
import { showTaskDetails } from "../extension/src/tasks.ts";
import type { Artifact } from "../src/domain/artifact.ts";
import type { OperationName } from "../src/service.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

function artifact(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "artifact-1",
		kind: "doc",
		title: "Detailed artifact",
		status: "active",
		subtype: "research",
		body: "# Markdown heading\n\nA long body with **bold**, *italic*, [link](https://example.test), and `code` that wraps at narrow widths.",
		labels: ["details", "matrix"],
		extra: { owner: "Daniel", nested: { state: "verified" } },
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-02T00:00:00.000Z",
		edges: [{ from: "artifact-1", relation: "relates_to", to: "a-very-long-related-artifact-identifier" }],
		...overrides,
	};
}

function tuiContext() {
	let customCalls = 0;
	let closed = false;
	const notifications: Array<{ message: string; level?: string }> = [];
	const renders: string[][] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/workspace/papyrus",
		ui: {
			notify(message: string, level?: string) { notifications.push({ message, level }); },
			async custom(factory: any) {
				customCalls += 1;
				const component = await factory(
					{ terminal: { rows: 24 }, requestRender() {} },
					theme,
					{},
					() => { closed = true; },
				);
				renders.push(component.render(80));
				renders.push(component.render(18));
				for (let index = 0; index < 30; index++) component.handleInput?.("\x1b[B");
				renders.push(component.render(18));
				component.handleInput?.("\x1b[C");
				renders.push(component.render(18));
				component.handleInput?.("\x1b");
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications, renders, state: () => ({ customCalls, closed }) };
}

const genericMatrix: Array<{ name: string; operation: OperationName; input?: Record<string, unknown>; value: Artifact }> = [
	{ name: "document", operation: "docs.show", value: artifact() },
	{ name: "note", operation: "notes.show", input: { project_root: "/workspace/papyrus" }, value: artifact({ subtype: "note", status: "draft" }) },
	{ name: "rule", operation: "rules.show", value: artifact({ kind: "rule", subtype: "", extra: { severity: "block", condition: "before release" } }) },
	{ name: "legacy skill", operation: "skills.show", value: artifact({ kind: "skill", subtype: "", extra: { trigger: "manual", steps: ["one", "two"] } }) },
	{ name: "template", operation: "skills.show", value: artifact({ kind: "skill", subtype: "artifact-template", extra: { targetKind: "doc", required: ["title"] } }) },
	{ name: "workflow", operation: "skills.show", value: artifact({ kind: "skill", subtype: "workflow", extra: { definition: { inputs: {}, blueprints: { tasks: [], docs: [], rules: [] } } } }) },
	{ name: "discussion", operation: "docs.show", value: artifact({ subtype: "discussion", status: "active", extra: { discussion: { state: "active", roundCount: 2 } } }) },
];

describe("Show details coverage matrix", () => {
	for (const row of genericMatrix) {
		it(`keeps ${row.name} details open in a bounded navigable view`, async () => {
			const harness = tuiContext();
			const calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
			await showArtifactDetails(harness.ctx, row.value.id, row.operation, row.input ?? {}, async (operation, input) => {
				calls.push({ operation, input });
				return row.value;
			});

			expect(calls).toEqual([{ operation: row.operation, input: expect.objectContaining({ id: row.value.id, ...(row.input ?? {}) }) }]);
			expect(harness.state()).toEqual({ customCalls: 1, closed: true });
			expect(harness.notifications).toEqual([]);
			const rendered = harness.renders.flat().join("\n");
			expect(rendered).toContain(row.value.title);
			expect(rendered).toContain("Markdown heading");
			expect(rendered).not.toContain("**bold**");
			expect(rendered).toContain("Metadata:");
			expect(rendered).toContain("Relationships:");
			for (const render of harness.renders.slice(1)) expect(render.every((line) => visibleWidth(line) <= 18)).toBe(true);
		});
	}

	it("keeps Task details on its specialized checklist/history/graph view", async () => {
		const harness = tuiContext();
		const task = artifact({ kind: "task", subtype: "", status: "in-progress", extra: { checklist: ["verify"] } });
		await showTaskDetails(harness.ctx, task);
		expect(harness.state()).toEqual({ customCalls: 1, closed: true });
		expect(harness.notifications).toEqual([]);
		expect(harness.renders[0]!.join("\n")).toContain("Task details");
		expect(harness.renders[0]!.join("\n")).toContain("Checklist:");
	});

	it("renders stable detail text for body, metadata, and edges", () => {
		const output = artifactDetailsText(artifact());
		expect(output).toContain("Detailed artifact\nartifact-1 [doc|active] · research");
		expect(output).toContain("Labels: details, matrix");
		expect(output).toContain("Metadata:\n  owner: Daniel");
		expect(output).toContain("Relationships:\n  artifact-1 --relates_to--> a-very-long-related-artifact-identifier");
	});

	it("reports missing artifacts and service failures without opening a broken view", async () => {
		const missing = tuiContext();
		await showArtifactDetails(missing.ctx, "missing", "docs.show", {}, async () => null);
		expect(missing.state().customCalls).toBe(0);
		expect(missing.notifications).toEqual([{ message: "Artifact missing not found", level: "error" }]);

		const failed = tuiContext();
		await showArtifactDetails(failed.ctx, "broken", "docs.show", {}, async () => { throw new Error("daemon unavailable"); });
		expect(failed.state().customCalls).toBe(0);
		expect(failed.notifications).toEqual([{ message: "Show details failed: daemon unavailable", level: "error" }]);
	});

	it("uses readable notification fallback outside interactive mode", async () => {
		const notifications: string[] = [];
		const ctx = { mode: "rpc", hasUI: false, ui: { notify(message: string) { notifications.push(message); } } } as unknown as ExtensionCommandContext;
		await showArtifactDetails(ctx, "artifact-1", "docs.show", {}, async () => artifact());
		expect(notifications[0]).toContain("Detailed artifact");
		expect(notifications[0]).toContain("Relationships:");
	});
});
