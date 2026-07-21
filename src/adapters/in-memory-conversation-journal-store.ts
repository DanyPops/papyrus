import type { JournalPost, JournalThread } from "../domain/conversation-journal.ts";
import type { ConversationJournalStore } from "../ports/conversation-journal-store.ts";

/**
 * Bounded in-memory conformance fixture -- the reference implementation the
 * conversationJournalConformanceSuite is proven against first, before any real
 * persistence backend needs to satisfy the same contract.
 */
export class InMemoryConversationJournalStore implements ConversationJournalStore {
	private readonly threads = new Map<string, JournalThread>();
	private readonly posts = new Map<string, JournalPost>();
	private readonly postIdsByOperationId = new Map<string, string>();
	private readonly postIdsByThread = new Map<string, string[]>();

	ensureThread(threadId: string): JournalThread {
		const existing = this.threads.get(threadId);
		if (existing) return existing;
		const thread: JournalThread = { id: threadId, createdAt: new Date().toISOString() };
		this.threads.set(threadId, thread);
		return thread;
	}

	getThread(threadId: string): JournalThread | undefined {
		return this.threads.get(threadId);
	}

	findPostByOperationId(operationId: string): JournalPost | undefined {
		const postId = this.postIdsByOperationId.get(operationId);
		return postId ? this.posts.get(postId) : undefined;
	}

	insertPost(post: JournalPost): void {
		this.posts.set(post.id, post);
		this.postIdsByOperationId.set(post.operationId, post.id);
		const ids = this.postIdsByThread.get(post.threadId) ?? [];
		ids.push(post.id);
		this.postIdsByThread.set(post.threadId, ids);
	}

	getPost(id: string): JournalPost | undefined {
		return this.posts.get(id);
	}

	postsForThread(threadId: string): readonly JournalPost[] {
		const ids = this.postIdsByThread.get(threadId) ?? [];
		return ids.map((id) => this.posts.get(id)!);
	}
}
