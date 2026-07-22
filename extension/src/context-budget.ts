import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN, CONTEXT_TREE_MAX_NODES } from "../../src/constants.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import type { TaskGraph } from "../../src/task-service.ts";
import { discoverSkillDirectories, scanSkillCatalogFootprint, type SkillCatalogFootprint } from "./skill-catalog-footprint.ts";
import { ruleInjectionPreview } from "./rules.ts";

export interface RuleBudgetEntry {
	id: string;
	title: string;
	characters: number;
	estimatedTokens: number;
}

export interface ContextBudget {
	rules: {
		entries: RuleBudgetEntry[]; // sorted descending by characters
		totalCharacters: number;
		totalEstimatedTokens: number;
	};
	skills: SkillCatalogFootprint;
	totalEstimatedTokens: number;
}

/** Active Rules are injected into every relevant turn -- the same permanent tax role as a Pi-native skill's catalog entry. */
export function computeRuleBudget(rules: ReadonlyArray<Pick<Artifact, "id" | "title" | "body" | "extra">>): ContextBudget["rules"] {
	const entries = rules
		.map((rule) => {
			const characters = ruleInjectionPreview(rule).length;
			return { id: rule.id, title: rule.title, characters, estimatedTokens: Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN) };
		})
		.sort((a, b) => b.characters - a.characters);
	return {
		entries,
		totalCharacters: entries.reduce((sum, entry) => sum + entry.characters, 0),
		totalEstimatedTokens: entries.reduce((sum, entry) => sum + entry.estimatedTokens, 0),
	};
}

/** Best-effort: a missing, unreadable, or malformed settings.json contributes no extra skill directories rather than failing the whole report. */
function readSettingsSkillPaths(settingsPath: string): string[] {
	try {
		const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as { skills?: unknown };
		if (!Array.isArray(raw.skills)) return [];
		return raw.skills.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return [];
	}
}

export function computeContextBudget(
	rules: ReadonlyArray<Pick<Artifact, "id" | "title" | "body" | "extra">>,
	cwd: string,
	homeDirectory: string = homedir(),
): ContextBudget {
	const settingsSkills = readSettingsSkillPaths(`${homeDirectory}/.pi/agent/settings.json`);
	const directories = discoverSkillDirectories(homeDirectory, cwd, settingsSkills);
	const skills = scanSkillCatalogFootprint(directories);
	const ruleBudget = computeRuleBudget(rules);
	return { rules: ruleBudget, skills, totalEstimatedTokens: ruleBudget.totalEstimatedTokens + skills.totalEstimatedTokens };
}

/** Pi's own documented compaction-reserve default (docs/compaction.md): headroom kept free for the model's response. */
export const DEFAULT_RESERVE_TOKENS = 16_384;

export interface ContextSegmentItem {
	label: string;
	estimatedTokens: number;
	/**
	 * Recursive children, when this item has real hierarchy of its own -- conversation history
	 * (Pi's session entries form a genuine tree via id/parentId, docs/session-format.md) and
	 * Papyrus Tasks (containment via parentIds/childIds) both do; Rules and Skills don't, so
	 * their items simply omit this field, degenerating to a flat one-level tree.
	 */
	children?: ContextSegmentItem[];
}

export interface ContextSegment {
	key: "rules" | "tasks" | "skills" | "basePrompt" | "messageHistory" | "other";
	label: string;
	estimatedTokens: number;
	/** Drill-down items, when this segment can be broken down further. Absent for "other" -- an opaque remainder, not a real category. */
	items?: ContextSegmentItem[];
	/**
	 * True when this segment's size is genuinely unmeasured (not yet observed), as opposed to
	 * measured-and-actually-zero. A display layer that hides zero-token rows to cut noise must
	 * NOT hide an unknown segment just because its placeholder value happens to be zero --
	 * that would silently misrepresent "we don't know" as "there is nothing here", the same
	 * category of honesty problem overshootTokens exists to prevent for the unaccounted bucket.
	 */
	unknown?: boolean;
}

/**
 * Session entries and tree nodes as SessionManager exposes them (docs/session-format.md,
 * SessionTreeNode from @earendil-works/pi-coding-agent): a subset covering only the fields
 * this estimate reads, so this stays testable with plain object literals instead of
 * importing pi's own session types.
 */
