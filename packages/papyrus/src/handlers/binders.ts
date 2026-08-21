import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { ArtifactTrashStore } from "../artifact/artifact-trash-store.ts";
import { binderTree } from "../binder/binder-service.ts";
import { bindersOperations } from "../modules/binders.ts";
import type { ProjectRegistryStore } from "../project-registry/project-registry-store.ts";
import { normalizeProjectRoot } from "../project-registry/scope-source.ts";
import type { ScopeGroupStore } from "../scope-group/scope-group-store.ts";
import { booleanProp, createOperationDefiner, numberProp, resolveArtifactIdWidened, stringProp, validationError } from "./shared.ts";

const OWNER = "binders";

function resolveBinderId(
	artifacts: ArtifactStore,
	scopes: ArtifactScopeStore,
	projectRoot: string | undefined,
	id: unknown,
	name: unknown,
): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.trim().length === 0) throw validationError("id or name is required");
	const alias = artifacts.getByAlias(name.trim());
	if (alias?.kind === "binder" && (projectRoot === undefined || scopes.appliesToProjectRoot(alias.id, normalizeProjectRoot(projectRoot)))) {
		return alias.id;
	}
	const tree = binderTree(artifacts, scopes, { projectRoot });
	const pathNeedle = name.trim().startsWith("/") ? name.trim() : `/${name.trim()}`;
	const pathMatches = tree.nodes.filter((node) => node.path.toLowerCase() === pathNeedle.toLowerCase());
	if (pathMatches.length === 1) return pathMatches[0]!.binder.id;
	const titleMatches = tree.nodes.filter((node) => node.binder.title.trim().toLowerCase() === name.trim().toLowerCase());
	if (titleMatches.length === 1) return titleMatches[0]!.binder.id;
	if (titleMatches.length > 1 || pathMatches.length > 1) {
		const matches = pathMatches.length > 0 ? pathMatches : titleMatches;
		throw validationError(`binder name "${name}" is ambiguous: ${matches.map((node) => node.path).join(", ")} -- use a path or id`);
	}
	throw validationError(`no binder named "${name}" found in this project context`);
}

function resolveAnyArtifactId(artifacts: ArtifactStore, id: unknown, name: unknown): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.trim().length === 0) throw validationError("artifact_id or artifact_name is required");
	return resolveArtifactIdWidened(artifacts, name, () => artifacts.query({ text: name }));
}

