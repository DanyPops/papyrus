import { basename, isAbsolute, normalize } from "node:path";
import { TASK_PROJECT_ROOT_MAX_LENGTH } from "../constants.ts";

export type TaskViewMode = "project" | "graph" | "all";
export type TaskScopeSource = "cwd" | "explicit" | "unscoped";

export interface TaskProjectScope {
	taskId: string;
	projectRoot?: string;
	source: TaskScopeSource;
}

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

export function normalizeProjectRoot(value: string): string {
	if (!isAbsolute(value)) throw new Error("project_root must be an absolute path");
	const normalized = normalize(value);
	if (normalized.length > TASK_PROJECT_ROOT_MAX_LENGTH) {
		throw new Error(`project_root cannot exceed ${TASK_PROJECT_ROOT_MAX_LENGTH} characters`);
	}
	return normalized;
}

export function taskScopeLabel(mode: TaskViewMode, projectRoot?: string, rootTitle?: string): string {
	if (mode === "all") return "All projects";
	const project = projectRoot ? basename(projectRoot) || projectRoot : "Unscoped";
	return mode === "graph" ? `${project} · ${rootTitle ?? "focused graph"}` : project;
}
