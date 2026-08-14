import type { Project, RegisterProjectInput } from "../project-registry/project-registry.ts";

/**
 * Kind-neutral project identity, shared by Task scope and every non-Task artifact scope
 * (Docs/Rules/Playbooks) rather than each domain keeping its own catalog. TaskScopeStore
 * composes one of these for its own `projects`/`matchingProjects`/`registerProject` methods
 * instead of implementing project bookkeeping itself; ArtifactScopeStore does the same.
 */
export interface ProjectRegistryStore {
	projects(query: string | undefined, limit: number): Project[];
	matchingProjects(reference: string): Project[];
	registerProject(input: RegisterProjectInput): Project;
}