export function registerBindersVehicleOperations(
	registry: VehicleRegistry,
	artifacts: ArtifactStore & ArtifactTrashStore,
	scopes: ArtifactScopeStore,
	projectRegistry: ProjectRegistryStore,
	scopeGroups: ScopeGroupStore,
): void {
	const operations = new Map(
		bindersOperations(artifacts, scopes, projectRegistry, scopeGroups).map((operation) => [operation.name, operation]),
	);
	const call = (name: string, input: Record<string, unknown>): unknown => operations.get(name)!.execute(input);
	const define = createOperationDefiner(registry, OWNER, "binders", ["binders:read", "binders:write"], call);
	const arrayProp = { type: "array" } as unknown as { type: string };
	const withBinderId = (input: Record<string, unknown>, idKey = "id", nameKey = "name") => ({
		...input,
		[idKey]: resolveBinderId(artifacts, scopes, input.project_root as string | undefined, input[idKey], input[nameKey]),
	});

	define(
		"create",
		"Creates a filesystem-style Binder. Binders organize artifacts without changing Task containment or Playbook execution. Direct labels on a Binder are inherited additively by descendants at read time. Prefer parent_name (a title, alias, or /path) over parent_id.",
		"local-write",
		{ title: stringProp, labels: arrayProp, parent_id: stringProp, parent_name: stringProp, project_root: stringProp, projects: arrayProp },
		["title"],
		(input) => ({
			...input,
			...(input.parent_id || input.parent_name
				? { parent_id: resolveBinderId(artifacts, scopes, input.project_root as string | undefined, input.parent_id, input.parent_name) }
				: {}),
		}),
	);
	define(
		"list",
		"Lists Binders. project_root alone is exact-membership audit scope; project_root plus applicable:true includes global Binders and Binders applicable to the project. Returns lean summaries unless full:true.",
		"read",
		{ text: stringProp, limit: numberProp, project_root: stringProp, applicable: booleanProp, full: booleanProp },
		[],
		(input) => input,
	);
	define(
		"tree",
		"Returns the project-context Binder tree plus placements and direct/inherited/effective labels for the bounded artifact_ids supplied. Label inheritance is computed, not copied into artifact labels.",
		"read",
		{ project_root: stringProp, artifact_ids: arrayProp },
		[],
		(input) => input,
	);
	define(
		"show",
		"Shows one Binder node by id, alias, title, or /path, including its path and inherited/effective labels.",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => withBinderId(input),
	);
	define(
		"update",
		"Renames a Binder and/or replaces its direct labels. Inherited labels on descendants update immediately because they are computed dynamically.",
		"local-write",
		{ id: stringProp, name: stringProp, title: stringProp, labels: arrayProp, project_root: stringProp },
		[],
		(input) => withBinderId(input),
	);
	define(
		"move",
		"Moves a Binder under parent_id/parent_name, or to the project-context root when neither is supplied. Rejects cycles and duplicate sibling names.",
		"local-write",
		{ id: stringProp, name: stringProp, parent_id: stringProp, parent_name: stringProp, project_root: stringProp },
		[],
		(input) => {
			const resolved = withBinderId(input);
			return {
				...resolved,
				...(input.parent_id || input.parent_name
					? { parent_id: resolveBinderId(artifacts, scopes, input.project_root as string | undefined, input.parent_id, input.parent_name) }
					: {}),
			};
		},
	);
	define(
		"file",
		"Files one non-Binder artifact in a Binder for this project context, replacing its previous visible placement. Prefer binder_name/artifact_name over ids when unambiguous.",
		"local-write",
		{
			binder_id: stringProp,
			binder_name: stringProp,
			artifact_id: stringProp,
			artifact_name: stringProp,
			project_root: stringProp,
		},
		[],
		(input) => ({
			...input,
			binder_id: resolveBinderId(artifacts, scopes, input.project_root as string | undefined, input.binder_id, input.binder_name),
			artifact_id: resolveAnyArtifactId(artifacts, input.artifact_id, input.artifact_name),
		}),
	);
	define(
		"unfile",
		"Moves one artifact to this project context's Binder root. This changes organization only, never Task containment or dependencies.",
		"local-write",
		{ artifact_id: stringProp, artifact_name: stringProp, project_root: stringProp },
		[],
		(input) => ({ ...input, artifact_id: resolveAnyArtifactId(artifacts, input.artifact_id, input.artifact_name) }),
	);
	define(
		"remove",
		"Trashes an empty Binder. A non-empty Binder is rejected until its contents are moved or unfiled.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp, reason: stringProp },
		[],
		(input) => withBinderId(input),
	);
	define(
		"scope",
		"Shows a Binder's project/scope-group scope.",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => withBinderId(input),
	);
	define(
		"set_global",
		"Makes a Binder apply in every project.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => withBinderId(input),
	);
	define(
		"set_none",
		"Hides a Binder from every project context.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		[],
		(input) => withBinderId(input),
	);
	define(
		"add_project",
		"Adds one registered project to a Binder's explicit scope.",
		"local-write",
		{ id: stringProp, name: stringProp, project: stringProp, project_root: stringProp },
		["project"],
		(input) => withBinderId(input),
	);
	define(
		"remove_project",
		"Removes one project from a Binder's explicit scope; removing the final member is rejected.",
		"local-write",
		{ id: stringProp, name: stringProp, project: stringProp, project_root: stringProp },
		["project"],
		(input) => withBinderId(input),
	);
	define(
		"replace_projects",
		"Replaces a Binder's project membership with a bounded non-empty list.",
		"local-write",
		{ id: stringProp, name: stringProp, projects: arrayProp, project_root: stringProp },
		["projects"],
		(input) => withBinderId(input),
	);
	define(
		"add_group",
		"Adds one nested scope group to a Binder's explicit scope.",
		"local-write",
		{ id: stringProp, name: stringProp, group: stringProp, project_root: stringProp },
		["group"],
		(input) => withBinderId(input),
	);
	define(
		"remove_group",
		"Removes one scope group from a Binder's explicit scope; removing the final member is rejected.",
		"local-write",
		{ id: stringProp, name: stringProp, group: stringProp, project_root: stringProp },
		["group"],
		(input) => withBinderId(input),
	);
	define(
		"replace_groups",
		"Replaces a Binder's scope-group membership with a bounded non-empty list.",
		"local-write",
		{ id: stringProp, name: stringProp, groups: arrayProp, project_root: stringProp },
		["groups"],
		(input) => withBinderId(input),
	);
}
