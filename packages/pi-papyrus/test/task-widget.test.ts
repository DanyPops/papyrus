import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { PushChannel } from "@danypops/vehicle-server/push-channel";
import { TaskOverlay } from "../extension/src/index.ts";
import {
	resetPapyrusClientForTests,
	resetPushChannelTargetResolverForTests,
	setPapyrusClientConnectorForTests,
	setPushChannelTargetResolverForTests,
} from "../extension/src/service-client.ts";
import { buildTaskWidgetProjection } from "../extension/src/task-widget.ts";
import type { Artifact, TaskGraph, TaskNode } from "@danypops/papyrus";

// Every TaskOverlay.refresh() call now also attempts to establish a push-channel
// subscription -- without this, these unit tests would fall through to the real
// resolvePushChannelTarget() and could open a real WebSocket against whatever
// Papyrus daemon happens to be running on this machine. Tests that actually
// exercise push-channel behavior override this themselves.
beforeEach(() => setPushChannelTargetResolverForTests(() => undefined));
afterEach(resetPushChannelTargetResolverForTests);

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

/**
 * Real Bun.serve + real WebSocket, not a mocked subscribeTaskPushChannel -- the whole
 * point is proving TaskOverlay actually reacts to a server-initiated push, not just
 * that it calls some function. Mirrors the wiring pattern verified in daemon-push-channel.test.ts.
 */
describe("TaskOverlay push channel: refreshes immediately on a server-published mutation", () => {
	afterEach(resetPapyrusClientForTests);

	function startPushFixture(token: string) {
		const pushChannel = new PushChannel({ token });
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (request, bunServer) => pushChannel.upgrade(request, bunServer) ?? undefined,
			websocket: pushChannel.websocketHandlers(),
		});
		return { pushChannel, server, port: server.port! };
	}

	it("a publish on the \"tasks\" topic triggers a real refresh() beyond the poll timer", async () => {
		const token = "overlay-push-token";
		const { pushChannel, server, port } = startPushFixture(token);
		try {
			setPushChannelTargetResolverForTests(() => ({ url: `ws://127.0.0.1:${port}/push`, token }));
			let calls = 0;
			setPapyrusClientConnectorForTests(async () => ({
				async call() { calls += 1; return { nodes: [], rootIds: [] } satisfies TaskGraph; },
			}) as any);

			const overlay = new TaskOverlay();
			overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);
			overlay.setProjectRoot("/home/dpopsuev/Projects/papyrus");

			// Establishes the push subscription as a side effect (ensurePushChannel()).
			// No poll timer running -- if a second refresh happens, it can only be the push.
			await overlay.refresh();
			const callsAfterFirstRefresh = calls;

			// Give the WebSocket a moment to finish its handshake and subscribe before publishing.
			for (let attempt = 0; attempt < 50 && pushChannel.connectionCount === 0; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(pushChannel.connectionCount).toBe(1);

			pushChannel.publish("tasks", { operation: "tasks.complete" });
			for (let attempt = 0; attempt < 50 && calls === callsAfterFirstRefresh; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(calls).toBeGreaterThan(callsAfterFirstRefresh);

			overlay.dispose();
		} finally {
			await server.stop(true);
		}
	});
});
