import { ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT } from "../constants.ts";
import type { TaskScopeSource } from "../domain/task-scope.ts";
import type { ProjectRegistryStore } from "../ports/project-registry-store.ts";
import { InMemoryProjectRegistryStore } from "../stores/in-memory-project-registry-store.ts";
import type { ArtifactScope, ArtifactScopeStore, LegacyArtifactScope } from "./artifact-scope-store.ts";

interface Row {
	mode: "global" | "projects";
	projectIds: Set<string>;
	source: TaskScopeSource;
}

export class InMemoryArtifactScopeStore implements ArtifactScopeStore {
	private readonly rows = new Map<string, Row>();
	private readonly registry: InMemoryProjectRegistryStore;

	// Membership is stored by project id, never by root, so a registry root move (see
	// ProjectRegistryStore.registerProject) needs no rewrite here at all -- unlike
	// InMemoryTaskScopeStore, this store never subscribes to root-move notifications.
	constructor(registry?: ProjectRegistryStore) {
		this.registry = registry instanceof InMemoryProjectRegistryStore ? registry : new InMemoryProjectRegistryStore();
	}

	private toScope(artifactId: string, row: Row | undefined): ArtifactScope {
		return row
			? { artifactId, mode: row.mode, projectIds: [...row.projectIds], source: row.source }
			: { artifactId, mode: "global", projectIds: [], source: "unscoped" };
	}

	scope(artifactId: string): ArtifactScope {
		return this.toScope(artifactId, this.rows.get(artifactId));
	}

	get(artifactId: string): LegacyArtifactScope | undefined {
		const row = this.rows.get(artifactId);
		if (!row) return undefined;
		const onlyProjectId = row.mode === "projects" && row.projectIds.size === 1 ? [...row.projectIds][0] : undefined;
		const projectRoot = onlyProjectId === undefined ? undefined : this.registry.byId(onlyProjectId)?.projectRoot;
		return { artifactId, ...(projectRoot === undefined ? {} : { projectRoot }), source: row.source };
	}

	assign(artifactId: string, projectRoot: string | undefined, source: TaskScopeSource): LegacyArtifactScope {
		if (projectRoot === undefined) {
			this.setGlobal(artifactId, source);
			return { artifactId, source };
		}
		const project = this.registry.registerProject({ projectRoot });
		this.replaceProjects(artifactId, [project.id], source);
		return { artifactId, projectRoot: project.projectRoot, source };
	}

	setGlobal(artifactId: string, source: TaskScopeSource): ArtifactScope {
		const row: Row = { mode: "global", projectIds: new Set(), source };
		this.rows.set(artifactId, row);
		return this.toScope(artifactId, row);
	}

	replaceProjects(artifactId: string, projectIds: readonly string[], source: TaskScopeSource): ArtifactScope {
		if (projectIds.length === 0) throw new Error("replaceProjects requires at least one project id; use setGlobal to clear scoping");
		if (projectIds.length > ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT) {
			throw new Error(`an artifact cannot belong to more than ${ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT} projects`);
		}
		const row: Row = { mode: "projects", projectIds: new Set(projectIds), source };
		this.rows.set(artifactId, row);
		return this.toScope(artifactId, row);
	}

	addProject(artifactId: string, projectId: string, source: TaskScopeSource): ArtifactScope {
		const existing = this.rows.get(artifactId);
		const projectIds = new Set(existing?.mode === "projects" ? existing.projectIds : []);
		if (!projectIds.has(projectId) && projectIds.size >= ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT) {
			throw new Error(`an artifact cannot belong to more than ${ARTIFACT_SCOPE_MAX_PROJECTS_PER_ARTIFACT} projects`);
		}
		projectIds.add(projectId);
		const row: Row = { mode: "projects", projectIds, source };
		this.rows.set(artifactId, row);
		return this.toScope(artifactId, row);
	}

	removeProject(artifactId: string, projectId: string): ArtifactScope {
		const existing = this.rows.get(artifactId);
		if (existing?.mode !== "projects" || !existing.projectIds.has(projectId)) return this.toScope(artifactId, existing);
		if (existing.projectIds.size === 1) {
			throw new Error("cannot remove the last project membership; call setGlobal to make this artifact apply everywhere instead");
		}
		const projectIds = new Set(existing.projectIds);
		projectIds.delete(projectId);
		const row: Row = { mode: "projects", projectIds, source: existing.source };
		this.rows.set(artifactId, row);
		return this.toScope(artifactId, row);
	}

	ids(projectRoot: string | undefined, limit: number): string[] {
		if (projectRoot === undefined) {
			return [...this.rows.entries()]
				.filter(([, row]) => row.mode === "global")
				.map(([artifactId]) => artifactId)
				.sort()
				.slice(0, limit);
		}
		const project = this.registry.byRoot(projectRoot);
		if (!project) return [];
		return [...this.rows.entries()]
			.filter(([, row]) => row.mode === "projects" && row.projectIds.has(project.id))
			.map(([artifactId]) => artifactId)
			.sort()
			.slice(0, limit);
	}

	appliesToProject(artifactId: string, projectId: string): boolean {
		const row = this.rows.get(artifactId);
		if (!row || row.mode === "global") return true;
		return row.projectIds.has(projectId);
	}
}
