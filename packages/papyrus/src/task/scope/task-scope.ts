import { basename } from "node:path";
import type { Project, RegisterProjectInput } from "../../project-registry/project-registry.ts";
import type { ScopeAssignmentSource } from "../../project-registry/scope-source.ts";

export { normalizeProjectRoot } from "../../project-registry/scope-source.ts";

export type TaskViewMode = "project" | "graph" | "all";

/** Task's own name for the shared, kind-neutral scope-assignment provenance -- see scope-source.ts. Kept as a type alias so every existing Task-scope call site keeps working unchanged. */
export type TaskScopeSource = ScopeAssignmentSource;

export interface TaskProjectScope {
	taskId: string;
	projectRoot?: string;
	source: TaskScopeSource;
}

/** Task's own name for the shared, kind-neutral Project identity -- see project-registry.ts. Kept as a type alias so every existing Task-scope call site keeps working unchanged. */
export type TaskProject = Project;

export type RegisterTaskProjectInput = RegisterProjectInput;

export interface TaskViewPreference {
	projectRoot: string;
	mode: TaskViewMode;
	rootTaskId?: string;
}

export interface TaskViewSelection {
	mode: TaskViewMode;
	label: string;
	projectRoot?: string;
	rootTaskId?: string;
}

export function taskScopeLabel(mode: TaskViewMode, projectRoot?: string, rootTitle?: string): string {
	if (mode === "all") return "All projects";
	const project = projectRoot ? basename(projectRoot) || projectRoot : "Unscoped";
	return mode === "graph" ? `${project} · ${rootTitle ?? "focused graph"}` : project;
}
