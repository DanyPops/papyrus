/**
 * Docs projected as a real VehicleRegistry: one VehicleOperation per real action.
 * Wraps modules/docs.ts's operation definitions. remove/restore/remove_subtree
 * are not duplicated here -- see ./artifact-trash-vehicle.ts.
 */
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { ArtifactScopeStore } from "../artifact/artifact-scope-store.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import type { AuthorityRegistry } from "../authority-registry.ts";
import { listDocuments } from "../domain-services.ts";
import { docsOperations } from "../modules/docs.ts";
import { booleanProp, createOperationDefiner, numberProp, resolveArtifactIdWidened, stringProp, validationError } from "./shared.ts";

const OWNER = "docs";

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
		projectRoot === undefined ? undefined : () => listDocuments(artifacts, scopes, { text: name }),
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
): void {
	const moduleOperations = new Map(docsOperations(artifacts, scopes, authority).map((op) => [op.name, op]));
	const call = (name: string, input: Record<string, unknown>): unknown => moduleOperations.get(name)!.execute(input);
	const define = createOperationDefiner(registry, OWNER, "docs", ["docs:read", "docs:write"], call);

	define(
		"create",
		"Creates a Doc -- descriptive knowledge, not actionable work. project_root is optional (omitted = unscoped).",
		"local-write",
		{
			title: stringProp,
			body: stringProp,
			subtype: stringProp,
			labels: { type: "array" } as unknown as { type: string },
			extra: { type: "object" } as unknown as { type: string },
			template_id: stringProp,
			project_root: stringProp,
		},
		["title"],
		(input) => input,
	);

	define(
		"list",
		"Lists Docs matching an optional status/text filter, scoped to project_root when given. Returns a lean summary (no body) by default -- pass full: true for the complete artifact.",
		"read",
		{ status: stringProp, text: stringProp, limit: numberProp, project_root: stringProp, full: booleanProp },
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
