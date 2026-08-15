import { basename, isAbsolute, normalize } from "node:path";
import { TASK_PROJECT_ROOT_MAX_LENGTH } from "../constants.ts";

/**
 * How a project root ended up attached to a scoped artifact -- shared across every artifact kind
 * (Tasks, Docs, Rules, Playbooks) rather than owned by Tasks alone, same category as Project
 * itself in project-registry.ts. This lived inside task-scope.ts under the name
 * `TaskScopeSource` until a SOLID audit (see Doc "SOLID pattern analysis: task-event/task-scope
 * shared-kernel extraction") found it consumed identically by artifact/, docs-service.ts,
 * rules-service.ts, playbook-service.ts, and modules/projects.ts -- a Role Interface split
 * couldn't fix this half of the problem because there's no single supplier to narrow a contract
 * for; every one of those five call sites is a peer owner of the same vocabulary. task-scope.ts
 * keeps `TaskScopeSource` as a backward-compatible alias of this type for Task's own call sites.
 */
export type ScopeAssignmentSource = "cwd" | "explicit" | "unscoped";

/**
 * Same relocation as ScopeAssignmentSource above, for the same reason: a pure, artifact-kind-
 * agnostic validation/normalization function that every non-Task scope-assigning service already
 * called directly rather than through any Task-owned abstraction.
 */
export function normalizeProjectRoot(value: string): string {
	if (!isAbsolute(value)) throw new Error("project_root must be an absolute path");
	const normalized = normalize(value);
	if (normalized.length > TASK_PROJECT_ROOT_MAX_LENGTH) {
		throw new Error(`project_root cannot exceed ${TASK_PROJECT_ROOT_MAX_LENGTH} characters`);
	}
	return normalized;
}
