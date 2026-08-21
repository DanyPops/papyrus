import { describe, expect, it } from "bun:test";
import { SQLiteArtifactScopeStore } from "../src/artifact/sqlite-artifact-scope-store.ts";
import { SQLITE_SCHEMA_VERSION } from "../src/constants.ts";
import { migrateDb, openDb } from "../src/db.ts";

describe("artifact-multi-project-scope migration (v27 -> current, through v28 and v29)", () => {
	it("preserves a global (NULL project_root) artifact_scopes row as explicit 'all' mode", () => {
		const db = openDb(":memory:");
		db.prepare(
			"INSERT INTO artifacts (id, kind, title, status, created_at, updated_at) VALUES (?, 'doc', 'Global doc', 'draft', ?, ?)",
		).run("doc-global", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO artifact_scopes (artifact_id, project_root, source, assigned_at) VALUES (?, NULL, 'unscoped', ?)").run(
			"doc-global",
			"2026-01-01T00:00:00.000Z",
		);
		db.exec("PRAGMA user_version = 27");

		const result = migrateDb(db);
		expect(result).toEqual({
			from: 27,
			to: SQLITE_SCHEMA_VERSION,
			applied: [
				"artifact-multi-project-scope",
				"artifact-scope-tri-state-and-scope-groups",
				"discuss-quiz",
				"binder-hierarchy-and-label-inheritance",
			],
		});

		const scopes = new SQLiteArtifactScopeStore(db);
		expect(scopes.scope("doc-global")).toEqual({ artifactId: "doc-global", mode: "all", members: [], source: "unscoped" });
		db.close();
	});

	it("preserves a single-project (non-NULL project_root) artifact_scopes row as explicit mode with exactly one project membership", () => {
		const db = openDb(":memory:");
		db.prepare(
			"INSERT INTO artifacts (id, kind, title, status, created_at, updated_at) VALUES (?, 'rule', 'Scoped rule', 'active', ?, ?)",
		).run("rule-scoped", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO artifact_scopes (artifact_id, project_root, source, assigned_at) VALUES (?, ?, 'explicit', ?)").run(
			"rule-scoped",
			"/repo/lector",
			"2026-01-01T00:00:00.000Z",
		);
		db.exec("PRAGMA user_version = 27");

		migrateDb(db);

		const scopes = new SQLiteArtifactScopeStore(db);
		const scope = scopes.scope("rule-scoped");
		expect(scope.mode).toBe("explicit");
		expect(scope.members).toHaveLength(1);
		expect(scope.members[0]!.type).toBe("project");
		expect(scopes.get("rule-scoped")?.projectRoot).toBe("/repo/lector");

		const project = db.prepare("SELECT id, project_root FROM task_projects WHERE project_root = ?").get("/repo/lector") as {
			id: string;
			project_root: string;
		};
		expect(project.id).toBe(scope.members[0]!.id);
		db.close();
	});

	it("registers a project root in task_projects even if no Task ever used it, without duplicating one a Task already registered", () => {
		const db = openDb(":memory:");
		db.prepare("INSERT INTO artifacts (id, kind, title, status, created_at, updated_at) VALUES (?, 'task', 'A task', 'todo', ?, ?)").run(
			"task-1",
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T00:00:00.000Z",
		);
		db.prepare("INSERT INTO artifacts (id, kind, title, status, created_at, updated_at) VALUES (?, 'doc', 'A doc', 'draft', ?, ?)").run(
			"doc-1",
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T00:00:00.000Z",
		);
		// A Task already registered /repo/shared; the Doc references the same root.
		db.prepare("INSERT INTO task_scopes (task_id, project_root, source, assigned_at) VALUES (?, ?, 'explicit', ?)").run(
			"task-1",
			"/repo/shared",
			"2026-01-01T00:00:00.000Z",
		);
		db.prepare(
			"INSERT INTO task_projects (id, name, aliases_json, project_root, created_at, updated_at) VALUES ('existing-project-id', 'shared', '[]', '/repo/shared', ?, ?)",
		).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO artifact_scopes (artifact_id, project_root, source, assigned_at) VALUES (?, ?, 'explicit', ?)").run(
			"doc-1",
			"/repo/shared",
			"2026-01-01T00:00:00.000Z",
		);
		// A second Doc references a root no Task ever used -- must be freshly registered.
		db.prepare(
			"INSERT INTO artifacts (id, kind, title, status, created_at, updated_at) VALUES (?, 'doc', 'Doc-only project', 'draft', ?, ?)",
		).run("doc-2", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
		db.prepare("INSERT INTO artifact_scopes (artifact_id, project_root, source, assigned_at) VALUES (?, ?, 'explicit', ?)").run(
			"doc-2",
			"/repo/doc-only",
			"2026-01-01T00:00:00.000Z",
		);
		db.exec("PRAGMA user_version = 27");

		migrateDb(db);

		const scopes = new SQLiteArtifactScopeStore(db);
		expect(scopes.scope("doc-1").members).toEqual([{ type: "project", id: "existing-project-id" }]); // reused the Task's own registration, no duplicate
		expect(db.prepare("SELECT COUNT(*) AS n FROM task_projects WHERE project_root = '/repo/shared'").get()).toEqual({ n: 1 });

		const doc2Scope = scopes.scope("doc-2");
		expect(doc2Scope.mode).toBe("explicit");
		expect(doc2Scope.members).toHaveLength(1);
		const freshProject = db.prepare("SELECT project_root FROM task_projects WHERE id = ?").get(doc2Scope.members[0]!.id) as {
			project_root: string;
		};
		expect(freshProject.project_root).toBe("/repo/doc-only");
		db.close();
	});

	it("a fresh database bootstraps directly at the current schema with mode already 'all' by default", () => {
		const db = openDb(":memory:");
		db.prepare("INSERT INTO artifacts (id, kind, title, status, created_at, updated_at) VALUES (?, 'doc', 'Fresh doc', 'draft', ?, ?)").run(
			"doc-fresh",
			"2026-01-01T00:00:00.000Z",
			"2026-01-01T00:00:00.000Z",
		);
		const scopes = new SQLiteArtifactScopeStore(db);
		expect(scopes.scope("doc-fresh")).toEqual({ artifactId: "doc-fresh", mode: "all", members: [], source: "unscoped" });
		db.close();
	});
});
