import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import { createPapyrusService } from "../src/service.ts";

const STORE_ID = "team-forum";
const address = { forumId: "engineering", topicId: "reviews", threadId: "context-mesh" };

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "papyrus-discourse-"));
	return createPapyrusService(join(directory, "papyrus.db"));
}

function command(operationId: string, extra: Record<string, unknown> = {}) {
	return {
		schemaVersion: "discourse.command.v1",
		operationId,
		authorId: "agent-a",
		content: { type: "message", text: operationId },
		...address,
		...extra,
	};
}

async function store(service: ReturnType<typeof createPapyrusService>, action: string, input: Record<string, unknown> = {}) {
	return service.execute("discourse.store", { action, store_id: STORE_ID, ...input });
}

describe("Papyrus Discourse store", () => {
	it("atomically appends idempotent posts as linked Context Mesh Docs", async () => {
		const service = fixture();
		const first = (await store(service, "append", {
			command: command("operation-1"),
			post_id: "post-1",
			timestamp: 1_700_000_000_000,
			event_retention: 10,
		})) as { post: { id: string; sequence: number }; replayed: boolean; events: Array<{ sequence: number }> };
		expect(first).toMatchObject({ post: { id: "post-1", sequence: 1 }, replayed: false });
		expect(first.events.map((event) => event.sequence)).toEqual([1, 2]);
		expect(await store(service, "append", {
			command: command("operation-1"), post_id: "ignored", timestamp: 1_700_000_000_001, event_retention: 10,
		})).toEqual({ ...first, replayed: true, events: [] });
		await expect(store(service, "append", {
			command: command("operation-1", { content: "changed" }), post_id: "post-conflict", timestamp: 2, event_retention: 10,
		})).rejects.toThrow("operation conflict");

		const threads = (await service.execute("artifact.query", { kind: "doc", subtype: "context-thread", limit: 10 })) as Array<{ id: string }>;
		const messages = (await service.execute("artifact.query", { kind: "doc", subtype: "context-message", limit: 10 })) as Array<{ id: string; extra: Record<string, unknown> }>;
		expect(threads).toHaveLength(1);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.extra).toMatchObject({ storeId: STORE_ID, postId: "post-1", sequence: 1 });
		const tree = (await service.execute("artifact.show", { id: threads[0]?.id, tree: true })) as { edges: Array<{ from: string; relation: string; to: string }> };
		expect(tree.edges).toEqual(expect.arrayContaining([
			{ from: threads[0]?.id, relation: "contains", to: messages[0]?.id },
			{ from: messages[0]?.id, relation: "part_of", to: threads[0]?.id },
		]));
		service.close();
	});

	it("verifies discusses links and enforces same-thread replies atomically", async () => {
		const service = fixture();
		const target = (await service.execute("docs.create", { title: "Reviewed design" })) as { id: string };
		await store(service, "append", {
			command: command("root", { references: [{ kind: "doc", id: target.id }] }),
			post_id: "root-post", timestamp: 1, event_retention: 10,
		});
		await store(service, "append", {
			command: command("reply", { replyToPostId: "root-post" }),
			post_id: "reply-post", timestamp: 2, event_retention: 10,
		});
		const messages = (await service.execute("artifact.query", { kind: "doc", subtype: "context-message", limit: 10 })) as Array<{ id: string; extra: Record<string, unknown> }>;
		const root = messages.find((artifact) => artifact.extra.postId === "root-post");
		const reply = messages.find((artifact) => artifact.extra.postId === "reply-post");
		const graph = (await service.execute("artifact.show", { id: reply?.id, tree: true })) as { edges: Array<{ from: string; relation: string; to: string }> };
		expect(graph.edges).toEqual(expect.arrayContaining([
			{ from: root?.id, relation: "discusses", to: target.id },
			{ from: reply?.id, relation: "reply_to", to: root?.id },
		]));
		await expect(store(service, "append", {
			command: command("cross-thread", { threadId: "other", replyToPostId: "root-post" }),
			post_id: "bad-reply", timestamp: 3, event_retention: 10,
		})).rejects.toThrow("same thread");
		await expect(store(service, "append", {
			command: command("missing-reference", { references: [{ kind: "task", id: "missing" }] }),
			post_id: "bad-reference", timestamp: 4, event_retention: 10,
		})).rejects.toThrow("not verified");
		expect((await service.execute("artifact.query", { kind: "doc", subtype: "context-message", limit: 10 }) as unknown[])).toHaveLength(2);
		service.close();
	});

	it("serves bounded sequence reads, replay, session cursors, and projection checkpoints", async () => {
		const service = fixture();
		for (let index = 0; index < 3; index += 1) {
			await store(service, "append", {
				command: command(`operation-${index}`), post_id: `post-${index}`, timestamp: index + 1, event_retention: 4,
			});
		}
		const first = (await store(service, "read_thread", { ...address, limit: 2 })) as { items: unknown[]; truncated: boolean; nextSequence: number };
		expect(first).toMatchObject({ truncated: true, nextSequence: 3 });
		expect(first.items).toHaveLength(2);
		const replay = (await store(service, "replay", { after_sequence: 0, limit: 2 })) as { events: unknown[]; expired: boolean; truncated: boolean };
		expect(replay).toMatchObject({ expired: false, truncated: true });
		expect(replay.events).toHaveLength(2);
		expect(await store(service, "acknowledge", { consumer_id: "session-1", sequence: 6 })).toBe(6);
		expect(await store(service, "consumer_cursor", { consumer_id: "session-1" })).toBe(6);
		const outbox = (await store(service, "read_projection_outbox", { projection_id: "archive", limit: 2 })) as unknown[];
		expect(outbox).toHaveLength(2);
		await store(service, "acknowledge_projection", { projection_id: "archive", sequence: 3 });
		expect(await store(service, "projection_checkpoint", { projection_id: "archive" })).toBe(3);
		expect(await store(service, "projection_pending", { projection_id: "archive" })).toBe(1);
		service.close();
	});

	it("supports topic, thread, question, snapshot, and replay-gap projections", async () => {
		const service = fixture();
		await store(service, "append", {
			command: command("question", { content: { type: "question", responseId: "q-1", targetId: "reviewer", text: "Why?" } }),
			post_id: "question-post", timestamp: 10, event_retention: 4,
		});
		expect(await store(service, "open_questions", { forumId: "engineering", targetId: "reviewer", limit: 10 })).toEqual(expect.objectContaining({
			items: [expect.objectContaining({ responseId: "q-1" })], completeness: "complete",
		}));
		await store(service, "append", {
			command: command("answer", { content: { type: "answer", responseId: "q-1", text: "Because" } }),
			post_id: "answer-post", timestamp: 11, event_retention: 4,
		});
		expect(await store(service, "open_questions", { forumId: "engineering", targetId: "reviewer", limit: 10 })).toEqual(expect.objectContaining({ items: [] }));
		expect(await store(service, "list_topics", { forumId: "engineering", limit: 10 })).toEqual(expect.objectContaining({
			items: [expect.objectContaining({ topicId: "reviews", postCount: 2, threadCount: 1 })],
		}));
		expect(await store(service, "list_threads", { forumId: "engineering", topicId: "reviews", limit: 10 })).toEqual(expect.objectContaining({
			items: [expect.objectContaining({ threadId: "context-mesh", postCount: 2, participantIds: ["agent-a"] })],
		}));
		expect(await store(service, "snapshot", { forumId: "engineering", limit: 1 })).toEqual(expect.objectContaining({
			posts: expect.objectContaining({ truncated: true, items: [expect.objectContaining({ id: "question-post" })] }),
			throughSequence: 6,
		}));
		expect(await store(service, "replay", { after_sequence: 1, limit: 10 })).toEqual(expect.objectContaining({ expired: true, events: [] }));
		service.close();
	});

	it("allocates monotonic post sequences and rejects unsafe bounds or payloads", async () => {
		const service = fixture();
		const writes = await Promise.all(Array.from({ length: 20 }, (_, index) => store(service, "append", {
			command: command(`concurrent-${index}`), post_id: `concurrent-post-${index}`, timestamp: index, event_retention: 100,
		}) as Promise<{ post: { sequence: number } }>));
		const sequences = writes.map((result) => result.post.sequence);
		expect(new Set(sequences).size).toBe(20);
		expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index * 2 + 1));
		await expect(store(service, "read_thread", { ...address, limit: 101 })).rejects.toThrow("limit");
		await expect(store(service, "append", {
			command: command("oversized", { content: "x".repeat(70_000) }), post_id: "oversized", timestamp: 1,
		})).rejects.toThrow("cannot exceed");
		await expect(store(service, "acknowledge", { consumer_id: "session", sequence: 1_000 })).rejects.toThrow("future sequence");
		service.close();
	});

	it("enforces extension-table subtype integrity inside SQLite", () => {
		const directory = mkdtempSync(join(tmpdir(), "papyrus-discourse-integrity-"));
		const db = openDb(join(directory, "papyrus.db"));
		const ordinary = new SQLiteArtifactStore(db).create({ kind: "doc", title: "Ordinary" });
		expect(() => db.prepare("INSERT INTO discourse_threads (store_id, forum_id, topic_id, thread_id, artifact_id) VALUES (?, ?, ?, ?, ?)")
			.run("store", "forum", "topic", "thread", ordinary.id)).toThrow("context-thread");
		expect(() => db.prepare("INSERT INTO discourse_posts (store_id, sequence, id, artifact_id, operation_id, command_json, forum_id, topic_id, thread_id, author_id, content_json, timestamp, references_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run("store", 1, "post", ordinary.id, "operation", "{}", "forum", "topic", "thread", "author", '"body"', 1, "[]"))
			.toThrow("context-message");
		db.close();
	});

	it("prohibits generic mutation of forum-owned subtypes and relations", async () => {
		const service = fixture();
		await expect(service.execute("docs.create", { title: "Bypass", subtype: "context-message" })).rejects.toThrow("discourse.store");
		await expect(service.execute("artifact.create", { kind: "doc", title: "Bypass", subtype: "context-thread" })).rejects.toThrow("discourse.store");
		const template = (await service.execute("skills.create_template", {
			title: "Forum bypass", target_kind: "doc", defaults: { title: "Bypass", subtype: "context-message" },
		})) as { id: string };
		await expect(service.execute("artifact.create", { template_id: template.id })).rejects.toThrow("discourse.store");
		await expect(service.execute("skills.instantiate", { template_id: template.id })).rejects.toThrow("discourse.store");
		const left = (await service.execute("docs.create", { title: "Left" })) as { id: string };
		const right = (await service.execute("docs.create", { title: "Right" })) as { id: string };
		await expect(service.execute("graph.link", { from: left.id, relation: "reply_to", to: right.id })).rejects.toThrow("discourse.store");
		service.close();
	});
});
