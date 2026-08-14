/**
 * Scope groups (named, reusable, possibly-nested scope member collections) projected as a real
 * VehicleRegistry: one VehicleOperation per real action. Wraps modules/scope-groups.ts's
 * operation definitions. See artifact/artifact-scope-store.ts's own doc comment for how a Doc/
 * Rule/Playbook's explicit scope references a group (docs/rules/playbooks.add_group etc.).
 */
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import { scopeGroupsOperations } from "../modules/scope-groups.ts";
import type { ProjectRegistryStore } from "../ports/project-registry-store.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import { createOperationDefiner, numberProp, stringProp } from "./shared.ts";

const OWNER = "scope_groups";

export function registerScopeGroupsVehicleOperations(
	registry: VehicleRegistry,
	scopeGroups: ScopeGroupStore,
	projectRegistry: ProjectRegistryStore,
	artifactScopes: ArtifactScopeStore,
): void {
	const moduleOperations = new Map(scopeGroupsOperations(scopeGroups, projectRegistry, artifactScopes).map((op) => [op.name, op]));
	const call = (name: string, input: Record<string, unknown>): unknown => moduleOperations.get(name)!.execute(input);
	const define = createOperationDefiner(registry, OWNER, "scope_groups", ["scope_groups:read", "scope_groups:write"], call);

	define(
		"list",
		"Lists registered scope groups, optionally filtered by a name/alias substring.",
		"read",
		{ query: stringProp, limit: numberProp },
		[],
		(input) => input,
	);

	define(
		"resolve",
		"Resolves an exact scope group reference (id, name, or alias) to its full identity, failing closed with bounded candidates when unknown or ambiguous.",
		"read",
		{ reference: stringProp },
		["reference"],
		(input) => input,
	);

	define(
		"register",
		"Registers a new scope group, or renames an existing one in place (via existing_id/group), preserving its stable id and old name as an alias.",
		"local-write",
		{
			name: stringProp,
			aliases: { type: "array" } as unknown as { type: string },
			existing_id: stringProp,
		},
		[],
		(input) => input,
	);

	define(
		"show",
		"Shows one scope group's identity and its own direct membership (not expanded through nested groups).",
		"read",
		{ group: { ...stringProp, description: "Exact scope group id, name, or alias." } },
		["group"],
		(input) => input,
	);

	define(
		"add_member",
		"Adds one member (a registered project, or another scope group -- nesting) to a scope group. Idempotent if already a member. Refuses a group-type member that would create a cycle or exceed the nesting depth bound.",
		"local-write",
		{
			group: { ...stringProp, description: "Exact scope group id, name, or alias." },
			member_type: { type: "string", enum: ["project", "group"] },
			member_reference: { ...stringProp, description: "Exact project or scope group id/name/alias/root reference, per member_type." },
		},
		["group", "member_type", "member_reference"],
		(input) => input,
	);

	define(
		"remove_member",
		"Removes one member from a scope group (idempotent -- removing an absent member is a no-op).",
		"local-write",
		{
			group: { ...stringProp, description: "Exact scope group id, name, or alias." },
			member_type: { type: "string", enum: ["project", "group"] },
			member_reference: { ...stringProp, description: "Exact project or scope group id/name/alias/root reference, per member_type." },
		},
		["group", "member_type", "member_reference"],
		(input) => input,
	);

	define(
		"delete",
		"Deletes a scope group outright. Refuses if any artifact's explicit scope, or any other scope group's own membership, still references it.",
		"local-write",
		{ group: { ...stringProp, description: "Exact scope group id, name, or alias." } },
		["group"],
		(input) => input,
	);
}
