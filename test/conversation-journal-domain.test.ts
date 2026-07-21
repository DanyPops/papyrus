import { describe, expect, it } from "bun:test";
import { ancestorChain, buildThreadTree, CONVERSATION_JOURNAL_MAX_TRAVERSAL_DEPTH, type JournalPost } from "../src/domain/conversation-journal.ts";

function post(overrides: Partial<JournalPost>): JournalPost {
	return {
		id: "post-1", threadId: "thread-1", authorId: "human", content: "x", truncated: false,
		timestamp: "2026-01-01T00:00:00.000Z", sourceSessionId: "session-a", operationId: "op-1", references: [],
		...overrides,
	};
}

describe("buildThreadTree: orphan resilience, matching Pi's getTree()", () => {
	it("treats a post whose replyToPostId does not resolve within the given list as its own root, never throwing", () => {
		const orphan = post({ id: "p2", replyToPostId: "not-in-this-page" });
		const tree = buildThreadTree([orphan]);
		expect(tree).toHaveLength(1);
		expect(tree[0]!.post.id).toBe("p2");
		expect(tree[0]!.children).toEqual([]);
	});

	it("sorts multiple children of the same branch point chronologically", () => {
		const root = post({ id: "root" });
		const later = post({ id: "later", replyToPostId: "root", timestamp: "2026-01-01T00:02:00.000Z" });
		const earlier = post({ id: "earlier", replyToPostId: "root", timestamp: "2026-01-01T00:01:00.000Z" });
		const tree = buildThreadTree([root, later, earlier]);
		expect(tree[0]!.children.map((node) => node.post.id)).toEqual(["earlier", "later"]);
	});

	it("does not infinite-loop on a malformed cycle -- unlike Pi's own getBranch(), which has no such guard", () => {
		const a = post({ id: "a", replyToPostId: "b" });
		const b = post({ id: "b", replyToPostId: "a" });
		// buildThreadTree only looks at direct parent/child relationships from the given list,
		// so a 2-cycle simply yields two nodes each pointing at the other as parent -- it must
		// terminate, not throw, and not loop.
		const tree = buildThreadTree([a, b]);
		expect(tree.length + tree.reduce((sum, node) => sum + node.children.length, 0)).toBeLessThanOrEqual(2);
	});
});

describe("ancestorChain: cycle-safe and depth-bounded, the host-neutral equivalent of Pi's getBranch()", () => {
	it("returns the root-first chain for a normal reply sequence", () => {
		const root = post({ id: "root" });
		const middle = post({ id: "middle", replyToPostId: "root" });
		const leaf = post({ id: "leaf", replyToPostId: "middle" });
		const byId = new Map([[root.id, root], [middle.id, middle], [leaf.id, leaf]]);
		expect(ancestorChain("leaf", byId).map((p) => p.id)).toEqual(["root", "middle", "leaf"]);
	});

	it("stops at an unresolvable replyToPostId instead of throwing (an aged-out ancestor under retention)", () => {
		const leaf = post({ id: "leaf", replyToPostId: "aged-out-ancestor" });
		const byId = new Map([[leaf.id, leaf]]);
		expect(ancestorChain("leaf", byId)).toEqual([leaf]);
	});

	it("terminates on a malformed cycle instead of looping forever", () => {
		const a = post({ id: "a", replyToPostId: "b" });
		const b = post({ id: "b", replyToPostId: "a" });
		const byId = new Map([[a.id, a], [b.id, b]]);
		const chain = ancestorChain("a", byId);
		expect(chain.length).toBeLessThanOrEqual(2);
	});

	it("is bounded by CONVERSATION_JOURNAL_MAX_TRAVERSAL_DEPTH even on a long, non-cyclic chain", () => {
		const byId = new Map<string, JournalPost>();
		const depth = CONVERSATION_JOURNAL_MAX_TRAVERSAL_DEPTH + 50;
		for (let index = 0; index < depth; index++) {
			byId.set(`p${index}`, post({ id: `p${index}`, replyToPostId: index === 0 ? undefined : `p${index - 1}` }));
		}
		const chain = ancestorChain(`p${depth - 1}`, byId);
		expect(chain.length).toBeLessThanOrEqual(CONVERSATION_JOURNAL_MAX_TRAVERSAL_DEPTH);
	});
});
