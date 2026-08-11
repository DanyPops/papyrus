import { type Artifact, TOOL_DETAILS_BODY_MAX_CHARACTERS, TOOL_DETAILS_MAX_ITEMS } from "@danypops/papyrus";
import {
	type ArtifactFocusAnnotation,
	artifactSummary,
	boundedText,
	completeness,
	PAPYRUS_TOOL_DETAILS_SCHEMA,
	type ResultCompleteness,
	type ToolArtifact,
	type ToolArtifactSummary,
	type ToolDetailsBase,
} from "./shared.ts";

export interface ArtifactToolDetails extends ToolDetailsBase {
	kind: "artifact";
	artifact: ToolArtifact;
	completeness: ResultCompleteness;
	focus?: ArtifactFocusAnnotation;
}

export interface ArtifactListToolDetails extends ToolDetailsBase {
	kind: "artifact-list";
	rows: ToolArtifactSummary[];
	total: number;
	completeness: ResultCompleteness;
}

export interface TransitionToolDetails extends ToolDetailsBase {
	kind: "transition";
	artifact: ToolArtifactSummary;
	fromStatus: string;
	toStatus: string;
}

export function createArtifactDetails(operation: string, artifact: Artifact, focus?: ArtifactFocusAnnotation): ArtifactToolDetails {
	const body = boundedText(artifact.body, TOOL_DETAILS_BODY_MAX_CHARACTERS);
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "artifact",
		operation,
		artifact: {
			...artifactSummary(artifact),
			body: body.value,
			createdAt: artifact.created_at,
			updatedAt: artifact.updated_at,
		},
		completeness: body.completeness,
		...(focus ? { focus } : {}),
	};
}

export function createArtifactListDetails(
	operation: string,
	artifacts: readonly Artifact[],
	total = artifacts.length,
): ArtifactListToolDetails {
	const rows = artifacts.slice(0, TOOL_DETAILS_MAX_ITEMS).map(artifactSummary);
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "artifact-list",
		operation,
		rows,
		total,
		completeness: completeness(Math.max(total, artifacts.length), rows.length),
	};
}

export function createTransitionDetails(
	operation: string,
	artifact: Artifact,
	fromStatus: string,
	toStatus: string,
): TransitionToolDetails {
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "transition",
		operation,
		artifact: artifactSummary(artifact),
		fromStatus,
		toStatus,
	};
}
