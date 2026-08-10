import { TASK_PROJECT_ALIAS_MAX_COUNT, TASK_PROJECT_NAME_MAX_LENGTH } from "../constants.ts";

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

/**
 * The one bounded schema vocabulary for a registered project name/alias set -- shared by Tasks'
 * own registerProject and the kind-neutral projects.register operation, rather than each domain
 * enforcing a slightly different bound. Reuses constants.ts's existing TASK_PROJECT_* bounds
 * (unchanged names -- the underlying catalog is Tasks' own historical one, just no longer
 * Tasks-exclusive) rather than introducing a second, parallel set of the same numbers.
 * Store-level registerProject (SQLiteProjectRegistryStore) does not itself validate
 * length/count, so every caller must go through this first.
 */
export function assertRegisterProjectInputBounds(name: string | undefined, aliases: string[] | undefined): void {
	if (name !== undefined && (name.trim().length === 0 || name.length > TASK_PROJECT_NAME_MAX_LENGTH)) {
		throw new Error(`project name must be between 1 and ${TASK_PROJECT_NAME_MAX_LENGTH} characters`);
	}
	if ((aliases?.length ?? 0) > TASK_PROJECT_ALIAS_MAX_COUNT) {
		throw new Error(`project aliases cannot exceed ${TASK_PROJECT_ALIAS_MAX_COUNT} entries`);
	}
	for (const alias of aliases ?? []) {
		if (alias.trim().length === 0 || alias.length > TASK_PROJECT_NAME_MAX_LENGTH) {
			throw new Error(`each project alias must be between 1 and ${TASK_PROJECT_NAME_MAX_LENGTH} characters`);
		}
	}
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
