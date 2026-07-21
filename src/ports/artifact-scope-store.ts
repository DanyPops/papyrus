import type { TaskScopeSource } from "../domain/task-scope.ts";

/**
 * Project scoping for Docs/Rules/Skills, mirroring TaskScopeStore's shape (task_scopes) but
 * kept as its own table/port rather than folding non-Task kinds into Task-named
 * infrastructure. TaskScopeSource ("cwd" | "explicit" | "unscoped") is already kind-agnostic
 * and reused as-is -- no reason to redefine the same three values under a new name.
 */
export interface ArtifactScope {
	artifactId: string;
	projectRoot?: string;
	source: TaskScopeSource;
}

export interface ArtifactScopeStore {
	assign(artifactId: string, projectRoot: string | undefined, source: TaskScopeSource): ArtifactScope;
	get(artifactId: string): ArtifactScope | undefined;
	/** Bounded id listing for one project (or the unscoped bucket when projectRoot is undefined). */
	ids(projectRoot: string | undefined, limit: number): string[];
}
