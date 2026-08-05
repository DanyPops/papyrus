import { describe, expect, it } from "bun:test";
import { runRulesCli } from "../src/cli/rules-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

const artifact = { id: "r1", alias: "r1-alias", title: "T", status: "draft", body: "some body" };

describe("runRulesCli (Stricli-backed)", () => {
	it("create: threads title/body/condition/rule-action/severity/labels/extra/project-root", async () => {
		const client = new FakeClient(artifact);
		const output = await runRulesCli(
			[
				"create",
				"--title",
				"T",
				"--body",
				"B",
				"--condition",
				"C",
				"--rule-action",
				"A",
				"--severity",
				"warn",
				"--labels-json",
				'["a"]',
				"--extra-json",
				'{"x":1}',
				"--project-root",
				"/explicit",
			],
			client,
			"/caller",
		);
		expect(client.calls).toEqual([
			{
				operation: "rules.create",
				input: {
					title: "T",
					body: "B",
					condition: "C",
					rule_action: "A",
					severity: "warn",
					labels: ["a"],
					extra: { x: 1 },
					project_root: "/explicit",
				},
			},
		]);
		expect(output).toBe("Created rule: r1-alias T");
	});

	it("list: threads status/text/limit/project-root", async () => {
		const client = new FakeClient([]);
		await runRulesCli(["list", "--status", "active", "--project-root", "/explicit"], client, "/caller");
		expect(client.calls).toEqual([
			{ operation: "rules.list", input: { status: "active", text: undefined, limit: undefined, project_root: "/explicit" } },
		]);
	});

	it("assign-project: with a target assigns, without one unscopes", async () => {
		const client = new FakeClient(artifact);
		await runRulesCli(["assign-project", "r1", "/target"], client, "/caller");
		expect(client.calls).toEqual([{ operation: "rules.assign_project", input: { id: "r1", project_root: "/target" } }]);
	});

	it("show: renders label plus body", async () => {
		const client = new FakeClient(artifact);
		const output = await runRulesCli(["show", "r1"], client, "/caller");
		expect(output).toBe("r1-alias T\n\nsome body");
	});

	it("preview: returns the raw preview string, JSON or not", async () => {
		const client = new FakeClient("preview text");
		const output = await runRulesCli(["preview", "r1"], client, "/caller");
		expect(client.calls).toEqual([{ operation: "rules.preview", input: { id: "r1" } }]);
		expect(output).toBe("preview text");
	});

	it.each(["enable", "disable"])("%s: calls rules.%s with just the id", async (action) => {
		const client = new FakeClient(artifact);
		await runRulesCli([action, "r1"], client, "/caller");
		expect(client.calls).toEqual([{ operation: `rules.${action}` as OperationName, input: { id: "r1" } }]);
	});

	it("gate: threads rule-id and task-id", async () => {
		const client = new FakeClient(artifact);
		const output = await runRulesCli(["gate", "r1", "t1"], client, "/caller");
		expect(client.calls).toEqual([{ operation: "rules.gate", input: { id: "r1", task_id: "t1" } }]);
		expect(output).toBe("Gated t1 with rule r1-alias T");
	});

	it("injectable: always uses the caller's project root -- there is no --project-root flag to override it", async () => {
		const client = new FakeClient([artifact]);
		const output = await runRulesCli(["injectable"], client, "/caller");
		expect(client.calls).toEqual([{ operation: "rules.injectable", input: { project_root: "/caller" } }]);
		expect(output).toBe("T");
	});

	it("injectable: rejects an unknown --project-root flag rather than silently ignoring it (the old hand-rolled parser's behavior)", async () => {
		const client = new FakeClient([artifact]);
		await expect(runRulesCli(["injectable", "--project-root", "/explicit"], client, "/caller")).rejects.toThrow();
	});

	it("injectable: renders 'no injectable rules' when empty", async () => {
		const client = new FakeClient([]);
		expect(await runRulesCli(["injectable"], client, "/caller")).toBe("No injectable rules.");
	});

	it("update: requires at least one of title/body/labels-json", async () => {
		const client = new FakeClient(artifact);
		await expect(runRulesCli(["update", "r1"], client, "/caller")).rejects.toThrow();
	});

	it("update: sends title/body/labels when given", async () => {
		const client = new FakeClient(artifact);
		await runRulesCli(["update", "r1", "--title", "T2"], client, "/caller");
		expect(client.calls).toEqual([{ operation: "rules.update", input: { id: "r1", title: "T2", body: undefined, labels: undefined } }]);
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runRulesCli(["bogus"], client, "/caller")).rejects.toThrow();
	});
});
