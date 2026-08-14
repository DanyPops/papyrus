/**
 * Docs projected as a real VehicleRegistry: one VehicleOperation per real action.
 * Wraps modules/docs.ts's operation definitions. remove/restore/remove_subtree
 * are not duplicated here -- see ./artifact-trash-vehicle.ts.
 */
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { AuthorityRegistry } from "../authority-registry.ts";
import { listDocuments } from "../docs/docs-service.ts";
import { docsOperations } from "../modules/docs.ts";
import type { ProjectRegistryStore } from "../ports/project-registry-store.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import { booleanProp, createOperationDefiner, numberProp, resolveArtifactIdWidened, stringProp, validationError } from "./shared.ts";

const OWNER = "docs";

/**
 * Resolves a doc's id from either an explicit id or its title. When project_root is given and
 * the project-scoped search finds nothing, widens only to a doc that actually APPLIES to this
 * project (global, or explicitly scoped to it via applicableToProjectRoot) -- never to a
 * same-named doc that belongs to a different project. A prior version widened to every doc of
 * that name across every project unconditionally once the scoped search came up empty, silently
 * leaking a name-based mutation across project boundaries (the same real bug rules.ts's own
 * resolveRuleId had before its own fix). A caller wanting a genuine all-project search can
 * already get it by omitting project_root entirely -- unchanged, unscoped behavior.
 */
function resolveDocId(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	projectRoot: string | undefined,
	id: unknown,
	name: unknown,
): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw validationError("id or name is required");
	return resolveArtifactIdWidened(
		artifacts,
		name,
		() => listDocuments(artifacts, scopes, { text: name, projectRoot }),
		projectRoot === undefined ? undefined : () => listDocuments(artifacts, scopes, { text: name, applicableToProjectRoot: projectRoot }),
	);
}

/** Cross-kind resolution for a link target -- can be a doc, task, rule, or playbook. Unscoped, matching the exact behavior of the artifact.query-backed resolution it replaces. */
function resolveTargetId(artifacts: ArtifactStore, id: unknown, name: unknown): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw validationError("target_id or target_name is required");
	return resolveArtifactIdWidened(artifacts, name, () => artifacts.query({ text: name }));
}