export interface SessionEntryLike {
	id: string;
	type: string;
	message?: unknown;
	summary?: string;
}
export interface SessionTreeNodeLike {
	entry: SessionEntryLike;
	children: SessionTreeNodeLike[];
}

function messageContentCharacters(message: unknown): number {
	if (typeof message !== "object" || message === null) return 0;
	const record = message as Record<string, unknown>;
	if (record["role"] === "bashExecution") {
		// Pi's own context builder excludes "!!"-prefixed bash output from context; match that.
		if (record["excludeFromContext"] === true) return 0;
		return String(record["command"] ?? "").length + String(record["output"] ?? "").length;
	}
	const content = record["content"];
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let characters = 0;
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const b = block as Record<string, unknown>;
		if (b["type"] === "text") characters += String(b["text"] ?? "").length;
		else if (b["type"] === "thinking") characters += String(b["thinking"] ?? "").length;
		else if (b["type"] === "toolCall") characters += JSON.stringify(b["arguments"] ?? {}).length;
		// "image" blocks are deliberately not counted here -- image tokens follow a different,
		// non-character-based cost model this char/4 estimate cannot represent; this is a real,
		// documented undercount for image-heavy sessions, not a silent approximation.
	}
	return characters;
}

function messageSnippet(message: unknown, maxLength = 48): string {
	if (typeof message !== "object" || message === null) return "";
	const record = message as Record<string, unknown>;
	if (record["role"] === "bashExecution") return String(record["command"] ?? "");
	const content = record["content"];
	const text = typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((block) => (typeof block === "object" && block !== null && (block as Record<string, unknown>)["type"] === "text" ? String((block as Record<string, unknown>)["text"] ?? "") : "")).join(" ")
			: "";
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

function entryLabel(entry: SessionEntryLike): string {
	if (entry.type === "compaction") return "compaction summary";
	if (entry.type === "branch_summary") return "branch summary";
	const role = typeof entry.message === "object" && entry.message !== null ? (entry.message as Record<string, unknown>)["role"] : undefined;
	const prefix = typeof role === "string" ? role : entry.type;
	const snippet = messageSnippet(entry.message);
	return snippet ? `${prefix}: ${snippet}` : prefix;
}

export interface MessageHistoryTree {
	/** One item per real tree root (ordinarily one, the session's first entry). */
	items: ContextSegmentItem[];
	/** Sum of tokens for entries on the CURRENT active path only -- what actually feeds the LLM's context right now, unlike content sitting in an abandoned /tree branch. */
	activeTokens: number;
	/** True if the walk hit CONTEXT_TREE_MAX_NODES or found a cycle -- the tree shown is a bounded prefix, not necessarily the complete session. */
	truncated: boolean;
}

/**
 * Walks Pi's own real session tree (ctx.sessionManager.getTree(), docs/session-format.md --
 * entries form a genuine tree via id/parentId, not just the linear current-branch path) to
 * estimate the conversation's context contribution AND surface branches explored via /tree
 * that are no longer on the active path -- content that cost real tokens to generate but is
 * NOT currently part of the context window. Bounded and cycle-safe (CONTEXT_TREE_MAX_NODES):
 * a session file is external, mutable state, and this deliberately hardens past a confirmed
 * real gap in Pi's own getBranch() (no cycle guard at all) rather than assuming the tree can
 * never be malformed.
 *
 * `activeEntryIds` MUST come from ctx.sessionManager.buildContextEntries(), not getBranch().
 * getBranch()'s own docstring says it "[i]ncludes all entry types... Use buildSessionContext()
 * to get the resolved messages for the LLM" -- it does not skip entries a real compaction has
 * already summarized away. A real session with 3 compactions confirmed using getBranch() here
 * overcounts activeTokens by over 13x, since every pre-compaction message still reads as
 * "active". buildContextEntries() is Pi's own compaction-aware entry list: the latest
 * compaction entry, its kept entries from firstKeptEntryId onward, and everything after.
 *
 * `branchEntryIds` (optional) is the full raw current-path id set (getBranch()'s own output).
 * When given, an entry on the branch path but excluded from activeEntryIds is labeled
 * "(compacted)" rather than the less accurate "(inactive branch)", which is reserved for
 * entries not on the current path at all (a genuinely abandoned /tree branch). Omitting it
 * preserves the simpler binary active/inactive-branch labeling for callers that only have one
 * set to give (e.g. tests).
 */
interface WalkFrame {
	node: SessionTreeNodeLike;
	parentIndex: number | null;
}

/**
 * Iterative (not recursive) two-pass walk: an explicit-stack pre-order discovery pass
 * followed by a reverse-order (children-before-parent) construction pass. A real, ordinary
 * (non-branching) long-running session is one long linear chain, so recursion depth would
 * equal entry count -- a session observed in production with 6,924 entries on its own active
 * branch confirmed this is not a hypothetical concern; a naive recursive walk risks a real
 * JavaScript call-stack overflow at that scale, independent of the CONTEXT_TREE_MAX_NODES
 * bound entirely.
 */
export function buildMessageHistoryTree(roots: ReadonlyArray<SessionTreeNodeLike>, activeEntryIds: ReadonlySet<string>, branchEntryIds?: ReadonlySet<string>): MessageHistoryTree {
	const visited = new Set<string>();
	let truncated = false;
	let activeTokens = 0;

	const order: WalkFrame[] = [];
	const stack: WalkFrame[] = [...roots].reverse().map((root) => ({ node: root, parentIndex: null }));
	while (stack.length > 0) {
		const frame = stack.pop()!;
		if (order.length >= CONTEXT_TREE_MAX_NODES) { truncated = true; break; }
		if (visited.has(frame.node.entry.id)) { truncated = true; continue; } // cycle guard
		visited.add(frame.node.entry.id);
		const index = order.length;
		order.push(frame);
		const children = [...frame.node.children].reverse().map((child) => ({ node: child, parentIndex: index }));
		stack.push(...children);
	}
	if (stack.length > 0) truncated = true; // node bound hit with more work still queued

	const childItemsByParent = new Map<number, ContextSegmentItem[]>();
	const itemByIndex = new Map<number, ContextSegmentItem>();
	for (let index = order.length - 1; index >= 0; index--) {
		const frame = order[index]!;
		const entry = frame.node.entry;
		const characters = entry.type === "message"
			? messageContentCharacters(entry.message)
			: entry.type === "compaction" || entry.type === "branch_summary"
				? (entry.summary ?? "").length
				: 0;
		const tokens = Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN);
		const isActive = activeEntryIds.has(entry.id);
		if (isActive) activeTokens += tokens;
		const isOnBranch = branchEntryIds ? branchEntryIds.has(entry.id) : isActive; // no branch set given -- fall back to the old binary active/inactive-branch label

		const children = childItemsByParent.get(index) ?? [];
		if (tokens === 0 && children.length === 0) continue; // no content, no descendants with content -- nothing to show

		const item: ContextSegmentItem = {
			label: isActive ? entryLabel(entry) : isOnBranch ? `${entryLabel(entry)} (compacted)` : `${entryLabel(entry)} (inactive branch)`,
			estimatedTokens: tokens,
			...(children.length > 0 ? { children } : {}),
		};
		itemByIndex.set(index, item);
		if (frame.parentIndex !== null) {
			const siblings = childItemsByParent.get(frame.parentIndex) ?? [];
			siblings.unshift(item); // reverse-order processing -- unshift restores original document order
			childItemsByParent.set(frame.parentIndex, siblings);
		}
	}

	const items: ContextSegmentItem[] = [];
	for (let index = 0; index < order.length; index++) {
		if (order[index]!.parentIndex === null) {
			const item = itemByIndex.get(index);
			if (item) items.push(item);
		}
	}
	return { items, activeTokens, truncated };
}

