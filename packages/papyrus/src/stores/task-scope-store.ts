import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { TASK_PROJECT_ALIAS_MAX_COUNT } from "../constants.ts";
import type {
	RegisterTaskProjectInput,
	TaskProject,
	TaskProjectScope,
	TaskScopeSource,
	TaskViewMode,
	TaskViewPreference,
} from "../domain/task-scope.ts";

export interface TaskScopeStore {
	assign(taskId: string, projectRoot: string | undefined, source: TaskScopeSource): TaskProjectScope;
	get(taskId: string): TaskProjectScope | undefined;
	taskIds(projectRoot: string | undefined, limit: number): string[];
	view(projectRoot: string): TaskViewPreference;
	setView(projectRoot: string, mode: TaskViewMode, rootTaskId?: string): TaskViewPreference;
	projects(query: string | undefined, limit: number): TaskProject[];
	matchingProjects(reference: string): TaskProject[];
	registerProject(input: RegisterTaskProjectInput): TaskProject;
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

export class InMemoryTaskScopeStore implements TaskScopeStore {
	private readonly scopes = new Map<string, TaskProjectScope>();
	private readonly views = new Map<string, TaskViewPreference>();
	private readonly projectRows = new Map<string, TaskProject>();

	assign(taskId: string, projectRoot: string | undefined, source: TaskScopeSource): TaskProjectScope {
		const scope = { taskId, ...(projectRoot === undefined ? {} : { projectRoot }), source };
		this.scopes.set(taskId, scope);
		if (projectRoot !== undefined && ![...this.projectRows.values()].some((project) => project.projectRoot === projectRoot)) {
			this.registerProject({ projectRoot });
		}
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
		const needle = query?.trim().toLowerCase();
		return [...this.projectRows.values()]
			.filter(
				(project) =>
					!needle ||
					project.name.toLowerCase().includes(needle) ||
					project.projectRoot.toLowerCase().includes(needle) ||
					project.aliases.some((alias) => alias.toLowerCase().includes(needle)),
			)
			.sort((left, right) => left.name.localeCompare(right.name) || left.projectRoot.localeCompare(right.projectRoot))
			.slice(0, limit);
	}

	matchingProjects(reference: string): TaskProject[] {
		const needle = reference.trim().toLowerCase();
		return [...this.projectRows.values()]
			.filter(
				(project) =>
					project.id.toLowerCase() === needle ||
					project.name.toLowerCase() === needle ||
					project.projectRoot.toLowerCase() === needle ||
					project.aliases.some((alias) => alias.toLowerCase() === needle),
			)
			.slice(0, 11);
	}

	registerProject(input: RegisterTaskProjectInput): TaskProject {
		const now = new Date().toISOString();
		const byRoot = [...this.projectRows.values()].find((project) => project.projectRoot === input.projectRoot);
		const existing = input.existingId ? this.projectRows.get(input.existingId) : byRoot;
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
			for (const [taskId, scope] of this.scopes) {
				if (scope.projectRoot === existing.projectRoot) this.scopes.set(taskId, { ...scope, projectRoot: project.projectRoot });
			}
			const view = this.views.get(existing.projectRoot);
			if (view) {
				this.views.delete(existing.projectRoot);
				this.views.set(project.projectRoot, { ...view, projectRoot: project.projectRoot });
			}
		}
		this.projectRows.set(project.id, project);
		return project;
	}
}
