import { describe, expect, it } from "bun:test";
import { runArtifactCli } from "../src/cli/artifact-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

const artifact = { id: "a1", alias: "a1-alias", title: "T", status: "todo", body: "some body" };

describe("runArtifactCli (Stricli-backed)", () => {
	it("create: only sends project_root when kind is task", async () => {
		const client = new FakeClient(artifact);
		await runArtifactCli(["create", "--kind", "task", "--title", "T"], client, "/proj");
		expect(client.calls).toEqual([
			{
				operation: "artifact.create",
				input: {
					kind: "task",
					title: "T",
					body: undefined,
					status: undefined,
					subtype: undefined,
					labels: undefined,
					extra: undefined,
					template_id: undefined,
					project_root: "/proj",
				},
			},
		]);
	});

	it("create: omits project_root entirely for a non-task kind", async () => {
		const client = new FakeClient(artifact);
		await runArtifactCli(["create", "--kind", "doc", "--title", "T"], client, "/proj");
		expect(client.calls[0]?.input).not.toHaveProperty("project_root");
	});

	it("create: rejects without --kind or --template-id", async () => {
		const client = new FakeClient(artifact);
		await expect(runArtifactCli(["create", "--title", "T"], client, "/proj")).rejects.toThrow();
	});

	it("create: --template-id alone satisfies the requirement", async () => {
		const client = new FakeClient(artifact);
		await runArtifactCli(["create", "--template-id", "tmpl"], client, "/proj");
		expect(client.calls).toEqual([
			{
				operation: "artifact.create",
				input: {
					kind: undefined,
					title: undefined,
					body: undefined,
					status: undefined,
					subtype: undefined,
					labels: undefined,
					extra: undefined,
					template_id: "tmpl",
				},
			},
		]);
	});

	it("query: threads kind/status/text/limit, renders 'no artifacts found' when empty", async () => {
		const client = new FakeClient([]);
		const output = await runArtifactCli(["query", "--kind", "task", "--status", "todo", "--text", "q", "--limit", "5"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "artifact.query", input: { kind: "task", status: "todo", text: "q", limit: 5 } }]);
		expect(output).toBe("No artifacts found.");
	});

	it("show: threads depth/max-nodes", async () => {
		const client = new FakeClient(artifact);
		const output = await runArtifactCli(["show", "a1", "--depth", "2", "--max-nodes", "10"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "artifact.show", input: { id: "a1", depth: 2, max_nodes: 10 } }]);
		expect(output).toBe("a1-alias T\n\nsome body");
	});

	it("remove: threads id and optional reason", async () => {
		const client = new FakeClient({ artifactId: "a1", trashedAt: "t", purgeAfter: "p" });
		const output = await runArtifactCli(["remove", "a1", "--reason", "cleanup"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "artifact.remove", input: { id: "a1", reason: "cleanup" } }]);
		expect(output).toBe("Trashed a1: eligible for purge at p");
	});

	it("remove-subtree: renders skipped count only when nonzero", async () => {
		const client = new FakeClient({ removed: ["a1", "a2"], skipped: ["a3"] });
		const output = await runArtifactCli(["remove-subtree", "a1"], client, "/proj");
		expect(output).toBe("Trashed 2 artifact(s), skipped 1 already-trashed.");
		const clean = new FakeClient({ removed: ["a1"], skipped: [] });
		expect(await runArtifactCli(["remove-subtree", "a1"], clean, "/proj")).toBe("Trashed 1 artifact(s).");
	});

	it("restore: renders restored vs not-trashed distinctly", async () => {
		const restored = new FakeClient({ restored: true });
		expect(await runArtifactCli(["restore", "a1"], restored, "/proj")).toBe("Restored a1");
		const notTrashed = new FakeClient({ restored: false });
		expect(await runArtifactCli(["restore", "a1"], notTrashed, "/proj")).toBe("a1 was not trashed");
	});

	it("trash-status: renders trashed record or not-trashed message", async () => {
		const trashed = new FakeClient({ artifactId: "a1", trashedAt: "t", purgeAfter: "p" });
		expect(await runArtifactCli(["trash-status", "a1"], trashed, "/proj")).toBe("a1: trashed at t, purge eligible at p");
		const notTrashed = new FakeClient(null);
		expect(await runArtifactCli(["trash-status", "a1"], notTrashed, "/proj")).toBe("a1 is not trashed");
	});

	it("trash-list: accepts no positional arguments, renders 'trash is empty' when empty", async () => {
		const client = new FakeClient([]);
		expect(await runArtifactCli(["trash-list"], client, "/proj")).toBe("Trash is empty.");
		expect(client.calls).toEqual([{ operation: "artifact.trash_list", input: {} }]);
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runArtifactCli(["bogus"], client, "/proj")).rejects.toThrow();
	});
});
