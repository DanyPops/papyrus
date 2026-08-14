import { ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT } from "../constants.ts";
import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import { SQLiteProjectRegistryStore } from "../project-registry/sqlite-project-registry-store.ts";
import type { ScopeMemberRef } from "../scope-group/scope-group.ts";
import { SQLiteScopeGroupStore } from "../scope-group/sqlite-scope-group-store.ts";
import type { TaskScopeSource } from "../task-scope/task-scope.ts";
import type { ArtifactScope, ArtifactScopeMode, ArtifactScopeStore, LegacyArtifactScope } from "./artifact-scope-store.ts";

interface ScopeRow {
	artifact_id: string;
	mode: ArtifactScopeMode;
	source: TaskScopeSource;
}

interface MemberRow {
	member_type: "project" | "group";
	member_id: string;
}

function memberFromRow(row: MemberRow): ScopeMemberRef {
	return row.member_type === "project" ? { type: "project", id: row.member_id } : { type: "group", id: row.member_id };
}

export class SQLiteArtifactScopeStore implements ArtifactScopeStore {
	private readonly registry: SQLiteProjectRegistryStore;
	private readonly scopeGroups: SQLiteScopeGroupStore;

	// Membership is by project/group id, not root/name -- a registry root move or scope group
	// rename needs no rewrite of artifact_scope_members at all, unlike SQLiteTaskScopeStore's own
	// task_scopes/task_views rewrite.
	constructor(private readonly db: Db) {
		this.registry = new SQLiteProjectRegistryStore(db);
		this.scopeGroups = new SQLiteScopeGroupStore(db);
	}

	private members(artifactId: string): ScopeMemberRef[] {
		return (
			this.db
				.prepare("SELECT member_type, member_id FROM artifact_scope_members WHERE artifact_id = ? ORDER BY member_type, member_id")
				.all(artifactId) as MemberRow[]
		).map(memberFromRow);
	}

	private readRow(artifactId: string): ScopeRow | undefined {
		const row = this.db
			.prepare("SELECT artifact_id, mode, source FROM artifact_scopes WHERE artifact_id = ?")
			.get(artifactId) as ScopeRow | null;
		return row ?? undefined;
	}

	scope(artifactId: string): ArtifactScope {
		const row = this.readRow(artifactId);
		if (!row) return { artifactId, mode: "all", members: [], source: "unscoped" };
		return { artifactId, mode: row.mode, members: row.mode === "explicit" ? this.members(artifactId) : [], source: row.source };
	}

	get(artifactId: string): LegacyArtifactScope | undefined {
		const row = this.readRow(artifactId);
		if (!row) return undefined;
		if (row.mode !== "explicit") return { artifactId, source: row.source };
		const members = this.members(artifactId);
		if (members.length !== 1 || members[0]!.type !== "project") return { artifactId, source: row.source };
		const project = this.registry.matchingProjects(members[0]!.id).find((candidate) => candidate.id === members[0]!.id);
		return { artifactId, ...(project ? { projectRoot: project.projectRoot } : {}), source: row.source };
	}

