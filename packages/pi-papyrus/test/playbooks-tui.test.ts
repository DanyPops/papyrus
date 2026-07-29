import { afterEach, describe, expect, it } from "bun:test";
import type { Artifact } from "@danypops/papyrus";
import { openPlaybookByName, playbookArgumentCompletions } from "../extension/src/playbooks.ts";
import { resetPapyrusClientForTests, setPapyrusClientConnectorForTests } from "../extension/src/service-client.ts";

afterEach(resetPapyrusClientForTests);

function playbook(overrides: Partial<Artifact> & { id: string; title: string }): Artifact {
	return { kind: "playbook", status: "active", subtype: "", body: "", labels: [], extra: {}, created_at: "x", updated_at: "x", ...overrides };
}

function mockList(playbooks: Artifact[], invoke: (id: string) => unknown = (id) => ({ entryTaskId: `entry-${id}`, created: { tasks: [`entry-${id}`] } })): Array<{ operation: string; input: unknown }> {
	const calls: Array<{ operation: string; input: unknown }> = [];
	setPapyrusClientConnectorForTests(async () => ({
		async call(operation: string, input: any) {
			calls.push({ operation, input });
			if (operation === "playbooks.list") return playbooks;
			if (operation === "playbooks.invoke") return invoke(input.id);
			throw new Error(`unexpected operation ${operation}`);
		},
	}) as any);
	return calls;
}

describe("/playbook command: argument completions and open-by-name", () => {
	it("completes only active playbooks whose title starts with the typed prefix, case-insensitively", async () => {
		mockList([
			playbook({ id: "p1", title: "New Project", extra: { trigger: "starting from scratch" } }),
			playbook({ id: "p2", title: "New Feature Flag" }),
			playbook({ id: "p3", title: "Old Project" }),
		]);
		const items = await playbookArgumentCompletions("new");
		expect(items).toEqual([
			{ value: "New Feature Flag", label: "New Feature Flag", description: undefined },
			{ value: "New Project", label: "New Project", description: "starting from scratch" },
		]);
	});

	it("returns every active playbook, sorted, for an empty prefix", async () => {
		mockList([playbook({ id: "p1", title: "B" }), playbook({ id: "p2", title: "A" })]);
		const items = await playbookArgumentCompletions("");
		expect(items?.map((item) => item.value)).toEqual(["A", "B"]);
	});

	it("degrades to null (no suggestions), never throws, on a daemon error", async () => {
		setPapyrusClientConnectorForTests(async () => ({ async call() { throw new Error("daemon unreachable"); } }) as any);
		expect(await playbookArgumentCompletions("x")).toBeNull();
	});

	it("routes a blank name to the full browser instead of the invoke path, without throwing", async () => {
		const ctx = { hasUI: false, ui: { notify: () => {}, setEditorText: () => {} } } as any;
		const calls = mockList([]);
		await openPlaybookByName("   ", ctx);
		expect(calls.some((call) => call.operation === "playbooks.invoke")).toBe(false);
	});

	it("resolves an exact name, invokes it (materializing real tasks), and reports the focused entry task", async () => {
		mockList([playbook({ id: "p1", title: "New Project" })], (id) => ({ entryTaskId: `entry-${id}`, created: { tasks: [`entry-${id}`] } }));
		let editorText: string | undefined;
		const notifications: string[] = [];
		const ctx = { ui: { setEditorText: (text: string) => { editorText = text; }, notify: (message: string) => notifications.push(message) } } as any;
		await openPlaybookByName("New Project", ctx);
		expect(editorText).toBe('Run the "New Project" playbook -- work on the currently focused task.');
		expect(notifications).toEqual(['"New Project" invoked: entry task entry-p1 focused']);
	});

	it("notifies an error, never throws, when the name doesn't match exactly one playbook", async () => {
		mockList([playbook({ id: "p1", title: "New Project" })]);
		const notifications: string[] = [];
		const ctx = { ui: { setEditorText: () => { throw new Error("must not be called"); }, notify: (message: string) => notifications.push(message) } } as any;
		await openPlaybookByName("Nonexistent", ctx);
		expect(notifications[0]).toContain('no artifact named "Nonexistent"');
	});
});
