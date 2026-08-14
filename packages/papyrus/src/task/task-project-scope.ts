import type { Artifact } from "../artifact/artifact.ts";
import { TASK_PROJECT_LIST_MAX_RESULTS } from "../constants.ts";
import { assertRegisterProjectInputBounds } from "../project-registry/project-registry.ts";
import type { AppendTaskEvent, TaskEventContext } from "../task-event/task-event.ts";
import type { TaskEventStore } from "../task-event/task-event-store.ts";
import {
	normalizeProjectRoot,
	type RegisterTaskProjectInput,
	type TaskProject,
	type TaskViewMode,
	type TaskViewSelection,
	taskScopeLabel,
} from "../task-scope/task-scope.ts";
import type { TaskScopeStore } from "../task-scope/task-scope-store.ts";

export class TaskProjectNotFoundError extends Error {}
export class TaskProjectAmbiguousError extends Error {}

/**
 * Task project-scope management (scopeSelection/setView/assignProject/projects/resolveProject/
 * registerProject), split out of the Tasks god class as part of a SOLID-audit-driven
 * decomposition (see task b51419a0 and the "TaskProjectScope" child of "Epic: Modularize
 * papyrus/pi-papyrus god-files into building-block modules"), mirroring the existing
 * TaskLeaseCoordinator/TaskMutationCoordinator/TaskFocusCoordinator precedent in this directory.
 *
 * list()/graph() (which stay on Tasks -- they're core query/graph-construction, not project-scope
 * itself) still call scopeSelection() on this collaborator via Tasks' own thin delegation.
 */
export class TaskProjectScope {
	constructor(
		private readonly scopes: TaskScopeStore,
		private readonly events: TaskEventStore,
		/** Delegates to Tasks.require() so project-scope methods get the identical not-found/wrong-kind checks every other Tasks method already enforces, without duplicating that logic here. */
		private readonly requireTask: (id: string) => Artifact,
		/** Delegates to Tasks' own actor/source/sessionId/reason defaulting so every event this collaborator appends looks identical to one Tasks itself would have appended. */
		private readonly appendEvent: (event: Omit<AppendTaskEvent, "actor" | "source">, context: TaskEventContext) => void,
	) {}

	scopeSelection(projectRoot?: string, mode?: TaskViewMode, rootTaskId?: string): TaskViewSelection {
		if (mode !== undefined && mode !== "project" && mode !== "graph" && mode !== "all")
			throw new Error("task scope must be project, graph, or all");
		if (projectRoot === undefined) return { mode: "all", label: taskScopeLabel("all") };
		const normalized = normalizeProjectRoot(projectRoot);
		const persisted = this.scopes.view(normalized);
		const selectedMode = mode ?? persisted.mode;
		const selectedRoot = rootTaskId ?? (selectedMode === "graph" ? persisted.rootTaskId : undefined);
		if (selectedMode === "graph" && !selectedRoot) throw new Error("graph scope requires root_task_id");
		const root = selectedRoot ? this.requireTask(selectedRoot) : undefined;
		if (root && this.scopes.get(root.id)?.projectRoot !== normalized) throw new Error(`task "${root.id}" is outside project scope`);
		return {
			mode: selectedMode,
			label: taskScopeLabel(selectedMode, normalized, root?.title),
			projectRoot: normalized,
			...(selectedRoot === undefined ? {} : { rootTaskId: selectedRoot }),
		};
	}

	setView(projectRoot: string, mode: TaskViewMode, rootTaskId?: string): TaskViewSelection {
		const selection = this.scopeSelection(projectRoot, mode, rootTaskId);
		this.scopes.setView(selection.projectRoot!, selection.mode, selection.rootTaskId);
		return selection;
	}

	assignProject(id: string, projectRoot: string, context: TaskEventContext = {}): Artifact {
		return this.events.atomic(() => {
			const task = this.requireTask(id);
			this.scopes.assign(id, normalizeProjectRoot(projectRoot), "explicit");
			this.appendEvent({ taskId: id, type: "project_assigned", reason: context.reason }, context);
			return task;
		});
	}

	projects(query?: string, limit = 20): TaskProject[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > TASK_PROJECT_LIST_MAX_RESULTS) {
			throw new Error(`project list limit must be between 1 and ${TASK_PROJECT_LIST_MAX_RESULTS}`);
		}
		return this.scopes.projects(query, limit);
	}

	resolveProject(reference: string): TaskProject {
		const matches = this.scopes.matchingProjects(reference);
		if (matches.length === 0) {
			const candidates = this.scopes.projects(reference, 10);
			const fallback = candidates.length === 0 ? this.scopes.projects(undefined, 10) : candidates;
			const suffix =
				fallback.length === 0 ? "" : ` Candidates: ${fallback.map((project) => `${project.name} (${project.projectRoot})`).join(", ")}`;
			throw new TaskProjectNotFoundError(`no task project named or aliased "${reference}" is registered.${suffix}`);
		}
		if (matches.length > 1) {
			throw new TaskProjectAmbiguousError(
				`task project reference "${reference}" is ambiguous: ${matches
					.slice(0, 10)
					.map((project) => `${project.name} (${project.projectRoot})`)
					.join(", ")}`,
			);
		}
		return matches[0]!;
	}

	registerProject(input: RegisterTaskProjectInput, existingReference?: string): TaskProject {
		const projectRoot = normalizeProjectRoot(input.projectRoot);
		const name = input.name?.trim();
		assertRegisterProjectInputBounds(name, input.aliases);
		const existingId = existingReference ? this.resolveProject(existingReference).id : input.existingId;
		return this.scopes.registerProject({ projectRoot, ...(name ? { name } : {}), aliases: input.aliases, existingId });
	}
}
