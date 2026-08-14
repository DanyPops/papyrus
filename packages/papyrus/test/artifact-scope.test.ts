import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import type { ArtifactScopeStore } from "../src/artifact/artifact-scope-store.ts";
import { InMemoryArtifactScopeStore } from "../src/artifact/in-memory-artifact-scope-store.ts";
import { SQLiteArtifactScopeStore } from "../src/artifact/sqlite-artifact-scope-store.ts";
import { ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT } from "../src/constants.ts";
import type { Db } from "../src/db.ts";
import { openDb } from "../src/db.ts";
import { createArtifact } from "../src/ops.ts";
import { InMemoryScopeGroupStore } from "../src/scope-group/in-memory-scope-group-store.ts";
import type { ScopeGroupStore } from "../src/scope-group/scope-group-store.ts";
import { SQLiteScopeGroupStore } from "../src/scope-group/sqlite-scope-group-store.ts";
import { InMemoryProjectRegistryStore } from "../src/stores/in-memory-project-registry-store.ts";
import { SQLiteProjectRegistryStore } from "../src/stores/sqlite-project-registry-store.ts";
import { tempDir } from "./helpers/tmp-dir.ts";

describe("ArtifactScopeStore: none/all/explicit tri-state scope with nested scope-group membership", () => {
	for (const backend of ["in-memory", "sqlite"] as const) {
		describe(backend, () => {
			function makeStore(): {
				scopes: ArtifactScopeStore;
				scopeGroups: ScopeGroupStore;
				registerProject: (root: string) => string;
				registerGroup: (name: string) => string;
				/** Real artifact ids -- artifact_scopes.artifact_id is FK-enforced against a genuine artifacts row for the sqlite backend. */
				artifact: (title: string) => string;
				cleanup: () => void;
			} {
				if (backend === "in-memory") {
					const registry = new InMemoryProjectRegistryStore();
					const scopeGroups = new InMemoryScopeGroupStore();
					const scopes = new InMemoryArtifactScopeStore(registry, scopeGroups);
					return {
						scopes,
						scopeGroups,
						registerProject: (root) => registry.registerProject({ projectRoot: root }).id,
						registerGroup: (name) => scopeGroups.registerGroup({ name }).id,
						artifact: (title) => title,
						cleanup: () => {},
					};
				}
				const dir = tempDir("papyrus-artifact-scope-");
				const db: Db = openDb(`${dir}/papyrus.db`);
				const registry = new SQLiteProjectRegistryStore(db);
				const scopeGroups = new SQLiteScopeGroupStore(db);
				const scopes = new SQLiteArtifactScopeStore(db);
				return {
					scopes,
					scopeGroups,
					registerProject: (root) => registry.registerProject({ projectRoot: root }).id,
					registerGroup: (name) => scopeGroups.registerGroup({ name }).id,
					artifact: (title) => createArtifact(db, { kind: "doc", title }).id,
					cleanup: () => rmSync(dir, { recursive: true, force: true }),
				};
			}

			it("defaults an artifact with no scope row to all/unscoped", () => {
				const { scopes, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					expect(scopes.scope(doc1)).toEqual({ artifactId: doc1, mode: "all", members: [], source: "unscoped" });
					expect(scopes.appliesToProject(doc1, "any-project")).toBe(true);
				} finally {
					cleanup();
				}
			});

			it("setAll clears any prior project membership", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const projectId = registerProject("/repo/lector");
					scopes.replaceMembers(doc1, [{ type: "project", id: projectId }], "explicit");
					const all = scopes.setAll(doc1, "explicit");
					expect(all).toEqual({ artifactId: doc1, mode: "all", members: [], source: "explicit" });
					expect(scopes.appliesToProject(doc1, projectId)).toBe(true);
				} finally {
					cleanup();
				}
			});

			it("setNone hides an artifact from every project, including one it was previously explicitly scoped to", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const projectId = registerProject("/repo/lector");
					scopes.replaceMembers(doc1, [{ type: "project", id: projectId }], "explicit");
					const none = scopes.setNone(doc1, "explicit");
					expect(none).toEqual({ artifactId: doc1, mode: "none", members: [], source: "explicit" });
					expect(scopes.appliesToProject(doc1, projectId)).toBe(false);
					expect(scopes.appliesToProjectRoot(doc1, undefined)).toBe(false);
				} finally {
					cleanup();
				}
			});

			it("replaceMembers sets exactly the given membership and rejects an empty set", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const a = registerProject("/repo/a");
					const b = registerProject("/repo/b");
					const scope = scopes.replaceMembers(
						doc1,
						[
							{ type: "project", id: a },
							{ type: "project", id: b },
						],
						"explicit",
					);
					expect(scope.mode).toBe("explicit");
					expect(scope.members.map((m) => m.id).sort()).toEqual([a, b].sort());
					expect(() => scopes.replaceMembers(doc1, [], "explicit")).toThrow(/at least one member/);
				} finally {
					cleanup();
				}
			});

			it("addMember is idempotent -- adding an already-present member is a no-op", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const a = registerProject("/repo/a");
					scopes.addMember(doc1, { type: "project", id: a }, "explicit");
					const again = scopes.addMember(doc1, { type: "project", id: a }, "explicit");
					expect(again.members).toEqual([{ type: "project", id: a }]);
				} finally {
					cleanup();
				}
			});

			it("addMember switches an artifact from all to explicit mode", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					scopes.setAll(doc1, "explicit");
					const a = registerProject("/repo/a");
					const scope = scopes.addMember(doc1, { type: "project", id: a }, "explicit");
					expect(scope.mode).toBe("explicit");
					expect(scope.members).toEqual([{ type: "project", id: a }]);
				} finally {
					cleanup();
				}
			});

			it("removeMember is idempotent -- removing an absent member is a no-op", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const a = registerProject("/repo/a");
					const b = registerProject("/repo/b");
					scopes.replaceMembers(
						doc1,
						[
							{ type: "project", id: a },
							{ type: "project", id: b },
						],
						"explicit",
					);
					const scope = scopes.removeMember(doc1, { type: "project", id: "nonexistent-project-id" });
					expect(scope.members.map((m) => m.id).sort()).toEqual([a, b].sort());
				} finally {
					cleanup();
				}
			});

			it("removeMember drops one membership, keeping the rest", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const a = registerProject("/repo/a");
					const b = registerProject("/repo/b");
					scopes.replaceMembers(
						doc1,
						[
							{ type: "project", id: a },
							{ type: "project", id: b },
						],
						"explicit",
					);
					const scope = scopes.removeMember(doc1, { type: "project", id: a });
					expect(scope.members).toEqual([{ type: "project", id: b }]);
				} finally {
					cleanup();
				}
			});

			it("rejects removing the last membership -- a caller must explicitly call setAll/setNone instead", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const a = registerProject("/repo/a");
					scopes.replaceMembers(doc1, [{ type: "project", id: a }], "explicit");
					expect(() => scopes.removeMember(doc1, { type: "project", id: a })).toThrow(/cannot remove the last scope member/);
					// The rejection must not have partially mutated state.
					expect(scopes.scope(doc1)).toEqual({
						artifactId: doc1,
						mode: "explicit",
						members: [{ type: "project", id: a }],
						source: "explicit",
					});
				} finally {
					cleanup();
				}
			});

			it("enforces the bounded maximum membership count on replaceMembers and addMember", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const doc2 = artifact("Doc 2");
					const ids = Array.from({ length: ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT }, (_, i) => registerProject(`/repo/p${i}`));
					const members = ids.map((id) => ({ type: "project" as const, id }));
					scopes.replaceMembers(doc1, members, "explicit");
					expect(scopes.scope(doc1).members).toHaveLength(ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT);
					const oneMore = registerProject("/repo/one-more");
					expect(() => scopes.addMember(doc1, { type: "project", id: oneMore }, "explicit")).toThrow(/cannot have more than/);
					expect(() => scopes.replaceMembers(doc2, [...members, { type: "project", id: oneMore }], "explicit")).toThrow(
						/cannot have more than/,
					);
				} finally {
					cleanup();
				}
			});

			it("appliesToProject is true for all-mode, true for a real membership, false otherwise, false for none-mode", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const doc2 = artifact("Doc 2");
					const doc3 = artifact("Doc 3");
					const a = registerProject("/repo/a");
					const b = registerProject("/repo/b");
					scopes.replaceMembers(doc1, [{ type: "project", id: a }], "explicit");
					expect(scopes.appliesToProject(doc1, a)).toBe(true);
					expect(scopes.appliesToProject(doc1, b)).toBe(false);
					scopes.setAll(doc2, "explicit");
					expect(scopes.appliesToProject(doc2, b)).toBe(true);
					scopes.setNone(doc3, "explicit");
					expect(scopes.appliesToProject(doc3, a)).toBe(false);
				} finally {
					cleanup();
				}
			});

			it("ids() lists direct project membership only, and the all bucket separately -- an unregistered root yields nothing", () => {
				const { scopes, registerProject, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const doc2 = artifact("Doc 2");
					const a = registerProject("/repo/a");
					scopes.replaceMembers(doc1, [{ type: "project", id: a }], "explicit");
					scopes.setAll(doc2, "explicit");
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
					scopes.replaceMembers(
						doc1,
						[
							{ type: "project", id: a },
							{ type: "project", id: b },
						],
						"explicit",
					);
					expect(scopes.get(doc1)?.projectRoot).toBeUndefined();
					expect(
						scopes
							.scope(doc1)
							.members.map((m) => m.id)
							.sort(),
					).toEqual([a, b].sort());
				} finally {
					cleanup();
				}
			});

			it("get() omits projectRoot for a single group-type membership -- the legacy shape only ever represents a single project", () => {
				const { scopes, registerGroup, artifact, cleanup } = makeStore();
				try {
					const doc1 = artifact("Doc 1");
					const groupId = registerGroup("solo-group");
					scopes.replaceMembers(doc1, [{ type: "group", id: groupId }], "explicit");
					expect(scopes.get(doc1)?.projectRoot).toBeUndefined();
				} finally {
					cleanup();
				}
			});

			describe("nested scope groups ('explicit scope can include nested scopes')", () => {
				it("appliesToProject resolves a project reachable only through a group membership", () => {
					const { scopes, scopeGroups, registerProject, registerGroup, artifact, cleanup } = makeStore();
					try {
						const doc1 = artifact("Doc 1");
						const a = registerProject("/repo/a");
						const b = registerProject("/repo/b");
						const groupId = registerGroup("ecosystem");
						scopeGroups.addMember(groupId, { type: "project", id: a });
						scopeGroups.addMember(groupId, { type: "project", id: b });
						scopes.replaceMembers(doc1, [{ type: "group", id: groupId }], "explicit");
						expect(scopes.appliesToProject(doc1, a)).toBe(true);
						expect(scopes.appliesToProject(doc1, b)).toBe(true);
						expect(scopes.appliesToProject(doc1, "unrelated")).toBe(false);
					} finally {
						cleanup();
					}
				});

				it("resolves a project reachable through two levels of group nesting", () => {
					const { scopes, scopeGroups, registerProject, registerGroup, artifact, cleanup } = makeStore();
					try {
						const doc1 = artifact("Doc 1");
						const a = registerProject("/repo/a");
						const inner = registerGroup("inner");
						const outer = registerGroup("outer");
						scopeGroups.addMember(inner, { type: "project", id: a });
						scopeGroups.addMember(outer, { type: "group", id: inner });
						scopes.replaceMembers(doc1, [{ type: "group", id: outer }], "explicit");
						expect(scopes.appliesToProject(doc1, a)).toBe(true);
					} finally {
						cleanup();
					}
				});

				it("mixes a direct project member with a group member in the same explicit scope", () => {
					const { scopes, scopeGroups, registerProject, registerGroup, artifact, cleanup } = makeStore();
					try {
						const doc1 = artifact("Doc 1");
						const direct = registerProject("/repo/direct");
						const grouped = registerProject("/repo/grouped");
						const groupId = registerGroup("mixed-group");
						scopeGroups.addMember(groupId, { type: "project", id: grouped });
						scopes.replaceMembers(
							doc1,
							[
								{ type: "project", id: direct },
								{ type: "group", id: groupId },
							],
							"explicit",
						);
						expect(scopes.appliesToProject(doc1, direct)).toBe(true);
						expect(scopes.appliesToProject(doc1, grouped)).toBe(true);
					} finally {
						cleanup();
					}
				});

				it("referencesGroup is true only while some artifact's explicit scope still names that group", () => {
					const { scopes, registerGroup, artifact, cleanup } = makeStore();
					try {
						const doc1 = artifact("Doc 1");
						const groupId = registerGroup("referenced");
						expect(scopes.referencesGroup(groupId)).toBe(false);
						scopes.replaceMembers(doc1, [{ type: "group", id: groupId }], "explicit");
						expect(scopes.referencesGroup(groupId)).toBe(true);
						scopes.setAll(doc1, "explicit");
						expect(scopes.referencesGroup(groupId)).toBe(false);
					} finally {
						cleanup();
					}
				});
			});
		});
	}
});
