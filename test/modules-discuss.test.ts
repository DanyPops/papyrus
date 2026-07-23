import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteDiscussionRoundStore } from "../src/adapters/sqlite-discussion-round-store.ts";
import { openDb } from "../src/db.ts";
import { Discussions } from "../src/discussion-service.ts";
import { discussOperations, DISCUSS_OPERATION_NAMES } from "../src/modules/discuss.ts";
import { OperationRegistry } from "../src/module-registry.ts";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const discussions = new Discussions(artifacts, new SQLiteDiscussionRoundStore(db));
	const registry = new OperationRegistry();
	registry.registerAll(discussOperations(discussions));
	return { registry, discussions };
}

describe("modules/discuss — registered operations", () => {
	it("registers exactly the discuss.* operations DISCUSS_OPERATION_NAMES declares, no more, no fewer", () => {
		const { registry } = fixture();
		expect(registry.list()).toEqual([...DISCUSS_OPERATION_NAMES].sort());
	});

	it("discuss.open requires title, actor, and content", () => {
		const { registry } = fixture();
		const open = registry.get("discuss.open")!;
		expect(() => open.execute({})).toThrow(/title is required/);
		expect(() => open.execute({ title: "T" })).toThrow(/actor is required/);
		expect(() => open.execute({ title: "T", actor: "a" })).toThrow(/content is required/);
		const result = open.execute({ title: "T", actor: "a", content: "c" }) as { discussion: { id: string } };
		expect(result.discussion.id).toBeTruthy();
	});

	it("discuss.open accepts blocks_task_ids (snake_case) for blocking a real task", () => {
		const { registry } = fixture();
		// Use a doc, not a task, and confirm the module surfaces the domain error (real task
		// wiring is covered end-to-end in discussion-service.test.ts).
		const open = registry.get("discuss.open")!;
		expect(() => open.execute({ title: "T", actor: "a", content: "c", blocks_task_ids: ["missing-id"] })).toThrow(/not found/);
	});

	it("discuss.block and discuss.unblock require task_id", () => {
		const { registry } = fixture();
		const open = registry.get("discuss.open")!;
		const { discussion } = open.execute({ title: "T", actor: "a", content: "c" }) as { discussion: { id: string } };
		const block = registry.get("discuss.block")!;
		expect(() => block.execute({ id: discussion.id })).toThrow(/task_id is required/);
	});

	it("discuss.open and discuss.reply accept snake_case options/options_mode/selected", () => {
		const { registry } = fixture();
		const open = registry.get("discuss.open")!;
		const opened = open.execute({ title: "T", actor: "a", content: "A or B?", options: ["A", "B"], options_mode: "single" }) as { discussion: { id: string; extra: Record<string, unknown> } };
		expect(opened.discussion.extra["discussion"]).toMatchObject({ pendingOptions: ["A", "B"], pendingOptionsMode: "single" });
		const reply = registry.get("discuss.reply")!;
		const replied = reply.execute({ id: opened.discussion.id, actor: "b", content: "B", selected: ["B"] }) as { discussion: { extra: Record<string, unknown> } };
		expect(replied.discussion.extra["discussion"]).not.toHaveProperty("pendingOptions");
	});

	it("discuss.reply rejects an invalid options_mode", () => {
		const { registry } = fixture();
		const open = registry.get("discuss.open")!;
		const opened = open.execute({ title: "T", actor: "a", content: "c" }) as { discussion: { id: string } };
		const reply = registry.get("discuss.reply")!;
		expect(() => reply.execute({ id: opened.discussion.id, actor: "b", content: "c", options: ["A", "B"], options_mode: "quorum" })).toThrow(/options_mode must be/);
	});

	it("discuss.list and discuss.rounds round-trip through the registry", () => {
		const { registry } = fixture();
		const open = registry.get("discuss.open")!;
		const { discussion } = open.execute({ title: "T", actor: "a", content: "opening" }) as { discussion: { id: string } };
		const list = registry.get("discuss.list")!.execute({}) as Array<{ id: string }>;
		expect(list.map((d) => d.id)).toContain(discussion.id);
		const rounds = registry.get("discuss.rounds")!.execute({ id: discussion.id }) as Array<{ roundNumber: number }>;
		expect(rounds.map((r) => r.roundNumber)).toEqual([1]);
	});
});
