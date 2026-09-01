import { describe, expect, it } from "bun:test";
import { runPlaybooksCli } from "../src/cli/playbooks-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

const artifact = { id: "p1", alias: "p1-alias", title: "T", status: "active", body: "some body" };

describe("runPlaybooksCli (Stricli-backed)", () => {
	it("create: threads title/body/trigger/steps/tools/labels/extra/arguments/project-root", async () => {
		const client = new FakeClient(artifact);
		const output = await runPlaybooksCli(
			[
				"create",
				"--title",
				"T",
				"--body",
				"B",
				"--trigger",
				"when X",
				"--steps-json",
				'["do a"]',
				"--tools-json",
				'["tasks"]',
				"--labels-json",
				'["a"]',
				"--extra-json",
				'{"x":1}',
				"--arguments-json",
				'[{"name":"env"}]',
				"--project-root",
				"/proj",
			],
			client,
		);
		expect(client.calls).toEqual([
			{
				operation: "playbooks.create",
				input: {
					title: "T",
					body: "B",
					trigger: "when X",
					steps: ["do a"],
					tools: ["tasks"],
					labels: ["a"],
					extra: { x: 1 },
					arguments: [{ name: "env" }],
					project_root: "/proj",
				},
			},
		]);
		expect(output).toBe("Created playbook: p1-alias T");
	});

	it("create: rejects without --title", async () => {
		const client = new FakeClient(artifact);
		await expect(runPlaybooksCli(["create"], client)).rejects.toThrow();
	});

	it("list: threads status/text/limit/project-root", async () => {
		const client = new FakeClient([]);
		await runPlaybooksCli(["list", "--status", "active"], client);
		expect(client.calls).toEqual([
			{ operation: "playbooks.list", input: { status: "active", text: undefined, limit: undefined, project_root: undefined } },
		]);
	});

	it("show: renders label plus body", async () => {
		const client = new FakeClient(artifact);
		const output = await runPlaybooksCli(["show", "p1"], client);
		expect(output).toBe("p1-alias T\n\nsome body");
	});

	it("preview: threads arguments-json, returns the raw rendered string", async () => {
		const client = new FakeClient("rendered text");
		const output = await runPlaybooksCli(["preview", "p1", "--arguments-json", '{"env":"prod"}'], client);
		expect(client.calls).toEqual([{ operation: "playbooks.preview", input: { id: "p1", arguments: { env: "prod" } } }]);
		expect(output).toBe("rendered text");
	});

	it("preview: accepts a Playbook name as the positional server-resolved reference", async () => {
		const client = new FakeClient("rendered text");
		await runPlaybooksCli(["preview", "Audit data design"], client);
		expect(client.calls).toEqual([{ operation: "playbooks.preview", input: { id: "Audit data design", arguments: undefined } }]);
	});

	it("invoke: threads arguments-json/run-id/project-root, renders the entry task focused message", async () => {
		const client = new FakeClient({ entryTaskId: "t1" });
		const output = await runPlaybooksCli(["invoke", "p1", "--arguments-json", '{"env":"prod"}', "--run-id", "r1"], client);
		expect(client.calls).toEqual([
			{ operation: "playbooks.invoke", input: { id: "p1", arguments: { env: "prod" }, run_id: "r1", project_root: undefined } },
		]);
		expect(output).toContain("t1");
	});

	it("invoke: renders missing-arguments distinctly", async () => {
		const client = new FakeClient({ missingArguments: ["env"] });
		const output = await runPlaybooksCli(["invoke", "p1"], client);
		expect(output).toBe("Missing required argument(s): env.");
	});

	it.each(["enable", "disable"])("%s: calls playbooks.%s with just the id", async (action) => {
		const client = new FakeClient(artifact);
		await runPlaybooksCli([action, "p1"], client);
		expect(client.calls).toEqual([{ operation: `playbooks.${action}` as OperationName, input: { id: "p1" } }]);
	});

	it("assign-project: with a target assigns, without one unscopes", async () => {
		const client = new FakeClient(artifact);
		await runPlaybooksCli(["assign-project", "p1", "/target"], client);
		expect(client.calls).toEqual([{ operation: "playbooks.assign_project", input: { id: "p1", project_root: "/target" } }]);
	});

	it("update: requires at least one of title/body/labels-json/trigger/steps-json", async () => {
		const client = new FakeClient(artifact);
		await expect(runPlaybooksCli(["update", "p1"], client)).rejects.toThrow();
	});

	it("update: persists an explicit activation flag", async () => {
		const client = new FakeClient(artifact);
		await runPlaybooksCli(["update", "p1", "--activation-enabled", "false"], client);
		expect(client.calls).toEqual([{ operation: "playbooks.update", input: { id: "p1", activation_enabled: false } }]);
	});

	it("update: threads trigger/steps-json, the exact gap this closes -- no more create-new+supersedes+disable workaround", async () => {
		const client = new FakeClient(artifact);
		await runPlaybooksCli(["update", "p1", "--trigger", "new, generic trigger", "--steps-json", '["new, generic step"]'], client);
		expect(client.calls).toEqual([
			{
				operation: "playbooks.update",
				input: { id: "p1", trigger: "new, generic trigger", steps: ["new, generic step"] },
			},
		]);
	});

	it("contain: nests child under parent", async () => {
		const client = new FakeClient(artifact);
		const output = await runPlaybooksCli(["contain", "p1", "p2"], client);
		expect(client.calls).toEqual([{ operation: "playbooks.contain", input: { parent_id: "p1", child_id: "p2" } }]);
		expect(output).toBe("Nested: p2 → p1-alias T");
	});

	it("uncontain: removes nesting", async () => {
		const client = new FakeClient(artifact);
		const output = await runPlaybooksCli(["uncontain", "p1", "p2"], client);
		expect(client.calls).toEqual([{ operation: "playbooks.uncontain", input: { parent_id: "p1", child_id: "p2" } }]);
		expect(output).toBe("Removed p2 from p1-alias T");
	});

	it("depend: adds a dependency", async () => {
		const client = new FakeClient(artifact);
		const output = await runPlaybooksCli(["depend", "p1", "p2"], client);
		expect(client.calls).toEqual([{ operation: "playbooks.depend", input: { id: "p1", dependency_id: "p2" } }]);
		expect(output).toBe("Dependency added: p1-alias T waits for p2");
	});

	it("undepend: removes a dependency", async () => {
		const client = new FakeClient(artifact);
		const output = await runPlaybooksCli(["undepend", "p1", "p2"], client);
		expect(client.calls).toEqual([{ operation: "playbooks.undepend", input: { id: "p1", dependency_id: "p2" } }]);
		expect(output).toBe("Dependency removed: p1-alias T no longer waits for p2");
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runPlaybooksCli(["bogus"], client)).rejects.toThrow();
	});

	it("list: threads --applicable through to playbooks.list", async () => {
		const client = new FakeClient([]);
		await runPlaybooksCli(["list", "--project-root", "/proj", "--applicable"], client);
		expect(client.calls).toEqual([
			{
				operation: "playbooks.list",
				input: { status: undefined, text: undefined, limit: undefined, project_root: "/proj", applicable: true },
			},
		]);
	});

	const scope = { artifactId: "p1", mode: "projects", projectIds: ["proj1"], source: "explicit" };

	it("scope: shows a Playbook's project scope", async () => {
		const client = new FakeClient(scope);
		const output = await runPlaybooksCli(["scope", "p1"], client);
		expect(client.calls).toEqual([{ operation: "playbooks.scope", input: { id: "p1" } }]);
		expect(output).toContain("proj1");
	});

	it("set-global: makes a Playbook global", async () => {
		const client = new FakeClient({ ...scope, mode: "global", projectIds: [] });
		await runPlaybooksCli(["set-global", "p1"], client);
		expect(client.calls).toEqual([{ operation: "playbooks.set_global", input: { id: "p1" } }]);
	});

	it("add-project: adds one project to a Playbook's membership", async () => {
		const client = new FakeClient(scope);
		await runPlaybooksCli(["add-project", "p1", "proj1"], client);
		expect(client.calls).toEqual([{ operation: "playbooks.add_project", input: { id: "p1", project: "proj1" } }]);
	});

	it("remove-project: removes one project from a Playbook's membership", async () => {
		const client = new FakeClient(scope);
		await runPlaybooksCli(["remove-project", "p1", "proj1"], client);
		expect(client.calls).toEqual([{ operation: "playbooks.remove_project", input: { id: "p1", project: "proj1" } }]);
	});

	it("replace-projects: replaces a Playbook's entire project membership from a JSON array", async () => {
		const client = new FakeClient(scope);
		await runPlaybooksCli(["replace-projects", "p1", "--projects-json", '["proj1","proj2"]'], client);
		expect(client.calls).toEqual([{ operation: "playbooks.replace_projects", input: { id: "p1", projects: ["proj1", "proj2"] } }]);
	});
});
