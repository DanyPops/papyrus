import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { filterArtifactRows, statusSummary } from "../extension/src/artifact-browser.ts";
import { documentRowMeta } from "../extension/src/docs.ts";
import { matchTaskByName, taskLine, taskLines } from "../extension/src/domain-tools.ts";
import { discussionRowMeta } from "../extension/src/discuss.ts";
import { discussionRoundCountOf, discussionStateOf } from "../extension/src/discussion-detail-view.ts";
import { noteCaptureInput, noteListInput, noteRowMeta } from "../extension/src/notes.ts";
import { NOTE_LIST_MAX_LIMIT } from "../src/constants.ts";
import { ruleInjectionPreview, ruleRowMeta } from "../extension/src/rules.ts";
import { skillInvocationPrompt, skillRowMeta, skillRunTaskGraph } from "../extension/src/skills.ts";
import {
	DISCUSSION_STATE_PRESENTATION,
	DOC_STATUS_PRESENTATION,
	NOTE_STATUS_PRESENTATION,
	RULE_STATUS_PRESENTATION,
	severityColor,
	SKILL_STATUS_PRESENTATION,
} from "../extension/src/artifact-status-presentation.ts";
import type { Artifact } from "../src/domain/artifact.ts";

const theme = {
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as Theme;

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
		expect(documentRowMeta(artifact({ subtype: "decision", labels: ["sqlite", "architecture"] }), theme)).toBe("decision · sqlite, architecture");
	});

	it("exposes Notes through direct commands, a bounded inbox, and one domain tool", () => {
		expect(noteRowMeta(artifact({ subtype: "note", extra: { noteHistory: [{ action: "captured" }, { action: "consumed" }] } }))).toBe("2 events");
		expect(noteCaptureInput("  Review this later  ", "/workspace/papyrus")).toEqual({
			body: "Review this later", project_root: "/workspace/papyrus", actor: "human", source: "note-command",
		});
		expect(noteCaptureInput("   ", "/workspace/papyrus")).toBeNull();
		// Regression: the generic artifact browser defaults to a 500-row page, which exceeds
		// notes.list's own NOTE_LIST_MAX_LIMIT (200) and made /notes fail with an opaque
		// extension error instead of ever rendering. The Notes inbox must request within its
		// own bound explicitly rather than relying on the browser's generic default.
		expect(noteListInput("/workspace/papyrus")).toEqual({ project_root: "/workspace/papyrus", limit: NOTE_LIST_MAX_LIMIT });
		expect(NOTE_LIST_MAX_LIMIT).toBeLessThan(500);
		const extension = readFileSync(new URL("../extension/src/index.ts", import.meta.url), "utf8");
		const tools = readFileSync(new URL("../extension/src/domain-tools.ts", import.meta.url), "utf8");
		expect(extension).toContain('registerCommand("note"');
		expect(extension).toContain('registerCommand("notes"');
		expect(tools).toContain('name: "notes"');
		for (const operation of ["notes.capture", "notes.list", "notes.show", "notes.consume", "notes.promote", "notes.archive"]) {
			expect(tools).toContain(operation);
		}
	});

	it("projects and previews rules exactly as injected", () => {
		const rule = artifact({
			kind: "rule",
			status: "active",
			body: "",
			extra: { severity: "block", condition: "before commit", action: "Run bun test" },
		});
		expect(ruleRowMeta(rule, theme)).toBe("BLOCK · when before commit");
		expect(ruleInjectionPreview(rule)).toContain("• Architecture (when: before commit)\n  Run bun test");
	});

	it("colors rule severity distinctly, so BLOCK/WARN/INFO are never visually identical", () => {
		const distinguishingTheme = { ...theme, fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as Theme;
		const severities = ["block", "warn", "info"] as const;
		const rendered = severities.map((severity) => ruleRowMeta(artifact({ kind: "rule", extra: { severity, condition: "x" } }), distinguishingTheme));
		const colorsUsed = new Set(rendered.map((line) => line.match(/^<(\w+)>/)?.[1]));
		expect(colorsUsed.size).toBe(3); // block, warn, info each get a genuinely different color, not the same fallback
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

	it("identifies executable workflows in the skills browser", () => {
		const workflow = artifact({
			kind: "skill",
			subtype: "workflow",
			extra: {
				definition: {
					inputs: { project: { type: "string" } },
					blueprints: { tasks: [{ ref: "work", title: "Work" }], docs: [], rules: [] },
				},
			},
		});
		expect(skillRowMeta(workflow)).toBe("workflow · 1 inputs · 1 tasks");
		expect(skillInvocationPrompt(workflow)).toContain("action=run");
		const task = artifact({ id: "run-work", kind: "task", title: "Work", status: "todo" });
		const graph = skillRunTaskGraph({
			skillId: workflow.id,
			runId: "run",
			arguments: { project: "Papyrus" },
			created: { docs: ["run-context"], rules: ["run-rule"], tasks: [task.id], skillRuns: [] },
			rootTaskIds: [task.id],
			execution: {
				layers: [[task.id]],
				cycleIds: [],
				nodes: [{
					id: task.id, title: task.title, status: "todo", active: false, state: "ready", layer: 0,
					prerequisiteIds: [], successorIds: [],
				}],
			},
		}, [task]);
		expect(graph.rootIds).toEqual([task.id]);
		expect(graph.nodes[0]).toMatchObject({ task: { id: task.id }, dependencyIds: [] });
	});
});

describe("status presentation: every browsable kind's statuses are colored, not just glyphed", () => {
	for (const [kindLabel, presentation] of [
		["rule", RULE_STATUS_PRESENTATION],
		["doc", DOC_STATUS_PRESENTATION],
		["note", NOTE_STATUS_PRESENTATION],
		["skill", SKILL_STATUS_PRESENTATION],
		["discussion", DISCUSSION_STATE_PRESENTATION],
	] as const) {
		it(`${kindLabel}: every status has a distinct color from every other status in the same kind`, () => {
			const entries = Object.entries(presentation);
			const colors = entries.map(([, value]) => value.color);
			expect(new Set(colors).size).toBe(colors.length); // no two statuses share a color within one kind
			for (const [status, value] of entries) {
				expect(value.glyph.length).toBeGreaterThan(0);
				expect(value.label.length).toBeGreaterThan(0);
				expect(status).toBeTruthy();
			}
		});
	}

	it("active is never the same color as deprecated/archived/draft, across every kind", () => {
		// This is the exact, literal complaint this feature closes: "hard to understand which
		// rules are active" traces to active/deprecated differing only by glyph shape (filled vs
		// hollow circle), not color. Lock in that active always reads as success-green.
		for (const presentation of [RULE_STATUS_PRESENTATION, SKILL_STATUS_PRESENTATION]) {
			expect(presentation["active"]!.color).toBe("success");
			expect(presentation["deprecated"]!.color).not.toBe("success");
		}
		expect(DOC_STATUS_PRESENTATION["active"]!.color).toBe("success");
		expect(NOTE_STATUS_PRESENTATION["active"]!.color).toBe("success");
	});

	it("maps every rule severity to a distinct color, defaulting unknown severities to muted rather than throwing", () => {
		expect(severityColor("block")).toBe("error");
		expect(severityColor("warn")).toBe("warning");
		expect(severityColor("info")).toBe("accent");
		expect(severityColor("BLOCK")).toBe("error"); // case-insensitive, since severity is often stored uppercased for display
		expect(severityColor("unknown-severity")).toBe("muted");
	});
});

describe("kind-specific frontend projections (continued)", () => {
	it("identifies artifact templates in the skills browser", () => {
		const template = artifact({ kind: "skill", subtype: "artifact-template", extra: { targetKind: "task" } });
		expect(skillRowMeta(template)).toBe("template → task");
		expect(skillInvocationPrompt(template)).toContain("template_id: artifact-1");
	});
});

describe("Tasks tool: name is the primary interfacing point, id stays backend-only", () => {
	function task(overrides: Partial<Artifact> = {}): Artifact {
		return artifact({ kind: "task", subtype: "", status: "todo", title: "Fix the thing", ...overrides });
	}

	it("taskLine never includes id, unlike the shared artifactLine", () => {
		const t = task({ id: "1307c008-7326-47fa-9551-9529aff1592c", status: "review", title: "Observe Vertex budget" });
		expect(taskLine(t)).toBe("[review] Observe Vertex budget");
		expect(taskLine(t)).not.toContain("1307c008");
	});

	it("taskLines omits id for distinct titles but appends it for a colliding title, so two same-named tasks stay distinguishable", () => {
		const unique = [task({ id: "a", title: "Alpha" }), task({ id: "b", title: "Beta" })];
		expect(taskLines(unique)).toEqual(["[todo] Alpha", "[todo] Beta"]);

		const colliding = [task({ id: "a", title: "Fix bug" }), task({ id: "b", title: "Fix bug" }), task({ id: "c", title: "Ship it" })];
		expect(taskLines(colliding)).toEqual(["[todo] Fix bug (a)", "[todo] Fix bug (b)", "[todo] Ship it"]);
	});

	it("matchTaskByName resolves a unique, case-insensitive, trimmed title match", () => {
		const candidates = [task({ id: "a", title: "Fix the thing" }), task({ id: "b", title: "Something else" })];
		expect(matchTaskByName(candidates, "  fix THE thing  ")).toBe("a");
	});

	it("matchTaskByName refuses when nothing matches", () => {
		expect(() => matchTaskByName([task({ title: "Something else" })], "missing")).toThrow(/no task named "missing" found/);
	});

	it("matchTaskByName refuses ambiguity and surfaces real ids only at that point, to disambiguate", () => {
		const candidates = [task({ id: "task-a", title: "Fix bug" }), task({ id: "task-b", title: "Fix bug" })];
		expect(() => matchTaskByName(candidates, "Fix bug")).toThrow(/2 tasks are named "Fix bug": Fix bug \(task-a\), Fix bug \(task-b\) -- use id to disambiguate/);
	});

	it("registers name-based equivalents for id, dependency_id, parent_id, child_id, root_task_id, and depends_on", () => {
		const tools = readFileSync(new URL("../extension/src/domain-tools.ts", import.meta.url), "utf8");
		for (const field of ["name:", "dependency_name:", "parent_name:", "child_name:", "root_task_name:", "depends_on_names:"]) {
			expect(tools).toContain(field);
		}
	});
});

describe("/discuss TUI: real lifecycle surfaced in rowMeta, not just the shared doc status glyph", () => {
	function discussion(state: string, roundCount: number): Artifact {
		return artifact({ subtype: "discussion", status: state === "settled" ? "archived" : "active", extra: { discussion: { state, roundCount } } });
	}

	it("reads state and round count defensively, defaulting to a safe read-only fallback on corrupt extra", () => {
		expect(discussionStateOf(discussion("active", 3))).toBe("active");
		expect(discussionRoundCountOf(discussion("active", 3))).toBe(3);
		const corrupt = artifact({ subtype: "discussion", extra: { discussion: { state: "not-a-real-state" } } });
		expect(discussionStateOf(corrupt)).toBe("unknown");
		expect(discussionRoundCountOf(corrupt)).toBe(0);
	});

	it("projects state and round count into rowMeta text, since the shared doc status glyph can't distinguish active from deferred", () => {
		// Regression: a settled Discussion's doc.status becomes "archived" but a *deferred* one
		// stays "active" at the doc level (domain/discussion.ts) -- the row glyph alone would render
		// active and deferred identically. rowMeta is where that real distinction must show up.
		expect(discussionRowMeta(discussion("active", 1), theme)).toBe("● active · 1 round");
		expect(discussionRowMeta(discussion("deferred", 2), theme)).toBe("⏸ deferred · 2 rounds");
		expect(discussionRowMeta(discussion("settled", 5), theme)).toBe("✓ settled · 5 rounds");
	});

	it("colors active/deferred/settled distinctly from one another", () => {
		const distinguishingTheme = { ...theme, fg: (color: string, text: string) => `<${color}>${text}</${color}>` } as Theme;
		const rendered = ["active", "deferred", "settled"].map((state) => discussionRowMeta(discussion(state, 1), distinguishingTheme));
		const colorsUsed = new Set(rendered.map((line) => line.match(/^<(\w+)>/)?.[1]));
		expect(colorsUsed.size).toBe(3);
	});

	it("surfaces a pending posed choice in rowMeta, since it's the one thing worth seeing before opening the transcript", () => {
		const awaiting = artifact({ subtype: "discussion", extra: { discussion: { state: "active", roundCount: 1, pendingOptions: ["A", "B"], pendingOptionsMode: "single" } } });
		expect(discussionRowMeta(awaiting, theme)).toBe("\u25cf active \u00b7 1 round \u00b7 awaiting: A/B");
		expect(discussionRowMeta(discussion("active", 1), theme)).not.toContain("awaiting");
	});

	it("registers the /discuss command and the discuss domain tool exposing every discuss.* operation", () => {
		const extension = readFileSync(new URL("../extension/src/index.ts", import.meta.url), "utf8");
		const tools = readFileSync(new URL("../extension/src/domain-tools.ts", import.meta.url), "utf8");
		expect(extension).toContain('registerCommand("discuss"');
		expect(tools).toContain('name: "discuss"');
		for (const operation of [
			"discuss.open", "discuss.reply", "discuss.defer", "discuss.resume", "discuss.settle",
			"discuss.block", "discuss.unblock", "discuss.show", "discuss.rounds", "discuss.list",
		]) {
			expect(tools).toContain(operation);
		}
	});
});
