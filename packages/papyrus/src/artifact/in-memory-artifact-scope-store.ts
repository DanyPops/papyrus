import { ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT } from "../constants.ts";
import { InMemoryProjectRegistryStore } from "../project-registry/in-memory-project-registry-store.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import { InMemoryScopeGroupStore } from "../scope-group/in-memory-scope-group-store.ts";
import { type ScopeMemberRef, sameScopeMember } from "../scope-group/scope-group.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import type { TaskScopeSource } from "../task-scope/task-scope.ts";
import type { ArtifactScope, ArtifactScopeMode, ArtifactScopeStore, LegacyArtifactScope } from "./artifact-scope-store.ts";

interface Row {
	mode: ArtifactScopeMode;
	members: ScopeMemberRef[];
	source: TaskScopeSource;
}

export class InMemoryArtifactScopeStore implements ArtifactScopeStore {
	private readonly rows = new Map<string, Row>();
	private readonly registry: InMemoryProjectRegistryStore;
	private readonly scopeGroups: ScopeGroupStore;

	// Membership is stored by project/group id, never by root/name, so a registry root move (see
	// ProjectRegistryStore.registerProject) or a scope group rename needs no rewrite here at all --
	// unlike InMemoryTaskScopeStore, this store never subscribes to root-move notifications.
	constructor(registry?: ProjectRegistryStore, scopeGroups?: ScopeGroupStore) {
		this.registry = registry instanceof InMemoryProjectRegistryStore ? registry : new InMemoryProjectRegistryStore();
		this.scopeGroups = scopeGroups ?? new InMemoryScopeGroupStore();
	}

	private toScope(artifactId: string, row: Row | undefined): ArtifactScope {
		return row
			? { artifactId, mode: row.mode, members: [...row.members], source: row.source }
			: { artifactId, mode: "all", members: [], source: "unscoped" };
	}

	scope(artifactId: string): ArtifactScope {
		return this.toScope(artifactId, this.rows.get(artifactId));
	}

	get(artifactId: string): LegacyArtifactScope | undefined {
		const row = this.rows.get(artifactId);
		if (!row) return undefined;
		const onlyProjectMember =
			row.mode === "explicit" && row.members.length === 1 && row.members[0]!.type === "project" ? row.members[0] : undefined;
		const projectRoot = onlyProjectMember === undefined ? undefined : this.registry.byId(onlyProjectMember.id)?.projectRoot;
		return { artifactId, ...(projectRoot === undefined ? {} : { projectRoot }), source: row.source };
	}

	assign(artifactId: string, projectRoot: string | undefined, source: TaskScopeSource): LegacyArtifactScope {
		if (projectRoot === undefined) {
			this.setAll(artifactId, source);
			return { artifactId, source };
		}
		const project = this.registry.registerProject({ projectRoot });
		this.replaceMembers(artifactId, [{ type: "project", id: project.id }], source);
		return { artifactId, projectRoot: project.projectRoot, source };
	}

	setAll(artifactId: string, source: TaskScopeSource): ArtifactScope {
		const row: Row = { mode: "all", members: [], source };
		this.rows.set(artifactId, row);
		return this.toScope(artifactId, row);
	}

	setNone(artifactId: string, source: TaskScopeSource): ArtifactScope {
		const row: Row = { mode: "none", members: [], source };
		this.rows.set(artifactId, row);
		return this.toScope(artifactId, row);
	}

	replaceMembers(artifactId: string, members: readonly ScopeMemberRef[], source: TaskScopeSource): ArtifactScope {
		if (members.length === 0) throw new Error("replaceMembers requires at least one member; use setAll/setNone to clear scoping");
		if (members.length > ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT) {
			throw new Error(`an artifact cannot have more than ${ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT} scope members`);
		}
		const unique = dedupeMembers(members);
		const row: Row = { mode: "explicit", members: unique, source };
		this.rows.set(artifactId, row);
		return this.toScope(artifactId, row);
	}

	addMember(artifactId: string, member: ScopeMemberRef, source: TaskScopeSource): ArtifactScope {
		const existing = this.rows.get(artifactId);
		const members = dedupeMembers(existing?.mode === "explicit" ? existing.members : []);
		if (!members.some((candidate) => sameScopeMember(candidate, member)) && members.length >= ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT) {
			throw new Error(`an artifact cannot have more than ${ARTIFACT_SCOPE_MAX_MEMBERS_PER_ARTIFACT} scope members`);
		}
		if (!members.some((candidate) => sameScopeMember(candidate, member))) members.push(member);
		const row: Row = { mode: "explicit", members, source };
		this.rows.set(artifactId, row);
		return this.toScope(artifactId, row);
	}

	removeMember(artifactId: string, member: ScopeMemberRef): ArtifactScope {
		const existing = this.rows.get(artifactId);
		if (existing?.mode !== "explicit" || !existing.members.some((candidate) => sameScopeMember(candidate, member))) {
			return this.toScope(artifactId, existing);
		}
		if (existing.members.length === 1) {
			throw new Error("cannot remove the last scope member; call setAll or setNone instead of accidentally widening/hiding scope");
		}
		const members = existing.members.filter((candidate) => !sameScopeMember(candidate, member));
		const row: Row = { mode: "explicit", members, source: existing.source };
		this.rows.set(artifactId, row);
		return this.toScope(artifactId, row);
	}

	ids(projectRoot: string | undefined, limit: number): string[] {
		if (projectRoot === undefined) {
			return [...this.rows.entries()]
				.filter(([, row]) => row.mode === "all")
				.map(([artifactId]) => artifactId)
				.sort()
				.slice(0, limit);
		}
		const project = this.registry.byRoot(projectRoot);
		if (!project) return [];
		return [...this.rows.entries()]
			.filter(([, row]) => row.mode === "explicit" && row.members.some((member) => member.type === "project" && member.id === project.id))
			.map(([artifactId]) => artifactId)
			.sort()
			.slice(0, limit);
	}

	private expandedProjectIds(row: Row): Set<string> {
		const result = new Set<string>();
		for (const member of row.members) {
			if (member.type === "project") result.add(member.id);
			else for (const projectId of this.scopeGroups.expandToProjectIds(member.id)) result.add(projectId);
		}
		return result;
	}

	appliesToProject(artifactId: string, projectId: string): boolean {
		const row = this.rows.get(artifactId);
		if (!row || row.mode === "all") return true;
		if (row.mode === "none") return false;
		return this.expandedProjectIds(row).has(projectId);
	}

	appliesToProjectRoot(artifactId: string, projectRoot: string | undefined): boolean {
		const row = this.rows.get(artifactId);
		if (!row || row.mode === "all") return true;
		if (row.mode === "none") return false;
		if (projectRoot === undefined) return false;
		const project = this.registry.byRoot(projectRoot);
		return project !== undefined && this.expandedProjectIds(row).has(project.id);
	}

	referencesGroup(groupId: string): boolean {
		return [...this.rows.values()].some(
			(row) => row.mode === "explicit" && row.members.some((member) => member.type === "group" && member.id === groupId),
		);
	}
}

function dedupeMembers(members: readonly ScopeMemberRef[]): ScopeMemberRef[] {
	const result: ScopeMemberRef[] = [];
	for (const member of members) {
		if (!result.some((candidate) => sameScopeMember(candidate, member))) result.push(member);
	}
	return result;
}
