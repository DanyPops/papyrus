import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteArtifactScopeStore } from "../src/adapters/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteGateRunner } from "../src/adapters/sqlite-gate-runner.ts";
import { AuthorityRegistry } from "../src/authority-registry.ts";
import { openDb } from "../src/db.ts";
import { Tasks } from "../src/task-service.ts";
import {
	createDocument,
	listDocuments,
	transitionDocument,
	assignDocumentProject,
	createRule,
	listRules,
	previewRule,
	transitionRule,
	gateTaskWithRule,
	assignRuleProject,
	createSkill,
	createArtifactTemplate,
	instantiateTemplate,
	listSkills,
	skillInvocation,
	transitionSkill,
	assignSkillProject,
} from "../src/domain-services.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "papyrus-domain-service-"));
	const db = openDb(join(dir, "papyrus.db"));
	const artifacts = new SQLiteArtifactStore(db);
	return { db, dir, artifacts, scopes: new SQLiteArtifactScopeStore(db), authority: new AuthorityRegistry(), tasks: new Tasks(artifacts, new SQLiteGateRunner(db)) };
}

describe("tasks application API", () => {
	it("creates and exposes task composition and dependencies as a graph", () => {
		const { db, tasks } = fixture();
		const epic = tasks.create({ title: "Ship Papyrus" });
		const prerequisite = tasks.create({ title: "Write design" });
		const child = tasks.create({ title: "Build frontend", parentId: epic.id, dependsOn: [prerequisite.id] });

		const graph = tasks.graph();
		const epicNode = graph.nodes.find((node) => node.task.id === epic.id)!;
		const childNode = graph.nodes.find((node) => node.task.id === child.id)!;
		expect(graph.rootIds).toContain(epic.id);
		expect(epicNode.childIds).toEqual([child.id]);
		expect(childNode.parentIds).toEqual([epic.id]);
		expect(childNode.dependencyIds).toEqual([prerequisite.id]);
		db.close();
	});

	it("enforces lifecycle and refuses completion until gates pass", () => {
		const { db, dir, tasks } = fixture();
		const output = join(dir, "built.txt");
		const task = tasks.create({ title: "Build output", gates: [{ type: "file-exists", target: output }] });

		expect(tasks.transition(task.id, "start").status).toBe("in-progress");
		expect(tasks.transition(task.id, "submit").status).toBe("review");
		const blocked = tasks.complete(task.id);
		expect(blocked.completed).toBe(false);
		expect(blocked.artifact.status).toBe("rejected");
		expect(blocked.gates[0]?.passed).toBe(false);

		writeFileSync(output, "done");
		expect(tasks.transition(task.id, "retry").status).toBe("in-progress");
		expect(tasks.transition(task.id, "submit").status).toBe("review");
		expect(tasks.complete(task.id).completed).toBe(true);
		expect(() => tasks.transition(task.id, "start")).toThrow("cannot start task from done");
		db.close();
	});

	it("lists only task artifacts", () => {
		const { db, artifacts, tasks } = fixture();
		tasks.create({ title: "Task" });
		artifacts.create({ kind: "doc", title: "Document" });
		expect(tasks.list()).toHaveLength(1);
		db.close();
	});
});

describe("rules domain service", () => {
	it("owns rule lifecycle, injection preview, and task gating", () => {
		const { db, artifacts, scopes, tasks } = fixture();
		const rule = createRule(artifacts, scopes, { title: "Test before commit", condition: "before commit", action: "Run bun test", severity: "block" });
		const task = tasks.create({ title: "Ship" });
		expect(rule.kind).toBe("rule");
		expect(previewRule(artifacts, rule.id)).toContain("• Test before commit (when: before commit)\n  Run bun test");
		expect(gateTaskWithRule(artifacts, rule.id, task.id).edges).toContainEqual({ from: rule.id, relation: "gates", to: task.id });
		expect(transitionRule(artifacts, rule.id, "disable").status).toBe("deprecated");
		expect(transitionRule(artifacts, rule.id, "enable").status).toBe("active");
		expect(listRules(artifacts, scopes, {})).toHaveLength(1);
		db.close();
	});
});

