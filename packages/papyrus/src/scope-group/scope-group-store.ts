import type { RegisterScopeGroupInput, ScopeGroup, ScopeMemberRef } from "./scope-group.ts";

/**
 * Kind-neutral registry for named, reusable scope member collections -- the "nesting" primitive
 * behind an artifact's explicit scope. Mirrors ProjectRegistryStore's own shape (create/list/
 * matching/register-in-place) plus real membership management and a real delete, learning from
 * the confirmed-live gap that ProjectRegistryStore itself has no delete path at all (see task
 * 1716b34b) -- a scope group's own delete refuses while still referenced, rather than never
 * being possible.
 */
export interface ScopeGroupStore {
	groups(query: string | undefined, limit: number): ScopeGroup[];
	matchingGroups(reference: string): ScopeGroup[];
	get(id: string): ScopeGroup | undefined;
	/** Registers a new group, or renames/updates an existing one in place (via existingId) -- same upsert shape as ProjectRegistryStore.registerProject, minus root-move semantics (a group has no root to move). */
	registerGroup(input: RegisterScopeGroupInput): ScopeGroup;
	members(groupId: string): ScopeMemberRef[];
	/** Adds one member (idempotent). Refuses a group-type member that would create a cycle (directly or transitively) or exceed SCOPE_GROUP_MAX_NESTING_DEPTH, and refuses exceeding SCOPE_GROUP_MAX_MEMBERS. */
	addMember(groupId: string, member: ScopeMemberRef): ScopeGroup;
	/** Removes one member (idempotent -- removing an absent member is a no-op). */
	removeMember(groupId: string, member: ScopeMemberRef): ScopeGroup;
	/** All projectIds reachable from this group by expanding every nested group member recursively (cycle-safe, depth-bounded), deduplicated. Does not include the group itself. */
	expandToProjectIds(groupId: string): Set<string>;
	/** True when adding `candidateMemberGroupId` as a member of `groupId` would create a cycle (groupId is reachable from candidateMemberGroupId) -- checked before addMember persists a group-type member. */
	wouldCreateCycle(groupId: string, candidateMemberGroupId: string): boolean;
	/** Deletes a group outright. Refuses (ScopeGroupInUseError) if any artifact's explicit scope or any other group's own membership still references it. */
	delete(groupId: string): void;
}
