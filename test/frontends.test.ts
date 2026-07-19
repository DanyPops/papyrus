import { describe, expect, it } from "bun:test";
import { filterArtifactRows, statusSummary } from "../extension/src/artifact-browser.ts";
import { documentRowMeta } from "../extension/src/docs.ts";
import { ruleInjectionPreview, ruleRowMeta } from "../extension/src/rules.ts";
import { skillInvocationPrompt, skillRowMeta } from "../extension/src/skills.ts";
import type { Artifact } from "../src/domain/artifact.ts";

function artifact(overrides: Partial<Artifact>): Artifact {
	return {
		id: "artifact-1",
		kind: "doc",
		title: "Architecture",
		status: "draft",
		subtype: "design",
		body: "SQLite graph design",
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("shared artifact browser model", () => {
	it("filters across identity, content, subtype, labels, and nested metadata", () => {
		const rows = [
			artifact({ labels: ["sqlite"], extra: { decision: { owner: "Daniel" } } }),
			artifact({ id: "rules-2", title: "Testing rule", subtype: "policy", body: "Always verify" }),
		];

		expect(filterArtifactRows(rows, "sqlite")).toHaveLength(1);
		expect(filterArtifactRows(rows, "daniel")).toHaveLength(1);
		expect(filterArtifactRows(rows, "policy")[0]?.id).toBe("rules-2");
	});

	it("summarizes statuses in configured order", () => {
		const rows = [artifact({ status: "active" }), artifact({ id: "2", status: "draft" }), artifact({ id: "3", status: "active" })];
		expect(statusSummary(rows, ["draft", "active", "archived"])).toEqual([
			{ status: "draft", count: 1 },
			{ status: "active", count: 2 },
		]);
	});
});

describe("kind-specific frontend projections", () => {
	it("projects document subtype and labels", () => {
		expect(documentRowMeta(artifact({ subtype: "decision", labels: ["sqlite", "architecture"] }))).toBe("decision · sqlite, architecture");
	});

	it("projects and previews rules exactly as injected", () => {
		const rule = artifact({
			kind: "rule",
			status: "active",
			body: "",
			extra: { severity: "block", condition: "before commit", action: "Run bun test" },
		});
		expect(ruleRowMeta(rule)).toBe("BLOCK · when before commit");
		expect(ruleInjectionPreview(rule)).toContain("• Architecture (when: before commit)\n  Run bun test");
	});

	it("projects skills and produces an invocation prompt", () => {
		const skill = artifact({
			kind: "skill",
			title: "TDD workflow",
			extra: { trigger: "writing code", tools: ["bun test", "tsc"], steps: ["Write failing test", "Implement"] },
		});
		expect(skillRowMeta(skill)).toBe("when writing code · bun test, tsc");
		expect(skillInvocationPrompt(skill)).toContain("Apply Papyrus skill \"TDD workflow\"");
		expect(skillInvocationPrompt(skill)).toContain("1. Write failing test");
	});

	it("identifies artifact templates in the skills browser", () => {
		const template = artifact({ kind: "skill", subtype: "artifact-template", extra: { targetKind: "task" } });
		expect(skillRowMeta(template)).toBe("template → task");
		expect(skillInvocationPrompt(template)).toContain("template_id: artifact-1");
	});
});
