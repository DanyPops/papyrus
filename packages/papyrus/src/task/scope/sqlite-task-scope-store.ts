import type { Db } from "../../db.ts";
import { inTransaction } from "../../db.ts";
import { SQLiteProjectRegistryStore } from "../../project-registry/sqlite-project-registry-store.ts";
import type {
	RegisterTaskProjectInput,
	TaskProject,
	TaskProjectScope,
	TaskScopeSource,
	TaskViewMode,
	TaskViewPreference,
} from "./task-scope.ts";
import type { TaskScopeStore } from "./task-scope-store.ts";

/** Rewrites every task_scopes/task_views row pinned to a project root that just moved -- called inside the same registerProject() transaction, so a rename/move is atomic with the rewrite. */
function rewriteTaskRowsForMovedRoot(db: Db, previousRoot: string, nextRoot: string): void {
	db.prepare("UPDATE task_scopes SET project_root = ? WHERE project_root = ?").run(nextRoot, previousRoot);
	db.prepare("UPDATE task_views SET project_root = ? WHERE project_root = ?").run(nextRoot, previousRoot);
}

export class SQLiteTaskScopeStore implements TaskScopeStore {
	private readonly registry: SQLiteProjectRegistryStore;

	constructor(private readonly db: Db) {
		this.registry = new SQLiteProjectRegistryStore(db, rewriteTaskRowsForMovedRoot);
	}

	assign(taskId: string, projectRoot: string | undefined, source: TaskScopeSource): TaskProjectScope {
		inTransaction(this.db, () => {
			if (projectRoot !== undefined) this.registerProject({ projectRoot });
			this.db
				.prepare(`
					INSERT INTO task_scopes (task_id, project_root, source, assigned_at)
					VALUES (?, ?, ?, ?)
					ON CONFLICT(task_id) DO UPDATE SET
						project_root = excluded.project_root,
						source = excluded.source,
						assigned_at = excluded.assigned_at
				`)
				.run(taskId, projectRoot ?? null, source, new Date().toISOString());
		});
		return { taskId, ...(projectRoot === undefined ? {} : { projectRoot }), source };
	}

	get(taskId: string): TaskProjectScope | undefined {
		const row = this.db.prepare("SELECT task_id, project_root, source FROM task_scopes WHERE task_id = ?").get(taskId) as {
			task_id: string;
			project_root: string | null;
			source: TaskScopeSource;
		} | null;
		return row
			? { taskId: row.task_id, ...(row.project_root === null ? {} : { projectRoot: row.project_root }), source: row.source }
			: undefined;
	}

	taskIds(projectRoot: string | undefined, limit: number): string[] {
		const rows =
			projectRoot === undefined
				? this.db.prepare("SELECT task_id FROM task_scopes WHERE project_root IS NULL ORDER BY task_id LIMIT ?").all(limit)
				: this.db.prepare("SELECT task_id FROM task_scopes WHERE project_root = ? ORDER BY task_id LIMIT ?").all(projectRoot, limit);
		return (rows as Array<{ task_id: string }>).map((row) => row.task_id);
	}

	view(projectRoot: string): TaskViewPreference {
		const row = this.db.prepare("SELECT project_root, mode, root_task_id FROM task_views WHERE project_root = ?").get(projectRoot) as {
			project_root: string;
			mode: TaskViewMode;
			root_task_id: string | null;
		} | null;
		return row
			? { projectRoot: row.project_root, mode: row.mode, ...(row.root_task_id === null ? {} : { rootTaskId: row.root_task_id }) }
			: { projectRoot, mode: "project" };
	}

	setView(projectRoot: string, mode: TaskViewMode, rootTaskId?: string): TaskViewPreference {
		inTransaction(this.db, () => {
			this.db
				.prepare(`
					INSERT INTO task_views (project_root, mode, root_task_id, updated_at)
					VALUES (?, ?, ?, ?)
					ON CONFLICT(project_root) DO UPDATE SET
						mode = excluded.mode,
						root_task_id = excluded.root_task_id,
						updated_at = excluded.updated_at
				`)
				.run(projectRoot, mode, rootTaskId ?? null, new Date().toISOString());
		});
		return { projectRoot, mode, ...(rootTaskId === undefined ? {} : { rootTaskId }) };
	}

	projects(query: string | undefined, limit: number): TaskProject[] {
		return this.registry.projects(query, limit);
	}

	matchingProjects(reference: string): TaskProject[] {
		return this.registry.matchingProjects(reference);
	}

	registerProject(input: RegisterTaskProjectInput): TaskProject {
		return this.registry.registerProject(input);
	}
}
