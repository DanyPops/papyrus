import type { JournalPost, JournalThread } from "../domain/conversation-journal.ts";

/**
 * Persistence port for ConversationJournal. Deliberately minimal and host-neutral: no
 * mention of any host runtime, no query beyond what a bounded thread read needs. Idempotency
 * (checking operationId before insert) is the service's job, not the store's -- this port is
 * dumb storage, matching Discourse's own store/service split (see the layering decision doc).
 */
export interface ConversationJournalStore {
	ensureThread(threadId: string): JournalThread;
	getThread(threadId: string): JournalThread | undefined;
	findPostByOperationId(operationId: string): JournalPost | undefined;
	insertPost(post: JournalPost): void;
	getPost(id: string): JournalPost | undefined;
	/** All posts for one thread, unbounded at the store layer -- the service applies the read bound. */
	postsForThread(threadId: string): readonly JournalPost[];
}
