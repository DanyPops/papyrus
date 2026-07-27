import { afterEach, describe, expect, it } from "bun:test";
import type { Artifact } from "@danypops/papyrus";
import { blockedTaskChoices, openTaskChoices, pickTaskByName } from "../extension/src/discuss.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

afterEach(resetPapyrusClientForTests);

function task(overrides: Partial<Artifact> & { id: string; title: string }): Artifact {
	return {
		kind: "task", status: "todo", subtype: "", body: "", labels: [], extra: {},
		created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("/discuss Block/Unblock task pickers -- name-primary, no raw ids surfaced", () => {
	it("openTaskChoices scopes to the given project_root and excludes terminal tasks", async () => {
		const calls: Array<{ operation: string; input: unknown }> = [];
		setPapyrusClientConnectorForTests(async () => ({
			async call(operation: string, input: unknown) {
				calls.push({ operation, input });
				return [
					task({ id: "t1", title: "Open task", status: "todo" }),
					task({ id: "t2", title: "Finished task", status: "done" }),
					task({ id: "t3", title: "Canceled task", status: "canceled" }),
					task({ id: "t4", title: "In progress task", status: "in-progress" }),
				];
			},
		}) as any);
		const result = await openTaskChoices("/home/dpopsuev/Projects/papyrus");
		expect(calls).toEqual([{ operation: "tasks.list", input: { project_root: "/home/dpopsuev/Projects/papyrus" } }]);
		expect(result.map((t) => t.title)).toEqual(["Open task", "In progress task"]);
	});

	it("blockedTaskChoices resolves only tasks this discussion actually blocks, ignoring unrelated edges and a task that no longer resolves", async () => {
		setPapyrusClientConnectorForTests(async () => ({
			async call(operation: string, input: any) {
				if (operation === "graph.tree") {
					return {
						id: "disc-1", edges: [
							{ from: "disc-1", relation: "blocks", to: "t1" },
							{ from: "disc-1", relation: "blocks", to: "t2" },
							{ from: "disc-1", relation: "references", to: "t3" },
							{ from: "other-disc", relation: "blocks", to: "t4" },
						],
					};
				}
				if (operation === "tasks.show") {
					if (input.id === "t1") return task({ id: "t1", title: "Blocked task one" });
					if (input.id === "t2") throw new Error("not found"); // trashed/removed since the edge was created
					throw new Error(`unexpected tasks.show id ${input.id}`);
				}
				throw new Error(`unexpected operation ${operation}`);
			},
		}) as any);
		const result = await blockedTaskChoices("disc-1");
		expect(result.map((t) => t.id)).toEqual(["t1"]);
	});

	it("blockedTaskChoices returns empty, never throws, when the discussion blocks nothing", async () => {
		setPapyrusClientConnectorForTests(async () => ({
			async call(operation: string) {
				if (operation === "graph.tree") return { id: "disc-1", edges: [] };
				throw new Error(`unexpected operation ${operation}`);
			},
		}) as any);
		expect(await blockedTaskChoices("disc-1")).toEqual([]);
	});

	it("pickTaskByName offers titles (never raw ids) through ctx.ui.select and maps the pick back to its Artifact", async () => {
		const tasks = [task({ id: "t1", title: "Ship feature X", status: "todo" }), task({ id: "t2", title: "Fix bug Y", status: "in-progress" })];
		const selectCalls: Array<{ title: string; options: string[] }> = [];
		const ctx = { ui: {
			select: async (title: string, options: string[]) => { selectCalls.push({ title, options }); return "Fix bug Y [in-progress]"; },
			notify: () => {},
		} } as any;
		const picked = await pickTaskByName(ctx, "Block which task?", tasks);
		expect(picked?.id).toBe("t2");
		expect(selectCalls).toEqual([{ title: "Block which task?", options: ["Ship feature X [todo]", "Fix bug Y [in-progress]"] }]);
		expect(JSON.stringify(selectCalls)).not.toContain("t1");
		expect(JSON.stringify(selectCalls)).not.toContain("t2");
	});

	it("pickTaskByName returns undefined without prompting when there is nothing to choose from", async () => {
		const notifications: string[] = [];
		const ctx = { ui: { select: async () => { throw new Error("should not be called"); }, notify: (message: string) => notifications.push(message) } } as any;
		expect(await pickTaskByName(ctx, "Block which task?", [])).toBeUndefined();
		expect(notifications).toEqual(["No open tasks to choose from."]);
	});

	it("pickTaskByName returns undefined on cancel (ctx.ui.select resolves undefined)", async () => {
		const ctx = { ui: { select: async () => undefined, notify: () => {} } } as any;
		const tasks = [task({ id: "t1", title: "Ship feature X" })];
		expect(await pickTaskByName(ctx, "Block which task?", tasks)).toBeUndefined();
	});
});
