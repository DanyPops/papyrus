import { describe, expect, it } from "bun:test";
import { buildBasePromptItems } from "../extension/src/base-prompt-breakdown.ts";

describe("buildBasePromptItems", () => {
	it("splits tool snippets, skills, and context files into their own items, each with a real count", () => {
		const items = buildBasePromptItems({
			cwd: "/workspace",
			toolSnippets: { read: "Read the contents of a file.", bash: "Execute a bash command." },
			skills: [
				{ name: "commit", description: "Write commits.", filePath: "/skills/commit/SKILL.md", baseDir: "/skills/commit", sourceInfo: {} as never, disableModelInvocation: false },
			],
			contextFiles: [{ path: "/workspace/AGENTS.md", content: "Some project instructions." }],
		}, 5000);

		const labels = items.map((item) => item.label);
		expect(labels.some((label) => label.includes("Tool snippets (2 tools)"))).toBe(true);
		expect(labels.some((label) => label.includes("Skills catalog (1 skills)"))).toBe(true);
		expect(labels.some((label) => label.includes("Project context files (1"))).toBe(true);
		expect(labels.some((label) => label.includes("Base template"))).toBe(true);
		for (const item of items) expect(item.estimatedTokens).toBeGreaterThan(0);
	});

	it("excludes skills marked disableModelInvocation from the count, since Pi's own formatSkillsForPrompt does the same", () => {
		const items = buildBasePromptItems({
			cwd: "/workspace",
			skills: [
				{ name: "visible", description: "d", filePath: "/f", baseDir: "/", sourceInfo: {} as never, disableModelInvocation: false },
				{ name: "hidden", description: "d", filePath: "/f", baseDir: "/", sourceInfo: {} as never, disableModelInvocation: true },
			],
		}, 5000);
		const skillsItem = items.find((item) => item.label.includes("Skills catalog"))!;
		expect(skillsItem.label).toContain("(1 skills)");
	});

	it("the remainder (base template) absorbs whatever the known sub-segments don't attribute, matching the real total honestly", () => {
		const items = buildBasePromptItems({ cwd: "/workspace" }, 4000);
		expect(items).toHaveLength(1);
		expect(items[0]!.label).toBe("Base template, guidelines, and formatting");
		expect(items[0]!.estimatedTokens).toBe(Math.ceil(4000 / 4));
	});

	it("clamps the remainder to zero instead of going negative when sub-segment estimates overshoot the real total", () => {
		const items = buildBasePromptItems({
			cwd: "/workspace",
			toolSnippets: { read: "x".repeat(10000) },
		}, 100); // real total is tiny; the tool-snippet estimate alone dwarfs it
		const remainder = items.find((item) => item.label.includes("Base template"));
		// Either omitted entirely (remainderCharacters === 0) or present at exactly zero -- never negative.
		if (remainder) expect(remainder.estimatedTokens).toBe(0);
	});

	it("returns only the base-template item when no structural options are present at all", () => {
		const items = buildBasePromptItems({ cwd: "/workspace" }, 0);
		expect(items).toHaveLength(1);
		expect(items[0]!.estimatedTokens).toBe(0);
	});
});
