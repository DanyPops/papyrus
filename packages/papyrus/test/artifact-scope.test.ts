import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import type { ArtifactScopeStore } from "../src/artifact/artifact-scope-store.ts";
import { InMemoryArtifactScopeStore } from "../src/artifact/in-memory-artifact-scope-store.ts";
import { SQLiteArtifactScopeStore } from "../src/artifact/sqlite-artifact-scope-store.ts";
import { ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT } from "../src/constants.ts";
import type { Db } from "../src/db.ts";
import { openDb } from "../src/db.ts";
import { createArtifact } from "../src/ops.ts";
import { InMemoryProjectRegistryStore } from "../src/stores/in-memory-project-registry-store.ts";
import { SQLiteProjectRegistryStore } from "../src/stores/sqlite-project-registry-store.ts";
import { tempDir } from "./helpers/tmp-dir.ts";

describe("ArtifactScopeStore: global vs. bounded non-empty project membership", () => {
	for (const backend of ["in-memory", "sqlite"] as const) {
		describe(backend, () => {
			function makeStore(): {
				scopes: ArtifactScopeStore;
				registerProject: (root: string) => string;
				/** Real artifact ids -- artifact_scopes.artifact_id is FK-enforced against a genuine artifacts row for the sqlite backend. */
				artifact: (title: string) => string;
				cleanup: () => void;
			} {
				if (backend === "in-memory") {
					const registry = new InMemoryProjectRegistryStore();
					const scopes = new InMemoryArtifactScopeStore(registry);
					return {
						scopes,
						registerProject: (root) => registry.registerProject({ projectRoot: root }).id,
						artifact: (title) => title,
						cleanup: () => {},
					};
				}
				const dir = tempDir("papyrus-artifact-scope-");
				const db: Db = openDb(`${dir}/papyrus.db`);
				const registry = new SQLiteProjectRegistryStore(db);
				const scopes = new SQLiteArtifactScopeStore(db);
				return {
					scopes,
					registerProject: (root) => registry.registerProject({ projectRoot: root }).id,
					artifact: (title) => createArtifact(db, { kind: "doc", title }).id,
					cleanup: () => rmSync(dir, { recursive: true, force: true }),
				};
			}

			it("defaults an artifact with no scope row to global/unscoped", () => {
				const { scopes, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					expect(scopes.scope(doc1)).toEqual({ artifactId: doc1, mode: "global", projectIds: [], source: "unscoped" });
					expect(scopes.appliesToProject(doc1, "any-project")).toBe(true);
				} finally {
					cleanup();
				}
			});

			it("setGlobal clears any prior project membership", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const projectId = registerProject("/repo/lector");
					scopes.replaceProjects(doc1, [projectId], "explicit");
					const global = scopes.setGlobal(doc1, "explicit");
					expect(global).toEqual({ artifactId: doc1, mode: "global", projectIds: [], source: "explicit" });
					expect(scopes.appliesToProject(doc1, projectId)).toBe(true);
				} finally {
					cleanup();
				}
			});

			it("replaceProjects sets exactly the given membership and rejects an empty set", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const a = registerProject("/repo/a");
					const b = registerProject("/repo/b");
					const scope = scopes.replaceProjects(doc1, [a, b], "explicit");
					expect(scope.mode).toBe("projects");
					expect(scope.projectIds.sort()).toEqual([a, b].sort());
					expect(() => scopes.replaceProjects(doc1, [], "explicit")).toThrow(/at least one project/);
				} finally {
					cleanup();
				}
			});

			it("addProject is idempotent -- adding an already-present id is a no-op", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const a = registerProject("/repo/a");
					scopes.addProject(doc1, a, "explicit");
					const again = scopes.addProject(doc1, a, "explicit");
					expect(again.projectIds).toEqual([a]);
				} finally {
					cleanup();
				}
			});

			it("addProject switches an artifact from global to projects mode", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					scopes.setGlobal(doc1, "explicit");
					const a = registerProject("/repo/a");
					const scope = scopes.addProject(doc1, a, "explicit");
					expect(scope.mode).toBe("projects");
					expect(scope.projectIds).toEqual([a]);
				} finally {
					cleanup();
				}
			});

			it("removeProject is idempotent -- removing an absent id is a no-op", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const a = registerProject("/repo/a");
					const b = registerProject("/repo/b");
					scopes.replaceProjects(doc1, [a, b], "explicit");
					const scope = scopes.removeProject(doc1, "nonexistent-project-id");
					expect(scope.projectIds.sort()).toEqual([a, b].sort());
				} finally {
					cleanup();
				}
			});

			it("removeProject drops one membership, keeping the rest", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const a = registerProject("/repo/a");
					const b = registerProject("/repo/b");
					scopes.replaceProjects(doc1, [a, b], "explicit");
					const scope = scopes.removeProject(doc1, a);
					expect(scope.projectIds).toEqual([b]);
				} finally {
					cleanup();
				}
			});

			it("rejects removing the last membership -- a caller must explicitly call setGlobal instead", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const a = registerProject("/repo/a");
					scopes.replaceProjects(doc1, [a], "explicit");
					expect(() => scopes.removeProject(doc1, a)).toThrow(/cannot remove the last project membership/);
					// The rejection must not have partially mutated state.
					expect(scopes.scope(doc1)).toEqual({ artifactId: doc1, mode: "projects", projectIds: [a], source: "explicit" });
				} finally {
					cleanup();
				}
			});

			it("enforces the bounded maximum membership count on replaceProjects and addProject", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const doc2 = artifact("Doc 2");
					const ids = Array.from({ length: ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT }, (_, i) => registerProject(`/repo/p${i}`));
					scopes.replaceProjects(doc1, ids, "explicit");
					expect(scopes.scope(doc1).projectIds).toHaveLength(ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT);
					const oneMore = registerProject("/repo/one-more");
					expect(() => scopes.addProject(doc1, oneMore, "explicit")).toThrow(/cannot belong to more than/);
					expect(() => scopes.replaceProjects(doc2, [...ids, oneMore], "explicit")).toThrow(/cannot belong to more than/);
				} finally {
					cleanup();
				}
			});

			it("appliesToProject is true for global, true for a real membership, false otherwise", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const doc2 = artifact("Doc 2");
					const a = registerProject("/repo/a");
					const b = registerProject("/repo/b");
					scopes.replaceProjects(doc1, [a], "explicit");
					expect(scopes.appliesToProject(doc1, a)).toBe(true);
					expect(scopes.appliesToProject(doc1, b)).toBe(false);
					scopes.setGlobal(doc2, "explicit");
					expect(scopes.appliesToProject(doc2, b)).toBe(true);
				} finally {
					cleanup();
				}
			});

			it("ids() lists members for one project root, and the global bucket separately -- an unregistered root yields nothing", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const doc2 = artifact("Doc 2");
					const a = registerProject("/repo/a");
					scopes.replaceProjects(doc1, [a], "explicit");
					scopes.setGlobal(doc2, "explicit");
					expect(scopes.ids("/repo/a", 10)).toEqual([doc1]);
					expect(scopes.ids(undefined, 10)).toEqual([doc2]);
					expect(scopes.ids("/repo/never-registered", 10)).toEqual([]);
				} finally {
					cleanup();
				}
			});

			it("the legacy assign/get single-root compatibility shim keeps working for every existing caller", () => {
				const { scopes, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const assigned = scopes.assign(doc1, "/repo/a", "explicit");
					expect(assigned.projectRoot).toBe("/repo/a");
					expect(scopes.get(doc1)?.projectRoot).toBe("/repo/a");
					const unscoped = scopes.assign(doc1, undefined, "unscoped");
					expect(unscoped.projectRoot).toBeUndefined();
					expect(scopes.get(doc1)?.projectRoot).toBeUndefined();
				} finally {
					cleanup();
				}
			});

			it("get() omits projectRoot once an artifact has more than one membership -- the legacy shape cannot represent it", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const a = registerProject("/repo/a");
					const b = registerProject("/repo/b");
					scopes.replaceProjects(doc1, [a, b], "explicit");
					expect(scopes.get(doc1)?.projectRoot).toBeUndefined();
					expect(scopes.scope(doc1).projectIds.sort()).toEqual([a, b].sort());
				} finally {
					cleanup();
				}
			});
		});
	}
});
