/**
 * Notes projected as a real VehicleRegistry: one VehicleOperation per real action
 * (capture/list/show/history/consume/promote/archive), each with its own effect
 * and narrow schema, instead of one `action: Type.String()` dispatch tool.
 *
 * Wraps modules/notes.ts's operation definitions rather than reimplementing their
 * input parsing. Resolves `name`/`target_name` to `id`/`target_id` server-side, in
 * the same call -- avoids a separate round trip per name before the real call.
 */
import { defineVehicleOperation, bindVehicleOperation } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import { Notes, NOTE_DISPOSITIONS } from "../note-service.ts";
import { notesOperations } from "../modules/notes.ts";
import { looseObjectSchema, numberProp, passthroughOutput, resolveArtifactIdWidened, stringProp } from "./artifact-vehicle-shared.ts";

const OWNER = "notes";

const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };

/** Resolves a note's id from either an explicit id or its title within projectRoot. */
function resolveNoteId(notes: Notes, projectRoot: string, id: unknown, name: unknown): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw new Error("id or name is required");
	return resolveArtifactIdWidened(name, () => notes.list({ projectRoot, text: name }));
}

/** Cross-kind equivalent for a promotion target -- a target can be a task, doc, rule, or playbook, not just a note. Unscoped by project, matching the exact behavior of the artifact.query-backed resolution it replaces. */
function resolveArtifactId(artifacts: ArtifactStore, id: unknown, name: unknown): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw new Error("target_id or target_name is required");
	return resolveArtifactIdWidened(name, () => artifacts.query({ text: name }));
}

/**
 * Registers every notes.* action as its own honest VehicleOperation onto an
 * existing registry (see ./papyrus-vehicle.ts for the composition root that
 * merges every domain's operations into one registry/one HTTP mount).
 * `artifacts` is only needed for promote's cross-kind target_name
 * resolution -- every other operation only ever touches notes themselves
 * via `notes`.
 */
export function registerNotesVehicleOperations(registry: VehicleRegistry, notes: Notes, artifacts: ArtifactStore): void {
	const moduleOperations = new Map(notesOperations(notes).map((op) => [op.name, op]));
	const call = (name: string, input: Record<string, unknown>): unknown => moduleOperations.get(name)!.execute(input);

	const define = (
		action: string,
		description: string,
		effect: "read" | "local-write",
		properties: Record<string, { type: string; enum?: readonly string[] }>,
		required: readonly string[],
		resolve: (input: Record<string, unknown>) => Record<string, unknown>,
	): void => {
		const operation = defineVehicleOperation({
			name: `notes.${action}`,
			version: 1,
			description,
			input: looseObjectSchema(properties, required),
			output: passthroughOutput,
			permissions: ["notes:read", "notes:write"],
			effect,
			idempotency: { mode: effect === "read" ? "safe" : "unsafe" },
			limits: LIMITS,
		});
		registry.register(OWNER, bindVehicleOperation(operation, () => async (context) => call(`notes.${action}`, resolve(context.input))));
	};

	define(
		"capture",
		"Stores a deferred request without creating work. Returns the created note.",
		"local-write",
		{ body: stringProp, title: stringProp, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp },
		["body", "project_root"],
		(input) => input,
	);

	define(
		"list",
		"Lists open (draft/active) notes, or a specific status, in a project.",
		"read",
		{ project_root: stringProp, status: { type: "string", enum: ["draft", "active", "archived"] }, text: stringProp, limit: numberProp },
		["project_root"],
		(input) => input,
	);

	define(
		"show",
		"Shows one note by id or title.",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp },
		["project_root"],
		(input) => ({ ...input, id: resolveNoteId(notes, input.project_root as string, input.id, input.name) }),
	);

	define(
		"history",
		"This note's own real append-only event log (captured/consumed/promoted/archived).",
		"read",
		{ id: stringProp, name: stringProp, project_root: stringProp, limit: numberProp, cursor: numberProp, direction: { type: "string", enum: ["asc", "desc"] } },
		["project_root"],
		(input) => ({ ...input, id: resolveNoteId(notes, input.project_root as string, input.id, input.name) }),
	);

	define(
		"consume",
		"Marks a note as considered.",
		"local-write",
		{ id: stringProp, name: stringProp, project_root: stringProp, actor: stringProp, source: stringProp, session_id: stringProp, reason: stringProp },
		["project_root"],
		(input) => ({ ...input, id: resolveNoteId(notes, input.project_root as string, input.id, input.name) }),
	);

	define(
		"promote",
		"Links a note to the Task, Doc, Rule, or Playbook it was promoted into, then archives it.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			target_id: stringProp,
			target_name: stringProp,
			project_root: stringProp,
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
			reason: stringProp,
		},
		["project_root"],
		(input) => ({
			...input,
			id: resolveNoteId(notes, input.project_root as string, input.id, input.name),
			target_id: resolveArtifactId(artifacts, input.target_id, input.target_name),
		}),
	);

	define(
		"archive",
		"Archives a note with an explicit disposition.",
		"local-write",
		{
			id: stringProp,
			name: stringProp,
			project_root: stringProp,
			disposition: { type: "string", enum: [...NOTE_DISPOSITIONS] },
			actor: stringProp,
			source: stringProp,
			session_id: stringProp,
			reason: stringProp,
		},
		["project_root", "disposition"],
		(input) => ({ ...input, id: resolveNoteId(notes, input.project_root as string, input.id, input.name) }),
	);
}
