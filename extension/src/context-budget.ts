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
