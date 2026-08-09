import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

import { SQLiteArtifactScopeStore } from "../src/artifact/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/artifact/sqlite-artifact-store.ts";
import { AuthorityRegistry } from "../src/authority-registry.ts";
import { openDb } from "../src/db.ts";
import {
	assignDocumentProject,
	createDocument,
	linkDocument,
	listDocuments,
	transitionDocument,
	updateDocument,
} from "../src/docs/docs-service.ts";
import {
	assignPlaybookProject,
	containPlaybook,
	createPlaybook,
	dependPlaybook,
	listPlaybooks,
	playbookInvocation,
	showPlaybook,
	transitionPlaybook,
	uncontainPlaybook,
	undependPlaybook,
	updatePlaybook,
} from "../src/playbook/playbook-service.ts";
import {
	assignRuleProject,
	createRule,
	gateTaskWithRule,
	listInjectableRules,
	listRules,
	previewRule,
	ruleCombinedLength,
	ruleCombinedLengthWarning,
	transitionRule,
	updateRule,
} from "../src/rules/rules-service.ts";
import { createAuthorityRegistry } from "../src/service.ts";
import { SQLiteGateRunner } from "../src/stores/sqlite-gate-runner.ts";
import { SQLiteProjectRegistryStore } from "../src/stores/sqlite-project-registry-store.ts";
import { Tasks } from "../src/task/task-service.ts";

