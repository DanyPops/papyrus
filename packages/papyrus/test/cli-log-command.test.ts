import { describe, expect, it } from "bun:test";
import { runLogCli } from "../src/cli/log-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

describe("runLogCli (Stricli-backed)", () => {
	it("append: sends every required flag plus the caller's project scope by default", async () => {
		const client = new FakeClient({ entry: { id: "e1" }, replayed: false });
		await runLogCli(
			["append", "--source", "pi-session-context", "--level", "info", "--message", "turn settled", "--operation-id", "s1:1"],
			client,
			"/proj",
		);
		expect(client.calls).toEqual([
			{
				operation: "logs.append",
				input: { source_id: "pi-session-context", project_root: "/proj", level: "info", message: "turn settled", operation_id: "s1:1" },
			},
		]);
	});

	it("append: --global omits project_root entirely", async () => {
		const client = new FakeClient({ entry: { id: "e1" }, replayed: false });
		await runLogCli(["append", "--source", "s", "--level", "info", "--message", "m", "--operation-id", "op", "--global"], client, "/proj");
		expect(client.calls[0]?.input).not.toHaveProperty("project_root");
	});

	it("append: threads --source-label, --fields-json, --session-id, --occurred-at when given", async () => {
		const client = new FakeClient({});
		await runLogCli(
			[
				"append",
				"--source",
				"s",
				"--level",
				"info",
				"--message",
				"m",
				"--operation-id",
				"op",
				"--source-label",
				"label",
				"--fields-json",
				'{"a":1}',
				"--session-id",
				"sess1",
				"--occurred-at",
				"2026-01-01T00:00:00.000Z",
			],
			client,
			"/proj",
		);
		expect(client.calls[0]?.input).toEqual({
			source_id: "s",
			source_label: "label",
			project_root: "/proj",
			level: "info",
			message: "m",
			operation_id: "op",
			fields: { a: 1 },
			session_id: "sess1",
			occurred_at: "2026-01-01T00:00:00.000Z",
		});
	});

	it("append: rejects when a required flag is missing", async () => {
		const client = new FakeClient({});
		await expect(runLogCli(["append", "--level", "info", "--message", "m", "--operation-id", "op"], client, "/proj")).rejects.toThrow();
	});

	it("query: sends --source plus optional since/level/limit", async () => {
		const client = new FakeClient({ entries: [{ id: "e1" }], truncated: false });
		const output = await runLogCli(["query", "--source", "s", "--since", "2026-01-01", "--level", "info", "--limit", "5"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "logs.query", input: { source_id: "s", since: "2026-01-01", level: "info", limit: 5 } }]);
		expect(output).toBe('{"id":"e1"}\n(1 entries)');
	});

	it("query: renders a truncated marker when the result says so", async () => {
		const client = new FakeClient({ entries: [], truncated: true });
		const output = await runLogCli(["query", "--source", "s"], client, "/proj");
		expect(output).toBe("(truncated -- more entries exist beyond this page)");
	});

	it("query: rejects when --source is missing", async () => {
		const client = new FakeClient({});
		await expect(runLogCli(["query"], client, "/proj")).rejects.toThrow();
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runLogCli(["bogus"], client, "/proj")).rejects.toThrow();
	});
});
