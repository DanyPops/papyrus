import { describe, expect, it } from "bun:test";
import { runNoteCli } from "../src/cli/note-command.ts";
import type { OperationName } from "../src/service.ts";

class FakeClient {
	readonly calls: Array<{ operation: OperationName; input: Record<string, unknown> }> = [];
	constructor(private readonly result: unknown) {}
	async call<Input extends Record<string, unknown>, Output>(operation: OperationName, input: Input): Promise<Output> {
		this.calls.push({ operation, input });
		return this.result as Output;
	}
}

const artifact = { id: "n1", alias: "n1-alias", title: "T", status: "draft", body: "some body" };

describe("runNoteCli (Stricli-backed)", () => {
	it("capture: sends body/title/project_root/actor/source", async () => {
		const client = new FakeClient(artifact);
		const output = await runNoteCli(["capture", "remember this", "--title", "T"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "notes.capture", input: { body: "remember this", title: "T", project_root: "/proj", actor: "human", source: "cli" } },
		]);
		expect(output).toBe("Captured: n1-alias T");
	});

	it("capture: rejects a second positional argument", async () => {
		const client = new FakeClient(artifact);
		await expect(runNoteCli(["capture", "text", "extra"], client, "/proj")).rejects.toThrow();
	});

	it("list: sends project_root plus optional status/text/limit", async () => {
		const client = new FakeClient([artifact]);
		const output = await runNoteCli(["list", "--status", "draft", "--text", "q", "--limit", "5"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "notes.list", input: { project_root: "/proj", status: "draft", text: "q", limit: 5 } }]);
		expect(output).toBe("[draft] n1-alias T");
	});

	it("list: renders 'no open notes' for an empty result", async () => {
		const client = new FakeClient([]);
		expect(await runNoteCli(["list"], client, "/proj")).toBe("No open notes.");
	});

	it("page: can inventory across projects and carries nextCursor", async () => {
		const client = new FakeClient({ items: [artifact], nextCursor: "next-1" });
		const output = await runNoteCli(["page", "--all-projects", "--limit", "5", "--cursor", "previous"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "notes.list_page", input: { limit: 5, cursor: "previous" } }]);
		expect(output).toBe("[draft] n1-alias T\nNext cursor: next-1");
	});

	it("show: sends id and project_root, renders label plus body", async () => {
		const client = new FakeClient(artifact);
		const output = await runNoteCli(["show", "n1"], client, "/proj");
		expect(client.calls).toEqual([{ operation: "notes.show", input: { id: "n1", project_root: "/proj" } }]);
		expect(output).toBe("n1-alias T\n\nsome body");
	});

	it("history: sends id/project_root/direction=desc plus optional limit, renders chronological order", async () => {
		const client = new FakeClient({
			events: [
				{ occurredAt: "2026-01-02T00:00:00.000Z", type: "archived", actor: "human", source: "cli", disposition: "completed" },
				{ occurredAt: "2026-01-01T00:00:00.000Z", type: "captured", actor: "human", source: "cli" },
			],
		});
		const output = await runNoteCli(["history", "n1", "--limit", "10"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "notes.history", input: { id: "n1", project_root: "/proj", direction: "desc", limit: 10 } },
		]);
		expect(output).toBe("2026-01-01T00:00:00.000Z captured · human/cli\n2026-01-02T00:00:00.000Z archived · human/cli · completed");
	});

	it("history: renders a no-history message for an empty page", async () => {
		const client = new FakeClient({ events: [] });
		expect(await runNoteCli(["history", "n1"], client, "/proj")).toBe("No recorded history for n1.");
	});

	it("consume: sends id/project_root/actor=agent/source=cli plus optional reason", async () => {
		const client = new FakeClient(artifact);
		const output = await runNoteCli(["consume", "n1", "--reason", "handled"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "notes.consume", input: { id: "n1", project_root: "/proj", actor: "agent", source: "cli", reason: "handled" } },
		]);
		expect(output).toBe("Consumed: n1-alias T");
	});

	it("promote: sends id/target_id/project_root/actor=agent plus optional reason", async () => {
		const client = new FakeClient(artifact);
		const output = await runNoteCli(["promote", "n1", "t1"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "notes.promote", input: { id: "n1", target_id: "t1", project_root: "/proj", actor: "agent", source: "cli" } },
		]);
		expect(output).toBe("Promoted: n1-alias T → t1");
	});

	it("archive: sends id/disposition/project_root/actor=human plus optional reason", async () => {
		const client = new FakeClient(artifact);
		const output = await runNoteCli(["archive", "n1", "completed"], client, "/proj");
		expect(client.calls).toEqual([
			{ operation: "notes.archive", input: { id: "n1", disposition: "completed", project_root: "/proj", actor: "human", source: "cli" } },
		]);
		expect(output).toBe("Archived: n1-alias T · completed");
	});

	it("rejects an unknown action", async () => {
		const client = new FakeClient({});
		await expect(runNoteCli(["bogus"], client, "/proj")).rejects.toThrow();
	});
});
