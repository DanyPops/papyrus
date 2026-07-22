import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN } from "../../src/constants.ts";
import type { ContextSegmentItem } from "./context-budget.ts";

/**
 * Splits Pi's base system prompt into real structural sub-segments instead of one opaque
 * number, using BeforeAgentStartEvent's own systemPromptOptions field -- Pi's own doc comment
 * on it: "Extensions can inspect this to understand what Pi loaded without re-discovering
 * resources." No new hook, no new risk: before_agent_start is already wired.
 *
 * Deliberately measures each INPUT's raw content size (tool snippet text, skill metadata,
 * context file content) rather than attempting to byte-for-byte reproduce Pi's internal
 * wrapping/tag format -- buildSystemPrompt() and formatSkillsForPrompt() are Pi-internal
 * functions, not part of the public extension API Papyrus can call, so reproducing their
 * exact template text here would be a real, silent drift risk if Pi ever changes it. The
 * remainder item absorbs whatever wrapping/template text this doesn't attribute, so the
 * segment's total always still matches the real observed prompt length exactly -- honesty
 * preserved even though individual sub-segment sizes are approximate, matching the same
 * known-segments-plus-honest-remainder pattern used everywhere else in this breakdown.
 */
export function buildBasePromptItems(options: BuildSystemPromptOptions, totalCharacters: number): ContextSegmentItem[] {
	const items: ContextSegmentItem[] = [];

	const toolSnippetEntries = Object.entries(options.toolSnippets ?? {});
	// Mirrors buildSystemPrompt()'s own "- name: snippet\n" line shape closely enough to be a
	// fair estimate without importing Pi-internal formatting code.
	const toolSnippetsCharacters = toolSnippetEntries.reduce((sum, [name, snippet]) => sum + name.length + snippet.length + 4, 0);
	if (toolSnippetsCharacters > 0) {
		items.push({ label: `Tool snippets (${toolSnippetEntries.length} tools)`, estimatedTokens: toCeilTokens(toolSnippetsCharacters) });
	}

	const visibleSkills = (options.skills ?? []).filter((skill) => !skill.disableModelInvocation);
	const skillsCharacters = visibleSkills.reduce((sum, skill) => sum + skill.name.length + skill.description.length + skill.filePath.length + 20, 0);
	if (skillsCharacters > 0) {
		items.push({ label: `Skills catalog (${visibleSkills.length} skills)`, estimatedTokens: toCeilTokens(skillsCharacters) });
	}

	const contextFiles = options.contextFiles ?? [];
	const contextFilesCharacters = contextFiles.reduce((sum, file) => sum + file.path.length + file.content.length + 40, 0);
	if (contextFilesCharacters > 0) {
		items.push({ label: `Project context files (${contextFiles.length}, e.g. AGENTS.md)`, estimatedTokens: toCeilTokens(contextFilesCharacters) });
	}

	const knownCharacters = toolSnippetsCharacters + skillsCharacters + contextFilesCharacters;
	const remainderCharacters = Math.max(0, totalCharacters - knownCharacters);
	if (remainderCharacters > 0 || items.length === 0) {
		items.push({ label: "Base template, guidelines, and formatting", estimatedTokens: toCeilTokens(remainderCharacters) });
	}

	return items;
}

function toCeilTokens(characters: number): number {
	return Math.ceil(characters / CONTEXT_ESTIMATE_CHARACTERS_PER_TOKEN);
}
