import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerPapyrus from "../extension/src/index.ts";
import {
	resetPapyrusClientForTests,
	resetVehicleClientTargetResolverForTests,
	setPapyrusClientConnectorForTests,
	setVehicleClientTargetResolverForTests,
} from "../extension/src/service-client.ts";

type ToolExecute = (id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;

async function registeredTools(): Promise<Map<string, ToolExecute>> {
	const tools = new Map<string, ToolExecute>();
	const api = {
		registerTool(tool: { name: string; execute: ToolExecute }) { tools.set(tool.name, tool.execute); },
		registerCommand() {},
		on() {},
		sendMessage() {},
		events: { emit() {} },
	} as unknown as ExtensionAPI;
	// No real Papyrus daemon involved in this test -- without this, registerNotesVehicle
	// would resolve whatever real daemon handle happens to exist on the machine running
	// this suite, not a hermetic no-op.
	setVehicleClientTargetResolverForTests(() => undefined);
	await registerPapyrus(api);
	return tools;
}

function context(): ExtensionContext {
	return { cwd: "/workspace/alef", hasUI: false, mode: "tui", sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext;
}

function mockService(handler: (operation: string, input: Record<string, unknown>) => unknown): Array<{ operation: string; input: Record<string, unknown> }> {
	const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
	setPapyrusClientConnectorForTests(async () => ({
		async call(operation: string, input: Record<string, unknown>) {
			calls.push({ operation, input });
			return handler(operation, input);
		},
	}) as any);
	return calls;
}

const discussion = { id: "d1", kind: "doc", title: "Split Packed core", status: "active", subtype: "discussion", body: "", labels: [], extra: {} };

afterEach(resetPapyrusClientForTests);
afterEach(resetVehicleClientTargetResolverForTests);

describe("discuss tool: actor defaults like tasks/notes already do, instead of forwarding a missing field to the daemon", () => {
	it("defaults actor to \"agent\" on open when the caller omits it, matching tasks/notes' own convention", async () => {
		const tools = await registeredTools();
		const calls = mockService(() => ({ discussion, rounds: [{ roundNumber: 1, actor: "agent", content: "Should we split?" }] }));
		await tools.get("discuss")!("id", { action: "open", title: "Split Packed core", content: "Should we split?" }, undefined, undefined, context());
		expect(calls).toHaveLength(1);
		expect(calls[0]!.input["actor"]).toBe("agent");
	});

	it("still honors an explicit human-authored actor instead of overriding it", async () => {
		const tools = await registeredTools();
		const calls = mockService(() => ({ discussion, rounds: [{ roundNumber: 1, actor: "alice", content: "Should we split?" }] }));
		await tools.get("discuss")!("id", { action: "open", title: "Split Packed core", content: "Should we split?", actor: "alice" }, undefined, undefined, context());
		expect(calls[0]!.input["actor"]).toBe("alice");
	});

	it("defaults actor to \"agent\" on reply the same way", async () => {
		const tools = await registeredTools();
		const calls = mockService(() => ({ discussion, rounds: [{ roundNumber: 2, actor: "agent", content: "Following up" }] }));
		await tools.get("discuss")!("id", { action: "reply", id: "d1", content: "Following up" }, undefined, undefined, context());
		expect(calls[0]!.input["actor"]).toBe("agent");
	});
});