export function registerDocsVehicleOperations(
	registry: VehicleRegistry,
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	authority: AuthorityRegistry,
	projectRegistry: ProjectRegistryStore,
	scopeGroups: ScopeGroupStore,
): void {
	const moduleOperations = new Map(docsOperations(artifacts, scopes, authority, projectRegistry, scopeGroups).map((op) => [op.name, op]));
	const call = (name: string, input: Record<string, unknown>): unknown => moduleOperations.get(name)!.execute(input);
	const define = createOperationDefiner(registry, OWNER, "docs", ["docs:read", "docs:write"], call);

	define(
		"create",
		"Creates a Doc -- descriptive knowledge, not actionable work. project_root is optional (omitted = unscoped). projects (a list of exact registered project id/name/alias/root references) creates it bounded to several projects at once instead, taking precedence over project_root when both are given.",
		"local-write",
		{
			title: stringProp,
			body: stringProp,
			subtype: stringProp,
			labels: { type: "array" } as unknown as { type: string },
			extra: { type: "object" } as unknown as { type: string },
			template_id: stringProp,
			project_root: stringProp,
			projects: { type: "array" } as unknown as { type: string },
		},
		["title"],
		(input) => input,
	);

	define(
		"list",
		"Lists Docs matching an optional status/text filter. project_root alone scopes to EXACT membership in that project (audit semantics); project_root plus applicable:true instead lists every Doc APPLICABLE to it (global Docs plus Docs whose membership includes it). Returns a lean summary (no body) by default -- pass full: true for the complete artifact.",
		"read",
		{ status: stringProp, text: stringProp, limit: numberProp, project_root: stringProp, applicable: booleanProp, full: booleanProp },
		[],
		(input) => input,
	);

	define("show", "Shows one Doc by id or title.", "read", { id: stringProp, name: stringProp, project_root: stringProp }, [], (input) => ({
		...input,
		id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name),
	}));

	define(
		"activate",
		"Activates a draft Doc.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"archive",
		"Archives an active Doc.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"reopen",
		"Reopens an archived Doc back to active.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"link",
		"Links a Doc to another artifact via a typed relation. Prefer target_name over target_id -- resolved server-side, searching every kind since a link target can be a doc, task, rule, or playbook.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			relation: { type: "string", enum: ["references", "documents", "supersedes", "relates_to", "contains", "part_of"] },
			target_id: stringProp,
			target_name: stringProp,
			project_root: stringProp,
		},
		["relation"],
		(input) => ({
			...input,
			id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name),
			target_id: resolveTargetId(artifacts, input.target_id, input.target_name),
		}),
	);

	define(
		"assign_project",
		"Reassigns a Doc's project_root, or unscopes it when project_root is omitted.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, undefined, input.id, input.name) }),
	);

	define(
		"scope",
		"Shows a Doc's real project scope: global (applies everywhere) or the bounded set of registered projects it applies to.",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"set_global",
		"Makes a Doc apply in every project, clearing any project membership. The only way to widen a project-bound Doc back to global -- removing its last membership through remove_project is rejected instead.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"add_project",
		"Adds one registered project (exact id, name, alias, or root) to a Doc's membership, switching it from global to project-bound if it was global. Idempotent if the project is already a member.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			project: { ...stringProp, description: "Exact project id, name, alias, or registered root to add." },
			project_root: stringProp,
		},
		["project"],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"remove_project",
		"Removes one registered project from a Doc's membership. Rejected while it is the Doc's only remaining membership -- call set_global first if the Doc should stop being project-bound entirely.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			project: { ...stringProp, description: "Exact project id, name, alias, or registered root to remove." },
			project_root: stringProp,
		},
		["project"],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"replace_projects",
		"Replaces a Doc's entire project membership with exactly this bounded, non-empty list of registered project references (id/name/alias/root). Use set_global instead to clear scoping entirely.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			projects: { type: "array", description: "Non-empty list of exact project id/name/alias/root references." } as unknown as {
				type: string;
			},
			project_root: stringProp,
		},
		["projects"],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"set_none",
		"Fully hides a Doc -- never applicable, never context-injected, regardless of project. The only way back is set_global, add_project, add_group, or replace_projects/replace_groups.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"add_group",
		"Adds one scope group (a named, reusable, possibly-nested collection of projects and/or other groups) to a Doc's explicit scope, switching it from global/none to project-bound if it wasn't already. Idempotent if the group is already a member.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			group: { ...stringProp, description: "Exact scope group id, name, or alias to add." },
			project_root: stringProp,
		},
		["group"],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"remove_group",
		"Removes one scope group from a Doc's explicit scope. Rejected while it is the Doc's only remaining scope member -- call set_global or set_none first.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			group: { ...stringProp, description: "Exact scope group id, name, or alias to remove." },
			project_root: stringProp,
		},
		["group"],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"replace_groups",
		"Replaces a Doc's entire scope-group membership with exactly this bounded, non-empty list of scope group references (id/name/alias). Use set_global/set_none instead to clear scoping entirely.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			groups: { type: "array", description: "Non-empty list of exact scope group id/name/alias references." } as unknown as {
				type: string;
			},
			project_root: stringProp,
		},
		["groups"],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);

	define(
		"update",
		"Changes a Doc's title/body/labels (at least one required). Refused for a read-only external projection (e.g. web-spider-ingested Docs) -- capture a correction as a new linked Doc instead.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			title: stringProp,
			body: stringProp,
			labels: { type: "array" } as unknown as { type: string },
			project_root: stringProp,
		},
		[],
		(input) => ({ ...input, id: resolveDocId(artifacts, scopes, input.project_root as string | undefined, input.id, input.name) }),
	);
}
