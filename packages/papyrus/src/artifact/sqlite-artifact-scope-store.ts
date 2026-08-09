import { ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT } from "../constants.ts";
import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import type { TaskScopeSource } from "../domain/task-scope.ts";
import { SQLiteProjectRegistryStore } from "../stores/sqlite-project-registry-store.ts";
import type { ArtifactScope, ArtifactScopeMode, ArtifactScopeStore, LegacyArtifactScope } from "./artifact-scope-store.ts";

interface ScopeRow {
	artifact_id: string;
	mode: ArtifactScopeMode;
	source: TaskScopeSource;
}

export class SQLiteArtifactScopeStore implements ArtifactScopeStore {
	private readonly registry: SQLiteProjectRegistryStore;

	// Membership is by project id, not root -- a registry root move (see
	// SQLiteProjectRegistryStore.registerProject) needs no rewrite of artifact_scope_projects at
	// all, unlike SQLiteTaskScopeStore's own task_scopes/task_views rewrite.
	constructor(private readonly db: Db) {
		this.registry = new SQLiteProjectRegistryStore(db);
	}

	private membershipIds(artifactId: string): string[] {
		return (
			this.db.prepare("SELECT project_id FROM artifact_scope_projects WHERE artifact_id = ? ORDER BY project_id").all(artifactId) as Array<{
				project_id: string;
			}>
		).map((row) => row.project_id);
	}

	private readRow(artifactId: string): ScopeRow | undefined {
		const row = this.db
			.prepare("SELECT artifact_id, mode, source FROM artifact_scopes WHERE artifact_id = ?")
			.get(artifactId) as ScopeRow | null;
		return row ?? undefined;
	}

	scope(artifactId: string): ArtifactScope {
		const row = this.readRow(artifactId);
		if (!row) return { artifactId, mode: "global", projectIds: [], source: "unscoped" };
		return { artifactId, mode: row.mode, projectIds: row.mode === "projects" ? this.membershipIds(artifactId) : [], source: row.source };
	}

	get(artifactId: string): LegacyArtifactScope | undefined {
		const row = this.readRow(artifactId);
		if (!row) return undefined;
		if (row.mode !== "projects") return { artifactId, source: row.source };
		const ids = this.membershipIds(artifactId);
		if (ids.length !== 1) return { artifactId, source: row.source };
		const project = this.registry.matchingProjects(ids[0]!).find((candidate) => candidate.id === ids[0]);
		return { artifactId, ...(project ? { projectRoot: project.projectRoot } : {}), source: row.source };
	}

	assign(artifactId: string, projectRoot: string | undefined, source: TaskScopeSource): LegacyArtifactScope {
		if (projectRoot === undefined) {
			this.setGlobal(artifactId, source);
			return { artifactId, source };
		}
		return inTransaction(this.db, () => {
			const project = this.registry.registerProject({ projectRoot });
			this.replaceProjects(artifactId, [project.id], source);
			return { artifactId, projectRoot: project.projectRoot, source };
		});
	}

	private upsertScopeRow(artifactId: string, mode: ArtifactScopeMode, source: TaskScopeSource): void {
		this.db
			.prepare(`
				INSERT INTO artifact_scopes (artifact_id, project_root, mode, source, assigned_at)
				VALUES (?, NULL, ?, ?, ?)
				ON CONFLICT(artifact_id) DO UPDATE SET
					project_root = NULL,
					mode = excluded.mode,
					source = excluded.source,
					assigned_at = excluded.assigned_at
			`)
			.run(artifactId, mode, source, new Date().toISOString());
	}

	setGlobal(artifactId: string, source: TaskScopeSource): ArtifactScope {
		return inTransaction(this.db, () => {
			this.upsertScopeRow(artifactId, "global", source);
			this.db.prepare("DELETE FROM artifact_scope_projects WHERE artifact_id = ?").run(artifactId);
			return { artifactId, mode: "global", projectIds: [], source };
		});
	}