	assign(artifactId: string, projectRoot: string | undefined, source: TaskScopeSource): LegacyArtifactScope {
		if (projectRoot === undefined) {
			this.setAll(artifactId, source);
			return { artifactId, source };
		}
		return inTransaction(this.db, () => {
			const project = this.registry.registerProject({ projectRoot });
			this.replaceMembers(artifactId, [{ type: "project", id: project.id }], source);
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

	setAll(artifactId: string, source: TaskScopeSource): ArtifactScope {
		return inTransaction(this.db, () => {
			this.upsertScopeRow(artifactId, "all", source);
			this.db.prepare("DELETE FROM artifact_scope_members WHERE artifact_id = ?").run(artifactId);
			return { artifactId, mode: "all", members: [], source };
		});
	}

	setNone(artifactId: string, source: TaskScopeSource): ArtifactScope {
		return inTransaction(this.db, () => {
			this.upsertScopeRow(artifactId, "none", source);
			this.db.prepare("DELETE FROM artifact_scope_members WHERE artifact_id = ?").run(artifactId);
			return { artifactId, mode: "none", members: [], source };
		});
	}

	replaceMembers(artifactId: string, members: readonly ScopeMemberRef[], source: TaskScopeSource): ArtifactScope {
		if (members.length === 0) throw new Error("replaceMembers requires at least one member; use setAll/setNone to clear scoping");
		if (members.length > ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT) {
			throw new Error(`an artifact cannot have more than ${ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT} scope members`);
		}
		return inTransaction(this.db, () => {
			this.upsertScopeRow(artifactId, "explicit", source);
			this.db.prepare("DELETE FROM artifact_scope_members WHERE artifact_id = ?").run(artifactId);
			const insert = this.db.prepare("INSERT OR IGNORE INTO artifact_scope_members (artifact_id, member_type, member_id) VALUES (?, ?, ?)");
			const seen = new Set<string>();
			for (const member of members) {
				const key = `${member.type}:${member.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				insert.run(artifactId, member.type, member.id);
			}
			return { artifactId, mode: "explicit", members: this.members(artifactId), source };
		});
	}

	addMember(artifactId: string, member: ScopeMemberRef, source: TaskScopeSource): ArtifactScope {
		return inTransaction(this.db, () => {
			const current = this.members(artifactId);
			const already = current.some((candidate) => candidate.type === member.type && candidate.id === member.id);
			if (!already && current.length >= ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT) {
				throw new Error(`an artifact cannot have more than ${ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT} scope members`);
			}
			this.upsertScopeRow(artifactId, "explicit", source);
			this.db
				.prepare("INSERT OR IGNORE INTO artifact_scope_members (artifact_id, member_type, member_id) VALUES (?, ?, ?)")
				.run(artifactId, member.type, member.id);
			return { artifactId, mode: "explicit", members: this.members(artifactId), source };
		});
	}

	removeMember(artifactId: string, member: ScopeMemberRef): ArtifactScope {
		return inTransaction(this.db, () => {
			const row = this.readRow(artifactId);
			const current = row?.mode === "explicit" ? this.members(artifactId) : [];
			const already = current.some((candidate) => candidate.type === member.type && candidate.id === member.id);
			if (row?.mode !== "explicit" || !already) return this.scope(artifactId);
			if (current.length === 1) {
				throw new Error("cannot remove the last scope member; call setAll or setNone instead of accidentally widening/hiding scope");
			}
			this.db
				.prepare("DELETE FROM artifact_scope_members WHERE artifact_id = ? AND member_type = ? AND member_id = ?")
				.run(artifactId, member.type, member.id);
			return { artifactId, mode: "explicit", members: this.members(artifactId), source: row.source };
		});
	}

	ids(projectRoot: string | undefined, limit: number): string[] {
		if (projectRoot === undefined) {
			return (
				this.db.prepare("SELECT artifact_id FROM artifact_scopes WHERE mode = 'all' ORDER BY artifact_id LIMIT ?").all(limit) as Array<{
					artifact_id: string;
				}>
			).map((row) => row.artifact_id);
		}
		const project = this.db.prepare("SELECT id FROM task_projects WHERE project_root = ?").get(projectRoot) as { id: string } | null;
		if (!project) return [];
		return (
			this.db
				.prepare(`
					SELECT asm.artifact_id AS artifact_id
					FROM artifact_scope_members asm
					JOIN artifact_scopes s ON s.artifact_id = asm.artifact_id AND s.mode = 'explicit'
					WHERE asm.member_type = 'project' AND asm.member_id = ?
					ORDER BY asm.artifact_id
					LIMIT ?
				`)
				.all(project.id, limit) as Array<{ artifact_id: string }>
		).map((row) => row.artifact_id);
	}

	private expandedProjectIds(artifactId: string): Set<string> {
		const result = new Set<string>();
		for (const member of this.members(artifactId)) {
			if (member.type === "project") result.add(member.id);
			else for (const projectId of this.scopeGroups.expandToProjectIds(member.id)) result.add(projectId);
		}
		return result;
	}

	appliesToProject(artifactId: string, projectId: string): boolean {
		const row = this.readRow(artifactId);
		if (!row || row.mode === "all") return true;
		if (row.mode === "none") return false;
		return this.expandedProjectIds(artifactId).has(projectId);
	}

	appliesToProjectRoot(artifactId: string, projectRoot: string | undefined): boolean {
		const row = this.readRow(artifactId);
		if (!row || row.mode === "all") return true;
		if (row.mode === "none") return false;
		if (projectRoot === undefined) return false;
		const project = this.db.prepare("SELECT id FROM task_projects WHERE project_root = ?").get(projectRoot) as { id: string } | null;
		return project !== null && this.expandedProjectIds(artifactId).has(project.id);
	}

	referencesGroup(groupId: string): boolean {
		return (
			this.db.prepare("SELECT 1 FROM artifact_scope_members WHERE member_type = 'group' AND member_id = ? LIMIT 1").get(groupId) !== null
		);
	}
}
