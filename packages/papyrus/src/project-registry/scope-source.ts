import { basename, isAbsolute, normalize } from "node:path";
import { TASK_PROJECT_ROOT_MAX_LENGTH } from "../constants.ts";

/** How a project root got attached to a scoped artifact -- shared across Tasks/Docs/Rules/Playbooks, same category as Project in project-registry.ts. */
export type ScopeAssignmentSource = "cwd" | "explicit" | "unscoped";

export function normalizeProjectRoot(value: string): string {
	if (!isAbsolute(value)) throw new Error("project_root must be an absolute path");
	const normalized = normalize(value);
	if (normalized.length > TASK_PROJECT_ROOT_MAX_LENGTH) {
		throw new Error(`project_root cannot exceed ${TASK_PROJECT_ROOT_MAX_LENGTH} characters`);
	}
	return normalized;
}
