/**
 * One conformance matrix, run identically against Docs, Rules, and Playbooks: the same bounded
 * global/multi-project scope contract must hold for all three kinds, not three independently
 * hand-verified approximations of it. Each kind's own adapter below wraps its real domain
 * functions (docs-service.ts/rules-service.ts/playbook-service.ts) behind one shared interface;
 * the suite itself never touches a kind-specific function directly.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Artifact } from "../src/artifact/artifact.ts";
import type { ArtifactScope } from "../src/artifact/artifact-scope-store.ts";
import { SQLiteArtifactScopeStore } from "../src/artifact/sqlite-artifact-scope-store.ts";
import { SQLiteArtifactStore } from "../src/artifact/sqlite-artifact-store.ts";
import { AuthorityRegistry } from "../src/authority-registry.ts";
import { openDb } from "../src/db.ts";
import {
	addDocProject,
	createDocument,
	docScope,
	listDocuments,
	removeDocProject,
	replaceDocProjects,
	setDocGlobal,
} from "../src/docs/docs-service.ts";
import {
	addPlaybookProject,
	createPlaybook,
	listPlaybooks,
	playbookScope,
	removePlaybookProject,
	replacePlaybookProjects,
	setPlaybookGlobal,
} from "../src/playbook/playbook-service.ts";
import {
	addRuleProject,
	createRule,
	listRules,
	removeRuleProject,
	replaceRuleProjects,
	ruleScope,
	setRuleGlobal,
} from "../src/rules/rules-service.ts";
import { SQLiteProjectRegistryStore } from "../src/stores/sqlite-project-registry-store.ts";
import { cleanupTempDirs, tempDir } from "./helpers/tmp-dir.ts";

afterAll(cleanupTempDirs);

interface ScopeConformanceAdapter {
	kind: string;
	create(title: string, opts?: { projectRoot?: string; projectReferences?: string[] }): Artifact;
	scope(id: string): ArtifactScope;
	setGlobal(id: string): ArtifactScope;
	addProject(id: string, reference: string): ArtifactScope;
	removeProject(id: string, reference: string): ArtifactScope;
	replaceProjects(id: string, references: string[]): ArtifactScope;
	listExact(projectRoot: string): Artifact[];
	listApplicable(projectRoot: string): Artifact[];
	listAll(): Artifact[];
	registerProject(projectRoot: string, name: string): { id: string };
	renameProject(projectRoot: string, newName: string): void;
}

function fixture() {
	const dir = tempDir("papyrus-scope-conformance-");
	const db = openDb(join(dir, "papyrus.db"));
	const artifacts = new SQLiteArtifactStore(db);
	const scopes = new SQLiteArtifactScopeStore(db);
	const registry = new SQLiteProjectRegistryStore(db);
	const authority = new AuthorityRegistry();

	const adapters: Record<string, ScopeConformanceAdapter> = {
		doc: {
			kind: "doc",
			create: (title, opts) =>
				createDocument(
					artifacts,
					scopes,
					{ title, projectRoot: opts?.projectRoot, projectReferences: opts?.projectReferences },
					authority,
					undefined,
					registry,
				),
			scope: (id) => docScope(artifacts, scopes, id),
			setGlobal: (id) => setDocGlobal(artifacts, scopes, id),
			addProject: (id, reference) => addDocProject(artifacts, scopes, registry, id, reference),
			removeProject: (id, reference) => removeDocProject(artifacts, scopes, registry, id, reference),
			replaceProjects: (id, references) => replaceDocProjects(artifacts, scopes, registry, id, references),
			listExact: (projectRoot) => listDocuments(artifacts, scopes, { projectRoot }),
			listApplicable: (projectRoot) => listDocuments(artifacts, scopes, { applicableToProjectRoot: projectRoot }),
			listAll: () => listDocuments(artifacts, scopes, {}),
			registerProject: (projectRoot, name) => registry.registerProject({ projectRoot, name }),
			renameProject: (projectRoot, newName) => registry.registerProject({ projectRoot, name: newName }),
		},
		rule: {
			kind: "rule",
			create: (title, opts) =>
				createRule(
					artifacts,
					scopes,
					{ title, projectRoot: opts?.projectRoot, projectReferences: opts?.projectReferences },
					undefined,
					registry,
				),
			scope: (id) => ruleScope(artifacts, scopes, id),
			setGlobal: (id) => setRuleGlobal(artifacts, scopes, id),
			addProject: (id, reference) => addRuleProject(artifacts, scopes, registry, id, reference),
			removeProject: (id, reference) => removeRuleProject(artifacts, scopes, registry, id, reference),
			replaceProjects: (id, references) => replaceRuleProjects(artifacts, scopes, registry, id, references),
			listExact: (projectRoot) => listRules(artifacts, scopes, { projectRoot }),
			listApplicable: (projectRoot) => listRules(artifacts, scopes, { applicableToProjectRoot: projectRoot }),
			listAll: () => listRules(artifacts, scopes, {}),
			registerProject: (projectRoot, name) => registry.registerProject({ projectRoot, name }),
			renameProject: (projectRoot, newName) => registry.registerProject({ projectRoot, name: newName }),
		},
		playbook: {
			kind: "playbook",
			create: (title, opts) =>
				createPlaybook(
					artifacts,
					scopes,
					{ title, projectRoot: opts?.projectRoot, projectReferences: opts?.projectReferences },
					undefined,
					registry,
				),
			scope: (id) => playbookScope(artifacts, scopes, id),
			setGlobal: (id) => setPlaybookGlobal(artifacts, scopes, id),
			addProject: (id, reference) => addPlaybookProject(artifacts, scopes, registry, id, reference),
			removeProject: (id, reference) => removePlaybookProject(artifacts, scopes, registry, id, reference),
			replaceProjects: (id, references) => replacePlaybookProjects(artifacts, scopes, registry, id, references),
			listExact: (projectRoot) => listPlaybooks(artifacts, scopes, { projectRoot }),
			listApplicable: (projectRoot) => listPlaybooks(artifacts, scopes, { applicableToProjectRoot: projectRoot }),
			listAll: () => listPlaybooks(artifacts, scopes, {}),
			registerProject: (projectRoot, name) => registry.registerProject({ projectRoot, name }),
			renameProject: (projectRoot, newName) => registry.registerProject({ projectRoot, name: newName }),
		},
	};

	return { db, adapters };
}

function runScopeConformanceSuite(adapterKey: "doc" | "rule" | "playbook"): void {
	describe(`artifact scope conformance: ${adapterKey}`, () => {
		it("creates global by default, and with 1 or N registered projects via projectReferences", () => {
			const { db, adapters } = fixture();
			const adapter = adapters[adapterKey]!;
			const projectA = adapter.registerProject("/tmp/conformance-a", "Conformance A");
			const projectB = adapter.registerProject("/tmp/conformance-b", "Conformance B");

			const global = adapter.create("Global");
			expect(adapter.scope(global.id)).toEqual({ artifactId: global.id, mode: "all", members: [], source: "unscoped" });

			const oneProject = adapter.create("One project", { projectReferences: [projectA.id] });
			expect(adapter.scope(oneProject.id).mode).toBe("explicit");
			expect(adapter.scope(oneProject.id).members.map((m) => m.id)).toEqual([projectA.id]);

			const twoProjects = adapter.create("Two projects", { projectReferences: [projectA.id, projectB.id] });
			expect(
				adapter
					.scope(twoProjects.id)
					.members.map((m) => m.id)
					.sort(),
			).toEqual([projectA.id, projectB.id].sort());
			db.close();
		});

		it("scope inspection returns stable registered identities (ids), not roots or transient labels", () => {
			const { db, adapters } = fixture();
			const adapter = adapters[adapterKey]!;
			const project = adapter.registerProject("/tmp/conformance-stable", "Conformance Stable");
			const created = adapter.create("Scoped", { projectReferences: [project.id] });
			expect(adapter.scope(created.id).members.map((m) => m.id)).toEqual([project.id]);
			db.close();
		});

		it("add is idempotent for an already-present project; remove is idempotent for an absent one", () => {
			const { db, adapters } = fixture();
			const adapter = adapters[adapterKey]!;
			const project = adapter.registerProject("/tmp/conformance-idempotent", "Conformance Idempotent");
			const other = adapter.registerProject("/tmp/conformance-idempotent-other", "Conformance Idempotent Other");
			const created = adapter.create("Idempotent");

			const afterFirstAdd = adapter.addProject(created.id, project.id);
			expect(afterFirstAdd.members.map((m) => m.id)).toEqual([project.id]);
			const afterSecondAdd = adapter.addProject(created.id, project.id);
			expect(afterSecondAdd.members.map((m) => m.id)).toEqual([project.id]);

			const afterRemoveAbsent = adapter.removeProject(created.id, other.id);
			expect(afterRemoveAbsent.members.map((m) => m.id)).toEqual([project.id]);
			db.close();
		});

		it("removing the final membership fails closed -- set_global is the only path back to global", () => {
			const { db, adapters } = fixture();
			const adapter = adapters[adapterKey]!;
			const project = adapter.registerProject("/tmp/conformance-final-remove", "Conformance Final Remove");
			const created = adapter.create("Final membership", { projectReferences: [project.id] });
			expect(() => adapter.removeProject(created.id, project.id)).toThrow(/set_global|last|only remaining|non-empty/i);
			const madeGlobal = adapter.setGlobal(created.id);
			expect(madeGlobal.mode).toBe("all");
			db.close();
		});

		it("replace and explicit set-global are atomic: replace swaps the whole set in one call, set-global clears it entirely", () => {
			const { db, adapters } = fixture();
			const adapter = adapters[adapterKey]!;
			const projectA = adapter.registerProject("/tmp/conformance-atomic-a", "Conformance Atomic A");
			const projectB = adapter.registerProject("/tmp/conformance-atomic-b", "Conformance Atomic B");
			const projectC = adapter.registerProject("/tmp/conformance-atomic-c", "Conformance Atomic C");
			const created = adapter.create("Atomic", { projectReferences: [projectA.id] });

			const replaced = adapter.replaceProjects(created.id, [projectB.id, projectC.id]);
			expect(replaced.members.map((m) => m.id).sort()).toEqual([projectB.id, projectC.id].sort());

			const globalized = adapter.setGlobal(created.id);
			expect(globalized).toEqual({ artifactId: created.id, mode: "all", members: [], source: "explicit" });
			db.close();
		});

		it("exact membership, applicable, and unscoped all-list queries are bounded and duplicate-free", () => {
			const { db, adapters } = fixture();
			const adapter = adapters[adapterKey]!;
			const projectA = adapter.registerProject("/tmp/conformance-query-a", "Conformance Query A");
			const projectB = adapter.registerProject("/tmp/conformance-query-b", "Conformance Query B");
			const multiMembership = adapter.create("Multi membership", { projectReferences: [projectA.id, projectB.id] });
			const onlyA = adapter.create("Only A", { projectReferences: [projectA.id] });
			const global = adapter.create("Global entry");

			const exactA = adapter.listExact("/tmp/conformance-query-a").map((entry) => entry.id);
			expect(exactA.sort()).toEqual([multiMembership.id, onlyA.id].sort());
			expect(exactA).not.toContain(global.id);

			const applicableA = adapter.listApplicable("/tmp/conformance-query-a").map((entry) => entry.id);
			// No duplicate entry for the multi-membership artifact.
			expect(applicableA.filter((id) => id === multiMembership.id)).toHaveLength(1);
			expect(applicableA).toContain(onlyA.id);
			expect(applicableA).toContain(global.id);

			const all = adapter.listAll().map((entry) => entry.id);
			expect(all).toEqual(expect.arrayContaining([multiMembership.id, onlyA.id, global.id]));
			db.close();
		});

		it("project rename/root move preserves an artifact's own membership -- scope tracks the project's stable id, not a snapshot of its name/root", () => {
			const { db, adapters } = fixture();
			const adapter = adapters[adapterKey]!;
			const project = adapter.registerProject("/tmp/conformance-rename-before", "Conformance Rename Before");
			const created = adapter.create("Survives rename", { projectReferences: [project.id] });
			adapter.renameProject("/tmp/conformance-rename-before", "Conformance Rename After");
			expect(adapter.scope(created.id).members.map((m) => m.id)).toEqual([project.id]);
			db.close();
		});

		it("same-title cross-project lookup never silently widens: exact membership never returns another project's same-named artifact", () => {
			const { db, adapters } = fixture();
			const adapter = adapters[adapterKey]!;
			const projectA = adapter.registerProject("/tmp/conformance-widen-a", "Conformance Widen A");
			const projectB = adapter.registerProject("/tmp/conformance-widen-b", "Conformance Widen B");
			const inA = adapter.create("Shared title", { projectReferences: [projectA.id] });
			const inB = adapter.create("Shared title", { projectReferences: [projectB.id] });

			const exactA = adapter.listExact("/tmp/conformance-widen-a").map((entry) => entry.id);
			expect(exactA).toContain(inA.id);
			expect(exactA).not.toContain(inB.id);
			db.close();
		});
	});
}

runScopeConformanceSuite("doc");
runScopeConformanceSuite("rule");
runScopeConformanceSuite("playbook");
