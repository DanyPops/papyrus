import { describe, expect, it } from "bun:test";
import type { VehicleOperationDescriptor } from "@danypops/vehicle-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { papyrusVehicleRenderers } from "../extension/src/vehicle-artifact-renderers.ts";

const fakeTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const limits = { defaultTimeoutMs: 1_000, maxTimeoutMs: 5_000, maxRequestBytes: 1_024, maxResponseBytes: 1_024 };

function descriptor(name: string): VehicleOperationDescriptor {
	return {
		name,
		version: 1,
		description: "",
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
		permissions: [],
		effect: "read",
		idempotency: { mode: "safe" },
		streaming: false,
		longRunning: false,
		limits,
		errors: [],
	};
}

function resultContext(overrides: Record<string, unknown> = {}) {
	return { cwd: "/tmp", isError: false, ...overrides } as never;
}

const vehicleIdentity = { name: "papyrus", version: "1", operation: "tasks.list", operationVersion: 1, toolCallId: "call-1" };

function artifact(overrides: Record<string, unknown> = {}) {
	return {
		id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		kind: "task",
		title: "A real task",
		status: "todo",
		subtype: "",
		body: "some body text",
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("papyrusVehicleRenderers", () => {
	const { renderResult } = papyrusVehicleRenderers(descriptor("tasks.list"));

	it("renders an artifact-array output as the curated list card, not a raw column dump", () => {
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, output: [artifact({ title: "First" }), artifact({ title: "Second" })] } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("First");
		expect(text).toContain("Second");
		expect(text).not.toContain("some body text");
	});

	it("renders a single artifact output as the curated artifact card", () => {
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, output: artifact({ title: "Just one" }) } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain("Just one");
	});

	it("falls back to the generic Vehicle renderer for a non-artifact output", () => {
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, output: { ok: true } } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n")).toContain("ok");
	});

	it("falls back to the generic renderer for a partial (progress) result", () => {
		const component = renderResult!(
			{ content: [], details: { vehicle: vehicleIdentity, progress: { current: 1, total: 2 } } },
			{ isPartial: true, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(40).join("\n")).toContain("50%");
	});

	it("falls back to the generic renderer on error, ignoring an otherwise artifact-shaped output", () => {
		const component = renderResult!(
			{ content: [{ type: "text", text: "backend unreachable" }], details: { vehicle: vehicleIdentity, output: artifact() } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext({ isError: true }),
		);
		expect(component.render(80).join("\n")).toContain("backend unreachable");
	});

	it("renders tasks.focused/pause/unpause's {artifact, status, updatedAt} wrapper as the curated artifact card, not a raw JSON dump", () => {
		const { renderResult: renderFocused } = papyrusVehicleRenderers(descriptor("tasks.focused"));
		const component = renderFocused!(
			{
				content: [],
				details: {
					vehicle: vehicleIdentity,
					output: { artifact: artifact({ title: "Focused task" }), status: "active", updatedAt: "2026-01-02T00:00:00.000Z" },
				},
			},
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Focused task");
		expect(text).toContain("focus active");
	});

	it("distinguishes a paused focus, including its reason, from the artifact's own lifecycle status", () => {
		const { renderResult: renderPause } = papyrusVehicleRenderers(descriptor("tasks.pause"));
		const component = renderPause!(
			{
				content: [],
				details: {
					vehicle: vehicleIdentity,
					output: {
						artifact: artifact({ title: "Paused task", status: "in-progress" }),
						status: "paused",
						updatedAt: "2026-01-02T00:00:00.000Z",
						pauseReason: "waiting on review",
					},
				},
			},
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("in-progress"); // the artifact's own lifecycle status, unchanged
		expect(text).toContain("focus paused");
		expect(text).toContain("waiting on review");
	});

	it("renders a friendly message for tasks.focused's null (nothing focused) output, not the literal word 'null'", () => {
		const { renderResult: renderFocused } = papyrusVehicleRenderers(descriptor("tasks.focused"));
		const component = renderFocused!(
			{ content: [], details: { vehicle: vehicleIdentity, output: null } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text.toLowerCase()).toContain("no focused task");
		expect(text).not.toBe("null");
	});

	it("does not misrender an unrelated null output as a focus state -- scoped to tasks.focused by name", () => {
		const { renderResult: renderShow } = papyrusVehicleRenderers(descriptor("docs.show"));
		const component = renderShow!(
			{ content: [], details: { vehicle: vehicleIdentity, output: null } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		expect(component.render(80).join("\n").toLowerCase()).not.toContain("focused");
	});

	it("renders tasks.plan's TaskExecutionPlan through DagView -- layers, a blocked node's dependency, and a cycle section", () => {
		const { renderResult: renderPlan } = papyrusVehicleRenderers(descriptor("tasks.plan"));
		const plan = {
			nodes: [
				{ id: "a", title: "Task A", status: "todo", active: false, state: "ready", layer: 0, prerequisiteIds: [], successorIds: ["b"] },
				{
					id: "b",
					title: "Task B",
					status: "todo",
					active: false,
					state: "blocked",
					layer: 1,
					prerequisiteIds: ["a"],
					successorIds: [],
				},
				{ id: "x", title: "Task X", status: "todo", active: false, state: "invalid", layer: null, prerequisiteIds: [], successorIds: [] },
				{ id: "y", title: "Task Y", status: "todo", active: false, state: "invalid", layer: null, prerequisiteIds: [], successorIds: [] },
			],
			layers: [["a"], ["b"]],
			cycleIds: ["x", "y"],
		};
		const component = renderPlan!(
			{ content: [], details: { vehicle: vehicleIdentity, output: plan } },
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Task A");
		expect(text).toContain("Task B");
		expect(text).toContain("depends on");
		expect(text.split("depends on")[1]).toContain("Task A");
		expect(text).toContain("Task X");
		expect(text).toContain("Task Y");
		expect(text).toContain("Cycle");
	});

	it("renders playbooks.invoke's PlaybookInvocationResult through DagView with a created-summary line, not raw JSON", () => {
		const { renderResult: renderInvoke } = papyrusVehicleRenderers(descriptor("playbooks.invoke"));
		const result = {
			playbookId: "pb-1",
			runId: "run-1",
			arguments: {},
			created: { docs: ["d1"], rules: [], tasks: ["t1", "t2"] },
			rootTaskIds: ["t1"],
			entryTaskId: "t1",
			execution: {
				nodes: [
					{
						id: "t1",
						title: "Step one",
						status: "todo",
						active: true,
						state: "ready",
						layer: 0,
						prerequisiteIds: [],
						successorIds: ["t2"],
					},
					{
						id: "t2",
						title: "Step two",
						status: "todo",
						active: false,
						state: "blocked",
						layer: 1,
						prerequisiteIds: ["t1"],
						successorIds: [],
					},
				],
				layers: [["t1"], ["t2"]],
				cycleIds: [],
			},
			content: [{ type: "text", text: "Invoked playbook run run-1" }],
		};
		const component = renderInvoke!(
			{ content: [], details: { vehicle: vehicleIdentity, output: result } },
			{ isPartial: false, expanded: true },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text).toContain("Step one");
		expect(text).toContain("Step two");
		expect(text).toContain("depends on");
		expect(text).toContain("2 task");
		expect(text).toContain("1 doc");
		expect(text).not.toContain("{");
	});

	it("renders playbooks.invoke's missingArguments case as a clear warning, not raw JSON", () => {
		const { renderResult: renderInvoke } = papyrusVehicleRenderers(descriptor("playbooks.invoke"));
		const result = {
			playbookId: "pb-1",
			missingArguments: ["jira_ticket"],
			content: [{ type: "text", text: "Missing required argument(s)" }],
		};
		const component = renderInvoke!(
			{ content: [], details: { vehicle: vehicleIdentity, output: result } },
			{ isPartial: false, expanded: false },
			fakeTheme,
			resultContext(),
		);
		const text = component.render(80).join("\n");
		expect(text.toLowerCase()).toContain("missing");
		expect(text).toContain("jira_ticket");
		expect(text).not.toContain("{");
	});
});