	replaceProjects(artifactId: string, projectIds: readonly string[], source: TaskScopeSource): ArtifactScope {
		if (projectIds.length === 0) throw new Error("replaceProjects requires at least one project id; use setGlobal to clear scoping");
		if (projectIds.length > ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT) {
			throw new Error(`an artifact cannot belong to more than ${ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT} projects`);
		}
		return inTransaction(this.db, () => {
			this.upsertScopeRow(artifactId, "projects", source);
			this.db.prepare("DELETE FROM artifact_scope_projects WHERE artifact_id = ?").run(artifactId);
			const insert = this.db.prepare("INSERT OR IGNORE INTO artifact_scope_projects (artifact_id, project_id) VALUES (?, ?)");
			const unique = [...new Set(projectIds)];
			for (const projectId of unique) insert.run(artifactId, projectId);
			return { artifactId, mode: "projects", projectIds: unique, source };
		});
	}

	addProject(artifactId: string, projectId: string, source: TaskScopeSource): ArtifactScope {
		return inTransaction(this.db, () => {
			const current = this.membershipIds(artifactId);
			if (!current.includes(projectId) && current.length >= ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT) {
				throw new Error(`an artifact cannot belong to more than ${ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT} projects`);
			}
			this.upsertScopeRow(artifactId, "projects", source);
			this.db.prepare("INSERT OR IGNORE INTO artifact_scope_projects (artifact_id, project_id) VALUES (?, ?)").run(artifactId, projectId);
			return { artifactId, mode: "projects", projectIds: this.membershipIds(artifactId), source };
		});
	}

	removeProject(artifactId: string, projectId: string): ArtifactScope {
		return inTransaction(this.db, () => {
			const row = this.readRow(artifactId);
			const current = row?.mode === "projects" ? this.membershipIds(artifactId) : [];
			if (row?.mode !== "projects" || !current.includes(projectId)) return this.scope(artifactId);
			if (current.length === 1) {
				throw new Error("cannot remove the last project membership; call setGlobal to make this artifact apply everywhere instead");
			}
			this.db.prepare("DELETE FROM artifact_scope_projects WHERE artifact_id = ? AND project_id = ?").run(artifactId, projectId);
			return { artifactId, mode: "projects", projectIds: this.membershipIds(artifactId), source: row.source };
		});
	}

	ids(projectRoot: string | undefined, limit: number): string[] {
		if (projectRoot === undefined) {
			return (
				this.db.prepare("SELECT artifact_id FROM artifact_scopes WHERE mode = 'global' ORDER BY artifact_id LIMIT ?").all(limit) as Array<{
					artifact_id: string;
				}>
			).map((row) => row.artifact_id);
		}
		const project = this.db.prepare("SELECT id FROM task_projects WHERE project_root = ?").get(projectRoot) as { id: string } | null;
		if (!project) return [];
		return (
			this.db
				.prepare(`
					SELECT asp.artifact_id AS artifact_id
					FROM artifact_scope_projects asp
					JOIN artifact_scopes s ON s.artifact_id = asp.artifact_id AND s.mode = 'projects'
					WHERE asp.project_id = ?
					ORDER BY asp.artifact_id
					LIMIT ?
				`)
				.all(project.id, limit) as Array<{ artifact_id: string }>
		).map((row) => row.artifact_id);
	}

	appliesToProject(artifactId: string, projectId: string): boolean {
		const row = this.readRow(artifactId);
		if (!row || row.mode === "global") return true;
		return this.membershipIds(artifactId).includes(projectId);
	}

	appliesToProjectRoot(artifactId: string, projectRoot: string | undefined): boolean {
		const row = this.readRow(artifactId);
		if (!row || row.mode === "global") return true;
		if (projectRoot === undefined) return false;
		const project = this.db.prepare("SELECT id FROM task_projects WHERE project_root = ?").get(projectRoot) as { id: string } | null;
		return project !== null && this.membershipIds(artifactId).includes(project.id);
	}
}
