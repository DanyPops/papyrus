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

afterEach(resetPapyrusClientForTests);
afterEach(resetVehicleClientTargetResolverForTests);

// docs' own remove_subtree coverage moved to @danypops/papyrus's
// test/artifact-trash-vehicle.test.ts -- docs is Vehicle-projected now, no
// pi.registerTool() of its own. rules/skills/playbooks still use this
// file's shared handler.
describe("remove_subtree shared across domain tools (tasks, rules, playbooks, skills)", () => {
	it("tasks tool: calls artifact.remove_subtree and reports the root's title plus how many contained artifacts were trashed", async () => {
		const tools = await registeredTools();
		const calls = mockService((operation) => {
			if (operation === "artifact.show") return { id: "t0", kind: "task", title: "Root", status: "todo", body: "", labels: [], extra: {} };
			return { removed: ["t0", "t1", "t2"], skipped: ["t3"] };
		});
		const result = await tools.get("tasks")!("id", { action: "remove_subtree", id: "t0", reason: "cleanup" }, undefined, undefined, context());
		expect(calls.some((c) => c.operation === "artifact.remove_subtree")).toBe(true);
		expect(result.content[0]!.text).toContain('"Root"');
		expect(result.content[0]!.text).toContain("2 contained artifact(s)");
		expect(result.content[0]!.text).toContain("skipped 1 already-trashed");
	});
});
