import { InMemoryProjectRegistryStore } from "../../project-registry/in-memory-project-registry-store.ts";
import type { ProjectRegistryStore } from "../../project-registry/project-registry-store.ts";
import type {
	RegisterTaskProjectInput,
	TaskProject,
	TaskProjectScope,
	TaskScopeSource,
	TaskViewMode,
	TaskViewPreference,
} from "./task-scope.ts";

/**
 * Role Interface (Fowler: https://martinfowler.com/bliki/RoleInterface.html) for the one
 * collaboration playbook workflow execution actually has with Task's own scope bookkeeping:
 * assigning a task's project scope when a playbook step creates/advances one. Extracted after a
 * SOLID audit found TaskScopeStore's full Header Interface (all 8 methods -- project-catalog
 * registration, view-preference bookkeeping, task-id listing, none of which playbook ever
 * touches) threaded unchanged through handlers/playbooks.ts, modules/playbooks.ts, and
 * playbook/workflow-execution.ts, which only ever calls .assign(). TaskScopeStore still
 * implements this structurally with zero changes to either concrete store; only the
 * playbook-facing field type narrows to this.
 */
export interface TaskScopeAssigner {
	assign(taskId: string, projectRoot: string | undefined, source: TaskScopeSource): TaskProjectScope;
}

export interface TaskScopeStore extends TaskScopeAssigner {
	get(taskId: string): TaskProjectScope | undefined;
	taskIds(projectRoot: string | undefined, limit: number): string[];
	view(projectRoot: string): TaskViewPreference;
	setView(projectRoot: string, mode: TaskViewMode, rootTaskId?: string): TaskViewPreference;
	projects(query: string | undefined, limit: number): TaskProject[];
	matchingProjects(reference: string): TaskProject[];
	registerProject(input: RegisterTaskProjectInput): TaskProject;
}

/**
 * Task's own scope/view bookkeeping, composing a ProjectRegistryStore for the project-catalog
 * methods (projects/matchingProjects/registerProject) rather than implementing that bookkeeping
 * itself -- see project-registry-store.ts. Pass a shared registry instance to keep Task and a
 * non-Task ArtifactScopeStore resolving against the exact same project identities; omitted, this
 * store gets its own private one (matching this class's own behavior before the extraction).
 */
export class InMemoryTaskScopeStore implements TaskScopeStore {
	private readonly scopes = new Map<string, TaskProjectScope>();
	private readonly views = new Map<string, TaskViewPreference>();
	private readonly registry: InMemoryProjectRegistryStore;

	constructor(registry?: ProjectRegistryStore) {
		this.registry = registry instanceof InMemoryProjectRegistryStore ? registry : new InMemoryProjectRegistryStore();
		this.registry.subscribeRootMoved((previousRoot, nextRoot) => this.onRootMoved(previousRoot, nextRoot));
	}

	private onRootMoved(previousRoot: string, nextRoot: string): void {
		for (const [taskId, scope] of this.scopes) {
			if (scope.projectRoot === previousRoot) this.scopes.set(taskId, { ...scope, projectRoot: nextRoot });
		}
		const view = this.views.get(previousRoot);
		if (view) {
			this.views.delete(previousRoot);
			this.views.set(nextRoot, { ...view, projectRoot: nextRoot });
		}
	}

	assign(taskId: string, projectRoot: string | undefined, source: TaskScopeSource): TaskProjectScope {
		const scope = { taskId, ...(projectRoot === undefined ? {} : { projectRoot }), source };
		this.scopes.set(taskId, scope);
		if (projectRoot !== undefined && !this.registry.byRoot(projectRoot)) this.registerProject({ projectRoot });
		return scope;
	}

	get(taskId: string): TaskProjectScope | undefined {
		return this.scopes.get(taskId);
	}

	taskIds(projectRoot: string | undefined, limit: number): string[] {
		return [...this.scopes.values()]
			.filter((scope) => scope.projectRoot === projectRoot)
			.map((scope) => scope.taskId)
			.sort()
			.slice(0, limit);
	}

	view(projectRoot: string): TaskViewPreference {
		return this.views.get(projectRoot) ?? { projectRoot, mode: "project" };
	}

	setView(projectRoot: string, mode: TaskViewMode, rootTaskId?: string): TaskViewPreference {
		const view = { projectRoot, mode, ...(rootTaskId === undefined ? {} : { rootTaskId }) };
		this.views.set(projectRoot, view);
		return view;
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
