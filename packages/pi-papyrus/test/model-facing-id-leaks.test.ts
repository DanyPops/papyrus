import { afterEach, describe, expect, it } from "bun:test";
import { type Artifact, type ArtifactStore, taskContext } from "@danypops/papyrus";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ActiveTaskContinuation } from "../extension/src/active-task-continuation.ts";
import registerPapyrus from "../extension/src/index.ts";
import {
	resetPapyrusClientForTests,
	resetVehicleClientTargetResolverForTests,
	setPapyrusClientConnectorForTests,
	setVehicleClientTargetResolverForTests,
} from "../extension/src/service-client.ts";

const TASK_ID = "0d6cc36a-2755-474c-b955-6a5534d5f66d";
const OTHER_ID = "899fdd09-1340-450b-ae60-e1816f9b481e";
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

function artifact(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: TASK_ID,
		alias: "decide-middleware-fate",
		kind: "task",
		title: "Decide middleware fate",
		status: "todo",
		subtype: "",
		body: "Choose and implement the enforcement point.",
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function modelText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((entry) => entry.type === "text")
		.map((entry) => entry.text ?? "")
		.join("\n");
}

type ToolExecute = (
	id: string,
	params: Record<string, unknown>,
	signal: undefined,
	onUpdate: undefined,
	ctx: ExtensionContext,
) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown }>;

