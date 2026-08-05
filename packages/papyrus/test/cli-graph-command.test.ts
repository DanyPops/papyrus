import { describe, expect, it } from "bun:test";
import { runGraphCli } from "../src/cli/graph-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

describe("runGraphCli (Stricli-backed)", () => {
	it("link: calls graph.link with from/relation/to", async () => {
		const client = new FakeClient({ ok: true });
		const output = await runGraphCli(["link", "a1", "relates_to", "a2"], client);
		expect(client.calls).toEqual([{ operation: "graph.link", input: { from: "a1", relation: "relates_to", to: "a2" } }]);
		expect(output).toBe("Linked a1 --relates_to--> a2");
	});

	it("link: --json returns raw result", async () => {
		const client = new FakeClient({ ok: true });
		const output = await runGraphCli(["link", "a1", "relates_to", "a2", "--json"], client);
		expect(JSON.parse(output)).toEqual({ ok: true });
	});

	it("unlink: renders removed vs not-found distinctly", async () => {
		const removed = new FakeClient({ removed: true });
		expect(await runGraphCli(["unlink", "a1", "relates_to", "a2"], removed)).toBe("Unlinked a1 --relates_to--> a2");
		const notFound = new FakeClient({ removed: false });
		expect(await runGraphCli(["unlink", "a1", "relates_to", "a2"], notFound)).toBe("No such relationship: a1 --relates_to--> a2");
	});

	it("tree: passes --depth/--max-nodes as numbers and renders edges", async () => {
		const client = new FakeClient({
			id: "a1",
			alias: "a1-alias",
			title: "T",
			status: "todo",
			edges: [{ from: "a1", relation: "relates_to", to: "a2" }],
		});
		const output = await runGraphCli(["tree", "a1", "--depth", "2", "--max-nodes", "10"], client);
		expect(client.calls).toEqual([{ operation: "graph.tree", input: { id: "a1", depth: 2, max_nodes: 10 } }]);
		expect(output).toBe("a1-alias T\n  a1 --relates_to--> a2");
	});

	it("tree: renders 'no edges' when there are none", async () => {
		const client = new FakeClient({ id: "a1", alias: "a1-alias", title: "T", status: "todo" });
		const output = await runGraphCli(["tree", "a1"], client);
		expect(output).toBe("a1-alias T — no edges");
	});

	it("status: calls graph.status with id and status", async () => {
		const client = new FakeClient({ id: "a1", alias: "a1-alias", title: "T", status: "active" });
		const output = await runGraphCli(["status", "a1", "active"], client);
		expect(client.calls).toEqual([{ operation: "graph.status", input: { id: "a1", status: "active" } }]);
		expect(output).toBe("Updated a1 → [active]");
	});

	it("history: threads every filter flag and renders each event line", async () => {
		const client = new FakeClient({
			events: [
				{
					occurredAt: "2026-01-01T00:00:00.000Z",
					artifactId: "a1",
					type: "status",
					fromStatus: "todo",
					toStatus: "active",
					actor: "user",
					source: "cli",
				},
			],
		});
		const output = await runGraphCli(
			[
				"history",
				"--id",
				"a1",
				"--actor",
				"user",
				"--session-id",
				"s1",
				"--since",
				"2026-01-01",
				"--limit",
				"10",
				"--cursor",
				"5",
				"--direction",
				"asc",
			],
			client,
		);
		expect(client.calls).toEqual([
			{
				operation: "graph.history",
				input: { id: "a1", actor: "user", session_id: "s1", since: "2026-01-01", limit: 10, cursor: 5, direction: "asc" },
			},
		]);
		expect(output).toBe("2026-01-01T00:00:00.000Z a1 status todo → active · user/cli");
	});

	it("history: renders 'no recorded events' for an empty page", async () => {
		const client = new FakeClient({ events: [] });
		expect(await runGraphCli(["history"], client)).toBe("No recorded events.");
	});

	it("rejects a numeric flag with a non-numeric value", async () => {
		const client = new FakeClient({});
		await expect(runGraphCli(["tree", "a1", "--depth", "not-a-number"], client)).rejects.toThrow();
	});

	it("rejects link without exactly 3 positional arguments", async () => {
		const client = new FakeClient({});
		await expect(runGraphCli(["link", "a1", "relates_to"], client)).rejects.toThrow();
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runGraphCli(["bogus"], client)).rejects.toThrow();
	});
});
