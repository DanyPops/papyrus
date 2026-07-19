import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteGateRunner } from "../src/adapters/sqlite-gate-runner.ts";
import { openDb } from "../src/db.ts";
import { Tasks } from "../src/task-service.ts";
import {
	createDocument,
	listDocuments,
	transitionDocument,
	createRule,
	listRules,
	previewRule,
	transitionRule,
	gateTaskWithRule,
	createSkill,
	createArtifactTemplate,
	instantiateTemplate,
	listSkills,
	skillInvocation,
	transitionSkill,
} from "../src/domain-services.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "papyrus-domain-service-"));
	const db = openDb(join(dir, "papyrus.db"));
	const artifacts = new SQLiteArtifactStore(db);
	return { db, dir, artifacts, tasks: new Tasks(artifacts, new SQLiteGateRunner(db)) };
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
		const { db, artifacts, tasks } = fixture();
		const rule = createRule(artifacts, { title: "Test before commit", condition: "before commit", action: "Run bun test", severity: "block" });
		const task = tasks.create({ title: "Ship" });
		expect(rule.kind).toBe("rule");
		expect(previewRule(artifacts, rule.id)).toContain("• Test before commit (when: before commit)\n  Run bun test");
		expect(gateTaskWithRule(artifacts, rule.id, task.id).edges).toContainEqual({ from: rule.id, relation: "gates", to: task.id });
		expect(transitionRule(artifacts, rule.id, "disable").status).toBe("deprecated");
		expect(transitionRule(artifacts, rule.id, "enable").status).toBe("active");
		expect(listRules(artifacts, {})).toHaveLength(1);
		db.close();
	});
});

describe("skills domain service", () => {
	it("owns skill lifecycle and invocation projection", () => {
		const { db, artifacts } = fixture();
		const skill = createSkill(artifacts, { title: "TDD workflow", trigger: "writing code", steps: ["Write failing test", "Implement"], tools: ["bun test"] });
		expect(skillInvocation(artifacts, skill.id)).toContain("1. Write failing test");
		expect(transitionSkill(artifacts, skill.id, "disable").status).toBe("deprecated");
		expect(transitionSkill(artifacts, skill.id, "enable").status).toBe("active");
		expect(listSkills(artifacts, {})).toHaveLength(1);
		db.close();
	});

	it("creates and instantiates artifact templates", () => {
		const { db, artifacts } = fixture();
		const template = createArtifactTemplate(artifacts, {
			title: "Research document", targetKind: "doc", defaults: { subtype: "research", labels: ["research"] }, required: ["title", "body"],
		});
		const document = instantiateTemplate(artifacts, template.id, { title: "Findings", body: "Verified evidence" });
		expect(document.kind).toBe("doc");
		expect(document.subtype).toBe("research");
		db.close();
	});
});

describe("documents domain service", () => {
	it("owns document creation and lifecycle", () => {
		const { db, artifacts } = fixture();
		const document = createDocument(artifacts, { title: "Architecture", subtype: "design", labels: ["sqlite"] });
		expect(transitionDocument(artifacts, document.id, "activate").status).toBe("active");
		expect(transitionDocument(artifacts, document.id, "archive").status).toBe("archived");
		expect(transitionDocument(artifacts, document.id, "reopen").status).toBe("draft");
		expect(listDocuments(artifacts, { text: "Architecture" })).toHaveLength(1);
		db.close();
	});

	it("rejects document actions against another artifact kind", () => {
		const { db, artifacts, tasks } = fixture();
		const task = tasks.create({ title: "Not a document" });
		expect(() => transitionDocument(artifacts, task.id, "archive")).toThrow("is not a doc");
		db.close();
	});
});