export interface ContextBreakdown {
	/** Real usage from ctx.getContextUsage() -- ground truth, not estimated. Null only when Pi has no usage yet (e.g. before the first turn). */
	totalTokens: number | null;
	/** From ctx.model.contextWindow. Null when the active model's context window is unknown. */
	contextWindow: number | null;
	/** contextWindow - reserveTokens, mirroring Pi's own compaction-trigger formula. Null when contextWindow is unknown. */
	effectiveBudget: number | null;
	/**
	 * How much the known/estimated segments (rules+tasks+skills+basePrompt+messageHistory)
	 * exceed the real total, when they do. Zero means no overshoot. This must stay visible
	 * rather than only being absorbed into "unaccounted" clamping to zero -- a clamped-to-zero
	 * unaccounted segment does NOT mean tool definitions and framework overhead are actually
	 * free; it means this estimate's other segments already consumed the entire real budget on
	 * paper. Hiding that distinction would make a genuinely nonzero cost look like zero.
	 */
	overshootTokens: number;
	/** rules, tasks, skills, basePrompt, messageHistory, then "other" absorbing whatever real usage the rest don't account for. */
	segments: ContextSegment[];
}

export interface BuildContextBreakdownInput {
	totalTokens: number | null;
	contextWindow: number | null;
	reserveTokens?: number;
	ruleBudget: ContextBudget["rules"];
	/** Open tasks contributing to the injected task-context summary, nested by containment (parentIds/childIds) so the Tasks segment reflects the real Task tree, not a flat list. */
	taskItems: ContextSegmentItem[];
	skills: SkillCatalogFootprint;
	/** Pi's own base system prompt size, cached from the last observed before_agent_start turn. Null before any turn has run yet. */
	basePromptEstimatedTokens: number | null;
	/** Structural sub-breakdown (tool snippets, Skills, context files, template remainder) from the same cached observation, built by buildBasePromptItems(). Empty when basePromptEstimatedTokens is null. */
	basePromptItems?: ContextSegmentItem[];
	/** From buildMessageHistoryTree() against the live session's real tree (ctx.sessionManager.getTree()). */
	messageHistoryItems: ContextSegmentItem[];
	/** buildMessageHistoryTree()'s activeTokens -- only entries on the current active path count toward the segment total; an abandoned /tree branch still appears in messageHistoryItems but contributes zero here. */
	messageHistoryActiveTokens: number;
}

