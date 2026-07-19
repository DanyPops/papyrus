import { describe, it, expect } from "bun:test";
import { openDb, type Db } from "../src/db.ts";
import { createArtifact, queryArtifacts, linkArtifacts, getArtifact, runGates } from "../src/ops.ts";
import { dbPath } from "../src/constants.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpDb(): { db: Db; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "papyrus-"));
	process.env["XDG_DATA_HOME"] = dir;
	const db = openDb(dbPath());
	return { db, dir };
}

describe("papyrus: four-kind model", () => {
	it("rejects unknown kind", () => {
		const { db } = tmpDb();
		expect(() => createArtifact(db, { kind: "frobnicate", title: "x" })).toThrow();
		db.close();
	});

	it("create + query each kind", () => {
		const { db } = tmpDb();
		const doc = createArtifact(db, { kind: "doc", title: "Architecture overview", subtype: "design" });
		const task = createArtifact(db, { kind: "task", title: "Implement SQLite layer" });
		const rule = createArtifact(db, { kind: "rule", title: "Run tests before commit", extra: { condition: "git commit", action: "bun test", severity: "block" } });
		const skill = createArtifact(db, { kind: "skill", title: "TDD workflow", extra: { trigger: "writing code", steps: ["write test", "implement", "refactor"], tools: ["bun test", "tsc"] } });

		expect(doc.kind).toBe("doc");
		expect(task.kind).toBe("task");
		expect(rule.kind).toBe("rule");
		expect(skill.kind).toBe("skill");

		expect(queryArtifacts(db, { kind: "doc" })).toHaveLength(1);
		expect(queryArtifacts(db, { kind: "task" })).toHaveLength(1);
		expect(queryArtifacts(db, { kind: "rule" })).toHaveLength(1);
		expect(queryArtifacts(db, { kind: "skill" })).toHaveLength(1);
		db.close();
	});

	it("default status per kind", () => {
		const { db } = tmpDb();
		expect(createArtifact(db, { kind: "doc", title: "D" }).status).toBe("draft");
		expect(createArtifact(db, { kind: "task", title: "T" }).status).toBe("todo");
		expect(createArtifact(db, { kind: "rule", title: "R" }).status).toBe("active");
		expect(createArtifact(db, { kind: "skill", title: "S" }).status).toBe("active");
		db.close();
	});

	it("universal links — any kind to any kind", () => {
		const { db } = tmpDb();
		const doc = createArtifact(db, { kind: "doc", title: "Spec" });
		const task = createArtifact(db, { kind: "task", title: "Do it" });
		const rule = createArtifact(db, { kind: "rule", title: "Test first" });
		const skill = createArtifact(db, { kind: "skill", title: "TDD" });

		// task follows rule
		linkArtifacts(db, task.id!, "follows", rule.id!);
		// task implements doc
		linkArtifacts(db, task.id!, "implements", doc.id!);
		// skill triggers task
		linkArtifacts(db, skill.id!, "triggers", task.id!);
		// rule gates task
		linkArtifacts(db, rule.id!, "gates", task.id!);
		// doc documents skill
		linkArtifacts(db, doc.id!, "documents", skill.id!);
		// doc references doc (chaining)
		const doc2 = createArtifact(db, { kind: "doc", title: "Related spec" });
		linkArtifacts(db, doc.id!, "references", doc2.id!);

		const tree = getArtifact(db, task.id!, { tree: true })!;
		expect(tree.edges!.length).toBeGreaterThanOrEqual(4);
		db.close();
	});

	it("task with gates in extra", () => {
		const { db, dir } = tmpDb();
		const target = join(dir, "out.txt");
		writeFileSync(target, "hello world");

		const task = createArtifact(db, {
			kind: "task",
			title: "Gated task",
			extra: { gates: [
				{ type: "file-exists", target },
				{ type: "contains", target, expect: "hello" },
				{ type: "contains", target, expect: "missing" },
			] },
		});
		const results = runGates(db, task.id!);
		expect(results).toHaveLength(3);
		expect(results[0]!.passed).toBe(true);
		expect(results[1]!.passed).toBe(true);
		expect(results[2]!.passed).toBe(false);
		db.close();
	});

	it("rule with condition/action/severity in extra", () => {
		const { db } = tmpDb();
		const rule = createArtifact(db, {
			kind: "rule",
			title: "Always run tsc before commit",
			extra: { condition: "before git commit", action: "bun x tsc --noEmit", severity: "block" },
		});
		expect(rule.extra["condition"]).toBe("before git commit");
		expect(rule.extra["severity"]).toBe("block");
		db.close();
	});

	it("skill with trigger/steps/tools in extra", () => {
		const { db } = tmpDb();
		const skill = createArtifact(db, {
			kind: "skill",
			title: "TDD cycle",
			extra: { trigger: "writing new code", steps: ["write failing test", "implement", "refactor"], tools: ["bun test", "tsc"] },
		});
		expect((skill.extra["steps"] as string[]).length).toBe(3);
		expect((skill.extra["tools"] as string[]).length).toBe(2);
		db.close();
	});

	it("full-text search across title and body", () => {
		const { db } = tmpDb();
		createArtifact(db, { kind: "doc", title: "SQLite architecture", body: "The WAL journal mode..." });
		createArtifact(db, { kind: "task", title: "Fix bug", body: "SQLite busy error on concurrent writes" });
		createArtifact(db, { kind: "doc", title: "Unrelated", body: "nothing here" });

		expect(queryArtifacts(db, { text: "SQLite" })).toHaveLength(2);
		expect(queryArtifacts(db, { text: "WAL" })).toHaveLength(1);
		expect(queryArtifacts(db, { text: "nothing" })).toHaveLength(1);
		db.close();
	});

	it("subgraph BFS from root", () => {
		const { db } = tmpDb();
		const goal = createArtifact(db, { kind: "task", title: "Ship v1" });
		const t1 = createArtifact(db, { kind: "task", title: "Task A" });
		const t2 = createArtifact(db, { kind: "task", title: "Task B" });
		const doc = createArtifact(db, { kind: "doc", title: "Design doc" });
		const rule = createArtifact(db, { kind: "rule", title: "Test everything" });

		linkArtifacts(db, goal.id!, "depends_on", t1.id!);
		linkArtifacts(db, t1.id!, "depends_on", t2.id!);
		linkArtifacts(db, t1.id!, "implements", doc.id!);
		linkArtifacts(db, t1.id!, "follows", rule.id!);

		const tree = getArtifact(db, goal.id!, { tree: true })!;
		// BFS should reach: goal → t1 → t2, doc, rule (5 artifacts, 4 edges)
		expect(tree.edges!.length).toBe(4);
		expect(tree.edges!.some((e) => e.from === t1.id && e.relation === "depends_on" && e.to === t2.id)).toBe(true);
		expect(tree.edges!.some((e) => e.from === t1.id && e.relation === "follows" && e.to === rule.id)).toBe(true);
		db.close();
	});

	it("bounds hierarchy traversal by depth and node count", () => {
		const { db } = tmpDb();
		const root = createArtifact(db, { kind: "task", title: "Epic" });
		const child = createArtifact(db, { kind: "task", title: "Child" });
		const grandchild = createArtifact(db, { kind: "task", title: "Grandchild" });
		const leaf = createArtifact(db, { kind: "task", title: "Leaf" });

		linkArtifacts(db, root.id, "contains", child.id);
		linkArtifacts(db, child.id, "part_of", root.id);
		linkArtifacts(db, child.id, "contains", grandchild.id);
		linkArtifacts(db, grandchild.id, "contains", leaf.id);
		linkArtifacts(db, leaf.id, "relates_to", child.id); // cycle without a root shortcut

		const oneLevel = getArtifact(db, root.id, { tree: true, depth: 1, maxNodes: 10 })!;
		expect(oneLevel.edges).toHaveLength(2);
		expect(oneLevel.edges!.every((edge) => [root.id, child.id].includes(edge.from) && [root.id, child.id].includes(edge.to))).toBe(true);

		const twoNodes = getArtifact(db, root.id, { tree: true, depth: 10, maxNodes: 2 })!;
		expect(twoNodes.edges).toHaveLength(2);
		expect(twoNodes.edges!.some((edge) => edge.to === grandchild.id)).toBe(false);
		db.close();
	});

	it("instantiates an artifact template with deep defaults", () => {
		const { db } = tmpDb();
		const template = createArtifact(db, {
			kind: "skill",
			subtype: "artifact-template",
			title: "Frontend task template",
			extra: {
				targetKind: "task",
				defaults: {
					body: "Deliver an interactive frontend.",
					labels: ["frontend"],
					extra: {
						checklist: ["Write failing test", "Implement", "Verify"],
						gates: [{ type: "command", target: "bun test" }],
					},
				},
				required: ["title", "extra.owner"],
			},
		});

		const task = createArtifact(db, {
			templateId: template.id,
			title: "Build documents frontend",
			extra: { owner: "agent", checklist: ["Override first"] },
		});

		expect(task.kind).toBe("task");
		expect(task.body).toBe("Deliver an interactive frontend.");
		expect(task.labels).toEqual(["frontend"]);
		expect(task.extra["owner"]).toBe("agent");
		expect(task.extra["checklist"]).toEqual(["Override first"]);
		expect(task.extra["gates"]).toEqual([{ type: "command", target: "bun test" }]);
		db.close();
	});

	it("rejects missing template requirements and target-kind mismatches", () => {
		const { db } = tmpDb();
		const template = createArtifact(db, {
			kind: "skill",
			subtype: "artifact-template",
			title: "Owned task",
			extra: { targetKind: "task", required: ["title", "extra.owner"] },
		});

		expect(() => createArtifact(db, { templateId: template.id, title: "No owner" })).toThrow("missing required template field");
		expect(() => createArtifact(db, { templateId: template.id, kind: "doc", title: "Wrong kind", extra: { owner: "agent" } })).toThrow("targets kind");
		db.close();
	});
});
