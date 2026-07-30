/**
 * Notes projected as a real VehicleRegistry: one VehicleOperation per real
 * action (capture/list/show/history/consume/promote/archive), each with its
 * own honest effect and narrow schema -- replacing pi-papyrus's hand-rolled
 * `notes(action=X)` mega-tool (unconstrained `action: Type.String()`, 14
 * fields unioned across all 7 branches, the "God Parameters"/"Kitchen Sink
 * tool" anti-pattern @danypops/vehicle's own README documents).
 *
 * Wraps modules/notes.ts's existing operation definitions rather than
 * reimplementing their input parsing -- this is a projection/contract layer
 * on top of the existing domain logic, not a second copy of it. Adds the
 * one thing those definitions don't do: resolving a human-readable
 * `name`/`target_name` to the `id`/`target_id` the domain logic actually
 * needs, server-side in the same call. The Pi-extension-side
 * `resolveNameFields` helper it replaces needed a separate round trip per
 * name before the real call; this does it in one.
 */
import { defineVehicleOperation, defineVehicleSchema, bindVehicleOperation, type VehicleSchemaCodec } from "@danypops/vehicle-core";
import { VehicleRegistry } from "@danypops/vehicle-server";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import { Notes, NOTE_DISPOSITIONS } from "../note-service.ts";
import type { Artifact } from "../domain/artifact.ts";
import { notesOperations } from "../modules/notes.ts";

const OWNER = "notes";

const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };

/**
 * VehicleRegistry only ever calls a schema's own safeParse -- jsonSchema is
 * descriptive metadata surfaced to a client/Pi projection, never itself
 * enforced at runtime -- so a declared `enum` has to be checked here for
 * real, or it's a documentation gesture, not an honest contract.
 */
function looseObjectSchema(properties: Record<string, { type: string; enum?: readonly string[] }>, required: readonly string[] = []): VehicleSchemaCodec<Record<string, unknown>> {
	return defineVehicleSchema<Record<string, unknown>>({
		jsonSchema: { type: "object", properties, required: [...required], additionalProperties: false },
		safeParse(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return { success: false, issues: [{ path: [], message: "input must be an object" }] };
			}
			const input = value as Record<string, unknown>;
			for (const key of required) {
				if (!(key in input)) return { success: false, issues: [{ path: [key], message: `${key} is required` }] };
			}
			for (const [key, schema] of Object.entries(properties)) {
				if (!schema.enum || !(key in input)) continue;
				if (!schema.enum.includes(input[key] as string)) {
					return { success: false, issues: [{ path: [key], message: `${key} must be one of ${schema.enum.join(", ")}` }] };
				}
			}
			return { success: true, value: input };
		},
	});
}

const passthroughOutput = defineVehicleSchema<unknown>({
	jsonSchema: { type: "object" },
	safeParse: (value) => ({ success: true, value }),
});

/** Exact match semantics as the Pi-extension helper it replaces (domain-tools.ts's matchArtifactByName) -- case-insensitive exact title match, refuses to guess between ambiguous matches. */
function matchArtifactByName(candidates: readonly Artifact[], name: string): string {
	const needle = name.trim().toLowerCase();
	const matches = candidates.filter((artifact) => artifact.title.trim().toLowerCase() === needle);
	if (matches.length === 0) throw new Error(`no artifact named "${name}" found in this scope`);
	if (matches.length > 1) {
		throw new Error(`${matches.length} artifacts are named "${name}": ${matches.map((a) => `${a.title} (${a.id})`).join(", ")} -- use id to disambiguate`);
	}
	return matches[0]!.id;
}

/** Resolves a note's id from either an explicit id or its title within projectRoot. */
function resolveNoteId(notes: Notes, projectRoot: string, id: unknown, name: unknown): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw new Error("id or name is required");
	return matchArtifactByName(notes.list({ projectRoot, text: name }), name);
}

/** Cross-kind equivalent for a promotion target -- a target can be a task, doc, rule, or skill, not just a note. Unscoped by project, matching the exact behavior of the artifact.query-backed resolution it replaces. */
function resolveArtifactId(artifacts: ArtifactStore, id: unknown, name: unknown): string {
	if (typeof id === "string" && id.length > 0) return id;
	if (typeof name !== "string" || name.length === 0) throw new Error("target_id or target_name is required");
	return matchArtifactByName(artifacts.query({ text: name }), name);
}

/**
 * Builds a VehicleRegistry exposing every notes.* action as its own honest
 * operation. `artifacts` is only needed for promote's cross-kind
 * target_name resolution -- every other operation only ever touches notes
 * themselves via `notes`.
 */
export function createNotesVehicleRegistry(notes: Notes, artifacts: ArtifactStore): VehicleRegistry {
	const registry = new VehicleRegistry({ name: "papyrus-notes", version: "1.0.0", description: "Papyrus's deferred human-intent inbox." });
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

	const stringProp = { type: "string" } as const;
	const numberProp = { type: "number" } as const;

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
		"Links a note to the Task, Doc, Rule, or Skill it was promoted into, then archives it.",
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

	return registry;
}
