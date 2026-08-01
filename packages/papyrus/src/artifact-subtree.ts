/**
 * Bulk trash of a `contains` subtree, any artifact kind -- a whole materialized Task run
 * (root container + steps + nested playbook children) or a Playbook's own nested-playbook
 * tree can be moved to trash in one call instead of enumerating every id by hand. Mirrors
 * Tasks.cancelSubtree's traversal shape but performs trash(), not a lifecycle transition,
 * so it applies to any kind that participates in `contains` (task, playbook), not just Task.
 */
import { ARTIFACT_REMOVE_SUBTREE_MAX_NODES } from "./constants.ts";
import type { ArtifactEventContext } from "./domain/artifact-event.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import type { ArtifactTrashStore } from "./ports/artifact-trash-store.ts";

export interface RemoveSubtreeResult {
	removed: string[];
	/** Already trashed -- a real no-op, not an error, matching trash()/restore()'s own idempotence elsewhere. */
	skipped: string[];
}

/**
 * Trashes `id` and every artifact reachable by following `contains` edges outward from it,
 * transitively. An already-trashed node is skipped rather than re-trashed (trash() itself is
 * idempotent, but skipping keeps the result's `removed` list meaningful -- only nodes newly
 * moved to trash by this call). A node that is the live Task Focus in some scope still throws
 * (the same guard trash() always enforces for a single artifact) rather than being silently
 * skipped -- an active Focus is a real conflict to surface, not routine already-done state.
 */
export function removeArtifactSubtree(
	store: ArtifactStore & ArtifactTrashStore,
	id: string,
	options: { reason?: string; context?: ArtifactEventContext } = {},
): RemoveSubtreeResult {
	if (!store.get(id)) throw new Error(`artifact "${id}" not found`);
	const visited = new Set<string>();
	const queue = [id];
	const removed: string[] = [];
	const skipped: string[] = [];
	while (queue.length > 0) {
		const current = queue.shift()!;
		if (visited.has(current)) continue;
		visited.add(current);
		if (visited.size > ARTIFACT_REMOVE_SUBTREE_MAX_NODES)
			throw new Error(`remove_subtree exceeds ${ARTIFACT_REMOVE_SUBTREE_MAX_NODES} artifacts`);
		const childIds = store
			.relationships({ artifactIds: [current] })
			.filter((edge) => edge.from === current && edge.relation === "contains")
			.map((edge) => edge.to);
		queue.push(...childIds);
		if (store.trashStatus(current)) {
			skipped.push(current);
			continue;
		}
		store.trash(current, { reason: options.reason, context: options.context });
		removed.push(current);
	}
	return { removed, skipped };
}
