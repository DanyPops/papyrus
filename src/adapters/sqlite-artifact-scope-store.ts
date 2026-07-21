import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import type { TaskScopeSource } from "../domain/task-scope.ts";
import type { ArtifactScope, ArtifactScopeStore } from "../ports/artifact-scope-store.ts";

export class SQLiteArtifactScopeStore implements ArtifactScopeStore {
	constructor(private readonly db: Db) {}

	assign(artifactId: string, projectRoot: string | undefined, source: TaskScopeSource): ArtifactScope {
		inTransaction(this.db, () => {
			this.db.prepare(`
				INSERT INTO artifact_scopes (artifact_id, project_root, source, assigned_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(artifact_id) DO UPDATE SET
					project_root = excluded.project_root,
					source = excluded.source,
					assigned_at = excluded.assigned_at
			`).run(artifactId, projectRoot ?? null, source, new Date().toISOString());
		});
		return { artifactId, ...(projectRoot === undefined ? {} : { projectRoot }), source };
	}

	get(artifactId: string): ArtifactScope | undefined {
		const row = this.db.prepare("SELECT artifact_id, project_root, source FROM artifact_scopes WHERE artifact_id = ?").get(artifactId) as
			| { artifact_id: string; project_root: string | null; source: TaskScopeSource }
			| null;
		return row ? { artifactId: row.artifact_id, ...(row.project_root === null ? {} : { projectRoot: row.project_root }), source: row.source } : undefined;
	}

	ids(projectRoot: string | undefined, limit: number): string[] {
		const rows = projectRoot === undefined
			? this.db.prepare("SELECT artifact_id FROM artifact_scopes WHERE project_root IS NULL ORDER BY artifact_id LIMIT ?").all(limit)
			: this.db.prepare("SELECT artifact_id FROM artifact_scopes WHERE project_root = ? ORDER BY artifact_id LIMIT ?").all(projectRoot, limit);
		return (rows as Array<{ artifact_id: string }>).map((row) => row.artifact_id);
	}
}
