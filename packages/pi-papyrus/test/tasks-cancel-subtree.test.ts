import { afterEach, describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerPapyrus from "../extension/src/index.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

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

describe("tasks tool: cancel_subtree", () => {
	it("calls tasks.cancel_subtree and reports how many tasks were canceled/skipped", async () => {
		const tools = await registeredTools();
		const calls = mockService(() => ({ canceled: ["t0", "t1", "t2"], skipped: ["t3"] }));
		const result = await tools.get("tasks")!("id", { action: "cancel_subtree", id: "t0" }, undefined, undefined, context());
		expect(calls).toHaveLength(1);
		expect(calls[0]!.operation).toBe("tasks.cancel_subtree");
		expect(calls[0]!.input["id"]).toBe("t0");
		expect(result.content[0]!.text).toContain("Canceled 3 task(s)");
		expect(result.content[0]!.text).toContain("skipped 1 already-terminal");
	});

	it("omits the skipped clause when nothing was skipped", async () => {
		const tools = await registeredTools();
		mockService(() => ({ canceled: ["t0"], skipped: [] }));
		const result = await tools.get("tasks")!("id", { action: "cancel_subtree", id: "t0" }, undefined, undefined, context());
		expect(result.content[0]!.text).toBe("Canceled 1 task(s).");
	});
});