describe("skills domain service", () => {
	it("owns skill lifecycle and invocation projection", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const skill = createSkill(artifacts, scopes, { title: "TDD workflow", trigger: "writing code", steps: ["Write failing test", "Implement"], tools: ["bun test"] }, authority);
		expect(skillInvocation(artifacts, skill.id)).toContain("1. Write failing test");
		expect(transitionSkill(artifacts, skill.id, "disable").status).toBe("deprecated");
		expect(transitionSkill(artifacts, skill.id, "enable").status).toBe("active");
		expect(listSkills(artifacts, scopes, {})).toHaveLength(1);
		db.close();
	});

	it("creates and instantiates artifact templates", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const template = createArtifactTemplate(artifacts, scopes, {
			title: "Research document", targetKind: "doc", defaults: { subtype: "research", labels: ["research"] }, required: ["title", "body"],
		}, authority);
		const document = instantiateTemplate(artifacts, template.id, { title: "Findings", body: "Verified evidence" }, authority);
		expect(document.kind).toBe("doc");
		expect(document.subtype).toBe("research");
		db.close();
	});
});

describe("documents domain service", () => {
	it("owns document creation and lifecycle", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const document = createDocument(artifacts, scopes, { title: "Architecture", subtype: "design", labels: ["sqlite"] }, authority);
		expect(transitionDocument(artifacts, document.id, "activate", authority).status).toBe("active");
		expect(transitionDocument(artifacts, document.id, "archive", authority).status).toBe("archived");
		expect(transitionDocument(artifacts, document.id, "reopen", authority).status).toBe("draft");
		expect(listDocuments(artifacts, scopes, { text: "Architecture" })).toHaveLength(1);
		db.close();
	});

	it("rejects document actions against another artifact kind", () => {
		const { db, artifacts, authority, tasks } = fixture();
		const task = tasks.create({ title: "Not a document" });
		expect(() => transitionDocument(artifacts, task.id, "archive", authority)).toThrow("is not a doc");
		db.close();
	});
});

// Defect: Docs (and Rules/Skills) had no project_root support at creation, no way to
// reassign one after the fact, and no project-filtered list -- unlike Tasks, which has
// had all three since task-project-scope. Mirrors Tasks' ArtifactScopeStore-backed shape
// (a separate table/port, not folded into Task-named infrastructure) rather than assuming
// project scoping is Task-specific.
describe("Docs/Rules/Skills project scoping (papyrus-defect-docs-and-likely-rulesskills-cannot-be-reassig-ucgf)", () => {
	it("scopes a Document to a project at creation, lists it by project, and leaves other projects unaffected", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const scoped = createDocument(artifacts, scopes, { title: "Scoped doc", projectRoot: "/workspace/papyrus" }, authority);
		const unscoped = createDocument(artifacts, scopes, { title: "Unscoped doc" }, authority);
		expect(listDocuments(artifacts, scopes, { projectRoot: "/workspace/papyrus" }).map((doc) => doc.id)).toEqual([scoped.id]);
		expect(listDocuments(artifacts, scopes, { projectRoot: "/workspace/other" })).toEqual([]);
		expect(listDocuments(artifacts, scopes, {}).map((doc) => doc.id).sort()).toEqual([scoped.id, unscoped.id].sort());
		db.close();
	});

	it("reassigns a Document to a different project after creation, and can unscope it", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const document = createDocument(artifacts, scopes, { title: "Doc", projectRoot: "/workspace/papyrus" }, authority);
		assignDocumentProject(artifacts, scopes, document.id, "/workspace/other");
		expect(listDocuments(artifacts, scopes, { projectRoot: "/workspace/papyrus" })).toEqual([]);
		expect(listDocuments(artifacts, scopes, { projectRoot: "/workspace/other" }).map((doc) => doc.id)).toEqual([document.id]);
		assignDocumentProject(artifacts, scopes, document.id, undefined);
		expect(listDocuments(artifacts, scopes, { projectRoot: "/workspace/other" })).toEqual([]);
		db.close();
	});

	it("rejects reassigning a Note's project through docs.assign_project -- notes go through notes.* like everything else about them", () => {
		const { db, artifacts, scopes } = fixture();
		const note = artifacts.create({ kind: "doc", subtype: "note", status: "draft", title: "A note" });
		expect(() => assignDocumentProject(artifacts, scopes, note.id, "/workspace/papyrus")).toThrow("note access requires a notes.* operation");
		db.close();
	});

	it("rejects assigning a project to an id that is not a Document", () => {
		const { db, artifacts, scopes, tasks } = fixture();
		const task = tasks.create({ title: "Not a document" });
		expect(() => assignDocumentProject(artifacts, scopes, task.id, "/workspace/papyrus")).toThrow("is not a doc");
		db.close();
	});

	it("scopes, lists, and reassigns a Rule's project the same way", () => {
		const { db, artifacts, scopes } = fixture();
		const rule = createRule(artifacts, scopes, { title: "Scoped rule", projectRoot: "/workspace/papyrus" });
		createRule(artifacts, scopes, { title: "Unscoped rule" });
		expect(listRules(artifacts, scopes, { projectRoot: "/workspace/papyrus" }).map((r) => r.id)).toEqual([rule.id]);
		assignRuleProject(artifacts, scopes, rule.id, "/workspace/other");
		expect(listRules(artifacts, scopes, { projectRoot: "/workspace/papyrus" })).toEqual([]);
		expect(listRules(artifacts, scopes, { projectRoot: "/workspace/other" }).map((r) => r.id)).toEqual([rule.id]);
		db.close();
	});

	it("scopes, lists, and reassigns a Skill's and an artifact template's project the same way", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const skill = createSkill(artifacts, scopes, { title: "Scoped skill", projectRoot: "/workspace/papyrus" }, authority);
		const template = createArtifactTemplate(artifacts, scopes, { title: "Scoped template", targetKind: "doc", projectRoot: "/workspace/papyrus" }, authority);
		createSkill(artifacts, scopes, { title: "Unscoped skill" }, authority);
		expect(listSkills(artifacts, scopes, { projectRoot: "/workspace/papyrus" }).map((s) => s.id).sort()).toEqual([skill.id, template.id].sort());
		assignSkillProject(artifacts, scopes, skill.id, "/workspace/other");
		expect(listSkills(artifacts, scopes, { projectRoot: "/workspace/papyrus" }).map((s) => s.id)).toEqual([template.id]);
		db.close();
	});

	it("rejects a non-absolute project_root, matching Tasks' own validation", () => {
		const { db, artifacts, scopes, authority } = fixture();
		expect(() => createDocument(artifacts, scopes, { title: "Bad", projectRoot: "relative/path" }, authority)).toThrow("project_root must be an absolute path");
		db.close();
	});
});

