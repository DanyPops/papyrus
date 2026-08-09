import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { TASK_PROJECT_ALIAS_MAX_COUNT } from "../constants.ts";
import type { Project, RegisterProjectInput } from "../domain/project-registry.ts";
import type { ProjectRegistryStore } from "../ports/project-registry-store.ts";

export function uniqueAliases(values: readonly string[], name: string): string[] {
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

/**
 * Extracted from what was TaskScopeStore's own project-registry bookkeeping (project list/exact
 * resolve/register/rename/move) -- moving a registered project's root must rewrite every
 * consumer's own rows keyed by that root (Task's own TaskProjectScope/TaskViewPreference,
 * and independently an ArtifactScopeStore's own membership rows), and more than one consumer
 * can share a single registry instance specifically so they resolve against identical project
 * identities. subscribeRootMoved supports that: every subscriber is notified, not just the
 * first, so sharing one instance across TaskScopeStore and ArtifactScopeStore never silently
 * drops the other's rewrite.
 */
export class InMemoryProjectRegistryStore implements ProjectRegistryStore {
	private readonly projectRows = new Map<string, Project>();
	private readonly rootMovedListeners: Array<(previousRoot: string, nextRoot: string) => void> = [];

	subscribeRootMoved(listener: (previousRoot: string, nextRoot: string) => void): void {
		this.rootMovedListeners.push(listener);
	}

	projects(query: string | undefined, limit: number): Project[] {
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

	matchingProjects(reference: string): Project[] {
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

	registerProject(input: RegisterProjectInput): Project {
		const now = new Date().toISOString();
		const byRoot = [...this.projectRows.values()].find((project) => project.projectRoot === input.projectRoot);
		const existing = input.existingId ? this.projectRows.get(input.existingId) : byRoot;
		const name = input.name?.trim() || existing?.name || basename(input.projectRoot) || input.projectRoot;
		const aliases = uniqueAliases(
			[...(existing?.aliases ?? []), ...(existing && existing.name !== name ? [existing.name] : []), ...(input.aliases ?? [])],
			name,
		);
		const project: Project = {
			id: existing?.id ?? randomUUID(),
			name,
			aliases,
			projectRoot: input.projectRoot,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		if (existing && existing.projectRoot !== project.projectRoot) {
			for (const listener of this.rootMovedListeners) listener(existing.projectRoot, project.projectRoot);
		}
		this.projectRows.set(project.id, project);
		return project;
	}

	/** Exposed for a caller (e.g. InMemoryTaskScopeStore) that needs to look up a project by its exact current root without going through the bounded matchingProjects search. */
	byRoot(projectRoot: string): Project | undefined {
		return [...this.projectRows.values()].find((project) => project.projectRoot === projectRoot);
	}

	/** Exposed for a caller (e.g. InMemoryArtifactScopeStore) that needs a project's own current fields (its root, for the legacy single-root compatibility view) from a stored membership id, without going through the needle-matching matchingProjects search. */
	byId(id: string): Project | undefined {
		return this.projectRows.get(id);
	}
}
