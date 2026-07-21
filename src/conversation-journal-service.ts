/**
 * conversation-journal-service.ts — host-neutral ConversationJournal application layer.
 *
 * Owns idempotency (checking operationId before insert) and bounds enforcement; the
 * ConversationJournalStore port underneath is dumb storage. See
 * src/domain/conversation-journal.ts for the domain shapes and the design rationale.
 */
import {
	ancestorChain,
	boundContent,
	buildThreadTree,
	CONVERSATION_JOURNAL_READ_MAX_POSTS,
	validateAppendPostCommand,
	type AppendPostCommand,
	type AppendPostResult,
	type JournalPost,
	type JournalThread,
	type ReadThreadQuery,
	type ThreadPage,
	type ThreadTreeNode,
} from "./domain/conversation-journal.ts";
import type { ConversationJournalStore } from "./ports/conversation-journal-store.ts";

export class ConversationJournalService {
	constructor(private readonly store: ConversationJournalStore) {}

	appendPost(command: AppendPostCommand): AppendPostResult {
		validateAppendPostCommand(command);

		const existing = this.store.findPostByOperationId(command.operationId);
		if (existing) return { post: existing, replayed: true };

		if (command.replyToPostId !== undefined && !this.store.getPost(command.replyToPostId)) {
			throw new Error(`replyToPostId "${command.replyToPostId}" not found`);
		}

		this.store.ensureThread(command.threadId);
		const { content, truncated } = boundContent(command.content);
		const post: JournalPost = {
			id: crypto.randomUUID(),
			threadId: command.threadId,
			...(command.replyToPostId !== undefined ? { replyToPostId: command.replyToPostId } : {}),
			authorId: command.authorId,
			content,
			truncated,
			timestamp: new Date().toISOString(),
			sourceSessionId: command.sourceSessionId,
			operationId: command.operationId,
			references: command.references ? [...command.references] : [],
		};
		this.store.insertPost(post);
		return { post, replayed: false };
	}

	getThread(threadId: string): JournalThread | undefined {
		return this.store.getThread(threadId);
	}

	getPost(id: string): JournalPost | undefined {
		return this.store.getPost(id);
	}

	/** Bounded, explicit-completeness thread read. Never silently drops posts past the bound. */
	readThread(query: ReadThreadQuery): ThreadPage {
		const limit = query.limit;
		if (!Number.isInteger(limit) || limit < 1 || limit > CONVERSATION_JOURNAL_READ_MAX_POSTS) {
			throw new Error(`readThread limit must be between 1 and ${CONVERSATION_JOURNAL_READ_MAX_POSTS}`);
		}
		const all = [...this.store.postsForThread(query.threadId)].sort(
			(left, right) => left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id),
		);
		const truncated = all.length > limit;
		return { posts: all.slice(0, limit), truncated };
	}

	/** Reconstructed reply tree for a thread, bounded and orphan/cycle-safe -- see buildThreadTree. */
	readThreadTree(threadId: string): ThreadTreeNode[] {
		return buildThreadTree(this.store.postsForThread(threadId));
	}

	/** Root-first ancestor chain for one post -- the host-neutral equivalent of Pi's getBranch(). */
	ancestorsOf(postId: string): JournalPost[] {
		const posts = this.store.postsForThread(this.store.getPost(postId)?.threadId ?? "");
		const byId = new Map(posts.map((post) => [post.id, post]));
		return ancestorChain(postId, byId);
	}
}
