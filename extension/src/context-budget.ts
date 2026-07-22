import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN } from "../../src/constants.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
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
 * Session branch entries as SessionManager exposes them (docs/session-format.md): a subset
 * covering only the fields this estimate reads, so this stays testable with plain object
 * literals instead of importing pi's own session types.
 */
export interface SessionBranchEntryLike {
	type: string;
	message?: unknown;
	summary?: string;
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

/**
 * Estimates the conversation transcript's own context contribution by walking the actual
 * session branch (docs/session-format.md's buildSessionContext(): message/compaction/
 * branch_summary entries participate in context, plain "custom" entries do not). This is
 * character-count estimation like every other Papyrus segment here, not exact -- but it is
 * real session content, not a guess, and in a long-running session this is very likely the
 * dominant contributor to "the base prompt, message history, and tool definitions" bucket
 * that would otherwise stay fully opaque.
 */
export function estimateMessageHistoryTokens(branch: ReadonlyArray<SessionBranchEntryLike>): number {
	let characters = 0;
	for (const entry of branch) {
		if (entry.type === "message") characters += messageContentCharacters(entry.message);
		else if (entry.type === "compaction" || entry.type === "branch_summary") characters += (entry.summary ?? "").length;
	}
	return Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN);
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
	/** Open tasks contributing to the injected task-context summary, each sized individually so the Tasks segment can be drilled into like Rules and Skills. */
	taskItems: ContextSegmentItem[];
	skills: SkillCatalogFootprint;
	/** Pi's own base system prompt size, cached from the last observed before_agent_start turn. Null before any turn has run yet. */
	basePromptEstimatedTokens: number | null;
	/** From estimateMessageHistoryTokens() against the live session branch. */
	messageHistoryEstimatedTokens: number;
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
		estimatedTokens: input.taskItems.reduce((sum, item) => sum + item.estimatedTokens, 0),
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
	};
	const messageHistory: ContextSegment = {
		key: "messageHistory",
		label: "Conversation message history",
		estimatedTokens: input.messageHistoryEstimatedTokens,
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


