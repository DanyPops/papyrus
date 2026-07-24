import {
	TOOL_DETAILS_BODY_MAX_CHARACTERS,
	TOOL_DETAILS_FIELD_MAX_CHARACTERS,
	TOOL_DETAILS_MAX_EDGES,
	TOOL_DETAILS_MAX_ITEMS,
	TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS,
	TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS,
	TOOL_MODEL_CONTENT_MAX_CHARACTERS,
} from "../../../src/constants.ts";
import type { Artifact } from "../../../src/domain/artifact.ts";

export const PAPYRUS_TOOL_DETAILS_SCHEMA = "papyrus.tool-details/v1" as const;

export interface ResultCompleteness {
	truncated: boolean;
	omitted: number;
}

export interface ToolArtifactSummary {
	id: string;
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

interface ToolDetailsBase {
	schemaVersion: typeof PAPYRUS_TOOL_DETAILS_SCHEMA;
	operation: string;
	kind: string;
}

export interface ArtifactToolDetails extends ToolDetailsBase {
	kind: "artifact";
	artifact: ToolArtifact;
	completeness: ResultCompleteness;
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

export interface ToolGraphEdge {
	from: string;
	relation: string;
	to: string;
}

export interface GraphToolDetails extends ToolDetailsBase {
	kind: "graph";
	nodes: ToolArtifactSummary[];
	edges: ToolGraphEdge[];
	nodeCompleteness: ResultCompleteness;
	edgeCompleteness: ResultCompleteness;
}

export interface ToolGateRow {
	passed: boolean;
	type: string;
	target: string;
	output: string;
}

export interface GateRunToolDetails extends ToolDetailsBase {
	kind: "gate-run";
	artifactId: string;
	artifactTitle: string;
	gates: ToolGateRow[];
	completeness: ResultCompleteness;
}

export interface ToolInvocationCreated {
	tasks: string[];
	docs: string[];
	rules: string[];
	roots: string[];
}

export interface InvocationToolDetails extends ToolDetailsBase {
	kind: "invocation";
	runId: string;
	created: ToolInvocationCreated;
	completeness: ResultCompleteness;
}

export interface PreviewToolDetails extends ToolDetailsBase {
	kind: "preview";
	title: string;
	content: string;
	completeness: ResultCompleteness;
}

export interface ErrorToolDetails extends ToolDetailsBase {
	kind: "error";
	code: string;
	message: string;
}

export type PapyrusToolDetails =
	| ArtifactToolDetails
	| ArtifactListToolDetails
	| TransitionToolDetails
	| GraphToolDetails
	| GateRunToolDetails
	| InvocationToolDetails
	| PreviewToolDetails
	| ErrorToolDetails;

export interface ModelContent {
	text: string;
	truncated: boolean;
	omitted: number;
}

function completeness(total: number, returned: number): ResultCompleteness {
	const omitted = Math.max(0, total - returned);
	return { truncated: omitted > 0, omitted };
}

function boundedText(value: string, maximum: number): { value: string; completeness: ResultCompleteness } {
	const clipped = value.slice(0, maximum);
	return { value: clipped, completeness: completeness(value.length, clipped.length) };
}

function artifactSummary(artifact: Artifact): ToolArtifactSummary {
	return {
		id: artifact.id,
		kind: artifact.kind,
		title: artifact.title,
		status: artifact.status,
		subtype: artifact.subtype,
		labels: artifact.labels.slice(0, TOOL_DETAILS_MAX_ITEMS),
	};
}

export function createArtifactDetails(operation: string, artifact: Artifact): ArtifactToolDetails {
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

export function createGraphDetails(
	operation: string,
	artifacts: readonly Artifact[],
	edges: readonly ToolGraphEdge[],
): GraphToolDetails {
	const nodes = artifacts.slice(0, TOOL_DETAILS_MAX_ITEMS).map(artifactSummary);
	const boundedEdges = edges.slice(0, TOOL_DETAILS_MAX_EDGES).map((edge) => ({ ...edge }));
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "graph",
		operation,
		nodes,
		edges: boundedEdges,
		nodeCompleteness: completeness(artifacts.length, nodes.length),
		edgeCompleteness: completeness(edges.length, boundedEdges.length),
	};
}

export function createGateRunDetails(
	operation: string,
	artifactId: string,
	artifactTitle: string,
	gates: readonly ToolGateRow[],
): GateRunToolDetails {
	const boundedGates = gates.slice(0, TOOL_DETAILS_MAX_ITEMS).map((gate) => ({
		...gate,
		output: gate.output.slice(0, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS),
	}));
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "gate-run",
		operation,
		artifactId,
		artifactTitle,
		gates: boundedGates,
		completeness: completeness(gates.length, boundedGates.length),
	};
}

export function createInvocationDetails(
	operation: string,
	runId: string,
	created: ToolInvocationCreated,
): InvocationToolDetails {
	const bounded: ToolInvocationCreated = {
		tasks: created.tasks.slice(0, TOOL_DETAILS_MAX_ITEMS),
		docs: created.docs.slice(0, TOOL_DETAILS_MAX_ITEMS),
		rules: created.rules.slice(0, TOOL_DETAILS_MAX_ITEMS),
		roots: created.roots.slice(0, TOOL_DETAILS_MAX_ITEMS),
	};
	const total = created.tasks.length + created.docs.length + created.rules.length + created.roots.length;
	const returned = bounded.tasks.length + bounded.docs.length + bounded.rules.length + bounded.roots.length;
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "invocation",
		operation,
		runId,
		created: bounded,
		completeness: completeness(total, returned),
	};
}

