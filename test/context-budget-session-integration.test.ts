import { describe, expect, it } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildMessageHistoryTree } from "../extension/src/context-budget.ts";
import { CONTEXT_TREE_MAX_NODES } from "../src/constants.ts";

/**
 * Integration tests against the REAL @earendil-works/pi-coding-agent SessionManager, not
 * hand-rolled SessionEntryLike/SessionTreeNodeLike fixtures. This is exactly how a real bug
 * was found: a production session with 6,924 entries on its own active branch showed
 * "Unaccounted — 850,078 tok (95.3%)", traced to CONTEXT_TREE_MAX_NODES (2000 at the time)
 * silently truncating buildMessageHistoryTree's walk after counting well under 4% of the
 * real conversation. Hand-rolled fixtures never exercised a tree anywhere near that size, so
 * they never caught it. These tests exercise the real getTree()/getBranch() shape and real
 * scale to close that gap.
 */

function longText(seed: string, length: number): string {
	return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

describe("buildMessageHistoryTree against a real SessionManager", () => {
	it("matches the real tree/branch shape SessionManager actually produces (not an assumed one)", () => {
		const sm = SessionManager.inMemory();
		sm.appendMessage({ role: "user", content: longText("x", 40), timestamp: Date.now() });
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: longText("y", 40) }],
			api: "test", provider: "test", model: "test",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		});

		const tree = sm.getTree();
		const branch = sm.getBranch();
		const activeIds = new Set(branch.map((entry) => entry.id));
		const result = buildMessageHistoryTree(tree as never, activeIds);

		expect(result.truncated).toBe(false);
		expect(result.activeTokens).toBe(Math.ceil(80 / 4)); // both messages, real char-count-derived estimate
		expect(result.items).toHaveLength(1); // one root, one linear chain
	});

	it("REGRESSION: a realistic long-running session (thousands of entries) is not truncated by an unrealistically small node bound", () => {
		const sm = SessionManager.inMemory();
		// 7,000 alternating user/assistant messages -- deliberately exceeding the OLD
		// CONTEXT_TREE_MAX_NODES=2000 bound that caused the real production bug, to prove the
		// current bound (50,000) does not repeat it. Each message carries real, sizeable text
		// so a truncated walk would produce a activeTokens number far below the real total.
		const messageCount = 7000;
		for (let index = 0; index < messageCount; index++) {
			if (index % 2 === 0) {
				sm.appendMessage({ role: "user", content: longText("u", 20), timestamp: Date.now() });
			} else {
				sm.appendMessage({
					role: "assistant", content: [{ type: "text", text: longText("a", 20) }],
					api: "test", provider: "test", model: "test",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop", timestamp: Date.now(),
				});
			}
		}

		const tree = sm.getTree();
		const branch = sm.getBranch();
		expect(branch.length).toBe(messageCount); // confirms the real API actually produced the scale this test claims
		const activeIds = new Set(branch.map((entry) => entry.id));
		const result = buildMessageHistoryTree(tree as never, activeIds);

		expect(result.truncated).toBe(false);
		const expectedTokens = Math.ceil((messageCount * 20) / 4);
		expect(result.activeTokens).toBe(expectedTokens); // the FULL conversation, not a truncated fraction of it
	}, 20_000);

	it("reports truncated when a session genuinely exceeds CONTEXT_TREE_MAX_NODES, rather than silently under-counting without any signal", () => {
		const sm = SessionManager.inMemory();
		const messageCount = CONTEXT_TREE_MAX_NODES + 50;
		for (let index = 0; index < messageCount; index++) {
			sm.appendMessage({ role: "user", content: "x", timestamp: Date.now() });
		}
		const tree = sm.getTree();
		const activeIds = new Set(sm.getBranch().map((entry) => entry.id));
		const result = buildMessageHistoryTree(tree as never, activeIds);
		expect(result.truncated).toBe(true);
	}, 30_000);

	it("labels a real /tree branch (created via SessionManager.branch) as inactive and excludes it from activeTokens", () => {
		const sm = SessionManager.inMemory();
		const rootId = sm.appendMessage({ role: "user", content: longText("root", 40), timestamp: Date.now() });
		sm.appendMessage({
			role: "assistant", content: [{ type: "text", text: longText("first-attempt", 100) }],
			api: "test", provider: "test", model: "test",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		});
		// Real /tree usage: move the leaf back to root and diverge onto a second branch --
		// the first attempt becomes an abandoned branch, still in the tree, no longer active.
		sm.branch(rootId);
		sm.appendMessage({
			role: "assistant", content: [{ type: "text", text: longText("second-attempt", 40) }],
			api: "test", provider: "test", model: "test",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		});

		const tree = sm.getTree();
		const activeIds = new Set(sm.getBranch().map((entry) => entry.id)); // only the SECOND attempt is on the current active path
		const result = buildMessageHistoryTree(tree as never, activeIds);

		const root = result.items[0]!;
		expect(root.children).toHaveLength(2); // both branches are real children of root in the tree
		const abandoned = root.children!.find((child) => child.label.includes("inactive branch"))!;
		const active = root.children!.find((child) => !child.label.includes("inactive branch"))!;
		expect(abandoned.estimatedTokens).toBe(Math.ceil(100 / 4)); // the abandoned branch's real cost is still shown
		expect(active.estimatedTokens).toBe(Math.ceil(40 / 4));
		// activeTokens counts the root + the active branch only, not the abandoned one.
		expect(result.activeTokens).toBe(Math.ceil(40 / 4) + Math.ceil(40 / 4));
	});

	it("getBranch() alone (without buildContextEntries()) does not honor compaction -- a compacted-away message still reads as on-path, which is exactly why activeEntryIds must come from buildContextEntries()", () => {
		// SessionManager's own getBranch() docstring: "Walk from entry to root... Includes all
		// entry types... Use buildSessionContext() to get the resolved messages for the LLM."
		// This confirms getBranch() is NOT compaction-aware -- only buildContextEntries()/
		// buildSessionContext() are. This test locks in that CURRENT, real getBranch() behavior
		// so a future change in Pi's SessionManager is caught, rather than silently assumed.
		const sm = SessionManager.inMemory();
		const firstId = sm.appendMessage({ role: "user", content: longText("old", 400), timestamp: Date.now() });
		const secondId = sm.appendMessage({
			role: "assistant", content: [{ type: "text", text: longText("old-response", 400) }],
			api: "test", provider: "test", model: "test",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		});
		sm.appendCompaction("summary of the old exchange", secondId, 200);
		sm.appendMessage({ role: "user", content: "after compaction", timestamp: Date.now() });

		const branchIds = sm.getBranch().map((entry) => entry.id);
		expect(branchIds).toContain(firstId);
		expect(branchIds).toContain(secondId);
	});

	it("REGRESSION: buildContextEntries()-derived activeEntryIds correctly excludes compacted-away content, unlike getBranch()", () => {
		// The real, live bug: "Conversation message history -- 1,347,205 tok (1321.2%)" was
		// reported against a session with 3 real compactions. Using getBranch() to build
		// activeEntryIds counts EVERY pre-compaction message as still active, even though it has
		// been replaced by a much smaller summary -- a session that has been compacted several
		// times over can accumulate a raw text volume many times larger than what the LLM is
		// actually shown right now. This test proves buildContextEntries() (Pi's own
		// compaction-aware entry list) fixes it: activeTokens must be bounded by what's actually
		// kept, not the full historical raw volume.
		const sm = SessionManager.inMemory();
		const assistantUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		let lastAssistantId = "";

		// Three real rounds of compaction, each summarizing away a large exchange -- mirroring
		// the real production session that reported this bug.
		for (let round = 0; round < 3; round++) {
			for (let index = 0; index < 200; index++) {
				sm.appendMessage({ role: "user", content: longText(`round${round}-u`, 200), timestamp: Date.now() });
				lastAssistantId = sm.appendMessage({
					role: "assistant", content: [{ type: "text", text: longText(`round${round}-a`, 200) }],
					api: "test", provider: "test", model: "test", usage: assistantUsage, stopReason: "stop", timestamp: Date.now(),
				});
			}
			const keepFromId = sm.appendMessage({ role: "user", content: "kept across compaction", timestamp: Date.now() });
			sm.appendCompaction(`summary of round ${round}`, keepFromId, 50000);
		}
		// A small amount of real post-compaction content -- what the LLM actually sees now.
		sm.appendMessage({ role: "user", content: longText("final", 200), timestamp: Date.now() });

		const tree = sm.getTree();
		const branchIds = new Set(sm.getBranch().map((entry) => entry.id));
		const contextEntryIds = new Set(sm.buildContextEntries().map((entry) => entry.id));

		// The bug, reproduced: using getBranch() alone counts everything, including all 3
		// rounds' worth of compacted-away raw text.
		const buggyResult = buildMessageHistoryTree(tree as never, branchIds);
		// The fix: using buildContextEntries() correctly excludes everything before the LAST
		// compaction's firstKeptEntryId.
		const fixedResult = buildMessageHistoryTree(tree as never, contextEntryIds, branchIds);

		expect(fixedResult.activeTokens).toBeLessThan(buggyResult.activeTokens); // the fix must actually reduce the overcount
		// Real content still counted after the fix: the 3rd compaction's summary, its "kept"
		// message, and the final post-compaction message -- not the 600 compacted-away messages.
		const expectedFixedTokens = Math.ceil("summary of round 2".length / 4)
			+ Math.ceil("kept across compaction".length / 4)
			+ Math.ceil(200 / 4);
		expect(fixedResult.activeTokens).toBe(expectedFixedTokens);
		// The buggy path, for contrast, counts far more than a single round's worth of content --
		// proving this is a REAL, large-magnitude overcount, not a rounding difference.
		expect(buggyResult.activeTokens).toBeGreaterThan(expectedFixedTokens * 50);
	});
});
