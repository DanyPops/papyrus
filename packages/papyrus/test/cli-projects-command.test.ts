import { describe, expect, it } from "bun:test";
import { runProjectsCli } from "../src/cli/projects-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

const project = { id: "p1", name: "Project One", aliases: ["p1-alias"], projectRoot: "/workspace/papyrus" };

describe("runProjectsCli (Stricli-backed)", () => {
	it("list: threads query/limit", async () => {
		const client = new FakeClient([project]);
		const output = await runProjectsCli(["list", "--query", "papyrus", "--limit", "5"], client);
		expect(client.calls).toEqual([{ operation: "projects.list", input: { query: "papyrus", limit: 5 } }]);
		expect(output).toContain("Project One");
	});

	it("list: renders 'no registered projects' when empty", async () => {
		const client = new FakeClient([]);
		const output = await runProjectsCli(["list"], client);
		expect(output).toBe("No registered projects.");
	});

	it("resolve: threads the reference positional", async () => {
		const client = new FakeClient(project);
		const output = await runProjectsCli(["resolve", "p1-alias"], client);
		expect(client.calls).toEqual([{ operation: "projects.resolve", input: { reference: "p1-alias" } }]);
		expect(output).toContain("Project One");
	});

	it("register: threads project-root/name/aliases-json/existing-id", async () => {
		const client = new FakeClient(project);
		await runProjectsCli(
			["register", "/workspace/papyrus", "--name", "Project One", "--aliases-json", '["p1-alias"]', "--existing-id", "p0"],
			client,
		);
		expect(client.calls).toEqual([
			{
				operation: "projects.register",
				input: { project_root: "/workspace/papyrus", name: "Project One", aliases: ["p1-alias"], existing_id: "p0" },
			},
		]);
	});

	it("register: rejects without a project-root positional", async () => {
		const client = new FakeClient(project);
		await expect(runProjectsCli(["register"], client)).rejects.toThrow();
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runProjectsCli(["bogus"], client)).rejects.toThrow();
	});
});
