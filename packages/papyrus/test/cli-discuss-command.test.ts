import { describe, expect, it } from "bun:test";
import { runDiscussCli } from "../src/cli/discuss-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

describe("runDiscussCli (Stricli-backed)", () => {
	it("open: threads title/actor/content/body/labels/blocks/options", async () => {
		const client = new FakeClient({ id: "d1" });
		const output = await runDiscussCli(
			[
				"open",
				"--title",
				"T",
				"--actor",
				"agent",
				"--content",
				"C",
				"--body",
				"B",
				"--labels-json",
				'["a"]',
				"--blocks-json",
				'["t1"]',
				"--options-json",
				'["x","y"]',
				"--options-mode",
				"single",
				"--option-descriptions-json",
				'["dx","dy"]',
			],
			client,
		);
		expect(client.calls).toEqual([
			{
				operation: "discuss.open",
				input: {
					title: "T",
					actor: "agent",
					content: "C",
					body: "B",
					labels: ["a"],
					blocks_task_ids: ["t1"],
					options: ["x", "y"],
					options_mode: "single",
					option_descriptions: ["dx", "dy"],
				},
			},
		]);
		expect(output).toBe(JSON.stringify({ id: "d1" }, null, 2));
	});

	it("open: --json returns compact JSON", async () => {
		const client = new FakeClient({ id: "d1" });
		const output = await runDiscussCli(["open", "--title", "T", "--actor", "a", "--content", "C", "--json"], client);
		expect(output).toBe(JSON.stringify({ id: "d1" }));
	});

	it("open: rejects a positional argument", async () => {
		const client = new FakeClient({});
		await expect(runDiscussCli(["open", "extra", "--title", "T", "--actor", "a", "--content", "C"], client)).rejects.toThrow();
	});

	it("reply: threads id/actor/content/selected/options", async () => {
		const client = new FakeClient({});
		await runDiscussCli(["reply", "d1", "--actor", "a", "--content", "C", "--selected-json", '["x"]'], client);
		expect(client.calls).toEqual([{ operation: "discuss.reply", input: { id: "d1", actor: "a", content: "C", selected: ["x"] } }]);
	});

	it("open: threads correct-options-json/explanation for a quiz", async () => {
		const client = new FakeClient({});
		await runDiscussCli(
			[
				"open",
				"--title",
				"T",
				"--actor",
				"a",
				"--content",
				"Capital of France?",
				"--options-json",
				'["Paris","London"]',
				"--options-mode",
				"single",
				"--correct-options-json",
				'["Paris"]',
				"--explanation",
				"Paris since 987 AD.",
			],
			client,
		);
		expect(client.calls).toEqual([
			{
				operation: "discuss.open",
				input: {
					title: "T",
					actor: "a",
					content: "Capital of France?",
					options: ["Paris", "London"],
					options_mode: "single",
					correct_options: ["Paris"],
					explanation: "Paris since 987 AD.",
				},
			},
		]);
	});

	it("reply: threads correct-options-json/explanation for a quiz posed on this same round", async () => {
		const client = new FakeClient({});
		await runDiscussCli(
			[
				"reply",
				"d1",
				"--actor",
				"a",
				"--content",
				"Now, capital of Japan?",
				"--options-json",
				'["Tokyo","Osaka"]',
				"--options-mode",
				"single",
				"--correct-options-json",
				'["Tokyo"]',
				"--explanation",
				"Tokyo is the capital.",
			],
			client,
		);
		expect(client.calls).toEqual([
			{
				operation: "discuss.reply",
				input: {
					id: "d1",
					actor: "a",
					content: "Now, capital of Japan?",
					options: ["Tokyo", "Osaka"],
					options_mode: "single",
					correct_options: ["Tokyo"],
					explanation: "Tokyo is the capital.",
				},
			},
		]);
	});

	it("reply: rejects when the id positional is missing", async () => {
		const client = new FakeClient({});
		await expect(runDiscussCli(["reply", "--actor", "a", "--content", "C"], client)).rejects.toThrow();
	});

	it("defer: threads id and --reason", async () => {
		const client = new FakeClient({});
		await runDiscussCli(["defer", "d1", "--reason", "paused"], client);
		expect(client.calls).toEqual([{ operation: "discuss.defer", input: { id: "d1", reason: "paused" } }]);
	});

	it("resume: threads just id", async () => {
		const client = new FakeClient({});
		await runDiscussCli(["resume", "d1"], client);
		expect(client.calls).toEqual([{ operation: "discuss.resume", input: { id: "d1" } }]);
	});

	it("settle: threads id and --settlement", async () => {
		const client = new FakeClient({});
		await runDiscussCli(["settle", "d1", "--settlement", "done"], client);
		expect(client.calls).toEqual([{ operation: "discuss.settle", input: { id: "d1", settlement: "done" } }]);
	});

	it("block: threads id and --task-id", async () => {
		const client = new FakeClient({});
		await runDiscussCli(["block", "d1", "--task-id", "t1"], client);
		expect(client.calls).toEqual([{ operation: "discuss.block", input: { id: "d1", task_id: "t1" } }]);
	});

	it("unblock: threads id and --task-id", async () => {
		const client = new FakeClient({});
		await runDiscussCli(["unblock", "d1", "--task-id", "t1"], client);
		expect(client.calls).toEqual([{ operation: "discuss.unblock", input: { id: "d1", task_id: "t1" } }]);
	});

	it("show: threads just id", async () => {
		const client = new FakeClient({});
		await runDiscussCli(["show", "d1"], client);
		expect(client.calls).toEqual([{ operation: "discuss.show", input: { id: "d1" } }]);
	});

	it("rounds: threads id, --after-round, --limit as numbers", async () => {
		const client = new FakeClient({});
		await runDiscussCli(["rounds", "d1", "--after-round", "3", "--limit", "10"], client);
		expect(client.calls).toEqual([{ operation: "discuss.rounds", input: { id: "d1", after_round: 3, limit: 10 } }]);
	});

	it("list: threads --state and --limit, accepts no positional", async () => {
		const client = new FakeClient({});
		await runDiscussCli(["list", "--state", "active", "--limit", "5"], client);
		expect(client.calls).toEqual([{ operation: "discuss.list", input: { state: "active", limit: 5 } }]);
	});

	it("list: rejects a positional argument", async () => {
		const client = new FakeClient({});
		await expect(runDiscussCli(["list", "extra"], client)).rejects.toThrow();
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runDiscussCli(["bogus"], client)).rejects.toThrow();
	});
});
