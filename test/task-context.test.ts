import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import { taskContext } from "../extension/src/task-context.ts";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "papyrus-task-context-"));
	const db = openDb(join(dir, "papyrus.db"));
	return { db, artifacts: new SQLiteArtifactStore(db) };
}

describe("task context reconciliation", () => {
	it("injects nothing when there are no open tasks", () => {
		const { db, artifacts } = fixture();
		expect(taskContext(artifacts)).toBeNull();
		db.close();
	});

	it("injects Alef-style desired, verify, next, and explicit completion check", () => {
		const { db, artifacts } = fixture();
		const active = artifacts.create({
			kind: "task",
			title: "Ship task frontend",
			body: "Users can manage tasks interactively.",
			extra: {
				gates: [{ type: "command", target: "bun test", expect: "0 fail" }],
			},
		});
		artifacts.setStatus(active.id, "in-progress");
		artifacts.create({ kind: "task", title: "Document task workflow" });

		const context = taskContext(artifacts)!;
		expect(context).toContain("Current: Ship task frontend");
		expect(context).toContain("Desired: Users can manage tasks interactively.");
		expect(context).toContain("Verify: command: bun test = 0 fail");
		expect(context).toContain("Next: Document task workflow");
		expect(context).toContain("Did we accomplish this task?");
		expect(context).toContain("run its gates before marking it done");
		// Codex goal-mode-informed additions: anti-scope-narrowing and evidence-based audit
		// language, not just a bare instruction to reconcile.
		expect(context).toContain("A written summary is not evidence");
		expect(context).toContain("Do not shrink the task's scope to whatever fits in this turn");
		expect(context).toContain("Do not reject or call something blocked on the first obstacle");
		db.close();
	});

	it("calls out rejected tasks as review failures", () => {
		const { db, artifacts } = fixture();
		const rejected = artifacts.create({ kind: "task", title: "Repair release" });
		artifacts.setStatus(rejected.id, "rejected");

		const context = taskContext(artifacts)!;
		expect(context).toContain("Rejected: Repair release");
		expect(context).toContain("0/1 done");
		db.close();
	});
});