async function registeredTools(): Promise<Map<string, ToolExecute>> {
	const tools = new Map<string, ToolExecute>();
	const api = {
		registerTool(tool: { name: string; execute: ToolExecute }) {
			tools.set(tool.name, tool.execute);
		},
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
	return {
		cwd: "/workspace/alef",
		hasUI: false,
		mode: "tui",
		sessionManager: { getSessionId: () => "session-a" },
	} as unknown as ExtensionContext;
}

function mockService(
	handler: (operation: string, input: Record<string, unknown>) => unknown,
): Array<{ operation: string; input: Record<string, unknown> }> {
	const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
	setPapyrusClientConnectorForTests(
		async () =>
			({
				async call(operation: string, input: Record<string, unknown>) {
					calls.push({ operation, input });
					return handler(operation, input);
				},
			}) as any,
	);
	return calls;
}

afterEach(resetPapyrusClientForTests);
afterEach(resetVehicleClientTargetResolverForTests);

describe("model-facing artifact references are name-first", () => {
	it("omits UUIDs from injected task context and active-task continuation prompts", () => {
		const task = artifact({ status: "in-progress" });
		const store = {
			query: () => [task],
			relationships: () => [],
			get: () => task,
		} as unknown as ArtifactStore;
		const injected = taskContext(store, task.id)!;
		expect(injected).toContain(task.title);
		expect(injected).not.toMatch(UUID);

		const driver = new ActiveTaskContinuation({ maxTurns: 2, maxUnchangedTurns: 2 });
		const continuation = driver.evaluate(task, { idle: true, pendingMessages: false });
		expect(continuation.prompt).toContain(task.title);
		expect(continuation.prompt).not.toMatch(UUID);
	});

	it("keeps legacy tool model text name-first while retaining IDs in structured details", async () => {
		const tools = await registeredTools();
		const rows = [artifact(), artifact({ id: OTHER_ID, kind: "doc", title: "Trust model", status: "draft" })];
		mockService((operation, input) => {
			if (operation === "artifact.query") return rows;
			if (operation === "artifact.show") return rows.find((row) => row.id === input.id) ?? rows[0];
			if (operation === "graph.status") return { ...rows[0], status: "in-progress" };
			if (operation === "graph.link") return { linked: true };
			if (operation === "graph.tree") return { ...rows[0], edges: [{ from: TASK_ID, relation: "references", to: OTHER_ID }] };
			if (operation === "graph.history")
				return { events: [{ occurredAt: "2026-01-01", artifactId: TASK_ID, type: "updated", actor: "agent", source: "test" }] };
			throw new Error(`unexpected operation ${operation}`);
		});

		const queryResult = await tools.get("papyrus_query")!("q", {}, undefined, undefined, context());
		const showResult = await tools.get("papyrus_show")!("s", { id: TASK_ID }, undefined, undefined, context());
		const statusResult = await tools.get("papyrus_graph")!(
			"g",
			{ action: "status", id: TASK_ID, status: "in-progress" },
			undefined,
			undefined,
			context(),
		);
		const linkResult = await tools.get("papyrus_graph")!(
			"g",
			{ action: "link", from: TASK_ID, relation: "references", to: OTHER_ID },
			undefined,
			undefined,
			context(),
		);
		const treeResult = await tools.get("papyrus_graph")!("g", { action: "tree", id: TASK_ID }, undefined, undefined, context());
		const historyResult = await tools.get("papyrus_graph")!("g", { action: "history", id: TASK_ID }, undefined, undefined, context());

		for (const result of [queryResult, showResult, statusResult, linkResult, treeResult, historyResult])
			expect(modelText(result)).not.toMatch(UUID);
		expect(JSON.stringify(queryResult.details)).toContain(OTHER_ID);
		expect(JSON.stringify(showResult.details)).toContain(TASK_ID);
	});

	it("reveals IDs in model text only when equal titles genuinely need disambiguation", async () => {
		const tools = await registeredTools();
		const duplicates = [artifact(), artifact({ id: OTHER_ID })];
		mockService((operation) => {
			if (operation === "artifact.query") return duplicates;
			throw new Error(`unexpected operation ${operation}`);
		});
		const result = await tools.get("papyrus_query")!("q", {}, undefined, undefined, context());
		const output = modelText(result);
		expect(output).toContain(TASK_ID);
		expect(output).toContain(OTHER_ID);
	});

	// "passes scope, project root, and resolved graph root through name lookup" and
	// "tasks(action=\"context\") calls through with verbosity=full" moved to
	// @danypops/papyrus's test/tasks-vehicle.test.ts -- tasks is Vehicle-projected now,
	// no pi.registerTool() of its own left to exercise via raw RPC mocking.

	it("papyrus_graph link/unlink resolve from_name/to_name to real ids, exactly as docs.link's target_name already does", async () => {
		const tools = await registeredTools();
		const rows = [artifact(), artifact({ id: OTHER_ID, kind: "doc", title: "Trust model", status: "draft" })];
		const calls = mockService((operation, input) => {
			if (operation === "artifact.query" && input.text === "Decide middleware fate") return [rows[0]];
			if (operation === "artifact.query" && input.text === "Trust model") return [rows[1]];
			if (operation === "graph.link") return { linked: true };
			if (operation === "graph.unlink") return { removed: true };
			if (operation === "artifact.show") return rows.find((row) => row.id === input.id) ?? null;
			throw new Error(`unexpected operation ${operation}`);
		});

		const linkResult = await tools.get("papyrus_graph")!(
			"g",
			{ action: "link", from_name: "Decide middleware fate", relation: "references", to_name: "Trust model" },
			undefined,
			undefined,
			context(),
		);
		const unlinkResult = await tools.get("papyrus_graph")!(
			"g",
			{ action: "unlink", from_name: "Decide middleware fate", relation: "references", to_name: "Trust model" },
			undefined,
			undefined,
			context(),
		);

		const linkCall = calls.find((entry) => entry.operation === "graph.link");
		expect(linkCall?.input).toMatchObject({ from: TASK_ID, to: OTHER_ID, relation: "references" });
		const unlinkCall = calls.find((entry) => entry.operation === "graph.unlink");
		expect(unlinkCall?.input).toMatchObject({ from: TASK_ID, to: OTHER_ID, relation: "references" });
		expect(modelText(linkResult)).toContain("Decide middleware fate");
		expect(modelText(linkResult)).toContain("Trust model");
		expect(modelText(unlinkResult)).toContain("Decide middleware fate");
	});

	it("papyrus_graph link/unlink still work with explicit from/to ids, unaffected by from_name/to_name being optional", async () => {
		const tools = await registeredTools();
		const rows = [artifact(), artifact({ id: OTHER_ID, kind: "doc", title: "Trust model", status: "draft" })];
		const calls = mockService((operation, input) => {
			if (operation === "graph.link") return { linked: true };
			if (operation === "artifact.show") return rows.find((row) => row.id === input.id) ?? null;
			throw new Error(`unexpected operation ${operation}`);
		});

		await tools.get("papyrus_graph")!(
			"g",
			{ action: "link", from: TASK_ID, relation: "references", to: OTHER_ID },
			undefined,
			undefined,
			context(),
		);

		const linkCall = calls.find((entry) => entry.operation === "graph.link");
		expect(linkCall?.input).toMatchObject({ from: TASK_ID, to: OTHER_ID });
		expect(calls.some((entry) => entry.operation === "artifact.query")).toBe(false);
	});

	// notes.* is no longer a hand-rolled pi.registerTool() -- name/target_name
	// resolution and history rendering for it now live server-side in
	// @danypops/papyrus's src/handlers/notes.ts, covered by that
	// package's own notes-vehicle.test.ts, not here.
});
