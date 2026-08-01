import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { openDb } from "../src/db.ts";
import type { PlaybookStep } from "../src/domain-services.ts";
import { compilePlaybookDefinition } from "../src/playbook-definition.ts";

function fixture() {
	const db = openDb(":memory:");
	return new SQLiteArtifactStore(db);
}

function createPlaybook(artifacts: SQLiteArtifactStore, title: string, steps: PlaybookStep[], extra: Record<string, unknown> = {}) {
	return artifacts.create({ kind: "playbook", title, body: "", status: "active", labels: [], extra: { steps, ...extra } });
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

describe("playbook-definition: structured steps (full-richness Blueprint absorption)", () => {
	it("compiles a doc step into blueprints.docs, not blueprints.tasks, and it never joins the dependsOn chain", () => {
		const artifacts = fixture();
		const playbook = createPlaybook(artifacts, "Ships a spec", [
			"First step",
			{ kind: "doc", title: "Design note", body: "the design", subtype: "design", labels: ["spec"] },
			"Second step",
		]);
		const compiled = compilePlaybookDefinition(artifacts, playbook.id);
		expect(compiled.definition.blueprints.docs).toHaveLength(1);
		expect(compiled.definition.blueprints.docs[0]).toMatchObject({
			title: "Design note",
			body: "the design",
			subtype: "design",
			labels: ["spec"],
		});
		// Two tasks only: root + "First step" + "Second step" -- three, actually; the doc step contributes nothing to blueprints.tasks.
		expect(compiled.definition.blueprints.tasks).toHaveLength(3);
		// The doc step doesn't break the sequential chain: "Second step" still depends on "First step", not on the doc.
		const second = compiled.definition.blueprints.tasks.find((task) => task.body === "Second step")!;
		const first = compiled.definition.blueprints.tasks.find((task) => task.body === "First step")!;
		expect(second.dependsOn).toEqual([first.ref]);
	});

	it("compiles a rule step into blueprints.rules with condition/action/severity", () => {
		const artifacts = fixture();
		const playbook = createPlaybook(artifacts, "Gates itself", [
			{ kind: "rule", title: "No secrets in commits", condition: "committing", action: "scan for secrets first", severity: "block" },
		]);
		const compiled = compilePlaybookDefinition(artifacts, playbook.id);
		expect(compiled.definition.blueprints.rules).toHaveLength(1);
		expect(compiled.definition.blueprints.rules[0]).toMatchObject({
			title: "No secrets in commits",
			condition: "committing",
			action: "scan for secrets first",
			severity: "block",
		});
	});

	it("compiles a call step into blueprints.skills, chained into the same dependsOn sequence as a task step", () => {
		const artifacts = fixture();
		const target = createPlaybook(artifacts, "Target", ["Target step"]);
		const playbook = createPlaybook(artifacts, "Caller", [
			"Before",
			{ kind: "call", title: "Run Target", playbookId: target.id, arguments: { x: "1" } },
			"After",
		]);
		const compiled = compilePlaybookDefinition(artifacts, playbook.id);
		expect(compiled.definition.blueprints.skills).toHaveLength(1);
		const call = compiled.definition.blueprints.skills[0]!;
		expect(call).toMatchObject({ title: "Run Target", targetId: target.id, arguments: { x: "1" } });
		const before = compiled.definition.blueprints.tasks.find((task) => task.body === "Before")!;
		const after = compiled.definition.blueprints.tasks.find((task) => task.body === "After")!;
		expect(call.dependsOn).toEqual([before.ref]);
		expect(after.dependsOn).toEqual([call.ref]);
	});

	it("an explicit {kind: 'task'} step behaves exactly like a plain string, with its own title honored", () => {
		const artifacts = fixture();
		const playbook = createPlaybook(artifacts, "Explicit task", [{ kind: "task", title: "Custom title", body: "Do the thing" }]);
		const compiled = compilePlaybookDefinition(artifacts, playbook.id);
		const step = compiled.definition.blueprints.tasks.find((task) => task.body === "Do the thing")!;
		expect(step.title).toBe("Custom title");
	});

	it("merges a declared argument's type/enum/default from the playbook's own extra into the compiled definition's inputs", () => {
		const artifacts = fixture();
		const playbook = createPlaybook(artifacts, "Typed args", ["Deploy to {{environment}}"], {
			arguments: [{ name: "environment", required: true, type: "string", enum: ["staging", "production"] }],
		});
		const compiled = compilePlaybookDefinition(artifacts, playbook.id);
		expect(compiled.definition.inputs.environment).toEqual({ type: "string", required: true, enum: ["staging", "production"] });
	});

	it("throws when a composition tree declares the same argument name with conflicting types", () => {
		const artifacts = fixture();
		const prereq = createPlaybook(artifacts, "Needs a count (number)", ["Step"], {
			arguments: [{ name: "n", required: true, type: "number" }],
		});
		const dependent = createPlaybook(artifacts, "Needs a count (string)", ["Step"], {
			arguments: [{ name: "n", required: true, type: "string" }],
		});
		artifacts.link({ from: dependent.id, relation: "depends_on", to: prereq.id });
		expect(() => compilePlaybookDefinition(artifacts, dependent.id)).toThrow(/conflicting types/);
	});
});
