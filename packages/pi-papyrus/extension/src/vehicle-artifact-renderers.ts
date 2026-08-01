/**
 * Curated result rendering for Papyrus's own Vehicle-projected operations
 * (notes.*, tasks.*, docs.*, rules.*, playbooks.*, artifact.*): reuses the
 * same ArtifactCard/ArtifactListCard components the pre-Vehicle native tool
 * used, instead of the generic Vehicle renderer's raw full-column table
 * dump -- a human reading a task/note list doesn't need id/subtype/extra/
 * timestamps up front, only title + status, with the rest available on
 * expand. Detection is by output shape, not operation name: every operation
 * registered through this client is one of Papyrus's own artifact domains,
 * so "looks like an Artifact" is a safe, name-independent signal here.
 * Falls back to the generic Vehicle renderer for any other output shape
 * (progress, transitions, gate runs, errors).
 */

import type { Artifact } from "@danypops/papyrus";
import type { VehicleToolRenderers } from "@danypops/vehicle-client-pi";
import { renderVehicleResult } from "@danypops/vehicle-client-pi/vehicle-render";
import type { VehicleOperationDescriptor } from "@danypops/vehicle-core";
import { ArtifactCard } from "./tool-rendering/artifact-card.ts";
import { ArtifactListCard } from "./tool-rendering/artifact-list.ts";
import { createArtifactDetails, createArtifactListDetails } from "./tool-rendering/render-model.ts";

function isArtifact(value: unknown): value is Artifact {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.kind === "string" &&
		typeof row.title === "string" &&
		typeof row.status === "string" &&
		typeof row.subtype === "string" &&
		typeof row.body === "string" &&
		Array.isArray(row.labels) &&
		typeof row.created_at === "string" &&
		typeof row.updated_at === "string"
	);
}

function isArtifactArray(value: unknown): value is Artifact[] {
	return Array.isArray(value) && value.every(isArtifact);
}

export function papyrusVehicleRenderers(descriptor: VehicleOperationDescriptor): VehicleToolRenderers {
	return {
		renderResult(result, options, theme, context) {
			if (!options.isPartial && !context.isError) {
				const output = (result.details as { output?: unknown } | undefined)?.output;
				if (isArtifactArray(output)) {
					return new ArtifactListCard(createArtifactListDetails(descriptor.name, output), theme, options.expanded);
				}
				if (isArtifact(output)) {
					return new ArtifactCard(createArtifactDetails(descriptor.name, output), theme, options.expanded);
				}
			}
			return renderVehicleResult(descriptor, result, options, theme, context);
		},
	};
}
