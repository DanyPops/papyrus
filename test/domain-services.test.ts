import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";
afterAll(cleanupTempDirs);
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
	updateDocument,
	createRule,
	listRules,
	previewRule,
	transitionRule,
	gateTaskWithRule,
	assignRuleProject,
	updateRule,
	createSkill,
	createArtifactTemplate,
	instantiateTemplate,
	listSkills,
	skillInvocation,
	transitionSkill,
	assignSkillProject,
	updateSkill,
	createPlaybook,
	listPlaybooks,
	showPlaybook,
	transitionPlaybook,
	assignPlaybookProject,
	updatePlaybook,
	playbookInvocation,
} from "../src/domain-services.ts";

function fixture() {
	const dir = tempDir("papyrus-domain-service-");
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

	it("excludes Discussions, which now share kind \"task\" but are not real work items", () => {
		const { db, artifacts, tasks } = fixture();
		tasks.create({ title: "Real task" });
		artifacts.create({ kind: "task", subtype: "discussion", title: "Some discussion" });
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

	it("rejects a rule whose condition+action+body exceeds the permanent-context-tax bound", () => {
		const { db, artifacts, scopes } = fixture();
		const oversized = "x".repeat(4001);
		expect(() => createRule(artifacts, scopes, { title: "Bloated", body: oversized })).toThrow(/4000-character bound/);
		// A rule right at the boundary, or comfortably under it, is unaffected.
		expect(() => createRule(artifacts, scopes, { title: "Fits", body: "x".repeat(4000) })).not.toThrow();
		expect(() => createRule(artifacts, scopes, { title: "Small", condition: "before commit", action: "Run tests", body: "Short reasoning" })).not.toThrow();
		// The bound is on the SUM of condition+action+body, not any single field alone.
		expect(() => createRule(artifacts, scopes, {
			title: "Split across fields",
			condition: "x".repeat(1500),
			action: "x".repeat(1500),
			body: "x".repeat(1500),
		})).toThrow(/4000-character bound/);
		db.close();
	});

	it("updates a rule's title/body/labels, still enforcing the combined context-tax bound against its existing condition/action", () => {
		const { db, artifacts, scopes } = fixture();
		const rule = createRule(artifacts, scopes, { title: "Test before commit", condition: "x".repeat(1900), action: "x".repeat(1900), body: "short" });
		const updated = updateRule(artifacts, rule.id, { title: "Test before commit v2", labels: ["reviewed"] });
		expect(updated.title).toBe("Test before commit v2");
		expect(updated.labels).toEqual(["reviewed"]);
		// Existing condition/action (1900+1900) plus a new, larger body pushes the combined total over 4000.
		expect(() => updateRule(artifacts, rule.id, { body: "x".repeat(300) })).toThrow(/4000-character bound/);
		expect(() => updateRule(artifacts, rule.id, { body: "short still" })).not.toThrow();
		db.close();
	});

	it("refuses to update a Rule that is a read-only projection from an external system", () => {
		const { db, artifacts, scopes } = fixture();
		const rule = createRule(artifacts, scopes, { title: "Imported policy", labels: ["source:some-external-system"] });
		expect(() => updateRule(artifacts, rule.id, { title: "Edited locally" })).toThrow(/read-only projection from some-external-system/);
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

	it("updates a skill's title/body/labels, refuses an empty update, and refuses an external projection", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const skill = createSkill(artifacts, scopes, { title: "TDD workflow" }, authority);
		const updated = updateSkill(artifacts, skill.id, { title: "TDD workflow v2", body: "revised", labels: ["stable"] });
		expect(updated.title).toBe("TDD workflow v2");
		expect(updated.body).toBe("revised");
		expect(() => updateSkill(artifacts, skill.id, {})).toThrow("update requires title, body, or labels");

		const projected = createSkill(artifacts, scopes, { title: "Imported workflow", labels: ["source:some-external-system"] }, authority);
		expect(() => updateSkill(artifacts, projected.id, { title: "Edited locally" })).toThrow(/read-only projection from some-external-system/);
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

	it("skills are special: invoking one queries Papyrus for its real linked artifacts, not just its own static extra fields", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const spec = createDocument(artifacts, scopes, { title: "API spec", subtype: "design" }, authority);
		const skill = createSkill(artifacts, scopes, { title: "Implement endpoint", trigger: "adding an endpoint", steps: ["Write test"] }, authority);
		artifacts.link({ from: skill.id, relation: "references", to: spec.id });

		const invocation = skillInvocation(artifacts, skill.id);
		expect(invocation).toContain("Linked context (query Papyrus for full detail before proceeding):");
		expect(invocation).toContain(`- references doc "API spec" (${spec.id})`);
	});

	it("skills can call other skills: invoking the caller recursively composes the linked skill's own invocation", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const inner = createSkill(artifacts, scopes, { title: "Inner skill", trigger: "never directly", steps: ["Do the inner thing"] }, authority);
		const outer = createSkill(artifacts, scopes, { title: "Outer skill", trigger: "starting work", steps: ["Do the outer thing"] }, authority);
		artifacts.link({ from: outer.id, relation: "triggers", to: inner.id });

		const invocation = skillInvocation(artifacts, outer.id);
		expect(invocation).toContain('Apply Papyrus skill "Outer skill"');
		expect(invocation).toContain(`Also invoke linked skill (triggers) "Inner skill" (${inner.id}):`);
		expect(invocation).toContain('Apply Papyrus skill "Inner skill"');
		expect(invocation).toContain("Do the inner thing");
		db.close();
	});

	it("degrades a skill-calls-skill cycle to a marker instead of infinite-looping the invocation preview", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const a = createSkill(artifacts, scopes, { title: "A", trigger: "x", steps: [] }, authority);
		const b = createSkill(artifacts, scopes, { title: "B", trigger: "x", steps: [] }, authority);
		artifacts.link({ from: a.id, relation: "triggers", to: b.id });
		artifacts.link({ from: b.id, relation: "triggers", to: a.id });

		const invocation = skillInvocation(artifacts, a.id); // must return, not hang or throw
		expect(invocation).toContain("already invoked above in this chain, not repeated");
		db.close();
	});
});

describe("playbooks domain service -- a completely different beast from Skills, not a subtype", () => {
	it("owns playbook lifecycle and renders trigger/steps/tools plus real linked context on invocation", () => {
		const { db, artifacts, scopes } = fixture();
		const linked = artifacts.create({ kind: "doc", title: "Reference doc", status: "draft" });
		const playbook = createPlaybook(artifacts, scopes, { title: "New Project", trigger: "starting something from scratch", steps: ["Frame the problem", "State the goal"], tools: ["discuss"] });
		expect(playbook.kind).toBe("playbook");
		artifacts.link({ from: playbook.id, relation: "references", to: linked.id });

		const invocation = playbookInvocation(artifacts, playbook.id);
		expect(invocation).toContain('Apply Papyrus playbook "New Project"');
		expect(invocation).toContain("Trigger: starting something from scratch");
		expect(invocation).toContain("1. Frame the problem");
		expect(invocation).toContain("2. State the goal");
		expect(invocation).toContain("Tools: discuss");
		expect(invocation).toContain('references doc "Reference doc"');
		// No skill-calls-skill-style nested composition exists for Playbooks.
		expect(invocation).not.toContain("Also invoke linked");

		expect(transitionPlaybook(artifacts, playbook.id, "disable").status).toBe("deprecated");
		expect(transitionPlaybook(artifacts, playbook.id, "enable").status).toBe("active");
		expect(listPlaybooks(artifacts, scopes, {})).toHaveLength(1);
		expect(showPlaybook(artifacts, playbook.id).id).toBe(playbook.id);
		db.close();
	});

	it("declares arguments; invoke lists provided values, flags missing required ones, and directs the agent to discuss live:true rather than guess", () => {
		const { db, artifacts, scopes } = fixture();
		const playbook = createPlaybook(artifacts, scopes, {
			title: "Deploy service",
			trigger: "deploying a service",
			steps: ["Build the image", "Push to the target environment"],
			arguments: [
				{ name: "service_name", description: "which service to deploy" },
				{ name: "environment", description: "target environment", required: true },
				{ name: "dry_run", description: "skip the real push", required: false },
			],
		});

		const noArgs = playbookInvocation(artifacts, playbook.id);
		expect(noArgs).toContain("- service_name (required: which service to deploy) -- not yet provided");
		expect(noArgs).toContain("- dry_run (optional: skip the real push) -- not yet provided");
		expect(noArgs).toContain("Missing required argument(s): service_name, environment.");
		expect(noArgs).toContain("discuss tool with live:true");

		const partial = playbookInvocation(artifacts, playbook.id, { service_name: "payments-api" });
		expect(partial).toContain("- service_name: payments-api");
		expect(partial).toContain("Missing required argument(s): environment.");
		expect(partial).not.toContain("service_name, environment"); // service_name is no longer missing

		const complete = playbookInvocation(artifacts, playbook.id, { service_name: "payments-api", environment: "staging" });
		expect(complete).not.toContain("Missing required argument");
		expect(complete).toContain("- environment: staging");
		db.close();
	});

	it("rejects malformed argument declarations at creation: not an array, too many, duplicate names, bad required type", () => {
		const { db, artifacts, scopes } = fixture();
		expect(() => createPlaybook(artifacts, scopes, { title: "Bad", arguments: "nope" })).toThrow("playbook arguments must be an array");
		expect(() => createPlaybook(artifacts, scopes, { title: "Bad", arguments: Array.from({ length: 21 }, (_, i) => ({ name: `a${i}` })) })).toThrow(/cannot exceed 20 entries/);
		expect(() => createPlaybook(artifacts, scopes, { title: "Bad", arguments: [{ name: "x" }, { name: "x" }] })).toThrow('argument name "x" is declared more than once');
		expect(() => createPlaybook(artifacts, scopes, { title: "Bad", arguments: [{ name: "x", required: "yes" }] })).toThrow('argument "x" required must be a boolean');
		expect(() => createPlaybook(artifacts, scopes, { title: "Bad", arguments: [{}] })).toThrow(/argument name must be between/);
		db.close();
	});

	it("scopes, reassigns, updates, and rejects a read-only external projection, the same as Docs/Rules/Skills", () => {
		const { db, artifacts, scopes } = fixture();
		const playbook = createPlaybook(artifacts, scopes, { title: "Scoped playbook", projectRoot: "/workspace/papyrus" });
		expect(listPlaybooks(artifacts, scopes, { projectRoot: "/workspace/papyrus" })).toHaveLength(1);
		expect(assignPlaybookProject(artifacts, scopes, playbook.id, undefined).id).toBe(playbook.id);
		expect(listPlaybooks(artifacts, scopes, { projectRoot: "/workspace/papyrus" })).toHaveLength(0);

		const updated = updatePlaybook(artifacts, playbook.id, { title: "Renamed playbook" });
		expect(updated.title).toBe("Renamed playbook");
		expect(() => updatePlaybook(artifacts, playbook.id, {})).toThrow("update requires title, body, or labels");

		const projected = createPlaybook(artifacts, scopes, { title: "Imported playbook", labels: ["source:some-external-system"] });
		expect(() => updatePlaybook(artifacts, projected.id, { title: "Edited locally" })).toThrow(/read-only projection from some-external-system/);
		db.close();
	});

	it("rejects playbook actions against another artifact kind, including a real Skill", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const skill = createSkill(artifacts, scopes, { title: "Not a playbook", trigger: "x", steps: [] }, authority);
		expect(() => showPlaybook(artifacts, skill.id)).toThrow("is not a playbook");
		expect(() => transitionPlaybook(artifacts, skill.id, "disable")).toThrow("is not a playbook");
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

	it("updates a document's title, body, and labels, and refuses an empty update", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const document = createDocument(artifacts, scopes, { title: "Architecture v1", body: "draft notes" }, authority);
		const updated = updateDocument(artifacts, document.id, { title: "Architecture v2", body: "revised notes", labels: ["reviewed"] }, authority);
		expect(updated.title).toBe("Architecture v2");
		expect(updated.body).toBe("revised notes");
		expect(updated.labels).toEqual(["reviewed"]);
		expect(() => updateDocument(artifacts, document.id, {}, authority)).toThrow("update requires title, body, or labels");
		expect(() => updateDocument(artifacts, document.id, { title: "" }, authority)).toThrow(/title must be between/);
		db.close();
	});

	it("refuses to update a Doc that is a read-only projection from an external system", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const document = createDocument(artifacts, scopes, { title: "Ingested page", labels: ["source:web-spider", "domain:example.com"] }, authority);
		expect(() => updateDocument(artifacts, document.id, { title: "Edited locally" }, authority)).toThrow(/read-only projection from web-spider/);
		db.close();
	});

	it("rejects updating a Note through docs.update -- notes go through notes.* like everything else about them", () => {
		const { db, artifacts, authority } = fixture();
		const note = artifacts.create({ kind: "doc", subtype: "note", title: "A note", status: "active" });
		expect(() => updateDocument(artifacts, note.id, { title: "Edited" }, authority)).toThrow("note access requires a notes.* operation");
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
