import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import type { Project, RegisterProjectInput } from "../domain/project-registry.ts";
import type { ProjectRegistryStore } from "../ports/project-registry-store.ts";
import { uniqueAliases } from "./in-memory-project-registry-store.ts";

interface ProjectRow {
	id: string;
	name: string;
	aliases_json: string;
	project_root: string;
	created_at: string;
	updated_at: string;
}

function projectFromRow(row: ProjectRow): Project {
	return {
		id: row.id,
		name: row.name,
		aliases: JSON.parse(row.aliases_json) as string[],
		projectRoot: row.project_root,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * Backed by `task_projects` -- the same table name Task's own migration (v26) established --
 * kept as-is rather than renamed, so an existing database's registered project ids/names/roots
 * survive this extraction with zero migration. Kind-neutral in behavior: nothing here reads or
 * writes a Task-shaped row: onRootMoved lets a composing store (TaskScopeStore,
 * ArtifactScopeStore) react to a root move for its own kind-specific rows in the same
 * transaction, without this store needing to know either of them exist.
 */
export class SQLiteProjectRegistryStore implements ProjectRegistryStore {
	constructor(
		private readonly db: Db,
		private readonly onRootMoved?: (db: Db, previousRoot: string, nextRoot: string) => void,
	) {}

	projects(query: string | undefined, limit: number): Project[] {
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

	matchingProjects(reference: string): Project[] {
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

	registerProject(input: RegisterProjectInput): Project {
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
			const project: Project = {
				id: existing?.id ?? randomUUID(),
				name,
				aliases,
				projectRoot: input.projectRoot,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			if (existing && existing.projectRoot !== project.projectRoot) this.onRootMoved?.(this.db, existing.projectRoot, project.projectRoot);
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
