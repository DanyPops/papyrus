import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import { ScopeGroupInUseError } from "./scope-group.ts";
import type { ScopeGroupStore } from "./scope-group-store.ts";

/**
 * The one real cross-store check a plain ScopeGroupStore.delete() cannot make on its own: whether
 * any Doc/Rule/Playbook's own explicit scope still references this group. ScopeGroupStore.delete()
 * itself only checks the self-consistency case (another group's own membership) -- deliberately,
 * so the store's own port stays kind-agnostic and never depends on ArtifactScopeStore. This
 * orchestration function is the one real caller that holds both.
 */
export function deleteScopeGroup(scopeGroups: ScopeGroupStore, artifactScopes: ArtifactScopeStore, groupId: string): void {
	if (artifactScopes.referencesGroup(groupId)) {
		throw new ScopeGroupInUseError(`scope group "${groupId}" is still referenced by at least one artifact's explicit scope`);
	}
	scopeGroups.delete(groupId);
}