function fixture() {
	const dir = tempDir("papyrus-domain-service-");
	const db = openDb(join(dir, "papyrus.db"));
	const artifacts = new SQLiteArtifactStore(db);
	return {
		db,
		dir,
		artifacts,
		scopes: new SQLiteArtifactScopeStore(db),
		authority: new AuthorityRegistry(),
		tasks: new Tasks(artifacts, new SQLiteGateRunner(db)),
	};
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

	it("a template's own extra.gates/checklist deep-merge into a created Task's extra and are enforced by tasks.complete with zero new code (task-template-conformance-auto-derive-a-completion 7b6c2e63)", () => {
		const { db, dir, artifacts, tasks } = fixture();
		const output = join(dir, "template-built.txt");
		const template = artifacts.create({
			kind: "task",
			subtype: "artifact-template",
			title: "Build-and-verify task template",
			extra: {
				targetKind: "task",
				defaults: {
					extra: {
						gates: [{ type: "file-exists", target: output }],
						checklist: { "output exists": { proof: [{ type: "artifact", target: output }] } },
					},
				},
			},
		});

		// No gates/checklist supplied by the caller at all -- both must come from the template alone.
		const task = tasks.create({ title: "From template", templateId: template.id });
		expect(task.extra.gates).toEqual([{ type: "file-exists", target: output }]);

		tasks.transition(task.id, "start");
		tasks.transition(task.id, "submit");
		const blocked = tasks.complete(task.id);
		expect(blocked.completed).toBe(false);
		expect(blocked.gates[0]?.passed).toBe(false);
		expect(blocked.checklist[0]?.accepted).toBe(true); // typed proof reference was supplied by the template

		writeFileSync(output, "done");
		tasks.transition(task.id, "retry");
		tasks.transition(task.id, "submit");
		expect(tasks.complete(task.id).completed).toBe(true);
		db.close();
	});

	it("caller-supplied gates at creation still win outright over a template's own defaults -- deepMerge replaces arrays, it does not concatenate them", () => {
		const { db, dir, artifacts, tasks } = fixture();
		const templateOutput = join(dir, "template-output.txt");
		const callerOutput = join(dir, "caller-output.txt");
		const template = artifacts.create({
			kind: "task",
			subtype: "artifact-template",
			title: "Template with default gates",
			extra: { targetKind: "task", defaults: { extra: { gates: [{ type: "file-exists", target: templateOutput }] } } },
		});
		const task = tasks.create({
			title: "Overrides the template's gates",
			templateId: template.id,
			gates: [{ type: "file-exists", target: callerOutput }],
		});
		expect(task.extra.gates).toEqual([{ type: "file-exists", target: callerOutput }]);
		db.close();
	});

	it('excludes Discussions, which now share kind "task" but are not real work items', () => {
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
		const rule = createRule(artifacts, scopes, {
			title: "Test before commit",
			condition: "before commit",
			action: "Run bun test",
			severity: "block",
		});
		const task = tasks.create({ title: "Ship" });
		expect(rule.kind).toBe("rule");
		expect(previewRule(artifacts, rule.id)).toContain("• Test before commit (when: before commit)\n  Run bun test");
		expect(gateTaskWithRule(artifacts, rule.id, task.id).edges).toContainEqual({ from: rule.id, relation: "gates", to: task.id });
		expect(transitionRule(artifacts, rule.id, "disable").status).toBe("deprecated");
		expect(transitionRule(artifacts, rule.id, "enable").status).toBe("active");
		expect(listRules(artifacts, scopes, {})).toHaveLength(1);
		db.close();
	});

	it("rejects an illegal transition with the same error shape the shared transition-table runner produces for every kind (unify-the-four-artifact-kind-transition-implementa e170c1a4)", () => {
		const { db, artifacts, scopes } = fixture();
		const rule = createRule(artifacts, scopes, { title: "Already active" });
		expect(() => transitionRule(artifacts, rule.id, "enable")).toThrow("cannot enable rule from active");
		db.close();
	});

	it("injection stays bounded and deterministic across a multi-membership Rule -- no duplicate entry, stable order, and limit behavior unaffected by how many projects it belongs to (rules-enforce-global-or-multi-project-applicabilit)", () => {
		const { db, artifacts, scopes } = fixture();
		const registry = new SQLiteProjectRegistryStore(db);
		const projectA = registry.registerProject({ projectRoot: "/tmp/determinism-a", name: "Determinism A" });
		const projectB = registry.registerProject({ projectRoot: "/tmp/determinism-b", name: "Determinism B" });

		const multiMembershipRule = createRule(
			artifacts,
			scopes,
			{ title: "Belongs to A and B", body: "Shared", projectReferences: [projectA.id, projectB.id] },
			undefined,
			registry,
		);
		const onlyA = createRule(artifacts, scopes, { title: "Only A", body: "A", projectReferences: [projectA.id] }, undefined, registry);

		const inA = listInjectableRules(artifacts, scopes, "/tmp/determinism-a").map((rule) => rule.id);
		// Exactly one entry for the multi-membership Rule, not one per membership row.
		expect(inA.filter((id) => id === multiMembershipRule.id)).toHaveLength(1);
		expect(inA).toContain(onlyA.id);

		const first = listInjectableRules(artifacts, scopes, "/tmp/determinism-a").map((rule) => rule.id);
		const second = listInjectableRules(artifacts, scopes, "/tmp/determinism-a").map((rule) => rule.id);
		expect(first).toEqual(second);
		db.close();
	});

	it("accepts subtype and templateId at creation -- the same create-time surface createDocument already has (papyrus-defect-unify-template-subtype-53b3a1eb)", () => {
		const { db, artifacts, scopes } = fixture();
		const rule = createRule(artifacts, scopes, { title: "Security rule", subtype: "security" });
		expect(rule.subtype).toBe("security");
		const template = artifacts.create({
			kind: "rule",
			subtype: "artifact-template",
			title: "Rule template",
			extra: { targetKind: "rule", defaults: { subtype: "compliance" } },
		});
		const fromTemplate = createRule(artifacts, scopes, { title: "From template", templateId: template.id });
		expect(fromTemplate.subtype).toBe("compliance");
		expect(fromTemplate.status).toBe("draft");
		db.close();
	});

	it("keeps a template-sourced Rule inert until its completionRequired fields are present and enable succeeds", () => {
		const { db, artifacts, scopes } = fixture();
		const template = artifacts.create({
			kind: "rule",
			subtype: "artifact-template",
			title: "Complete governance rule template",
			extra: { targetKind: "rule", completionRequired: ["body"] },
		});
		const rule = createRule(artifacts, scopes, { title: "Incomplete rule", templateId: template.id });
		expect(rule.status).toBe("draft");
		expect(rule.extra.templateId).toBe(template.id);
		expect(listInjectableRules(artifacts, scopes, undefined).map((candidate) => candidate.id)).not.toContain(template.id);
		expect(listInjectableRules(artifacts, scopes, undefined).map((candidate) => candidate.id)).not.toContain(rule.id);
		expect(() => transitionRule(artifacts, rule.id, "enable")).toThrow(
			`rule does not conform to template "${template.id}": missing completion-required field "body"`,
		);

		updateRule(artifacts, rule.id, { body: "Always run the complete verification suite." });
		expect(transitionRule(artifacts, rule.id, "enable").status).toBe("active");
		expect(listInjectableRules(artifacts, scopes, undefined).map((candidate) => candidate.id)).toContain(rule.id);
		db.close();
	});

	it("rejects a rule whose condition+action+body exceeds the permanent-context-tax bound", () => {
		const { db, artifacts, scopes } = fixture();
		const oversized = "x".repeat(4001);
		expect(() => createRule(artifacts, scopes, { title: "Bloated", body: oversized })).toThrow(/4000-character bound/);
		// A rule right at the boundary, or comfortably under it, is unaffected.
		expect(() => createRule(artifacts, scopes, { title: "Fits", body: "x".repeat(4000) })).not.toThrow();
		expect(() =>
			createRule(artifacts, scopes, { title: "Small", condition: "before commit", action: "Run tests", body: "Short reasoning" }),
		).not.toThrow();
		// The bound is on the SUM of condition+action+body, not any single field alone.
		expect(() =>
			createRule(artifacts, scopes, {
				title: "Split across fields",
				condition: "x".repeat(1500),
				action: "x".repeat(1500),
				body: "x".repeat(1500),
			}),
		).toThrow(/4000-character bound/);
		db.close();
	});

	it("updates a rule's title/body/labels, still enforcing the combined context-tax bound against its existing condition/action", () => {
		const { db, artifacts, scopes } = fixture();
		const rule = createRule(artifacts, scopes, {
			title: "Test before commit",
			condition: "x".repeat(1900),
			action: "x".repeat(1900),
			body: "short",
		});
		const updated = updateRule(artifacts, rule.id, { title: "Test before commit v2", labels: ["reviewed"] });
		expect(updated.title).toBe("Test before commit v2");
		expect(updated.labels).toEqual(["reviewed"]);
		// Existing condition/action (1900+1900) plus a new, larger body pushes the combined total over 4000.
		expect(() => updateRule(artifacts, rule.id, { body: "x".repeat(300) })).toThrow(/4000-character bound/);
		expect(() => updateRule(artifacts, rule.id, { body: "short still" })).not.toThrow();
		db.close();
	});

	it("ruleCombinedLength sums condition+action+body, treating a missing field as empty", () => {
		expect(ruleCombinedLength("cond", "act", "body")).toBe(11);
		expect(ruleCombinedLength(undefined, undefined, undefined)).toBe(0);
		expect(ruleCombinedLength("x".repeat(10), undefined, "y".repeat(5))).toBe(15);
	});

	it("ruleCombinedLengthWarning is undefined at or under the 600-character soft target, and a message once over it", () => {
		expect(ruleCombinedLengthWarning(0)).toBeUndefined();
		expect(ruleCombinedLengthWarning(600)).toBeUndefined();
		expect(ruleCombinedLengthWarning(601)).toContain("601 characters");
		expect(ruleCombinedLengthWarning(601)).toContain("600-character soft target");
		expect(ruleCombinedLengthWarning(601)).toContain("4000");
	});

	it("refuses to update a Rule that is a read-only projection from an external system", () => {
		const { db, artifacts, scopes } = fixture();
		const rule = createRule(artifacts, scopes, { title: "Imported policy", labels: ["source:some-external-system"] });
		expect(() => updateRule(artifacts, rule.id, { title: "Edited locally" })).toThrow(/read-only projection from some-external-system/);
		db.close();
	});

	it("refuses to change lifecycle or gate a Task with a Rule that is a read-only projection -- update is not the only way to mutate one", () => {
		const { db, artifacts, scopes, tasks } = fixture();
		const rule = createRule(artifacts, scopes, { title: "Imported policy", labels: ["source:some-external-system"] });
		expect(() => transitionRule(artifacts, rule.id, "disable")).toThrow(/read-only projection from some-external-system/);
		const task = tasks.create({ title: "Gated task" });
		expect(() => gateTaskWithRule(artifacts, rule.id, task.id)).toThrow(/read-only projection from some-external-system/);
		db.close();
	});
});

