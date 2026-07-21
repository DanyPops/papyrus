/**
 * domain/conversation-journal.ts — host-neutral ConversationJournal domain.
 *
 * See decision-discourse-as-a-layer-above-sessions-separate-conver-p832 and
 * pis-tree-implementation-concrete-lessons-for-the-discourse-s-wnrs (Papyrus docs) for the
 * design this implements and the concrete lessons behind each choice below.
 *
 * A Thread is the conversation's own stable identity, independent of whichever host
 * process/session recorded any given Post into it. This module and its package source
 * must never mention host runtime names (no "Pi") -- sourceSessionId is a generic
 * provenance field on a Post, not a host-specific concept, and the host decides what
 * value to put there.
 */

export const CONVERSATION_JOURNAL_CONTENT_MAX_CHARACTERS = 20_000;
export const CONVERSATION_JOURNAL_SOURCE_ID_MAX_LENGTH = 256;
export const CONVERSATION_JOURNAL_MAX_REFERENCES_PER_POST = 50;
/** Bounds a single readThread call; retention/eviction beyond this is a host/persistence concern, not this domain's. */
export const CONVERSATION_JOURNAL_READ_MAX_POSTS = 500;
/** Bounds reply-chain traversal so a cycle (accidental or adversarial) cannot infinite-loop a tree build -- see the Pi /tree lessons doc for why this must not be assumed away. */
export const CONVERSATION_JOURNAL_MAX_TRAVERSAL_DEPTH = 10_000;

export type JournalAuthor = "human" | "agent";

/** A reference to an artifact owned outside this journal -- verified by the host, never asserted. */
export interface ArtifactReference {
	readonly kind: string;
	readonly id: string;
}

export interface JournalThread {
	readonly id: string;
	readonly createdAt: string;
}

export interface JournalPost {
	readonly id: string;
	readonly threadId: string;
	/** Absent only for a thread's first post. */
	readonly replyToPostId?: string;
	readonly authorId: JournalAuthor;
	readonly content: string;
	/** True when content was cut to CONVERSATION_JOURNAL_CONTENT_MAX_CHARACTERS -- never silently. */
	readonly truncated: boolean;
	readonly timestamp: string;
	/** Which host session/process recorded this post. Provenance, never this domain's top-level container -- see the layering decision doc. */
	readonly sourceSessionId: string;
	/**
	 * Idempotency key. Must be a composite of (sourceSessionId, a host-local entry id),
	 * constructed by the caller -- never a bare host entry id alone. A host's own entry
	 * ids are commonly unique only within one recording session, not globally; using one
	 * alone as a global idempotency key risks a false dedup collision between two
	 * unrelated sessions. See the Pi /tree lessons doc for the concrete case this
	 * generalizes from.
	 */
	readonly operationId: string;
	readonly references: readonly ArtifactReference[];
}

export interface AppendPostCommand {
	readonly threadId: string;
	readonly replyToPostId?: string;
	readonly authorId: JournalAuthor;
	readonly content: string;
	readonly sourceSessionId: string;
	readonly operationId: string;
	readonly references?: readonly ArtifactReference[];
}

export interface AppendPostResult {
	readonly post: JournalPost;
	/** True when this exact operationId was already journaled and this call was a safe no-op replay. */
	readonly replayed: boolean;
}

export interface ReadThreadQuery {
	readonly threadId: string;
	readonly limit: number;
}

export interface ThreadPage {
	readonly posts: readonly JournalPost[];
	/** True when more posts exist beyond `limit` -- never silently drop the tail without saying so. */
	readonly truncated: boolean;
}

/** One node of a reconstructed reply tree; see buildThreadTree. */
export interface ThreadTreeNode {
	readonly post: JournalPost;
	readonly children: ThreadTreeNode[];
}

