/**
 * Shared schema helpers and name->id resolution for every per-domain
 * VehicleRegistry projection (notes-vehicle.ts, rules-vehicle.ts, docs-vehicle.ts,
 * artifact-trash-vehicle.ts).
 */
import { defineVehicleSchema, type VehicleSchemaCodec } from "@danypops/vehicle-core";
import type { Artifact } from "../domain/artifact.ts";

/**
 * VehicleRegistry only ever calls a schema's own safeParse -- jsonSchema is
 * descriptive metadata surfaced to a client/Pi projection, never itself
 * enforced at runtime -- so a declared `enum` has to be checked here for
 * real, or it's a documentation gesture, not an honest contract.
 */
export function looseObjectSchema(properties: Record<string, { type: string; enum?: readonly string[] }>, required: readonly string[] = []): VehicleSchemaCodec<Record<string, unknown>> {
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

export const passthroughOutput: VehicleSchemaCodec<unknown> = defineVehicleSchema<unknown>({
	jsonSchema: { type: "object" },
	safeParse: (value) => ({ success: true, value }),
});

export const stringProp = { type: "string" } as const;
export const numberProp = { type: "number" } as const;

/** Exact match semantics as the Pi-extension helper this replaces (domain-tools.ts's matchArtifactByName) -- case-insensitive exact title match, refuses to guess between ambiguous matches. */
export function matchArtifactByName(candidates: readonly Artifact[], name: string): string {
	const needle = name.trim().toLowerCase();
	const matches = candidates.filter((artifact) => artifact.title.trim().toLowerCase() === needle);
	if (matches.length === 0) throw new Error(`no artifact named "${name}" found in this scope`);
	if (matches.length > 1) {
		throw new Error(`${matches.length} artifacts are named "${name}": ${matches.map((a) => `${a.title} (${a.id})`).join(", ")} -- use id to disambiguate`);
	}
	return matches[0]!.id;
}

/**
 * Resolves a name to an id, retrying against `fetchWidened` (an unscoped/cross-project
 * search) only when `fetchCandidates` finds nothing. Owns the match-or-widen control
 * flow only -- the caller supplies its own scoped/widened list calls, since scoping
 * differs per domain. Omit `fetchWidened` when there is no wider scope to retry.
 */
export function resolveArtifactIdWidened(name: string, fetchCandidates: () => readonly Artifact[], fetchWidened?: () => readonly Artifact[]): string {
	try {
		return matchArtifactByName(fetchCandidates(), name);
	} catch (error) {
		if (!(error instanceof Error) || !error.message.startsWith("no artifact named") || !fetchWidened) throw error;
		return matchArtifactByName(fetchWidened(), name);
	}
}
