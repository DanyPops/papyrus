import { describe, expect, it } from "bun:test";
import { runDocsCli } from "../src/cli/docs-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

const artifact = { id: "d1", alias: "d1-alias", title: "T", status: "draft", body: "some body" };

describe("runDocsCli (Stricli-backed)", () => {
	it("create: threads title/body/subtype/labels/extra/template-id/project-root", async () => {
		const client = new FakeClient(artifact);
		const output = await runDocsCli(
			[
				"create",
				"--title",
				"T",
				"--body",
				"B",
				"--subtype",
				"note",
				"--labels-json",
				'["a"]',
				"--extra-json",
				'{"x":1}',
				"--template-id",
				"tmpl",
				"--project-root",
				"/proj",
			],
			client,
		);
		expect(client.calls).toEqual([
			{
				operation: "docs.create",
				input: { title: "T", body: "B", subtype: "note", labels: ["a"], extra: { x: 1 }, template_id: "tmpl", project_root: "/proj" },
			},
		]);
		expect(output).toBe("Created document: d1-alias T");
	});

	it("create: rejects without --title", async () => {
		const client = new FakeClient(artifact);
		await expect(runDocsCli(["create"], client)).rejects.toThrow();
	});

	it("list: threads status/text/limit/project-root, renders 'no documents found' when empty", async () => {
		const client = new FakeClient([]);
		const output = await runDocsCli(["list", "--status", "active", "--text", "q", "--limit", "5", "--project-root", "/proj"], client);
		expect(client.calls).toEqual([{ operation: "docs.list", input: { status: "active", text: "q", limit: 5, project_root: "/proj" } }]);
		expect(output).toBe("No documents found.");
	});

	it("assign-project: with a project-root assigns, without one unscopes", async () => {
		const client = new FakeClient(artifact);
		await runDocsCli(["assign-project", "d1", "/proj"], client);
		expect(client.calls).toEqual([{ operation: "docs.assign_project", input: { id: "d1", project_root: "/proj" } }]);
		const client2 = new FakeClient(artifact);
		const output2 = await runDocsCli(["assign-project", "d1"], client2);
		expect(client2.calls).toEqual([{ operation: "docs.assign_project", input: { id: "d1", project_root: undefined } }]);
		expect(output2).toBe("Unscoped d1");
	});

	it("show: renders label plus body", async () => {
		const client = new FakeClient(artifact);
		const output = await runDocsCli(["show", "d1"], client);
		expect(client.calls).toEqual([{ operation: "docs.show", input: { id: "d1" } }]);
		expect(output).toBe("d1-alias T\n\nsome body");
	});

	it.each(["activate", "archive", "reopen"])("%s: calls docs.%s with just the id", async (action) => {
		const client = new FakeClient(artifact);
		await runDocsCli([action, "d1"], client);
		expect(client.calls).toEqual([{ operation: `docs.${action}` as OperationName, input: { id: "d1" } }]);
	});

	it("link: threads id/relation/target-id", async () => {
		const client = new FakeClient(artifact);
		const output = await runDocsCli(["link", "d1", "relates_to", "d2"], client);
		expect(client.calls).toEqual([{ operation: "docs.link", input: { id: "d1", relation: "relates_to", target_id: "d2" } }]);
		expect(output).toBe("Linked d1 --relates_to--> d2");
	});

	it("update: requires at least one of title/body/labels-json", async () => {
		const client = new FakeClient(artifact);
		await expect(runDocsCli(["update", "d1"], client)).rejects.toThrow();
	});

	it("update: sends title/body/labels when given", async () => {
		const client = new FakeClient(artifact);
		await runDocsCli(["update", "d1", "--title", "T2"], client);
		expect(client.calls).toEqual([{ operation: "docs.update", input: { id: "d1", title: "T2", body: undefined, labels: undefined } }]);
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runDocsCli(["bogus"], client)).rejects.toThrow();
	});
});