/** Sums a possibly-nested item tree's tokens recursively -- every node's own contribution, not just top-level items. */
function sumItemTree(items: ContextSegmentItem[]): number {
	return items.reduce((sum, item) => sum + item.estimatedTokens + sumItemTree(item.children ?? []), 0);
}

/**
 * Builds the Tasks segment's items from Papyrus's own real containment tree (parentIds/
 * childIds), not a flat list -- Tasks are a genuine DAG (a task may have more than one
 * parent, a deliberate design decision, not a defect: see /tasks contain). Open tasks only
 * (done/canceled tasks are filtered first, matching taskContext()'s own "only open work
 * matters" rule); a task whose real parent is done/canceled or otherwise filtered out
 * becomes a root in THIS projection rather than being silently dropped. A task reachable
 * from more than one open parent is shown once, under whichever parent this bounded walk
 * reaches first -- the same spanning-tree compromise already applied to the task widget
 * (extension/src/task-widget.ts) for the identical multi-parent-DAG-in-a-bounded-view
 * problem, not a new inconsistency.
 */
interface TaskWalkFrame {
	taskId: string;
	parentIndex: number | null;
}

/** Same iterative two-pass shape as buildMessageHistoryTree, for the same reason: don't assume containment depth stays small just because it usually does. */
export function buildTaskItemTree(graph: TaskGraph): ContextSegmentItem[] {
	const byId = new Map(graph.nodes.map((node) => [node.task.id, node]));
	const openIds = new Set(graph.nodes.filter((node) => node.task.status !== "done" && node.task.status !== "canceled").map((node) => node.task.id));
	const visited = new Set<string>();

	const rootIds = [...openIds].filter((id) => {
		const node = byId.get(id)!;
		return node.parentIds.length === 0 || !node.parentIds.some((parentId) => openIds.has(parentId));
	});

	const order: TaskWalkFrame[] = [];
	const stack: TaskWalkFrame[] = [...rootIds].reverse().map((taskId) => ({ taskId, parentIndex: null }));
	while (stack.length > 0) {
		const frame = stack.pop()!;
		if (order.length >= CONTEXT_TREE_MAX_NODES) break;
		if (visited.has(frame.taskId) || !openIds.has(frame.taskId)) continue; // cycle guard + open-only filter
		visited.add(frame.taskId);
		const index = order.length;
		order.push(frame);
		const node = byId.get(frame.taskId);
		const children = [...(node?.childIds ?? [])].reverse()
			.filter((childId) => openIds.has(childId))
			.map((childId) => ({ taskId: childId, parentIndex: index }));
		stack.push(...children);
	}

	const childItemsByParent = new Map<number, ContextSegmentItem[]>();
	const itemByIndex = new Map<number, ContextSegmentItem>();
	for (let index = order.length - 1; index >= 0; index--) {
		const frame = order[index]!;
		const node = byId.get(frame.taskId);
		if (!node) continue;
		const characters = node.task.title.length + node.task.body.length;
		const tokens = Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN);
		const children = childItemsByParent.get(index) ?? [];
		const item: ContextSegmentItem = { label: node.task.title, estimatedTokens: tokens, ...(children.length > 0 ? { children } : {}) };
		itemByIndex.set(index, item);
		if (frame.parentIndex !== null) {
			const siblings = childItemsByParent.get(frame.parentIndex) ?? [];
			siblings.unshift(item);
			childItemsByParent.set(frame.parentIndex, siblings);
		}
	}

	const items: ContextSegmentItem[] = [];
	for (let index = 0; index < order.length; index++) {
		if (order[index]!.parentIndex === null) {
			const item = itemByIndex.get(index);
			if (item) items.push(item);
		}
	}
	return items;
}

