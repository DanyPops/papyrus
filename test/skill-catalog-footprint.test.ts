import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";
afterAll(cleanupTempDirs);
import {
	discoverSkillDirectories,
	parseSkillFrontmatter,
	scanSkillCatalogFootprint,
} from "../extension/src/skill-catalog-footprint.ts";

describe("parseSkillFrontmatter", () => {
	it("extracts name and a plain single-line description", () => {
		const content = "---\nname: commit\ndescription: Stage and push changes.\n---\n\n# Commit\n";
		expect(parseSkillFrontmatter(content)).toEqual({ name: "commit", description: "Stage and push changes." });
	});

	it("folds a real-world `description: >` block scalar into one space-joined line", () => {
		const content = [
			"---",
			"name: dsa-review",
			"description: >",
			"  Analyze a piece of code for DSA quality — measure complexity, recognize",
			"  problem shape and bottleneck.",
			"---",
			"# DSA Review",
		].join("\n");
		expect(parseSkillFrontmatter(content)).toEqual({
			name: "dsa-review",
			description: "Analyze a piece of code for DSA quality — measure complexity, recognize problem shape and bottleneck.",
		});
	});

	it("preserves line breaks for a literal `|` block scalar", () => {
		const content = "---\nname: x\ndescription: |\n  line one\n  line two\n---\nbody";
		expect(parseSkillFrontmatter(content)).toEqual({ name: "x", description: "line one\nline two" });
	});

	it("strips matching quotes from quoted scalar values", () => {
		expect(parseSkillFrontmatter('---\nname: x\ndescription: "Quoted description"\n---\n')).toEqual({
			name: "x", description: "Quoted description",
		});
	});

	it("returns null when frontmatter is missing or a required field is absent", () => {
		expect(parseSkillFrontmatter("# No frontmatter at all")).toBeNull();
		expect(parseSkillFrontmatter("---\nname: x\n---\nno description")).toBeNull();
		expect(parseSkillFrontmatter("---\ndescription: only\n---\n")).toBeNull();
	});
});

describe("discoverSkillDirectories", () => {
	it("includes both global locations and project locations up to the git root", () => {
		const dir = tempDir("papyrus-skill-discover-");
		const repoRoot = join(dir, "repo");
		const nested = join(repoRoot, "packages", "app");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		mkdirSync(nested, { recursive: true });

		const directories = discoverSkillDirectories("/home/testuser", nested);

		expect(directories).toContain("/home/testuser/.pi/agent/skills");
		expect(directories).toContain("/home/testuser/.agents/skills");
		expect(directories).toContain(join(nested, ".pi", "skills"));
		expect(directories).toContain(join(nested, ".agents", "skills"));
		expect(directories).toContain(join(repoRoot, ".pi", "skills")); // walked up to the git root
		expect(directories).not.toContain(join(dir, ".pi", "skills")); // stops AT the git root, does not walk past it
	});

	it("includes explicit settings.json skills entries verbatim", () => {
		const directories = discoverSkillDirectories("/home/testuser", "/home/testuser", ["/home/testuser/.claude/skills"]);
		expect(directories).toContain("/home/testuser/.claude/skills");
	});

	it("deduplicates when project and home directory coincide", () => {
		const directories = discoverSkillDirectories("/home/testuser", "/home/testuser");
		expect(new Set(directories).size).toBe(directories.length);
	});
});

describe("scanSkillCatalogFootprint", () => {
	function writeSkill(path: string, name: string, description: string): void {
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
	}

	it("scans nested SKILL.md directories and computes a sorted-by-size footprint", () => {
		const dir = tempDir("papyrus-skill-scan-");
		writeSkill(join(dir, "commit"), "commit", "Short.");
		writeSkill(join(dir, "kernel-sideload"), "kernel-sideload", "A much longer description that costs more tokens than the short one.");

		const footprint = scanSkillCatalogFootprint([dir]);

		expect(footprint.entries).toHaveLength(2);
		expect(footprint.entries[0]!.name).toBe("kernel-sideload"); // sorted descending by size -- biggest offender first
		expect(footprint.entries[1]!.name).toBe("commit");
		expect(footprint.totalCharacters).toBe(footprint.entries[0]!.characters + footprint.entries[1]!.characters);
		expect(footprint.totalEstimatedTokens).toBeGreaterThan(0);
		expect(footprint.scannedDirectories).toEqual([dir]);
	});

	it("discovers direct root .md files only in .pi/agent/skills and .pi/skills, never in .agents/skills", () => {
		const dir = tempDir("papyrus-skill-scan-root-");
		const piAgentSkills = join(dir, ".pi", "agent", "skills");
		const agentsSkills = join(dir, ".agents", "skills");
		mkdirSync(piAgentSkills, { recursive: true });
		mkdirSync(agentsSkills, { recursive: true });
		writeFileSync(join(piAgentSkills, "brave-search.md"), "---\nname: brave-search\ndescription: Web search.\n---\n");
		writeFileSync(join(agentsSkills, "ignored.md"), "---\nname: ignored\ndescription: Should not be discovered.\n---\n");

		const footprint = scanSkillCatalogFootprint([piAgentSkills, agentsSkills]);

		expect(footprint.entries.map((entry) => entry.name)).toEqual(["brave-search"]);
	});

	it("silently skips a missing or unreadable directory rather than throwing", () => {
		const footprint = scanSkillCatalogFootprint(["/definitely/does/not/exist"]);
		expect(footprint).toEqual({ entries: [], totalCharacters: 0, totalEstimatedTokens: 0, scannedDirectories: [] });
	});

	it("skips a skill directory with no description as invalid, per the Agent Skills spec's lenient-but-required rule", () => {
		const dir = tempDir("papyrus-skill-scan-invalid-");
		mkdirSync(join(dir, "broken"), { recursive: true });
		writeFileSync(join(dir, "broken", "SKILL.md"), "---\nname: broken\n---\nNo description field.");

		const footprint = scanSkillCatalogFootprint([dir]);

		expect(footprint.entries).toHaveLength(0);
	});

	it("does not descend into node_modules or .git while walking", () => {
		const dir = tempDir("papyrus-skill-scan-ignore-");
		writeSkill(join(dir, "node_modules", "some-package"), "phantom", "Should never be found.");
		writeSkill(join(dir, "real-skill"), "real-skill", "Should be found.");

		const footprint = scanSkillCatalogFootprint([dir]);

		expect(footprint.entries.map((entry) => entry.name)).toEqual(["real-skill"]);
	});
});
