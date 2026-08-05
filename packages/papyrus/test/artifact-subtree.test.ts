import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteTaskFocusStore } from "../src/adapters/sqlite-task-focus-store.ts";
import { removeArtifactSubtree } from "../src/artifact/artifact-subtree.ts";
import { openDb } from "../src/db.ts";

function fixture() {
	const db = openDb(":memory:");
	return { store: new SQLiteArtifactStore(db), focus: new SQLiteTaskFocusStore(db) };
}

describe("removeArtifactSubtree: bulk trash of a contains subtree, any artifact kind", () => {
	it("trashes a task and its whole containment subtree in one call", () => {
		const { store } = fixture();
		const root = store.create({ kind: "task", title: "Root", status: "todo" });
		const childA = store.create({ kind: "task", title: "Child A", status: "todo" });
		const childB = store.create({ kind: "task", title: "Child B", status: "todo" });
		const grandchild = store.create({ kind: "task", title: "Grandchild", status: "todo" });
		store.link({ from: root.id, relation: "contains", to: childA.id });
		store.link({ from: root.id, relation: "contains", to: childB.id });
		store.link({ from: childA.id, relation: "contains", to: grandchild.id });

		const outcome = removeArtifactSubtree(store, root.id, { reason: "test cleanup" });
		expect(outcome.removed.sort()).toEqual([root.id, childA.id, childB.id, grandchild.id].sort());
		expect(outcome.skipped).toEqual([]);
		for (const id of outcome.removed) expect(store.trashStatus(id)).not.toBeNull();
	});

	it("skips an already-trashed node instead of erroring, but still walks past it to its own children", () => {
		const { store } = fixture();
		const root = store.create({ kind: "task", title: "Root", status: "todo" });
		const child = store.create({ kind: "task", title: "Child", status: "todo" });
		const grandchild = store.create({ kind: "task", title: "Grandchild", status: "todo" });
		store.link({ from: root.id, relation: "contains", to: child.id });
		store.link({ from: child.id, relation: "contains", to: grandchild.id });
		store.trash(child.id, { reason: "pre-trashed" });

		const outcome = removeArtifactSubtree(store, root.id);
		expect(outcome.removed.sort()).toEqual([root.id, grandchild.id].sort());
		expect(outcome.skipped).toEqual([child.id]);
	});

	it("works across mixed kinds -- a playbook's own nested-playbook children, not just tasks", () => {
		const { store } = fixture();
		const parent = store.create({ kind: "playbook", title: "Parent", status: "active" });
		const child = store.create({ kind: "playbook", title: "Child", status: "active" });
		store.link({ from: parent.id, relation: "contains", to: child.id });

		const outcome = removeArtifactSubtree(store, parent.id);
		expect(outcome.removed.sort()).toEqual([parent.id, child.id].sort());
	});

	it("refuses (does not silently skip) a node that is the live Task Focus", () => {
		const { store, focus } = fixture();
		const root = store.create({ kind: "task", title: "Root", status: "todo" });
		focus.set(root.id);

		expect(() => removeArtifactSubtree(store, root.id)).toThrow(/active Task Focus/);
	});

	it("throws for an unknown root id instead of silently doing nothing", () => {
		const { store } = fixture();
		expect(() => removeArtifactSubtree(store, "does-not-exist")).toThrow(/not found/);
	});
});