// Regression: the Task-creation defect (fixed in Tasks.create by hardcoding an explicit
// status instead of falling through to defaultStatusFor's "first status row by rowid"
// heuristic) is a bug *class*, not a one-off. defaultStatusFor picks whichever status a
// migration or manual edit happened to insert first for a kind -- any creation path that
// omits status is equally exposed. Reproduce the adversarial condition directly (reorder
// a kind's status rows so the wrong one is rowid-first) and assert every creation path
// that has no caller-supplied status still lands on its documented default regardless.
describe("artifact creation is immune to status seed/row order for every kind, not only tasks", () => {
	function adversariallyReorderStatuses(db: ReturnType<typeof openDb>, kind: string, correctDefault: string): void {
		// Simulate what a migration or manual repair can do: delete and reinsert a kind's status
		// rows so a status other than the documented default gets the lowest (earliest) rowid.
		const rows = db.prepare("SELECT name FROM statuses WHERE kind = ?").all(kind) as Array<{ name: string }>;
		db.prepare("DELETE FROM statuses WHERE kind = ?").run(kind);
		for (const row of rows) {
			if (row.name === correctDefault) continue; // reinsert every other status first
			db.prepare("INSERT INTO statuses (name, kind) VALUES (?, ?)").run(row.name, kind);
		}
		db.prepare("INSERT INTO statuses (name, kind) VALUES (?, ?)").run(correctDefault, kind); // documented default now rowid-last
		const rowidFirst = db.prepare("SELECT name FROM statuses WHERE kind = ? ORDER BY rowid LIMIT 1").get(kind) as { name: string };
		expect(rowidFirst.name).not.toBe(correctDefault); // sanity: the adversarial condition actually holds
	}

	it("creates a Document as draft even when another doc status is rowid-first", () => {
		const { db, artifacts, scopes, authority } = fixture();
		adversariallyReorderStatuses(db, "doc", "draft");
		expect(createDocument(artifacts, scopes, { title: "Adversarial" }, authority).status).toBe("draft");
		db.close();
	});

	it("creates a Rule as active even when another rule status is rowid-first", () => {
		const { db, artifacts, scopes } = fixture();
		adversariallyReorderStatuses(db, "rule", "active");
		expect(createRule(artifacts, scopes, { title: "Adversarial" }).status).toBe("active");
		db.close();
	});

	it("creates a Skill and an artifact template as active even when another skill status is rowid-first", () => {
		const { db, artifacts, scopes, authority } = fixture();
		adversariallyReorderStatuses(db, "skill", "active");
		expect(createSkill(artifacts, scopes, { title: "Adversarial" }, authority).status).toBe("active");
		expect(createArtifactTemplate(artifacts, scopes, { title: "Adversarial template", targetKind: "doc" }, authority).status).toBe("active");
		db.close();
	});
});