function requireBounded(value: string, label: string, maxLength: number): string {
	if (value.length === 0) throw new Error(`${label} is required`);
	if (value.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
	return value;
}

export function validateAppendPostCommand(command: AppendPostCommand): void {
	requireBounded(command.threadId, "threadId", CONVERSATION_JOURNAL_SOURCE_ID_MAX_LENGTH);
	requireBounded(command.sourceSessionId, "sourceSessionId", CONVERSATION_JOURNAL_SOURCE_ID_MAX_LENGTH);
	requireBounded(command.operationId, "operationId", CONVERSATION_JOURNAL_SOURCE_ID_MAX_LENGTH * 2);
	if (command.content.length === 0) throw new Error("content is required");
	if (command.authorId !== "human" && command.authorId !== "agent") throw new Error('authorId must be "human" or "agent"');
	const references = command.references ?? [];
	if (references.length > CONVERSATION_JOURNAL_MAX_REFERENCES_PER_POST) {
		throw new Error(`a post is bounded to ${CONVERSATION_JOURNAL_MAX_REFERENCES_PER_POST} references; got ${references.length}`);
	}
}

/** Applies the explicit truncation bound. Never silently drops the truncation fact -- callers must surface `truncated`. */
export function boundContent(content: string): { content: string; truncated: boolean } {
	if (content.length <= CONVERSATION_JOURNAL_CONTENT_MAX_CHARACTERS) return { content, truncated: false };
	return { content: content.slice(0, CONVERSATION_JOURNAL_CONTENT_MAX_CHARACTERS), truncated: true };
}

/**
 * Reconstructs the reply tree from a flat list of posts (as returned by one bounded
 * readThread call). A post whose replyToPostId does not resolve within this same list --
 * because it is genuinely a thread root, or because an ancestor aged out under a
 * retention policy -- degrades to being treated as a root of its own sub-tree, exactly
 * like Pi's own getTree() treats an orphaned entry. This never throws on that account.
 *
 * Bounded and cycle-safe: a post already visited while walking up cannot be revisited,
 * so a malformed or adversarial replyToPostId cycle cannot infinite-loop this function --
 * see the Pi /tree lessons doc for why that guard must be explicit, not assumed.
 */
export function buildThreadTree(posts: readonly JournalPost[]): ThreadTreeNode[] {
	const nodesById = new Map<string, ThreadTreeNode>();
	for (const post of posts) nodesById.set(post.id, { post, children: [] });

	const roots: ThreadTreeNode[] = [];
	for (const post of posts) {
		const node = nodesById.get(post.id)!;
		const parent = post.replyToPostId ? nodesById.get(post.replyToPostId) : undefined;
		if (parent) parent.children.push(node);
		else roots.push(node);
	}

	for (const node of nodesById.values()) {
		node.children.sort((left, right) => left.post.timestamp.localeCompare(right.post.timestamp) || left.post.id.localeCompare(right.post.id));
	}
	roots.sort((left, right) => left.post.timestamp.localeCompare(right.post.timestamp) || left.post.id.localeCompare(right.post.id));
	return roots;
}

/**
 * Walks from a post back toward its thread root via replyToPostId, root-first order --
 * the host-neutral equivalent of Pi's getBranch(). Bounded by
 * CONVERSATION_JOURNAL_MAX_TRAVERSAL_DEPTH and tracks visited ids explicitly so a cycle
 * cannot infinite-loop this walk, unlike Pi's own getBranch() (a documented gap in Pi,
 * not something to assume away here).
 */
export function ancestorChain(postId: string, postsById: ReadonlyMap<string, JournalPost>): JournalPost[] {
	const chain: JournalPost[] = [];
	const visited = new Set<string>();
	let currentId: string | undefined = postId;
	while (currentId !== undefined) {
		if (visited.has(currentId)) break; // cycle guard
		if (chain.length >= CONVERSATION_JOURNAL_MAX_TRAVERSAL_DEPTH) break; // depth guard
		visited.add(currentId);
		const post = postsById.get(currentId);
		if (!post) break; // orphan: stop here, do not error
		chain.push(post);
		currentId = post.replyToPostId;
	}
	return chain.reverse();
}
