import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import { compilePlaybookDefinition } from "../src/playbook-definition.ts";

function fixture() {
	const db = openDb(":memory:");
	return new SQLiteArtifactStore(db);
}

function createPlaybook(artifacts: SQLiteArtifactStore, title: string, steps: string[]) {
	return artifacts.create({ kind: "playbook", title, body: "", status: "active", labels: [], extra: { steps } });
}

/**
 * Regression: a contains/depends_on edge left pointing at a trashed playbook (e.g. after
 * remove+recreate under the same title without first uncontaining the old one) used to
 * resolve straight through -- artifacts.get() still returns a trashed artifact ("still
 * directly showable"), so the compiler pulled its stale content into the materialized graph.
 * Confirmed live: a playbook restructure produced three straight invocations of stale
 * one-liner content before this was found and fixed.
 */
describe("playbook-definition: composition edges to a trashed playbook are not resolved", () => {
	it("skips a trashed nested (contains) playbook entirely", () => {
		const artifacts = fixture();
		const parent = createPlaybook(artifacts, "Parent", ["Parent step"]);
		const staleChild = createPlaybook(artifacts, "Child (stale)", ["Stale step"]);
		artifacts.link({ from: parent.id, relation: "contains", to: staleChild.id });
		artifacts.trash(staleChild.id, { reason: "superseded" });

		const compiled = compilePlaybookDefinition(artifacts, parent.id);
		const bodies = compiled.definition.blueprints.tasks.map((task) => task.body);
		expect(bodies).not.toContain("Stale step");
		expect(compiled.definition.blueprints.tasks).toHaveLength(2); // parent root + its own one step, nothing from the trashed child
	});

	it("skips a trashed prerequisite (depends_on) playbook entirely", () => {
		const artifacts = fixture();
		const dependent = createPlaybook(artifacts, "Dependent", ["Dependent step"]);
		const stalePrereq = createPlaybook(artifacts, "Prereq (stale)", ["Stale prereq step"]);
		artifacts.link({ from: dependent.id, relation: "depends_on", to: stalePrereq.id });
		artifacts.trash(stalePrereq.id, { reason: "superseded" });

		const compiled = compilePlaybookDefinition(artifacts, dependent.id);
		const bodies = compiled.definition.blueprints.tasks.map((task) => task.body);
		expect(bodies).not.toContain("Stale prereq step");
		expect(compiled.definition.blueprints.tasks).toHaveLength(2); // dependent root + its own one step, nothing from the trashed prereq
	});

	it("still resolves a live (non-trashed) nested playbook normally", () => {
		const artifacts = fixture();
		const parent = createPlaybook(artifacts, "Parent", ["Parent step"]);
		const child = createPlaybook(artifacts, "Child", ["Live step"]);
		artifacts.link({ from: parent.id, relation: "contains", to: child.id });

		const compiled = compilePlaybookDefinition(artifacts, parent.id);
		const bodies = compiled.definition.blueprints.tasks.map((task) => task.body);
		expect(bodies).toContain("Live step");
	});

	it("refuses to invoke a trashed playbook directly", () => {
		const artifacts = fixture();
		const playbook = createPlaybook(artifacts, "Doomed", ["A step"]);
		artifacts.trash(playbook.id, { reason: "superseded" });
		expect(() => compilePlaybookDefinition(artifacts, playbook.id)).toThrow(/trashed/);
	});
});
