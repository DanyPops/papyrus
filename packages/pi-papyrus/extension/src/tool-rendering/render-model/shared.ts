/**
 * Base kernel shared by every render-model/*.ts result-kind module: the schema-version marker,
 * the common completeness/bounding primitives, and the base validators nearly every kind's own
 * parse case reuses. Split out of the former single render-model.ts as part of a SOLID-audit-
 * driven decomposition (see Doc "Modularity playbook: building-block-shaped TypeScript modules
 * for papyrus/pi-papyrus" and the "pi-papyrus render-model.ts split" child of "Epic: Modularize
 * papyrus/pi-papyrus god-files into building-block modules").
 */
import {
	type Artifact,
	TOOL_DETAILS_BODY_MAX_CHARACTERS,
	TOOL_DETAILS_FIELD_MAX_CHARACTERS,
	TOOL_DETAILS_MAX_ITEMS,
	TOOL_MODEL_CONTENT_MAX_CHARACTERS,
} from "@danypops/papyrus";

export const PAPYRUS_TOOL_DETAILS_SCHEMA = "papyrus.tool-details/v1" as const;

export interface ResultCompleteness {
	truncated: boolean;
	omitted: number;
}

export interface ToolArtifactSummary {
	id: string;
	/** Optional only for a detail object persisted before this field existed -- ArtifactCard falls back to id when absent. */
	alias?: string;
	kind: string;
	title: string;
	status: string;
	subtype: string;
	labels: string[];
}

export interface ToolArtifact extends ToolArtifactSummary {
	body: string;
	createdAt: string;
	updatedAt: string;
}

export interface ToolDetailsBase {
	schemaVersion: typeof PAPYRUS_TOOL_DETAILS_SCHEMA;
	operation: string;
	kind: string;
}

/** Distinct from the artifact's own lifecycle status (todo/in-progress/done/...) --
 * this is Task Focus's own separate active/paused dimension, carried by
 * tasks.focused/tasks.pause/tasks.unpause's {artifact, status, updatedAt}
 * wrapper shape. Never conflate the two: an artifact can be "in-progress"
 * while its focus is "paused". */
export interface ArtifactFocusAnnotation {
	status: string;
	updatedAt: string;
	pauseReason?: string;
}

export interface ModelContent {
	text: string;
	truncated: boolean;
	omitted: number;
}

export function completeness(total: number, returned: number): ResultCompleteness {
	const omitted = Math.max(0, total - returned);
	return { truncated: omitted > 0, omitted };
}

export function boundedText(value: string, maximum: number): { value: string; completeness: ResultCompleteness } {
	const clipped = value.slice(0, maximum);
	return { value: clipped, completeness: completeness(value.length, clipped.length) };
}

export type ArtifactSummarySource = Pick<Artifact, "id" | "kind" | "title" | "status" | "subtype" | "labels"> & { alias?: string };

export function artifactSummary(artifact: ArtifactSummarySource): ToolArtifactSummary {
	return {
		id: artifact.id,
		alias: artifact.alias,
		kind: artifact.kind,
		title: artifact.title,
		status: artifact.status,
		subtype: artifact.subtype,
		labels: artifact.labels.slice(0, TOOL_DETAILS_MAX_ITEMS),
	};
}

export function boundedStringArray(values: readonly string[]): string[] {
	return values.slice(0, TOOL_DETAILS_MAX_ITEMS);
}

export function createModelContent(value: string): ModelContent {
	if (value.length <= TOOL_MODEL_CONTENT_MAX_CHARACTERS) {
		return { text: value, truncated: false, omitted: 0 };
	}
	let omitted = value.length - TOOL_MODEL_CONTENT_MAX_CHARACTERS;
	let marker = "";
	let kept = 0;
	for (let iteration = 0; iteration < 5; iteration += 1) {
		const nextMarker = `\n[truncated ${omitted} characters]`;
		const nextKept = Math.max(0, TOOL_MODEL_CONTENT_MAX_CHARACTERS - nextMarker.length);
		const nextOmitted = value.length - nextKept;
		marker = nextMarker;
		kept = nextKept;
		if (nextOmitted === omitted) break;
		omitted = nextOmitted;
	}
	return { text: `${value.slice(0, kept)}${marker}`, truncated: true, omitted: value.length - kept };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBoundedString(value: unknown, maximum = TOOL_DETAILS_FIELD_MAX_CHARACTERS): value is string {
	return typeof value === "string" && value.length <= maximum;
}

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= TOOL_DETAILS_MAX_ITEMS && value.every((item) => isBoundedString(item));
}

export function isCompleteness(value: unknown): value is ResultCompleteness {
	return isRecord(value) && typeof value.truncated === "boolean" && Number.isSafeInteger(value.omitted) && Number(value.omitted) >= 0;
}

export function isArtifactSummary(value: unknown): value is ToolArtifactSummary {
	return (
		isRecord(value) &&
		isBoundedString(value.id) &&
		isBoundedString(value.kind) &&
		isBoundedString(value.title) &&
		isBoundedString(value.status) &&
		isBoundedString(value.subtype) &&
		isStringArray(value.labels)
	);
}

export function isToolArtifact(value: unknown): value is ToolArtifact {
	if (!isRecord(value)) return false;
	const body = value.body;
	const createdAt = value.createdAt;
	const updatedAt = value.updatedAt;
	return (
		isArtifactSummary(value) &&
		isBoundedString(body, TOOL_DETAILS_BODY_MAX_CHARACTERS) &&
		isBoundedString(createdAt) &&
		isBoundedString(updatedAt)
	);
}

export function isFocusAnnotation(value: unknown): value is ArtifactFocusAnnotation {
	return (
		isRecord(value) &&
		isBoundedString(value.status) &&
		isBoundedString(value.updatedAt) &&
		(value.pauseReason === undefined || isBoundedString(value.pauseReason))
	);
}

export function isBoundedArray<T>(value: unknown, maximum: number, predicate: (entry: unknown) => entry is T): value is T[] {
	return Array.isArray(value) && value.length <= maximum && value.every(predicate);
}
