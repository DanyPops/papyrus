/**
 * artifact.* -- show/remove/remove_subtree/restore, identical regardless of an
 * artifact's kind. Registered once here, shared by every domain, instead of
 * duplicated as rules.remove/docs.remove/etc.
 */
import { bindVehicleOperation, defineVehicleOperation } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { removeArtifactSubtree } from "../artifact/artifact-subtree.ts";
import type { ArtifactTrashStore } from "../artifact/artifact-trash-store.ts";
import { looseObjectSchema, numberProp, passthroughOutput, stringProp, validationError } from "./shared.ts";

const OWNER = "artifact";
const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };

function eventContext(input: Record<string, unknown>): { actor?: string; source?: string; sessionId?: string } {
	const actor = input.actor;
	const source = input.source;
	const sessionId = input.session_id ?? input.sessionId;
	return {
		actor: typeof actor === "string" ? actor : undefined,
		source: typeof source === "string" ? source : undefined,
		sessionId: typeof sessionId === "string" ? sessionId : undefined,
	};
}

function requireId(input: Record<string, unknown>): string {
	const id = input.id;
	if (typeof id !== "string" || id.length === 0) throw validationError("id is required");
	return id;
}

export function registerArtifactTrashOperations(registry: VehicleRegistry, artifacts: ArtifactStore & ArtifactTrashStore): void {
	const define = (
		action: string,
		description: string,
		effect: "read" | "local-write" | "destructive",
		properties: Record<string, { type: string; enum?: readonly string[] }>,
		required: readonly string[],
		execute: (input: Record<string, unknown>) => unknown,
	): void => {
		const operation = defineVehicleOperation({
			name: `artifact.${action}`,
			version: 1,
			description,
			input: looseObjectSchema(properties, required),
			output: passthroughOutput,
			permissions: ["artifact:read", "artifact:write"],
			effect,
			idempotency: { mode: effect === "read" ? "safe" : "unsafe" },
			limits: LIMITS,
		});
		registry.register(
			OWNER,
			bindVehicleOperation(operation, () => async (context) => execute(context.input)),
		);
	};

	define(
		"show",
		"Shows any artifact (doc, task, rule, playbook) by id, regardless of kind.",
		"read",
		{ id: stringProp, tree: { type: "boolean" } as unknown as { type: string }, depth: numberProp, max_nodes: numberProp },
		["id"],
		(input) =>
			artifacts.get(requireId(input), {
				tree: input.tree === true,
				depth: typeof input.depth === "number" ? input.depth : undefined,
				maxNodes: typeof input.max_nodes === "number" ? input.max_nodes : undefined,
			}),
	);

	define(
		"remove",
		"Moves any artifact to a time-gated trash, excluded from list/query but still directly showable, restorable via artifact.restore until the purge deadline.",
		"local-write",
		{ id: stringProp, reason: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		["id"],
		(input) =>
			artifacts.trash(requireId(input), {
				reason: typeof input.reason === "string" ? input.reason : undefined,
				context: eventContext(input),
			}),
	);

	define(
		"remove_subtree",
		"Trashes an artifact and its whole `contains` subtree in one call, skipping already-trashed nodes.",
		"local-write",
		{ id: stringProp, reason: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		["id"],
		(input) =>
			removeArtifactSubtree(artifacts, requireId(input), {
				reason: typeof input.reason === "string" ? input.reason : undefined,
				context: eventContext(input),
			}),
	);

	define(
		"restore",
		"Restores a trashed artifact. Idempotent: restoring one that isn't trashed is a real no-op, not an error.",
		"local-write",
		{ id: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		["id"],
		(input) => artifacts.restore(requireId(input), eventContext(input)),
	);
}
