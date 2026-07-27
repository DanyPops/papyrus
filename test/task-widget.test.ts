import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { TaskOverlay } from "../extension/src/index.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";
import { buildTaskWidgetProjection } from "../extension/src/task-widget.ts";
import type { Artifact } from "../src/domain/artifact.ts";
import type { TaskGraph, TaskNode } from "../src/task-service.ts";

function task(id: string, title: string, status: string): Artifact {
	return {
		id, title, status, kind: "task", subtype: "", body: "", labels: [], extra: {},
		created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
	};
}

function node(artifact: Artifact, parentIds: string[] = [], childIds: string[] = [], active = false): TaskNode {
	return { task: artifact, active, parentIds, childIds, dependencyIds: [] };
}

const graph: TaskGraph = {
	nodes: [
		node(task("parent", "Lifecycle parent", "in-progress"), [], ["child"]),
		node(task("child", "Focused child", "review"), ["parent"], [], true),
		node(task("todo", "Todo one", "todo")),
		node(task("done", "Done one", "done")),
		node(task("canceled", "Canceled one", "canceled")),
	],
	rootIds: ["parent", "todo", "done", "canceled"],
};

describe("task widget projection", () => {
	it("shows open parents and children in containment order with orthogonal focus", () => {
		const projection = buildTaskWidgetProjection(graph, 3);

		expect(projection.rows.map(({ task, depth, hasOpenChildren, active }) => ({
			id: task.id, depth, hasOpenChildren, active,
		}))).toEqual([
			{ id: "parent", depth: 0, hasOpenChildren: true, active: false },
			{ id: "child", depth: 1, hasOpenChildren: false, active: true },
			{ id: "todo", depth: 0, hasOpenChildren: false, active: false },
		]);
		expect(projection.openTotal).toBe(3);
		expect(projection.total).toBe(5);
	});

	it("retains active focus when the open row bound would otherwise omit it", () => {
		const expanded: TaskGraph = {
			nodes: [
				node(task("first", "First", "todo")),
				node(task("second", "Second", "in-progress")),
				node(task("focused", "Focused", "rejected"), [], [], true),
			],
			rootIds: ["first", "second", "focused"],
		};
		const projection = buildTaskWidgetProjection(expanded, 2);

		expect(projection.rows.map((row) => row.task.id)).toEqual(["first", "focused"]);
		expect(projection.openTotal).toBe(3);
		expect(projection.rows.find((row) => row.active)?.task.id).toBe("focused");
	});

	it("projects parentCount from the DAG's actual parentIds, so a multi-parent task can be flagged rather than silently shown as single-parent", () => {
		const shared: TaskGraph = {
			nodes: [
				node(task("parent-a", "Parent A", "in-progress"), [], ["shared"]),
				node(task("parent-b", "Parent B", "in-progress"), [], ["shared"]),
				node(task("shared", "Shared child", "todo"), ["parent-a", "parent-b"], []),
			],
			rootIds: ["parent-a", "parent-b"],
		};
		const projection = buildTaskWidgetProjection(shared, 10);
		expect(projection.rows.find((row) => row.task.id === "shared")?.parentCount).toBe(2);
		expect(projection.rows.find((row) => row.task.id === "parent-a")?.parentCount).toBe(0);
	});

	it("returns no rows when every task is terminal", () => {
		const terminal: TaskGraph = {
			nodes: [node(task("done", "Done", "done")), node(task("canceled", "Canceled", "canceled"))],
			rootIds: ["done", "canceled"],
		};
		const projection = buildTaskWidgetProjection(terminal, 3);

		expect(projection.rows).toEqual([]);
		expect(projection.openTotal).toBe(0);
		expect(projection.total).toBe(2);
	});
});

/**
 * Regression: TaskOverlay.refresh() is called from several pi.on(...) handlers
 * (session_compact, session_tree, tool_execution_end) that don't wrap it in their own
 * try/catch -- Pi's event emitter does not guarantee catching a handler's rejection, so a
 * throw here would become an unhandled rejection instead of a stability issue contained to
 * this best-effort status widget.
 */
