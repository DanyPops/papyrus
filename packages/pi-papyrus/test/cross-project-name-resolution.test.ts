/**
 * Real friction hit live: wiring a cross-project tasks.depend edge (a task in one project
 * depending on a task in another) took several failed attempts before finding a working
 * parameter combination -- passing an explicit project_root scoped BOTH the primary `name` and
 * `dependency_name` to the same project, and the only working escape hatch (`scope: "all"`) was
 * undocumented. resolveArtifactIdByName now retries once against a global search when a name
 * isn't found under the caller's own scope, unless the caller already pinned an explicit scope.
 */
import type { PapyrusClient, Artifact } from "@danypops/papyrus";
import { describe, expect, it, afterEach } from "bun:test";
import { registerTasksTool } from "../extension/src/domain-tools.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

afterEach(() => {
	resetPapyrusClientForTests();
});

function registeredTasksTool(): { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: () => void, ctx: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> } {
	let tool: unknown;
	registerTasksTool({ registerTool: (definition: unknown) => { tool = definition; } } as never);
	return tool as ReturnType<typeof registeredTasksTool>;
}

function fakeCtx(cwd = "/tmp/project-a"): unknown {
	return { sessionManager: { getSessionId: () => "test-session" }, cwd };
}

function task(overrides: Partial<Artifact> = {}): Artifact {
	return {
		id: "task-1", kind: "task", title: "Some task", status: "todo", subtype: null, body: "",
		labels: [], extra: {}, created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	} as Artifact;
}

function mockService(handler: (operation: string, input: Record<string, unknown>) => unknown): Array<{ operation: string; input: Record<string, unknown> }> {
	const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
	setPapyrusClientConnectorForTests(() => Promise.resolve({
		call: (operation: string, input: Record<string, unknown>) => {
			calls.push({ operation, input });
			return Promise.resolve(handler(operation, input));
		},
	} as unknown as PapyrusClient));
	return calls;
}

describe("tasks tool: cross-project name resolution for depend", () => {
	it("resolves dependency_name in a different project by widening scope once, and notes it in the response", async () => {
		const calls = mockService((operation, input) => {
			if (operation === "tasks.list") {
				if (input["text"] === "From task") return [task({ id: "from-1", title: "From task" })];
				if (input["text"] === "Companion task") return input["scope"] === "all" ? [task({ id: "dep-1", title: "Companion task" })] : [];
				return [];
			}
			if (operation === "tasks.depend") return task({ id: "from-1", title: "From task" });
			throw new Error(`unexpected operation ${operation}`);
		});

		const tool = registeredTasksTool();
		const result = await tool.execute("call-1", { action: "depend", name: "From task", dependency_name: "Companion task" }, new AbortController().signal, () => {}, fakeCtx());

		const dependCalls = calls.filter((call) => call.operation === "tasks.depend");
		expect(dependCalls).toHaveLength(1);
		expect(dependCalls[0]?.input["dependency_id"]).toBe("dep-1");
		expect(result.content[0]?.text).toContain('"Companion task" was not found in the current project scope; resolved across all projects instead.');
	});

	it("does not widen when the caller pinned an explicit scope, so a genuine not-found stays a real error", async () => {
		mockService((operation, input) => {
			if (operation === "tasks.list") {
				if (input["text"] === "From task") return [task({ id: "from-1", title: "From task" })];
				return [];
			}
			throw new Error(`unexpected operation ${operation}`);
		});

		const tool = registeredTasksTool();
		await expect(
			tool.execute("call-1", { action: "depend", name: "From task", dependency_name: "Companion task", scope: "project" }, new AbortController().signal, () => {}, fakeCtx()),
		).rejects.toThrow(/no artifact named "Companion task" found in this scope/);
	});

	it("never widens an ambiguous match into a false success", async () => {
		mockService((operation, input) => {
			if (operation === "tasks.list") {
				if (input["text"] === "From task") return [task({ id: "from-1", title: "From task" })];
				if (input["text"] === "Companion task") return [task({ id: "dep-1", title: "Companion task" }), task({ id: "dep-2", title: "Companion task" })];
				return [];
			}
			throw new Error(`unexpected operation ${operation}`);
		});

		const tool = registeredTasksTool();
		await expect(
			tool.execute("call-1", { action: "depend", name: "From task", dependency_name: "Companion task" }, new AbortController().signal, () => {}, fakeCtx()),
		).rejects.toThrow(/2 artifacts are named "Companion task"/);
	});

	it("resolving a name in the caller's own project scope emits no widening note", async () => {
		mockService((operation) => {
			if (operation === "tasks.list") return [task({ id: "from-1", title: "From task" })];
			if (operation === "tasks.depend") return task({ id: "from-1", title: "From task" });
			throw new Error(`unexpected operation ${operation}`);
		});

		const tool = registeredTasksTool();
		const result = await tool.execute("call-1", { action: "depend", name: "From task", dependency_id: "dep-1" }, new AbortController().signal, () => {}, fakeCtx());
		expect(result.content[0]?.text).not.toContain("resolved across all projects instead");
	});

	it("documents dependency_name (singular, depend/undepend) vs depends_on_names (plural, create) so the two aren't confused", () => {
		let description = "";
		registerTasksTool({ registerTool: (definition: { description: string }) => { description = definition.description; } } as never);
		expect(description).toContain("depend`/`undepend` actions");
		expect(description).toContain("only for `create`'s initial dependency set");
	});
});
