import { describe, expect, it } from "bun:test";
import { SQLiteArtifactScopeStore } from "../src/artifact/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/artifact/sqlite-artifact-store.ts";
import {
	binderTree,
	createBinder,
	fileArtifact,
	moveBinder,
	removeBinder,
	unfileArtifact,
	updateBinder,
} from "../src/binder/binder-service.ts";
import { openDb } from "../src/db.ts";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const scopes = new SQLiteArtifactScopeStore(db);
	return { db, artifacts, scopes };
}

describe("Binder hierarchy and inherited labels", () => {
	it("builds stable paths and computes additive labels from every ancestor without mutating artifact labels", () => {
		const { db, artifacts, scopes } = fixture();
		const root = createBinder(artifacts, scopes, { title: "Engineering", labels: ["area:engineering"], projectRoot: "/workspace/papyrus" });
		const child = createBinder(artifacts, scopes, {
			title: "Architecture",
			labels: ["type:architecture", "area:engineering"],
			parentId: root.id,
			projectRoot: "/workspace/papyrus",
		});
		const doc = artifacts.create({ kind: "doc", status: "draft", title: "Storage decision", labels: ["decision"] });

		fileArtifact(artifacts, scopes, doc.id, child.id, "/workspace/papyrus");
		const tree = binderTree(artifacts, scopes, { projectRoot: "/workspace/papyrus", artifactIds: [doc.id] });
		const childNode = tree.nodes.find((node) => node.binder.id === child.id)!;
		const placement = tree.artifacts[0]!;

		expect(childNode.path).toBe("/Engineering/Architecture");
		expect(childNode.inheritedLabels).toEqual(["area:engineering"]);
		expect(childNode.effectiveLabels).toEqual(["area:engineering", "type:architecture"]);
		expect(placement).toEqual({
			artifactId: doc.id,
			binderId: child.id,
			inheritedLabels: ["area:engineering", "type:architecture"],
			effectiveLabels: ["area:engineering", "type:architecture", "decision"],
		});
		expect(artifacts.get(doc.id)!.labels).toEqual(["decision"]);
		db.close();
	});

	it("updates every descendant's computed labels immediately after a move or Binder relabel", () => {
		const { db, artifacts, scopes } = fixture();
		const oldRoot = createBinder(artifacts, scopes, { title: "Old", labels: ["old"] });
		const newRoot = createBinder(artifacts, scopes, { title: "New", labels: ["new"] });
		const child = createBinder(artifacts, scopes, { title: "Child", parentId: oldRoot.id });
		const task = artifacts.create({ kind: "task", status: "todo", title: "Implement", labels: ["direct"] });
		fileArtifact(artifacts, scopes, task.id, child.id, undefined);

		moveBinder(artifacts, scopes, child.id, newRoot.id, undefined);
		updateBinder(artifacts, scopes, newRoot.id, { labels: ["new", "priority:high"] }, undefined);
		const tree = binderTree(artifacts, scopes, { artifactIds: [task.id] });

		expect(tree.nodes.find((node) => node.binder.id === child.id)?.path).toBe("/New/Child");
		expect(tree.artifacts[0]?.effectiveLabels).toEqual(["new", "priority:high", "direct"]);
		expect(artifacts.get(task.id)!.labels).toEqual(["direct"]);
		db.close();
	});

	it("rejects path-like names, duplicate siblings, and hierarchy cycles", () => {
		const { db, artifacts, scopes } = fixture();
		expect(() => createBinder(artifacts, scopes, { title: "a/b" })).toThrow(/cannot.*\//i);
		const root = createBinder(artifacts, scopes, { title: "Root" });
		const child = createBinder(artifacts, scopes, { title: "Child", parentId: root.id });
		expect(() => createBinder(artifacts, scopes, { title: "child", parentId: root.id })).toThrow(/already exists/i);
		expect(() => moveBinder(artifacts, scopes, root.id, child.id, undefined)).toThrow(/descendant/i);
		db.close();
	});

	it("supports a different placement for the same global artifact in each project context", () => {
		const { db, artifacts, scopes } = fixture();
		const inA = createBinder(artifacts, scopes, { title: "Project A", projectRoot: "/workspace/a", labels: ["project:a"] });
		const inB = createBinder(artifacts, scopes, { title: "Project B", projectRoot: "/workspace/b", labels: ["project:b"] });
		const doc = artifacts.create({ kind: "doc", status: "draft", title: "Shared" });

		fileArtifact(artifacts, scopes, doc.id, inA.id, "/workspace/a");
		fileArtifact(artifacts, scopes, doc.id, inB.id, "/workspace/b");

		expect(binderTree(artifacts, scopes, { projectRoot: "/workspace/a", artifactIds: [doc.id] }).artifacts[0]).toMatchObject({
			binderId: inA.id,
			effectiveLabels: ["project:a"],
		});
		expect(binderTree(artifacts, scopes, { projectRoot: "/workspace/b", artifactIds: [doc.id] }).artifacts[0]).toMatchObject({
			binderId: inB.id,
			effectiveLabels: ["project:b"],
		});
		db.close();
	});

	it("only removes empty Binders and moves an unfiled artifact back to root", () => {
		const { db, artifacts, scopes } = fixture();
		const binder = createBinder(artifacts, scopes, { title: "Inbox" });
		const rule = artifacts.create({ kind: "rule", status: "active", title: "Review changes" });
		fileArtifact(artifacts, scopes, rule.id, binder.id, undefined);
		expect(() => removeBinder(artifacts, binder.id)).toThrow(/not empty/i);

		const placement = unfileArtifact(artifacts, scopes, rule.id, undefined);
		expect(placement.binderId).toBeUndefined();
		expect(removeBinder(artifacts, binder.id).artifactId).toBe(binder.id);
		expect(artifacts.query({ kind: "binder" })).toEqual([]);
		db.close();
	});
});
