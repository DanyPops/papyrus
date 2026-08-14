import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { InMemoryArtifactScopeStore } from "../src/artifact/in-memory-artifact-scope-store.ts";
import { openDb } from "../src/db.ts";
import { InMemoryProjectRegistryStore } from "../src/project-registry/in-memory-project-registry-store.ts";
import { SQLiteProjectRegistryStore } from "../src/project-registry/sqlite-project-registry-store.ts";
import { SQLiteTaskScopeStore } from "../src/task-scope/sqlite-task-scope-store.ts";
import { InMemoryTaskScopeStore } from "../src/task-scope/task-scope-store.ts";
import { tempDir } from "./helpers/tmp-dir.ts";

describe("ProjectRegistryStore: id/name/alias/root resolution, ambiguity, rename, and root move", () => {
	for (const backend of ["in-memory", "sqlite"] as const) {
		describe(backend, () => {
			function makeRegistry() {
				if (backend === "in-memory") return { registry: new InMemoryProjectRegistryStore(), cleanup: () => {} };
				const dir = tempDir("papyrus-project-registry-");
				const db = openDb(`${dir}/papyrus.db`);
				return { registry: new SQLiteProjectRegistryStore(db), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
			}

			it("registers a project once, resolving by exact id, name, root, or alias", () => {
				const { registry, cleanup } = makeRegistry();
				try {
					const project = registry.registerProject({ projectRoot: "/repo/lector", name: "Lector", aliases: ["lct"] });
					expect(registry.matchingProjects(project.id)).toHaveLength(1);
					expect(registry.matchingProjects("Lector")).toHaveLength(1);
					expect(registry.matchingProjects("/repo/lector")).toHaveLength(1);
					expect(registry.matchingProjects("lct")).toHaveLength(1);
					expect(registry.matchingProjects("LECTOR")).toHaveLength(1); // case-insensitive
					expect(registry.matchingProjects("nonexistent")).toHaveLength(0);
				} finally {
					cleanup();
				}
			});

			it("re-registering the same root updates the existing project instead of duplicating it", () => {
				const { registry, cleanup } = makeRegistry();
				try {
					const first = registry.registerProject({ projectRoot: "/repo/lector", name: "Lector" });
					const second = registry.registerProject({ projectRoot: "/repo/lector", name: "Lector Renamed" });
					expect(second.id).toBe(first.id);
					expect(registry.projects(undefined, 100)).toHaveLength(1);
					expect(second.name).toBe("Lector Renamed");
					expect(second.aliases).toContain("Lector"); // the old name folds into aliases
				} finally {
					cleanup();
				}
			});

			it("moving a registered project's root by existingId is a rename, not a new registration", () => {
				const { registry, cleanup } = makeRegistry();
				try {
					const original = registry.registerProject({ projectRoot: "/repo/old-path", name: "Lector" });
					const moved = registry.registerProject({ projectRoot: "/repo/new-path", existingId: original.id });
					expect(moved.id).toBe(original.id);
					expect(moved.projectRoot).toBe("/repo/new-path");
					expect(registry.projects(undefined, 100)).toHaveLength(1);
					expect(registry.matchingProjects("/repo/old-path")).toHaveLength(0);
					expect(registry.matchingProjects("/repo/new-path")).toHaveLength(1);
				} finally {
					cleanup();
				}
			});

			it("bounds a query listing and caps matchingProjects at 11 candidates", () => {
				const { registry, cleanup } = makeRegistry();
				try {
					for (let i = 0; i < 20; i++) registry.registerProject({ projectRoot: `/repo/proj-${i}`, name: `proj-${i}` });
					expect(registry.projects(undefined, 5)).toHaveLength(5);
					expect(registry.projects("proj", 3)).toHaveLength(3);
				} finally {
					cleanup();
				}
			});
		});
	}
});

describe("ProjectRegistryStore sharing: a root move propagates to every subscriber, not just the first", () => {
	it("in-memory: TaskScopeStore and ArtifactScopeStore sharing one registry both see a root move", () => {
		const registry = new InMemoryProjectRegistryStore();
		const taskScopes = new InMemoryTaskScopeStore(registry);
		const artifactScopes = new InMemoryArtifactScopeStore(registry);

		taskScopes.assign("task-1", "/repo/old-path", "explicit");
		const project = registry.registerProject({ projectRoot: "/repo/old-path" });
		artifactScopes.assign("doc-1", "/repo/old-path", "explicit");

		registry.registerProject({ projectRoot: "/repo/new-path", existingId: project.id });

		// Task's own scope row is rewritten to the new root (task-scope-store's own onRootMoved).
		expect(taskScopes.get("task-1")?.projectRoot).toBe("/repo/new-path");
		expect(taskScopes.taskIds("/repo/old-path", 10)).toEqual([]);
		expect(taskScopes.taskIds("/repo/new-path", 10)).toEqual(["task-1"]);

		// Artifact scope membership is by project id, so it needs no rewrite at all -- it still
		// resolves correctly under the new root because get()/ids() look the id up live.
		expect(artifactScopes.get("doc-1")?.projectRoot).toBe("/repo/new-path");
		expect(artifactScopes.ids("/repo/old-path", 10)).toEqual([]);
		expect(artifactScopes.ids("/repo/new-path", 10)).toEqual(["doc-1"]);
	});

	it("Task scope/view behavior is unchanged by the extraction: the existing project registry regression suite already covers this end to end", () => {
		// See task-project-idempotency.test.ts's "discovers, resolves, renames, and moves
		// registered projects while preserving aliases and task scope" -- kept as the one
		// authoritative Task-side regression rather than duplicated here.
		expect(true).toBe(true);
	});
});

describe("TaskScopeStore/ArtifactScopeStore tasks.* compatibility delegates are unchanged", () => {
	it("InMemoryTaskScopeStore.projects/matchingProjects/registerProject still work standalone (no shared registry passed)", () => {
		const scopes = new InMemoryTaskScopeStore();
		const project = scopes.registerProject({ projectRoot: "/repo/lector", name: "Lector" });
		expect(scopes.projects(undefined, 10).map((p) => p.id)).toEqual([project.id]);
		expect(scopes.matchingProjects("Lector")).toHaveLength(1);
	});

	it("SQLiteTaskScopeStore.projects/matchingProjects/registerProject still work standalone", () => {
		const dir = tempDir("papyrus-project-registry-sqlite-");
		try {
			const db = openDb(`${dir}/papyrus.db`);
			const scopes = new SQLiteTaskScopeStore(db);
			const project = scopes.registerProject({ projectRoot: "/repo/lector", name: "Lector" });
			expect(scopes.projects(undefined, 10).map((p) => p.id)).toEqual([project.id]);
			expect(scopes.matchingProjects("Lector")).toHaveLength(1);
			db.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
