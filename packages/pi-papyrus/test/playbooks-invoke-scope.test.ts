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
	return { cwd: "/workspace/defect-validation", hasUI: false, mode: "tui", sessionManager: { getSessionId: () => "session-real" } } as unknown as ExtensionContext;
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

const invocationResult = { entryTaskId: "t1", rootTaskIds: ["t0"], created: { tasks: ["t0", "t1"] } };

afterEach(resetPapyrusClientForTests);

/**
 * Regression: playbooks.invoke ends by calling tasks.focus server-side. The tasks tool always
 * scopes ITS OWN reads to ctx.cwd + the real session id -- so an invoke call that left either
 * unset produced a focus write invisible to a subsequent tasks(action=focused), confirmed live
 * (the focus_set event existed with the right session, but a cwd-scoped read still found it
 * only when project_root also matched -- an unscoped task never appears in a project-scoped list).
 */
describe("playbooks tool: invoke defaults project_root and session_id the same way the tasks tool always does", () => {
	it("defaults project_root to ctx.cwd and session_id to the real session when the caller omits both", async () => {
		const tools = await registeredTools();
		const calls = mockService(() => invocationResult);
		await tools.get("playbooks")!("id", { action: "invoke", id: "pb1", arguments: { jira_ticket: "OCPBUGS-95587" } }, undefined, undefined, context());
		expect(calls).toHaveLength(1);
		expect(calls[0]!.input["project_root"]).toBe("/workspace/defect-validation");
		expect(calls[0]!.input["session_id"]).toBe("session-real");
	});

	it("honors an explicit project_root/session_id instead of overriding them", async () => {
		const tools = await registeredTools();
		const calls = mockService(() => invocationResult);
		await tools.get("playbooks")!("id", { action: "invoke", id: "pb1", project_root: "/explicit/root", session_id: "explicit-session" }, undefined, undefined, context());
		expect(calls[0]!.input["project_root"]).toBe("/explicit/root");
		expect(calls[0]!.input["session_id"]).toBe("explicit-session");
	});

	it("resolves an unscoped playbook by name before applying the invoke-only project_root default -- the default must never narrow name resolution", async () => {
		const tools = await registeredTools();
		const playbook = { id: "pb1", kind: "playbook", title: "Defect Validation Playbook", status: "active", body: "", labels: [], extra: {} };
		const calls = mockService((operation, input) => {
			if (operation === "playbooks.list") {
				// The unscoped playbook itself must still be found: resolution must not have
				// inherited the invoke-only project_root default.
				expect(input["project_root"]).toBeUndefined();
				return [playbook];
			}
			return invocationResult;
		});
		await tools.get("playbooks")!("id", { action: "invoke", name: "Defect Validation Playbook" }, undefined, undefined, context());
		const invoke = calls.find((call) => call.operation === "playbooks.invoke")!;
		expect(invoke.input["id"]).toBe("pb1");
		expect(invoke.input["project_root"]).toBe("/workspace/defect-validation");
	});

	it("does not inject project_root/session_id for other actions -- create/list keep their prior unscoped-by-default behavior", async () => {
		const tools = await registeredTools();
		const calls = mockService((operation) => (operation === "playbooks.list" ? [] : { id: "pb1", kind: "playbook", title: "x", status: "active", body: "", labels: [], extra: {} }));
		await tools.get("playbooks")!("id", { action: "create", title: "New Playbook" }, undefined, undefined, context());
		await tools.get("playbooks")!("id", { action: "list" }, undefined, undefined, context());
		for (const call of calls) {
			expect(call.input["project_root"]).toBeUndefined();
			expect(call.input["session_id"]).toBeUndefined();
		}
	});
});