describe("playbooks domain service -- a completely different beast from Skills, not a subtype", () => {
	it("owns playbook lifecycle and renders trigger/steps/tools plus real linked context on invocation", () => {
		const { db, artifacts, scopes } = fixture();
		const linked = artifacts.create({ kind: "doc", title: "Reference doc", status: "draft" });
		const playbook = createPlaybook(artifacts, scopes, {
			title: "New Project",
			trigger: "starting something from scratch",
			steps: ["Frame the problem", "State the goal"],
			tools: ["discuss"],
		});
		expect(playbook.kind).toBe("playbook");
		artifacts.link({ from: playbook.id, relation: "references", to: linked.id });

		const invocation = playbookInvocation(artifacts, playbook.id);
		expect(invocation).toContain('Apply Papyrus playbook "New Project"');
		expect(invocation).not.toContain(playbook.id);
		expect(invocation).not.toContain(linked.id);
		expect(invocation).toContain("Trigger: starting something from scratch");
		expect(invocation).toContain("1. Frame the problem");
		expect(invocation).toContain("2. State the goal");
		expect(invocation).toContain("Tools: discuss");
		expect(invocation).toContain('references doc "Reference doc"');
		// The only link here is to a Doc, not another Playbook, so no nested composition triggers.
		expect(invocation).not.toContain("Also invoke linked");

		expect(transitionPlaybook(artifacts, playbook.id, "disable").status).toBe("deprecated");
		expect(transitionPlaybook(artifacts, playbook.id, "enable").status).toBe("active");
		expect(listPlaybooks(artifacts, scopes, {})).toHaveLength(1);
		expect(showPlaybook(artifacts, playbook.id).id).toBe(playbook.id);
		db.close();
	});

	it("accepts subtype and templateId at creation -- the same create-time surface createDocument already has (papyrus-defect-unify-template-subtype-53b3a1eb)", () => {
		const { db, artifacts, scopes } = fixture();
		const playbook = createPlaybook(artifacts, scopes, { title: "Runbook", subtype: "incident-response" });
		expect(playbook.subtype).toBe("incident-response");
		const template = artifacts.create({
			kind: "playbook",
			subtype: "artifact-template",
			title: "Playbook template",
			extra: { targetKind: "playbook", defaults: { subtype: "onboarding" } },
		});
		const fromTemplate = createPlaybook(artifacts, scopes, { title: "From template", templateId: template.id });
		expect(fromTemplate.subtype).toBe("onboarding");
		db.close();
	});

	it("playbooks nest via contains: invoking the parent recursively runs the child's own steps as part of it", () => {
		const { db, artifacts, scopes } = fixture();
		const child = createPlaybook(artifacts, scopes, { title: "Child playbook", trigger: "never directly", steps: ["Do the child thing"] });
		const parent = createPlaybook(artifacts, scopes, {
			title: "Parent playbook",
			trigger: "starting work",
			steps: ["Do the parent thing"],
		});
		const contained = containPlaybook(artifacts, parent.id, child.id);
		expect(contained.edges).toContainEqual({ from: parent.id, relation: "contains", to: child.id });
		expect(contained.edges).toContainEqual({ from: child.id, relation: "part_of", to: parent.id });

		const invocation = playbookInvocation(artifacts, parent.id);
		expect(invocation).toContain('Apply Papyrus playbook "Parent playbook"');
		expect(invocation).toContain('Nested playbook (contains) "Child playbook" -- run as part of this one:');
		expect(invocation).toContain('Apply Papyrus playbook "Child playbook"');
		expect(invocation).not.toContain(parent.id);
		expect(invocation).not.toContain(child.id);
		expect(invocation).toContain("Do the child thing");
		// Nesting renders AFTER the parent's own body -- it's additional detail, not a precondition.
		expect(invocation.indexOf("Do the parent thing")).toBeLessThan(invocation.indexOf("Do the child thing"));

		const uncontained = uncontainPlaybook(artifacts, parent.id, child.id);
		expect(uncontained.edges ?? []).not.toContainEqual({ from: parent.id, relation: "contains", to: child.id });
		expect(playbookInvocation(artifacts, parent.id)).not.toContain("Nested playbook");
		db.close();
	});

	it("playbooks chain via depends_on: invoking the dependent recursively runs the prerequisite's steps FIRST", () => {
		const { db, artifacts, scopes } = fixture();
		const prerequisite = createPlaybook(artifacts, scopes, {
			title: "Prerequisite playbook",
			trigger: "never directly",
			steps: ["Do the prerequisite thing"],
		});
		const dependent = createPlaybook(artifacts, scopes, {
			title: "Dependent playbook",
			trigger: "starting work",
			steps: ["Do the dependent thing"],
		});
		const depended = dependPlaybook(artifacts, dependent.id, prerequisite.id);
		expect(depended.edges).toContainEqual({ from: dependent.id, relation: "depends_on", to: prerequisite.id });

		const invocation = playbookInvocation(artifacts, dependent.id);
		expect(invocation).toContain(
			'Prerequisite playbook (depends_on) "Prerequisite playbook" -- complete this FIRST, before the steps below:',
		);
		expect(invocation).toContain('Apply Papyrus playbook "Prerequisite playbook"');
		expect(invocation).toContain('Apply Papyrus playbook "Dependent playbook"');
		// Chaining renders BEFORE the dependent's own body -- it must complete first.
		expect(invocation.indexOf("Do the prerequisite thing")).toBeLessThan(invocation.indexOf("Do the dependent thing"));

		const undepended = undependPlaybook(artifacts, dependent.id, prerequisite.id);
		expect(undepended.edges ?? []).not.toContainEqual({ from: dependent.id, relation: "depends_on", to: prerequisite.id });
		expect(playbookInvocation(artifacts, dependent.id)).not.toContain("Prerequisite playbook");
		db.close();
	});

	it("rejects a playbook containing or depending on itself, and refuses composition on a read-only external projection", () => {
		const { db, artifacts, scopes } = fixture();
		const playbook = createPlaybook(artifacts, scopes, { title: "Self" });
		expect(() => containPlaybook(artifacts, playbook.id, playbook.id)).toThrow("cannot contain itself");
		expect(() => dependPlaybook(artifacts, playbook.id, playbook.id)).toThrow("cannot depend on itself");

		const other = createPlaybook(artifacts, scopes, { title: "Other" });
		const projected = createPlaybook(artifacts, scopes, { title: "Imported playbook", labels: ["source:some-external-system"] });
		expect(() => containPlaybook(artifacts, projected.id, other.id)).toThrow(/read-only projection from some-external-system/);
		expect(() => dependPlaybook(artifacts, projected.id, other.id)).toThrow(/read-only projection from some-external-system/);
		db.close();
	});

	it("degrades a playbook composition cycle (contains or depends_on) to a marker instead of infinite-looping the invocation preview", () => {
		const { db, artifacts, scopes } = fixture();
		const a = createPlaybook(artifacts, scopes, { title: "A", trigger: "x", steps: [] });
		const b = createPlaybook(artifacts, scopes, { title: "B", trigger: "x", steps: [] });
		containPlaybook(artifacts, a.id, b.id);
		dependPlaybook(artifacts, b.id, a.id);

		const invocation = playbookInvocation(artifacts, a.id); // must return, not hang or throw
		expect(invocation).toContain("already invoked above in this chain, not repeated");
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
		expect(() =>
			createPlaybook(artifacts, scopes, { title: "Bad", arguments: Array.from({ length: 21 }, (_, i) => ({ name: `a${i}` })) }),
		).toThrow(/cannot exceed 20 entries/);
		expect(() => createPlaybook(artifacts, scopes, { title: "Bad", arguments: [{ name: "x" }, { name: "x" }] })).toThrow(
			'argument name "x" is declared more than once',
		);
		expect(() => createPlaybook(artifacts, scopes, { title: "Bad", arguments: [{ name: "x", required: "yes" }] })).toThrow(
			'argument "x" required must be a boolean',
		);
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
		expect(() => updatePlaybook(artifacts, projected.id, { title: "Edited locally" })).toThrow(
			/read-only projection from some-external-system/,
		);
		db.close();
	});

	it("refuses to change lifecycle on a Playbook that is a read-only projection -- update is not the only way to mutate one", () => {
		const { db, artifacts, scopes } = fixture();
		const projected = createPlaybook(artifacts, scopes, { title: "Imported playbook", labels: ["source:some-external-system"] });
		expect(() => transitionPlaybook(artifacts, projected.id, "disable")).toThrow(/read-only projection from some-external-system/);
		db.close();
	});

	it("rejects playbook actions against another artifact kind", () => {
		const { db, artifacts } = fixture();
		const rule = artifacts.create({ kind: "rule", status: "active", title: "Not a playbook" });
		expect(() => showPlaybook(artifacts, rule.id)).toThrow("is not a playbook");
		expect(() => transitionPlaybook(artifacts, rule.id, "disable")).toThrow("is not a playbook");
		db.close();
	});

	it("rejects an illegal transition with the same error shape the shared transition-table runner produces for every kind (unify-the-four-artifact-kind-transition-implementa e170c1a4)", () => {
		const { db, artifacts, scopes } = fixture();
		const playbook = createPlaybook(artifacts, scopes, { title: "Already active" });
		expect(() => transitionPlaybook(artifacts, playbook.id, "enable")).toThrow("cannot enable playbook from active");
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

	it("rejects an illegal transition with the same error shape the shared transition-table runner produces for every kind (unify-the-four-artifact-kind-transition-implementa e170c1a4)", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const document = createDocument(artifacts, scopes, { title: "Still draft" }, authority);
		expect(() => transitionDocument(artifacts, document.id, "archive", authority)).not.toThrow(); // draft -> archived is legal
		expect(() => transitionDocument(artifacts, document.id, "activate", authority)).toThrow("cannot activate doc from archived");
		db.close();
	});

	it("updates a document's title, body, and labels, and refuses an empty update", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const document = createDocument(artifacts, scopes, { title: "Architecture v1", body: "draft notes" }, authority);
		const updated = updateDocument(
			artifacts,
			document.id,
			{ title: "Architecture v2", body: "revised notes", labels: ["reviewed"] },
			authority,
		);
		expect(updated.title).toBe("Architecture v2");
		expect(updated.body).toBe("revised notes");
		expect(updated.labels).toEqual(["reviewed"]);
		expect(() => updateDocument(artifacts, document.id, {}, authority)).toThrow("update requires title, body, or labels");
		expect(() => updateDocument(artifacts, document.id, { title: "" }, authority)).toThrow(/title must be between/);
		db.close();
	});

	it("refuses to update a Doc that is a read-only projection from an external system", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const document = createDocument(
			artifacts,
			scopes,
			{ title: "Ingested page", labels: ["source:web-spider", "domain:example.com"] },
			authority,
		);
		expect(() => updateDocument(artifacts, document.id, { title: "Edited locally" }, authority)).toThrow(
			/read-only projection from web-spider/,
		);
		db.close();
	});

	it("refuses to change lifecycle or link a Doc that is a read-only projection -- update is not the only way to mutate one", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const ingested = createDocument(artifacts, scopes, { title: "Ingested page", labels: ["source:web-spider"] }, authority);
		expect(() => transitionDocument(artifacts, ingested.id, "archive", authority)).toThrow(/read-only projection from web-spider/);
		const other = createDocument(artifacts, scopes, { title: "Native note" }, authority);
		expect(() => linkDocument(artifacts, ingested.id, "references", other.id, authority)).toThrow(/read-only projection from web-spider/);
		expect(() => linkDocument(artifacts, other.id, "references", ingested.id, authority)).toThrow(/read-only projection from web-spider/);
		db.close();
	});

	it("links two locally-owned Docs", () => {
		const { db, artifacts, scopes, authority } = fixture();
		const from = createDocument(artifacts, scopes, { title: "Overview" }, authority);
		const to = createDocument(artifacts, scopes, { title: "Detail" }, authority);
		const linked = linkDocument(artifacts, from.id, "references", to.id, authority);
		expect(linked.edges).toContainEqual({ from: from.id, relation: "references", to: to.id });
		db.close();
	});

	it("links a Doc to a Task -- a plain reference edge does not mutate the Task's lifecycle, so it must not trip the tasks.* status guard", () => {
		const { db, artifacts, scopes, tasks } = fixture();
		// The bare empty-claims fixture() authority above can't reproduce this -- the real
		// production registry (tasksAuthorityClaim etc.) is what the bug actually lives in.
		const authority = createAuthorityRegistry();
		const document = createDocument(artifacts, scopes, { title: "Design notes" }, authority);
		const task = tasks.create({ title: "Ship the feature" });

		const linked = linkDocument(artifacts, document.id, "references", task.id, authority);
		expect(linked.edges).toContainEqual({ from: document.id, relation: "references", to: task.id });

		const reverse = linkDocument(artifacts, document.id, "documents", task.id, authority);
		expect(reverse.edges).toContainEqual({ from: document.id, relation: "documents", to: task.id });

		// The guard must still exist for its real purpose: an actual status change through the wrong tool.
		expect(() => transitionDocument(artifacts, task.id, "archive", authority)).toThrow("is not a doc");
		db.close();
	});

	it("still refuses linking a Doc to a Note through docs.link -- Notes keep their own link-scoped guard, unaffected by the Task fix", () => {
		const { db, artifacts, scopes } = fixture();
		const authority = createAuthorityRegistry();
		const document = createDocument(artifacts, scopes, { title: "Design notes" }, authority);
		const note = artifacts.create({ kind: "doc", subtype: "note", title: "A note", status: "active" });
		expect(() => linkDocument(artifacts, document.id, "references", note.id, authority)).toThrow(
			"note relationships require a notes.* operation",
		);
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
		expect(
			listDocuments(artifacts, scopes, {})
				.map((doc) => doc.id)
				.sort(),
		).toEqual([scoped.id, unscoped.id].sort());
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
		expect(() => assignDocumentProject(artifacts, scopes, note.id, "/workspace/papyrus")).toThrow(
			"note access requires a notes.* operation",
		);
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

	it("rejects a non-absolute project_root, matching Tasks' own validation", () => {
		const { db, artifacts, scopes, authority } = fixture();
		expect(() => createDocument(artifacts, scopes, { title: "Bad", projectRoot: "relative/path" }, authority)).toThrow(
			"project_root must be an absolute path",
		);
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

	it("creates a Playbook as active even when another playbook status is rowid-first", () => {
		const { db, artifacts, scopes } = fixture();
		adversariallyReorderStatuses(db, "playbook", "active");
		expect(createPlaybook(artifacts, scopes, { title: "Adversarial" }).status).toBe("active");
		db.close();
	});
});
