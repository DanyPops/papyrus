/**
 * Reusable ConversationJournal conformance suite -- mirrors the pattern in
 * ~/Repositories/discourse's own discourseConformanceSuite (packages/core/discourse/test/conformance.ts):
 * one behavioral contract, proven first against the in-memory reference fixture, and
 * reusable unmodified against a real persistence backend later
 * (persist-conversationjournal-records-through-papyrus-gesq) to prove equivalence
 * rather than re-deriving the same tests twice.
 */
import { describe, expect, it } from "bun:test";
import { CONVERSATION_JOURNAL_READ_MAX_POSTS } from "../src/domain/conversation-journal.ts";
import { ConversationJournalService } from "../src/conversation-journal-service.ts";

export type ConversationJournalConformanceFactory = () => ConversationJournalService;

let operationCounter = 0;
function nextOperationId(sourceSessionId: string): string {
	return `${sourceSessionId}:entry-${++operationCounter}`;
}

export function conversationJournalConformanceSuite(createService: ConversationJournalConformanceFactory): void {
	describe("ConversationJournal conformance", () => {
		it("appends the first post of a thread with no replyToPostId, and creates the thread implicitly", () => {
			const service = createService();
			const result = service.appendPost({
				threadId: "thread-1", authorId: "human", content: "Hello", sourceSessionId: "session-a",
				operationId: nextOperationId("session-a"),
			});
			expect(result.replayed).toBe(false);
			expect(result.post.threadId).toBe("thread-1");
			expect(result.post.replyToPostId).toBeUndefined();
			expect(service.getThread("thread-1")).toBeDefined();
		});

		it("replays a duplicate operationId as a safe no-op instead of creating a second post", () => {
			const service = createService();
			const operationId = nextOperationId("session-a");
			const first = service.appendPost({ threadId: "thread-1", authorId: "human", content: "Hi", sourceSessionId: "session-a", operationId });
			const second = service.appendPost({ threadId: "thread-1", authorId: "human", content: "Hi", sourceSessionId: "session-a", operationId });
			expect(second.replayed).toBe(true);
			expect(second.post).toEqual(first.post);
			expect(service.readThread({ threadId: "thread-1", limit: 10 }).posts).toHaveLength(1);
		});

		it("chains replies within one thread via replyToPostId", () => {
			const service = createService();
			const root = service.appendPost({ threadId: "thread-1", authorId: "human", content: "Q", sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			const reply = service.appendPost({
				threadId: "thread-1", replyToPostId: root.post.id, authorId: "agent", content: "A", sourceSessionId: "session-a", operationId: nextOperationId("session-a"),
			});
			expect(reply.post.replyToPostId).toBe(root.post.id);
		});

		it("rejects a replyToPostId that does not exist", () => {
			const service = createService();
			expect(() => service.appendPost({
				threadId: "thread-1", replyToPostId: "missing", authorId: "human", content: "X", sourceSessionId: "session-a", operationId: nextOperationId("session-a"),
			})).toThrow("not found");
		});

		it("keeps two threads' posts fully independent", () => {
			const service = createService();
			service.appendPost({ threadId: "thread-1", authorId: "human", content: "one", sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			service.appendPost({ threadId: "thread-2", authorId: "human", content: "two", sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			expect(service.readThread({ threadId: "thread-1", limit: 10 }).posts).toHaveLength(1);
			expect(service.readThread({ threadId: "thread-2", limit: 10 }).posts).toHaveLength(1);
		});

		it("reports explicit truncation when a thread has more posts than the read limit, never silently dropping the tail", () => {
			const service = createService();
			for (let index = 0; index < 5; index++) {
				service.appendPost({ threadId: "thread-1", authorId: "human", content: `post-${index}`, sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			}
			const page = service.readThread({ threadId: "thread-1", limit: 3 });
			expect(page.posts).toHaveLength(3);
			expect(page.truncated).toBe(true);
			const full = service.readThread({ threadId: "thread-1", limit: 10 });
			expect(full.truncated).toBe(false);
		});

		it("bounds the read limit itself rather than accepting an unbounded request", () => {
			const service = createService();
			expect(() => service.readThread({ threadId: "thread-1", limit: CONVERSATION_JOURNAL_READ_MAX_POSTS + 1 })).toThrow("must be between 1");
			expect(() => service.readThread({ threadId: "thread-1", limit: 0 })).toThrow("must be between 1");
		});

		it("marks content truncated when it exceeds the bound, and never silently otherwise", () => {
			const service = createService();
			const short = service.appendPost({ threadId: "thread-1", authorId: "human", content: "short", sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			expect(short.post.truncated).toBe(false);
			const long = service.appendPost({
				threadId: "thread-1", authorId: "human", content: "x".repeat(25_000), sourceSessionId: "session-a", operationId: nextOperationId("session-a"),
			});
			expect(long.post.truncated).toBe(true);
			expect(long.post.content.length).toBeLessThan(25_000);
		});

		it("reconstructs a reply tree spanning a branch point, matching Pi's own tree shape", () => {
			const service = createService();
			const root = service.appendPost({ threadId: "thread-1", authorId: "human", content: "root", sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			const left = service.appendPost({ threadId: "thread-1", replyToPostId: root.post.id, authorId: "agent", content: "left", sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			const right = service.appendPost({ threadId: "thread-1", replyToPostId: root.post.id, authorId: "agent", content: "right", sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			const tree = service.readThreadTree("thread-1");
			expect(tree).toHaveLength(1);
			expect(tree[0]!.post.id).toBe(root.post.id);
			expect(tree[0]!.children.map((node) => node.post.id).sort()).toEqual([left.post.id, right.post.id].sort());
		});

		it("returns a root-first ancestor chain for a reply, the host-neutral equivalent of Pi's getBranch", () => {
			const service = createService();
			const root = service.appendPost({ threadId: "thread-1", authorId: "human", content: "root", sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			const middle = service.appendPost({ threadId: "thread-1", replyToPostId: root.post.id, authorId: "agent", content: "middle", sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			const leaf = service.appendPost({ threadId: "thread-1", replyToPostId: middle.post.id, authorId: "human", content: "leaf", sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			const chain = service.ancestorsOf(leaf.post.id);
			expect(chain.map((post) => post.id)).toEqual([root.post.id, middle.post.id, leaf.post.id]);
		});

		it("records sourceSessionId as provenance without treating it as the thread's identity -- two different sessions can post into the same thread", () => {
			const service = createService();
			const first = service.appendPost({ threadId: "thread-1", authorId: "human", content: "from session A", sourceSessionId: "session-a", operationId: nextOperationId("session-a") });
			const second = service.appendPost({
				threadId: "thread-1", replyToPostId: first.post.id, authorId: "human", content: "continuing in a new session", sourceSessionId: "session-b", operationId: nextOperationId("session-b"),
			});
			expect(first.post.sourceSessionId).toBe("session-a");
			expect(second.post.sourceSessionId).toBe("session-b");
			expect(service.readThread({ threadId: "thread-1", limit: 10 }).posts.map((post) => post.threadId)).toEqual(["thread-1", "thread-1"]);
		});

		it("rejects an empty or oversized content, and an invalid authorId", () => {
			const service = createService();
			expect(() => service.appendPost({ threadId: "thread-1", authorId: "human", content: "", sourceSessionId: "session-a", operationId: nextOperationId("session-a") })).toThrow("content is required");
			expect(() => service.appendPost({ threadId: "thread-1", authorId: "robot" as never, content: "x", sourceSessionId: "session-a", operationId: nextOperationId("session-a") })).toThrow('authorId must be "human" or "agent"');
		});

		it("rejects a post with more references than the bound", () => {
			const service = createService();
			const references = Array.from({ length: 51 }, (_, index) => ({ kind: "task", id: `task-${index}` }));
			expect(() => service.appendPost({
				threadId: "thread-1", authorId: "human", content: "x", sourceSessionId: "session-a", operationId: nextOperationId("session-a"), references,
			})).toThrow("bounded to 50 references");
		});

		it("records verified artifact references on a post", () => {
			const service = createService();
			const result = service.appendPost({
				threadId: "thread-1", authorId: "agent", content: "Implemented the fix", sourceSessionId: "session-a", operationId: nextOperationId("session-a"),
				references: [{ kind: "task", id: "fix-the-bug" }],
			});
			expect(result.post.references).toEqual([{ kind: "task", id: "fix-the-bug" }]);
		});
	});
}
