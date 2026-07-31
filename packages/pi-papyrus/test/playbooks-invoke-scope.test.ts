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

const invocationResult = {
	playbookId: "pb1",
	runId: "run1",
	arguments: {},
	entryTaskId: "t1",
	rootTaskIds: ["t0"],
	created: { tasks: ["t0", "t1"], docs: [], rules: [] },
	execution: {
		nodes: [
			{ id: "t0", title: "Step 1", status: "todo", active: true, state: "ready", layer: 0, prerequisiteIds: [], successorIds: ["t1"] },
			{ id: "t1", title: "Step 2", status: "todo", active: false, state: "blocked", layer: 1, prerequisiteIds: ["t0"], successorIds: [] },
		],
		layers: [["t0"], ["t1"]],
		cycleIds: [],
	},
};

afterEach(resetPapyrusClientForTests);
afterEach(resetVehicleClientTargetResolverForTests);

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

/**
 * Regression: playbooks.invoke used to dump the entire raw PlaybookInvocationResult
 * (including the full execution DAG's raw ids/layers/prerequisite arrays) via
 * JSON.stringify into the tool's details -- unreadable, confirmed live by a real user.
 * Mirrors skills.run's already-correct summary + createInvocationDetails pattern.
 */
describe("playbooks tool: invoke renders a real summary, not a raw JSON dump", () => {
	it("summarizes created counts, entry task by label, ready roots by label, and an Execution section -- never a raw JSON blob", async () => {
		const tools = await registeredTools();
		mockService(() => invocationResult);
		const result = await tools.get("playbooks")!("id", { action: "invoke", id: "pb1" }, undefined, undefined, context());
		const message = result.content[0]!.text!;
		expect(message).toContain("Invoked playbook run run1: 2 task(s), 0 rule(s), 0 doc(s) created.");
		expect(message).toContain("Entry task now focused: Step 2.");
		expect(message).toContain("Ready roots: Step 1.");
		expect(message).toContain("Execution:");
		expect(message).toContain("[ready] Step 1");
		expect(message).toContain("[blocked] Step 2");
		expect(message).not.toContain("{\n");
		expect(result.details).toMatchObject({ kind: "invocation", operation: "playbooks.invoke", runId: "run1" });
	});

	it("reports missing arguments as a plain message, not a raw dump, and creates nothing", async () => {
		const tools = await registeredTools();
		mockService(() => ({ playbookId: "pb1", missingArguments: ["jira_ticket"] }));
		const result = await tools.get("playbooks")!("id", { action: "invoke", id: "pb1" }, undefined, undefined, context());
		const message = result.content[0]!.text!;
		expect(message).toBe("Missing required argument(s): jira_ticket. Nothing was created -- ask the human for these (discuss tool, live:true), then invoke again.");
		expect(result.details).toMatchObject({ kind: "invocation", operation: "playbooks.invoke" });
	});
});
