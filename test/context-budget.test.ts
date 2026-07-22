import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeContextBudget, computeRuleBudget, formatContextBudgetReport } from "../extension/src/context-budget.ts";

function rule(id: string, title: string, extra: Record<string, unknown> = {}): { id: string; title: string; body: string; extra: Record<string, unknown> } {
	return { id, title, body: "Do the thing.", extra };
}

describe("computeRuleBudget", () => {
	it("sizes each rule via the same ruleInjectionPreview text actually injected, sorted biggest first", () => {
		const budget = computeRuleBudget([
			rule("short", "Short rule"),
			rule("long", "A rule with a much longer title that costs more characters", { condition: "always", action: "Do more things with more words" }),
		]);
		expect(budget.entries[0]!.id).toBe("long");
		expect(budget.entries[1]!.id).toBe("short");
		expect(budget.totalCharacters).toBe(budget.entries[0]!.characters + budget.entries[1]!.characters);
		expect(budget.totalEstimatedTokens).toBeGreaterThan(0);
	});

	it("reports zero for no active rules rather than throwing", () => {
		expect(computeRuleBudget([])).toEqual({ entries: [], totalCharacters: 0, totalEstimatedTokens: 0 });
	});
});

describe("computeContextBudget", () => {
	it("combines rule and skill footprints into one total", () => {
		const dir = mkdtempSync(join(tmpdir(), "papyrus-budget-"));
		const skillDir = join(dir, "home", ".pi", "agent", "skills", "example");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: example\ndescription: An example skill.\n---\n");

		const budget = computeContextBudget([rule("r1", "A rule")], join(dir, "project"), join(dir, "home"));

		expect(budget.rules.entries).toHaveLength(1);
		expect(budget.skills.entries).toHaveLength(1);
		expect(budget.totalEstimatedTokens).toBe(budget.rules.totalEstimatedTokens + budget.skills.totalEstimatedTokens);
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads settings.json's skills array and includes those directories in the scan", () => {
		const dir = mkdtempSync(join(tmpdir(), "papyrus-budget-settings-"));
		const homeDirectory = join(dir, "home");
		const externalSkills = join(dir, "external-skills", "imported");
		mkdirSync(join(homeDirectory, ".pi", "agent"), { recursive: true });
		mkdirSync(externalSkills, { recursive: true });
		writeFileSync(join(homeDirectory, ".pi", "agent", "settings.json"), JSON.stringify({ skills: [join(dir, "external-skills")] }));
		writeFileSync(join(externalSkills, "SKILL.md"), "---\nname: imported\ndescription: Configured via settings.json.\n---\n");

		const budget = computeContextBudget([], join(dir, "project"), homeDirectory);

		expect(budget.skills.entries.map((entry) => entry.name)).toEqual(["imported"]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("tolerates a missing or malformed settings.json rather than failing the whole report", () => {
		const dir = mkdtempSync(join(tmpdir(), "papyrus-budget-badsettings-"));
		const homeDirectory = join(dir, "home");
		mkdirSync(join(homeDirectory, ".pi", "agent"), { recursive: true });
		writeFileSync(join(homeDirectory, ".pi", "agent", "settings.json"), "{ not valid json");

		expect(() => computeContextBudget([], join(dir, "project"), homeDirectory)).not.toThrow();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("formatContextBudgetReport", () => {
	it("renders a readable report with per-item breakdown and a combined total", () => {
		const report = formatContextBudgetReport({
			rules: { entries: [{ id: "r1", title: "Never mention Papyrus in project docs", characters: 2603, estimatedTokens: 651 }], totalCharacters: 2603, totalEstimatedTokens: 651 },
			skills: {
				entries: [{ name: "ptp-weekly-ci", description: "x", location: "/x/SKILL.md", characters: 472, estimatedTokens: 118 }],
				totalCharacters: 472, totalEstimatedTokens: 118, scannedDirectories: ["/home/user/.claude/skills"],
			},
			totalEstimatedTokens: 769,
		});
		expect(report).toContain("Rules (active, injected every relevant turn): 1 rules · 2603 chars · ~651 tokens");
		expect(report).toContain("Never mention Papyrus in project docs");
		expect(report).toContain("Skills (Pi-native catalog, injected at startup): 1 skills · 472 chars · ~118 tokens");
		expect(report).toContain("ptp-weekly-ci");
		expect(report).toContain("Scanned: /home/user/.claude/skills");
		expect(report).toContain("Total passive tax: ~769 tokens across 2 items");
	});

	it("reports plainly when nothing is found, instead of an empty or confusing section", () => {
		const report = formatContextBudgetReport({
			rules: { entries: [], totalCharacters: 0, totalEstimatedTokens: 0 },
			skills: { entries: [], totalCharacters: 0, totalEstimatedTokens: 0, scannedDirectories: [] },
			totalEstimatedTokens: 0,
		});
		expect(report).toContain("No skill directories found");
		expect(report).toContain("Total passive tax: ~0 tokens across 0 items");
	});
});
