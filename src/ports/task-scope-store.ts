import type { TaskProjectScope, TaskScopeSource, TaskViewMode, TaskViewPreference } from "../domain/task-scope.ts";

export interface TaskScopeStore {
	assign(taskId: string, projectRoot: string | undefined, source: TaskScopeSource): TaskProjectScope;
	get(taskId: string): TaskProjectScope | undefined;
	taskIds(projectRoot: string | undefined, limit: number): string[];
	view(projectRoot: string): TaskViewPreference;
	setView(projectRoot: string, mode: TaskViewMode, rootTaskId?: string): TaskViewPreference;
}

export class InMemoryTaskScopeStore implements TaskScopeStore {
	private readonly scopes = new Map<string, TaskProjectScope>();
	private readonly views = new Map<string, TaskViewPreference>();

	assign(taskId: string, projectRoot: string | undefined, source: TaskScopeSource): TaskProjectScope {
		const scope = { taskId, ...(projectRoot === undefined ? {} : { projectRoot }), source };
		this.scopes.set(taskId, scope);
		return scope;
	}

	get(taskId: string): TaskProjectScope | undefined { return this.scopes.get(taskId); }

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
}
