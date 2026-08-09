/**
 * A registered project identity, shared across every artifact kind (Tasks, Docs, Rules,
 * Playbooks) rather than owned by Tasks alone -- extracted so a Doc/Rule/Playbook can resolve
 * and register against the exact same id/name/alias/root space a Task already does, instead of
 * each domain inventing its own project catalog.
 */
export interface Project {
	id: string;
	name: string;
	aliases: string[];
	projectRoot: string;
	createdAt: string;
	updatedAt: string;
}

export interface RegisterProjectInput {
	projectRoot: string;
	name?: string;
	aliases?: string[];
	existingId?: string;
}

export class ProjectNotFoundError extends Error {}
export class ProjectAmbiguousError extends Error {}

export interface ProjectReferenceLookup {
	matchingProjects(reference: string): Project[];
	projects(query: string | undefined, limit: number): Project[];
}

/**
 * Same bounded, fail-closed exact-reference resolution Tasks' own resolveProject already uses
 * (case-insensitive exact id/name/alias/root, zero matches is an error with up to 10 bounded
 * candidates, more than one match is an error listing every match up to 10) -- extracted here so
 * a non-Task domain (Rules, and later Docs/Playbooks) gets the identical contract instead of a
 * hand-rolled approximation. Tasks' own TaskProjectNotFoundError/TaskProjectAmbiguousError are
 * deliberately left as they are (a working, tested path with its own established call sites);
 * this is for every domain that never had project-reference resolution before.
 */
export function resolveProjectReference(registry: ProjectReferenceLookup, reference: string): Project {
	const matches = registry.matchingProjects(reference);
	if (matches.length === 0) {
		const candidates = registry.projects(reference, 10);
		const fallback = candidates.length === 0 ? registry.projects(undefined, 10) : candidates;
		const suffix =
			fallback.length === 0 ? "" : ` Candidates: ${fallback.map((project) => `${project.name} (${project.projectRoot})`).join(", ")}`;
		throw new ProjectNotFoundError(`no project named or aliased "${reference}" is registered.${suffix}`);
	}
	if (matches.length > 1) {
		throw new ProjectAmbiguousError(
			`project reference "${reference}" is ambiguous: ${matches
				.slice(0, 10)
				.map((project) => `${project.name} (${project.projectRoot})`)
				.join(", ")}`,
		);
	}
	return matches[0]!;
}
