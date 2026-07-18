import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/db.ts";
import { createArtifact, getArtifact } from "../src/ops.ts";
import {
	completeTask,
	createDocument,
	createTask,
	listDocuments,
	listTasks,
	transitionDocument,
	transitionTask,
} from "../src/facades.ts";

function tmpDb(): { db: Db; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "papyrus-facade-"));
	return { db: openDb(join(dir, "papyrus.db")), dir };
}

describe("tasks facade", () => {
	it("creates task hierarchy and dependencies without exposing kind or relations", () => {
		const { db } = tmpDb();
		const epic = createTask(db, { title: "Ship Papyrus" });
		const prerequisite = createTask(db, { title: "Write design" });
		const child = createTask(db, {
			title: "Build frontend",
			parentId: epic.id,
			dependsOn: [prerequisite.id],
		});

		expect(child.kind).toBe("task");
		const graph = getArtifact(db, child.id, { tree: true })!;
		expect(graph.edges).toContainEqual({ from: epic.id, relation: "contains", to: child.id });
		expect(graph.edges).toContainEqual({ from: child.id, relation: "part_of", to: epic.id });
		expect(graph.edges).toContainEqual({ from: child.id, relation: "depends_on", to: prerequisite.id });
		db.close();
	});

	it("enforces lifecycle and refuses completion until gates pass", () => {
		const { db, dir } = tmpDb();
		const output = join(dir, "built.txt");
		const task = createTask(db, {
			title: "Build output",
			gates: [{ type: "file-exists", target: output }],
		});

		expect(transitionTask(db, task.id, "start").status).toBe("active");
		const blocked = completeTask(db, task.id);
		expect(blocked.completed).toBe(false);
		expect(blocked.artifact.status).toBe("active");
		expect(blocked.gates[0]?.passed).toBe(false);

		writeFileSync(output, "done");
		const completed = completeTask(db, task.id);
		expect(completed.completed).toBe(true);
		expect(completed.artifact.status).toBe("done");
		expect(() => transitionTask(db, task.id, "start")).toThrow("cannot start task from done");
		db.close();
	});

	it("lists only task artifacts", () => {
		const { db } = tmpDb();
		createTask(db, { title: "Task" });
		createArtifact(db, { kind: "doc", title: "Document" });
		expect(listTasks(db, {})).toHaveLength(1);
		db.close();
	});
});

describe("documents facade", () => {
	it("owns document creation and lifecycle", () => {
		const { db } = tmpDb();
		const document = createDocument(db, { title: "Architecture", subtype: "design", labels: ["sqlite"] });
		expect(document.kind).toBe("doc");
		expect(document.status).toBe("draft");
		expect(transitionDocument(db, document.id, "activate").status).toBe("active");
		expect(transitionDocument(db, document.id, "archive").status).toBe("archived");
		expect(transitionDocument(db, document.id, "reopen").status).toBe("draft");
		expect(listDocuments(db, { text: "Architecture" })).toHaveLength(1);
		db.close();
	});

	it("rejects document actions against another artifact kind", () => {
		const { db } = tmpDb();
		const task = createTask(db, { title: "Not a document" });
		expect(() => transitionDocument(db, task.id, "archive")).toThrow("is not a doc");
		db.close();
	});
});
