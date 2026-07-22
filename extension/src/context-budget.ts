import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN } from "../../src/constants.ts";
import type { Artifact } from "../../src/domain/artifact.ts";
import { discoverSkillDirectories, scanSkillCatalogFootprint, type SkillCatalogFootprint } from "./skill-catalog-footprint.ts";
import { ruleInjectionPreview } from "./rules.ts";

const REPORT_MAX_ROWS = 5;

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
	key: "rules" | "tasks" | "skills" | "other";
	label: string;
	estimatedTokens: number;
	/** Drill-down items, when this segment can be broken down further. Absent for "other" -- an opaque remainder, not a real category. */
	items?: ContextSegmentItem[];
}

export interface ContextBreakdown {
	/** Real usage from ctx.getContextUsage() -- ground truth, not estimated. Null only when Pi has no usage yet (e.g. before the first turn). */
	totalTokens: number | null;
	/** From ctx.model.contextWindow. Null when the active model's context window is unknown. */
	contextWindow: number | null;
	/** contextWindow - reserveTokens, mirroring Pi's own compaction-trigger formula. Null when contextWindow is unknown. */
	effectiveBudget: number | null;
	/** rules, tasks, skills, then "other" absorbing whatever real usage the first three don't account for. */
	segments: ContextSegment[];
}

export interface BuildContextBreakdownInput {
	totalTokens: number | null;
	contextWindow: number | null;
	reserveTokens?: number;
	ruleBudget: ContextBudget["rules"];
	taskEstimatedTokens: number;
	skills: SkillCatalogFootprint;
}

/**
 * Composes Papyrus's own estimated segments (rules/tasks/skills) against the real total Pi
 * reports, deriving "everything else" (base system prompt, message history, tool definitions
 * -- none of which Papyrus can see or estimate) as the remainder. The remainder is clamped to
 * zero rather than shown negative: char/4 token estimation is approximate, and a small
 * overshoot in the known segments must not display as a nonsensical negative "other" bucket.
 * When the real total is unavailable, "other" is reported as zero and totalTokens surfaces as
 * null so callers can label the whole breakdown as estimate-only rather than silently treating
 * a partial sum as ground truth.
 */
export function buildContextBreakdown(input: BuildContextBreakdownInput): ContextBreakdown {
	const reserveTokens = input.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const rules: ContextSegment = {
		key: "rules",
		label: "Papyrus Rules",
		estimatedTokens: input.ruleBudget.totalEstimatedTokens,
		items: input.ruleBudget.entries.map((entry) => ({ label: entry.title, estimatedTokens: entry.estimatedTokens })),
	};
	const tasks: ContextSegment = { key: "tasks", label: "Papyrus Tasks", estimatedTokens: input.taskEstimatedTokens };
	const skills: ContextSegment = {
		key: "skills",
		label: "Pi Skills catalog",
		estimatedTokens: input.skills.totalEstimatedTokens,
		items: input.skills.entries.map((entry) => ({ label: entry.name, estimatedTokens: entry.estimatedTokens })),
	};
	const knownTokens = rules.estimatedTokens + tasks.estimatedTokens + skills.estimatedTokens;
	const other: ContextSegment = {
		key: "other",
		label: "Everything else (base prompt, message history, tool definitions)",
		estimatedTokens: input.totalTokens === null ? 0 : Math.max(0, input.totalTokens - knownTokens),
	};
	return {
		totalTokens: input.totalTokens,
		contextWindow: input.contextWindow,
		effectiveBudget: input.contextWindow === null ? null : Math.max(0, input.contextWindow - reserveTokens),
		segments: [rules, tasks, skills, other],
	};
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Pure text formatter, independent of live daemon/filesystem state, for direct unit testing. */
export function formatContextBudgetReport(budget: ContextBudget): string {
	const lines: string[] = ["Papyrus passive context budget", ""];

	lines.push(`Rules (active, injected every relevant turn): ${budget.rules.entries.length} rules · ${budget.rules.totalCharacters} chars · ~${budget.rules.totalEstimatedTokens} tokens`);
	if (budget.rules.entries.length > 0) {
		lines.push("  Largest:");
		for (const entry of budget.rules.entries.slice(0, REPORT_MAX_ROWS)) {
			lines.push(`  ${entry.characters.toString().padStart(5)} chars (~${entry.estimatedTokens} tok)  ${truncate(entry.title, 60)}`);
		}
	}
	lines.push("");

	lines.push(`Skills (Pi-native catalog, injected at startup): ${budget.skills.entries.length} skills · ${budget.skills.totalCharacters} chars · ~${budget.skills.totalEstimatedTokens} tokens`);
	if (budget.skills.entries.length > 0) {
		lines.push("  Largest:");
		for (const entry of budget.skills.entries.slice(0, REPORT_MAX_ROWS)) {
			lines.push(`  ${entry.characters.toString().padStart(5)} chars (~${entry.estimatedTokens} tok)  ${truncate(entry.name, 40)}`);
		}
	}
	if (budget.skills.scannedDirectories.length > 0) {
		lines.push(`  Scanned: ${budget.skills.scannedDirectories.join(", ")}`);
	} else {
		lines.push("  No skill directories found (checked Pi's documented global/project locations and settings.json's skills array).");
	}
	lines.push("");

	lines.push(`Total passive tax: ~${budget.totalEstimatedTokens} tokens across ${budget.rules.entries.length + budget.skills.entries.length} items, before a single user message or tool call.`);
	return lines.join("\n");
}