export function createPreviewDetails(operation: string, title: string, content: string): PreviewToolDetails {
	const bounded = boundedText(content, TOOL_DETAILS_BODY_MAX_CHARACTERS);
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "preview",
		operation,
		title,
		content: bounded.value,
		completeness: bounded.completeness,
	};
}

export function createErrorDetails(operation: string, code: string, message: string): ErrorToolDetails {
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "error",
		operation,
		code: code.slice(0, TOOL_DETAILS_FIELD_MAX_CHARACTERS),
		message: message.slice(0, TOOL_DETAILS_BODY_MAX_CHARACTERS),
	};
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maximum = TOOL_DETAILS_FIELD_MAX_CHARACTERS): value is string {
	return typeof value === "string" && value.length <= maximum;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= TOOL_DETAILS_MAX_ITEMS && value.every((item) => isBoundedString(item));
}

function isCompleteness(value: unknown): value is ResultCompleteness {
	return isRecord(value) && typeof value.truncated === "boolean" && Number.isSafeInteger(value.omitted) && Number(value.omitted) >= 0;
}

function isArtifactSummary(value: unknown): value is ToolArtifactSummary {
	return isRecord(value)
		&& isBoundedString(value.id)
		&& isBoundedString(value.kind)
		&& isBoundedString(value.title)
		&& isBoundedString(value.status)
		&& isBoundedString(value.subtype)
		&& isStringArray(value.labels);
}

function isToolArtifact(value: unknown): value is ToolArtifact {
	if (!isRecord(value)) return false;
	const body = value.body;
	const createdAt = value.createdAt;
	const updatedAt = value.updatedAt;
	return isArtifactSummary(value)
		&& isBoundedString(body, TOOL_DETAILS_BODY_MAX_CHARACTERS)
		&& isBoundedString(createdAt)
		&& isBoundedString(updatedAt);
}

function isGraphEdge(value: unknown): value is ToolGraphEdge {
	return isRecord(value) && isBoundedString(value.from) && isBoundedString(value.relation) && isBoundedString(value.to);
}

function isGateRow(value: unknown): value is ToolGateRow {
	return isRecord(value)
		&& typeof value.passed === "boolean"
		&& isBoundedString(value.type)
		&& isBoundedString(value.target)
		&& isBoundedString(value.output, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS);
}

function isBoundedArray<T>(value: unknown, maximum: number, predicate: (entry: unknown) => entry is T): value is T[] {
	return Array.isArray(value) && value.length <= maximum && value.every(predicate);
}

/** Validate renderer details restored from session history before using them as typed presentation state. */
export function parsePapyrusToolDetails(value: unknown): PapyrusToolDetails | undefined {
	let serializedLength: number;
	try {
		serializedLength = JSON.stringify(value).length;
	} catch {
		return undefined;
	}
	if (serializedLength > TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS || !isRecord(value)
		|| value.schemaVersion !== PAPYRUS_TOOL_DETAILS_SCHEMA
		|| !isBoundedString(value.operation)
		|| !isBoundedString(value.kind)) return undefined;

	switch (value.kind) {
		case "artifact":
			return isToolArtifact(value.artifact) && isCompleteness(value.completeness)
				? value as unknown as ArtifactToolDetails : undefined;
		case "artifact-list":
			return isBoundedArray(value.rows, TOOL_DETAILS_MAX_ITEMS, isArtifactSummary)
				&& Number.isSafeInteger(value.total) && Number(value.total) >= value.rows.length
				&& isCompleteness(value.completeness)
				? value as unknown as ArtifactListToolDetails : undefined;
		case "transition":
			return isArtifactSummary(value.artifact) && isBoundedString(value.fromStatus) && isBoundedString(value.toStatus)
				? value as unknown as TransitionToolDetails : undefined;
		case "graph":
			return isBoundedArray(value.nodes, TOOL_DETAILS_MAX_ITEMS, isArtifactSummary)
				&& isBoundedArray(value.edges, TOOL_DETAILS_MAX_EDGES, isGraphEdge)
				&& isCompleteness(value.nodeCompleteness) && isCompleteness(value.edgeCompleteness)
				? value as unknown as GraphToolDetails : undefined;
		case "gate-run":
			return isBoundedString(value.artifactId)
				&& isBoundedString(value.artifactTitle)
				&& isBoundedArray(value.gates, TOOL_DETAILS_MAX_ITEMS, isGateRow)
				&& isCompleteness(value.completeness)
				? value as unknown as GateRunToolDetails : undefined;
		case "invocation": {
			if (!isRecord(value.created)) return undefined;
			return isBoundedString(value.runId)
				&& isStringArray(value.created.tasks) && isStringArray(value.created.docs)
				&& isStringArray(value.created.rules) && isStringArray(value.created.roots)
				&& isCompleteness(value.completeness)
				? value as unknown as InvocationToolDetails : undefined;
		}
		case "preview":
			return isBoundedString(value.title) && isBoundedString(value.content, TOOL_DETAILS_BODY_MAX_CHARACTERS) && isCompleteness(value.completeness)
				? value as unknown as PreviewToolDetails : undefined;
		case "error":
			return isBoundedString(value.code) && isBoundedString(value.message, TOOL_DETAILS_BODY_MAX_CHARACTERS)
				? value as unknown as ErrorToolDetails : undefined;
		default:
			return undefined;
	}
}
