import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/db.ts";
import { createArtifact, updateStatus } from "../src/ops.ts";
import { taskContextFromDb } from "../extension/src/task-context.ts";

function tmpDb(): Db {
	const dir = mkdtempSync(join(tmpdir(), "papyrus-task-context-"));
	return openDb(join(dir, "papyrus.db"));
}

describe("task context reconciliation", () => {
	it("injects nothing when there are no open tasks", () => {
		const db = tmpDb();
		expect(taskContextFromDb(db)).toBeNull();
		db.close();
	});

	it("injects Alef-style desired, verify, next, and explicit completion check", () => {
		const db = tmpDb();
		const active = createArtifact(db, {
			kind: "task",
			title: "Ship task frontend",
			body: "Users can manage tasks interactively.",
			extra: {
				gates: [{ type: "command", target: "bun test", expect: "0 fail" }],
			},
		});
		updateStatus(db, active.id, "active");
		createArtifact(db, { kind: "task", title: "Document task workflow" });

		const context = taskContextFromDb(db)!;
		expect(context).toContain("Current: Ship task frontend");
		expect(context).toContain("Desired: Users can manage tasks interactively.");
		expect(context).toContain("Verify: command: bun test = 0 fail");
		expect(context).toContain("Next: Document task workflow");
		expect(context).toContain("Did we accomplish this task?");
		expect(context).toContain("run its gates before marking it done");
		db.close();
	});

	it("calls out failed tasks as blocked work", () => {
		const db = tmpDb();
		const failed = createArtifact(db, { kind: "task", title: "Repair release" });
		updateStatus(db, failed.id, "failed");

		const context = taskContextFromDb(db)!;
		expect(context).toContain("Blocked: Repair release");
		expect(context).toContain("0/1 done");
		db.close();
	});
});