describe("TaskOverlay.refresh(): never throws, even if rendering itself fails", () => {
	afterEach(resetPapyrusClientForTests);

	it("swallows a render() failure after a successful snapshot fetch", async () => {
		setPapyrusClientConnectorForTests(async () => ({
			async call() { return { nodes: [], rootIds: [] } satisfies TaskGraph; },
		}) as any);
		const overlay = new TaskOverlay();
		overlay.setUI({} as ExtensionUIContext);
		overlay.setProjectRoot("/home/dpopsuev/Projects/papyrus");
		(overlay as unknown as { render: () => void }).render = () => { throw new Error("boom"); };

		await expect(overlay.refresh()).resolves.toBeUndefined();
	});

	it("swallows a render() failure even when the snapshot fetch itself failed", async () => {
		setPapyrusClientConnectorForTests(async () => ({
			async call() { throw new Error("daemon unavailable"); },
		}) as any);
		const overlay = new TaskOverlay();
		overlay.setUI({} as ExtensionUIContext);
		overlay.setProjectRoot("/home/dpopsuev/Projects/papyrus");
		(overlay as unknown as { render: () => void }).render = () => { throw new Error("boom"); };

		await expect(overlay.refresh()).resolves.toBeUndefined();
	});
});

/**
 * Regression: event-triggered refresh (tool_execution_end, session_compact/tree) can only see
 * a Task mutation this session's own tool calls made. A mutation from the CLI run directly in
 * a shell, or from a second concurrent Pi session against the same daemon, announces nothing
 * -- the widget needs a bounded polling fallback independent of any event.
 */
describe("TaskOverlay polling: catches a Task mutation no event announces", () => {
	afterEach(resetPapyrusClientForTests);

	it("startPolling refreshes repeatedly on its own, without any tool_execution_end or session event", async () => {
		let calls = 0;
		setPapyrusClientConnectorForTests(async () => ({
			async call() { calls += 1; return { nodes: [], rootIds: [] } satisfies TaskGraph; },
		}) as any);
		const overlay = new TaskOverlay();
		overlay.setUI({} as ExtensionUIContext);
		overlay.setProjectRoot("/home/dpopsuev/Projects/papyrus");

		overlay.startPolling(10);
		await new Promise((resolve) => setTimeout(resolve, 55));
		overlay.stopPolling();

		expect(calls).toBeGreaterThanOrEqual(3);
	});

	it("is idempotent -- calling startPolling twice does not run two overlapping timers", async () => {
		let calls = 0;
		setPapyrusClientConnectorForTests(async () => ({
			async call() { calls += 1; return { nodes: [], rootIds: [] } satisfies TaskGraph; },
		}) as any);
		const overlay = new TaskOverlay();
		overlay.setUI({} as ExtensionUIContext);
		overlay.setProjectRoot("/home/dpopsuev/Projects/papyrus");

		overlay.startPolling(10);
		overlay.startPolling(10);
		await new Promise((resolve) => setTimeout(resolve, 55));
		const callsWithOneTimer = calls;
		overlay.stopPolling();

		// ~5 ticks expected from one 10ms timer over 55ms; two overlapping timers would roughly double it.
		expect(callsWithOneTimer).toBeLessThan(9);
	});

	it("stopPolling (and dispose()) stop further refreshes", async () => {
		let calls = 0;
		setPapyrusClientConnectorForTests(async () => ({
			async call() { calls += 1; return { nodes: [], rootIds: [] } satisfies TaskGraph; },
		}) as any);
		const overlay = new TaskOverlay();
		overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);
		overlay.setProjectRoot("/home/dpopsuev/Projects/papyrus");

		overlay.startPolling(10);
		await new Promise((resolve) => setTimeout(resolve, 35));
		overlay.dispose();
		const callsAtDispose = calls;
		await new Promise((resolve) => setTimeout(resolve, 35));

		expect(calls).toBe(callsAtDispose);
	});
});
