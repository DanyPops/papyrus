/**
 * modules/scope-groups.ts — named, reusable, possibly-nested scope member collections as their
 * own Papyrus-native registered module. A scope group's own members (added/removed here) are
 * referenced by Docs/Rules/Playbooks' own explicit scope (docs/rules/playbooks.add_group etc.,
 * see ../artifact/artifact-scope-store.ts) -- "explicit scope can include nested scopes".
 * Mirrors modules/projects.ts's own shape (list/resolve/register) for the catalog half, plus
 * real membership management and a real delete (deleteScopeGroup, unlike ProjectRegistryStore
 * which has no delete path at all -- see papyrus task 1716b34b).
 */

import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import { SCOPE_GROUP_LIST_MAX_RESULTS } from "../constants.ts";
import { resolveProjectReference } from "../domain/project-registry.ts";
import type { OperationDefinition } from "../module-registry.ts";
import type { ProjectRegistryStore } from "../ports/project-registry-store.ts";
import { deleteScopeGroup } from "../scope-group/delete-scope-group.ts";
import { resolveScopeGroupReference, type ScopeMemberRef } from "../scope-group/scope-group.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import { type OperationInput, optionalNumber, optionalString, optionalStringArray, string } from "./operation-input.ts";

const MODULE_ID = "scope_groups";

export const SCOPE_GROUPS_OPERATION_NAMES = [
	"scope_groups.list",
	"scope_groups.resolve",
	"scope_groups.register",
	"scope_groups.show",
	"scope_groups.add_member",
	"scope_groups.remove_member",
	"scope_groups.delete",
] as const;

function resolveMember(
	registry: ProjectRegistryStore,
	scopeGroups: ScopeGroupStore,
	memberType: string,
	memberReference: string,
): ScopeMemberRef {
	if (memberType === "project") return { type: "project", id: resolveProjectReference(registry, memberReference).id };
	if (memberType === "group") return { type: "group", id: resolveScopeGroupReference(scopeGroups, memberReference).id };
	throw new Error('member_type must be "project" or "group"');
}

export function scopeGroupsOperations(
	scopeGroups: ScopeGroupStore,
	registry: ProjectRegistryStore,
	artifactScopes: ArtifactScopeStore,
): OperationDefinition[] {
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name,
		moduleId: MODULE_ID,
		execute,
	});
	return [
		define("scope_groups.list", (input: OperationInput) => {
			const limit = optionalNumber(input, "limit") ?? 20;
			if (!Number.isInteger(limit) || limit < 1 || limit > SCOPE_GROUP_LIST_MAX_RESULTS) {
				throw new Error(`scope group list limit must be between 1 and ${SCOPE_GROUP_LIST_MAX_RESULTS}`);
			}
			return scopeGroups.groups(optionalString(input, "query"), limit);
		}),
		define("scope_groups.resolve", (input: OperationInput) => resolveScopeGroupReference(scopeGroups, string(input, "reference"))),
		define("scope_groups.register", (input: OperationInput) =>
			scopeGroups.registerGroup({
				name: optionalString(input, "name"),
				aliases: optionalStringArray(input, "aliases"),
				existingId: optionalString(input, "existing_id"),
			}),
		),
		define("scope_groups.show", (input: OperationInput) => {
			const group = resolveScopeGroupReference(scopeGroups, string(input, "group"));
			return { group, members: scopeGroups.members(group.id) };
		}),
		define("scope_groups.add_member", (input: OperationInput) => {
			const group = resolveScopeGroupReference(scopeGroups, string(input, "group"));
			const member = resolveMember(registry, scopeGroups, string(input, "member_type"), string(input, "member_reference"));
			scopeGroups.addMember(group.id, member);
			return { group, members: scopeGroups.members(group.id) };
		}),
		define("scope_groups.remove_member", (input: OperationInput) => {
			const group = resolveScopeGroupReference(scopeGroups, string(input, "group"));
			const member = resolveMember(registry, scopeGroups, string(input, "member_type"), string(input, "member_reference"));
			scopeGroups.removeMember(group.id, member);
			return { group, members: scopeGroups.members(group.id) };
		}),
		define("scope_groups.delete", (input: OperationInput) => {
			const group = resolveScopeGroupReference(scopeGroups, string(input, "group"));
			deleteScopeGroup(scopeGroups, artifactScopes, group.id);
			return { deleted: true, id: group.id };
		}),
	];
}
