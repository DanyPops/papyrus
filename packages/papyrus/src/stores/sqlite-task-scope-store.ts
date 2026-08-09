import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { TASK_PROJECT_ALIAS_MAX_COUNT } from "../constants.ts";
import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import type {
	RegisterTaskProjectInput,
	TaskProject,
	TaskProjectScope,
	TaskScopeSource,
	TaskViewMode,
	TaskViewPreference,
} from "../domain/task-scope.ts";
import type { TaskScopeStore } from "./task-scope-store.ts";

interface ProjectRow {
	id: string;
	name: string;
	aliases_json: string;
	project_root: string;
	created_at: string;
	updated_at: string;
}

function projectFromRow(row: ProjectRow): TaskProject {
	return {
		id: row.id,
		name: row.name,
		aliases: JSON.parse(row.aliases_json) as string[],
		projectRoot: row.project_root,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function uniqueAliases(values: readonly string[], name: string): string[] {
	const seen = new Set([name.trim().toLowerCase()]);
	const aliases = values.flatMap((value) => {
		const trimmed = value.trim();
		const key = trimmed.toLowerCase();
		if (!trimmed || seen.has(key)) return [];
		seen.add(key);
		return [trimmed];
	});
	if (aliases.length > TASK_PROJECT_ALIAS_MAX_COUNT) {
		throw new Error(`project aliases cannot exceed ${TASK_PROJECT_ALIAS_MAX_COUNT} entries`);
	}
	return aliases;
}

export class SQLiteTaskScopeStore implements TaskScopeStore {
	constructor(private readonly db: Db) {}

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
		const needle = query?.trim().toLowerCase();
		if (!needle) {
			return (
				this.db
					.prepare(
						"SELECT id, name, aliases_json, project_root, created_at, updated_at FROM task_projects ORDER BY name, project_root LIMIT ?",
					)
					.all(limit) as ProjectRow[]
			).map(projectFromRow);
		}
		return (
			this.db
				.prepare(`
					SELECT id, name, aliases_json, project_root, created_at, updated_at
					FROM task_projects
					WHERE instr(lower(name), ?) > 0
						OR instr(lower(project_root), ?) > 0
						OR EXISTS (
							SELECT 1 FROM json_each(task_projects.aliases_json)
							WHERE instr(lower(CAST(json_each.value AS TEXT)), ?) > 0
						)
					ORDER BY name, project_root
					LIMIT ?
				`)
				.all(needle, needle, needle, limit) as ProjectRow[]
		).map(projectFromRow);
	}

	matchingProjects(reference: string): TaskProject[] {
		const needle = reference.trim().toLowerCase();
		return (
			this.db
				.prepare(`
					SELECT id, name, aliases_json, project_root, created_at, updated_at
					FROM task_projects
					WHERE lower(id) = ? OR lower(name) = ? OR lower(project_root) = ?
						OR EXISTS (
							SELECT 1 FROM json_each(task_projects.aliases_json)
							WHERE lower(CAST(json_each.value AS TEXT)) = ?
						)
					ORDER BY name, project_root
					LIMIT 11
				`)
				.all(needle, needle, needle, needle) as ProjectRow[]
		).map(projectFromRow);
	}

	registerProject(input: RegisterTaskProjectInput): TaskProject {
		return inTransaction(this.db, () => {
			const row = (
				input.existingId
					? this.db
							.prepare("SELECT id, name, aliases_json, project_root, created_at, updated_at FROM task_projects WHERE id = ?")
							.get(input.existingId)
					: this.db
							.prepare("SELECT id, name, aliases_json, project_root, created_at, updated_at FROM task_projects WHERE project_root = ?")
							.get(input.projectRoot)
			) as ProjectRow | null;
			const existing = row ? projectFromRow(row) : undefined;
			const now = new Date().toISOString();
			const name = input.name?.trim() || existing?.name || basename(input.projectRoot) || input.projectRoot;
			const aliases = uniqueAliases(
				[...(existing?.aliases ?? []), ...(existing && existing.name !== name ? [existing.name] : []), ...(input.aliases ?? [])],
				name,
			);
			const project: TaskProject = {
				id: existing?.id ?? randomUUID(),
				name,
				aliases,
				projectRoot: input.projectRoot,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			if (existing && existing.projectRoot !== project.projectRoot) {
				this.db.prepare("UPDATE task_scopes SET project_root = ? WHERE project_root = ?").run(project.projectRoot, existing.projectRoot);
				this.db.prepare("UPDATE task_views SET project_root = ? WHERE project_root = ?").run(project.projectRoot, existing.projectRoot);
			}
			this.db
				.prepare(`
					INSERT INTO task_projects (id, name, aliases_json, project_root, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?)
					ON CONFLICT(id) DO UPDATE SET
						name = excluded.name,
						aliases_json = excluded.aliases_json,
						project_root = excluded.project_root,
						updated_at = excluded.updated_at
				`)
				.run(project.id, project.name, JSON.stringify(project.aliases), project.projectRoot, project.createdAt, project.updatedAt);
			return project;
		});
	}
}
