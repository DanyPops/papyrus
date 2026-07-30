/**
 * Real incident: `tasks(action: "update", gates: [...])` on an already-created task silently
 * dropped the gates field -- tasks.update only ever reads title/body/labels/status (see
 * Tasks.setGates's own doc comment in task-service.ts), and the pi-facing `tasks` tool never
 * exposed the backend's already-correct tasks.set_gates operation as a reachable action at all.
 * The service-level operation and its own tests were already right; this is the missing wiring.
 */
import type { PapyrusClient, Artifact } from "@danypops/papyrus";
import { describe, expect, it, afterEach } from "bun:test";
import { registerTasksTool } from "../extension/src/domain-tools.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

afterEach(() => {
	resetPapyrusClientForTests();
});

function registeredTasksTool(): { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: () => void, ctx: unknown) => Promise<unknown> } {
	let tool: unknown;
	registerTasksTool({ registerTool: (definition: unknown) => { tool = definition; } } as never);
	return tool as ReturnType<typeof registeredTasksTool>;
}

function fakeCtx(): unknown {
	return { sessionManager: { getSessionId: () => "test-session" }, cwd: "/tmp/papyrus-test-project" };
}

function task(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "task-1",
		kind: "task",
		title: "Some task",
		status: "in-progress",
		subtype: null,
		body: "body",
		labels: [],
		extra: { gates: [{ command: "bun run typecheck" }] },
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	} as unknown as Artifact;
}

describe("tasks tool set_gates action", () => {
	it("routes action: 'set_gates' to the backend's tasks.set_gates operation, not tasks.update", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		const updatedTask = task({ extra: { gates: [{ command: "echo replaced" }] } });
		setPapyrusClientConnectorForTests(() =>
			Promise.resolve({
				call: (operation: string, input: unknown) => {
					calls.push({ operation, input });
					return Promise.resolve(updatedTask);
				},
			} as unknown as PapyrusClient),
		);

		const tool = registeredTasksTool();
		await tool.execute("call-1", { action: "set_gates", id: "task-1", gates: [{ command: "echo replaced" }] }, new AbortController().signal, () => {}, fakeCtx());

		const setGatesCalls = calls.filter((call) => call.operation === "tasks.set_gates");
		expect(setGatesCalls).toHaveLength(1);
		expect(setGatesCalls[0]?.input).toMatchObject({ id: "task-1", gates: [{ command: "echo replaced" }] });
		expect(calls.some((call) => call.operation === "tasks.update")).toBe(false);
	});

	it("advertises set_gates in its own description, so a caller can discover it exists", () => {
		let description = "";
		registerTasksTool({ registerTool: (definition: { description: string }) => { description = definition.description; } } as never);
		expect(description).toContain("set_gates");
	});

	it("action: 'update' with a gates field never reaches tasks.update's gates parameter -- update ignores it entirely, by design", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		setPapyrusClientConnectorForTests(() =>
			Promise.resolve({
				call: (operation: string, input: unknown) => {
					calls.push({ operation, input });
					return Promise.resolve(task());
				},
			} as unknown as PapyrusClient),
		);

		const tool = registeredTasksTool();
		await tool.execute("call-1", { action: "update", id: "task-1", body: "new body", gates: [{ command: "echo should-be-ignored" }] }, new AbortController().signal, () => {}, fakeCtx());

		expect(calls).toHaveLength(1);
		expect(calls[0]?.operation).toBe("tasks.update");
		// Documents the real, backend-enforced contract (task-service.ts's `update` only reads
		// title/body/labels/status) -- a `gates` field riding along on `action: "update"` is
		// legal to send but has zero effect. Callers wanting to change gates must use set_gates.
	});
});