/**
 * Composes every segment Papyrus can actually measure or estimate (rules, tasks, skills
 * catalog, cached base-prompt size, and the live session's own message history) against the
 * real total Pi reports, deriving "unaccounted" (tool definitions and framework overhead --
 * genuinely invisible to any extension) as the remainder. The remainder is clamped to zero
 * rather than shown negative -- char/4 token estimation is approximate, and a small overshoot
 * in the known segments must not display as a nonsensical negative bucket -- but the clamp
 * amount itself is preserved as overshootTokens rather than silently discarded, so a
 * consumer can tell "genuinely zero" apart from "our other estimates already exceeded the
 * real total". When the real total is unavailable, unaccounted is reported as zero and
 * totalTokens surfaces as null so callers can label the whole breakdown as estimate-only
 * rather than silently treating a partial sum as ground truth.
 */
export function buildContextBreakdown(input: BuildContextBreakdownInput): ContextBreakdown {
	const reserveTokens = input.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const rules: ContextSegment = {
		key: "rules",
		label: "Papyrus Rules",
		estimatedTokens: input.ruleBudget.totalEstimatedTokens,
		items: input.ruleBudget.entries.map((entry) => ({ label: entry.title, estimatedTokens: entry.estimatedTokens })),
	};
	const tasks: ContextSegment = {
		key: "tasks",
		label: "Papyrus Tasks",
		estimatedTokens: sumItemTree(input.taskItems),
		items: input.taskItems,
	};
	const skills: ContextSegment = {
		key: "skills",
		label: "Pi Skills catalog",
		estimatedTokens: input.skills.totalEstimatedTokens,
		items: input.skills.entries.map((entry) => ({ label: entry.name, estimatedTokens: entry.estimatedTokens })),
	};
	const basePrompt: ContextSegment = {
		key: "basePrompt",
		label: input.basePromptEstimatedTokens === null ? "Base system prompt (not observed yet)" : "Base system prompt (Pi + host instructions)",
		estimatedTokens: input.basePromptEstimatedTokens ?? 0,
		...(input.basePromptEstimatedTokens === null ? { unknown: true } : {}),
		...(input.basePromptItems && input.basePromptItems.length > 0 ? { items: input.basePromptItems } : {}),
	};
	const messageHistory: ContextSegment = {
		key: "messageHistory",
		label: "Conversation message history",
		estimatedTokens: input.messageHistoryActiveTokens,
		items: input.messageHistoryItems,
	};
	const knownTokens = rules.estimatedTokens + tasks.estimatedTokens + skills.estimatedTokens + basePrompt.estimatedTokens + messageHistory.estimatedTokens;
	const overshootTokens = input.totalTokens === null ? 0 : Math.max(0, knownTokens - input.totalTokens);
	const other: ContextSegment = {
		key: "other",
		label: overshootTokens > 0
			? `Unaccounted (tool definitions, framework overhead) -- estimate overshoot: other segments' estimates already exceed the real total by ~${overshootTokens} tokens, so this is a floor, not a real zero`
			: "Unaccounted (tool definitions, framework overhead)",
		estimatedTokens: input.totalTokens === null ? 0 : Math.max(0, input.totalTokens - knownTokens),
	};
	return {
		totalTokens: input.totalTokens,
		contextWindow: input.contextWindow,
		effectiveBudget: input.contextWindow === null ? null : Math.max(0, input.contextWindow - reserveTokens),
		overshootTokens,
		segments: [rules, tasks, skills, basePrompt, messageHistory, other],
	};
}


