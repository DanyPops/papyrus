/**
 * render-model/ -- typed, bounded Vehicle-result render details, one file per result-kind
 * (already Strategy-shaped in spirit: one create-and-is-guard pair per kind), split out of the former
 * single 827-line render-model.ts as part of a SOLID-audit-driven decomposition (see Doc
 * "Modularity playbook: building-block-shaped TypeScript modules for papyrus/pi-papyrus" and the
 * "pi-papyrus render-model.ts split" child of "Epic: Modularize papyrus/pi-papyrus god-files into
 * building-block modules"). This file is the one place that assembles every kind into the
 * PapyrusToolDetails union and validates a persisted one back (parsePapyrusToolDetails) -- the
 * "wide internal, narrow public" shape: each sibling module owns one kind's own real complexity,
 * this one only ever needs to know each kind's own type + guard, never re-derive it.
 */
import {
	TOOL_DETAILS_BODY_MAX_CHARACTERS,
	TOOL_DETAILS_MAX_EDGES,
	TOOL_DETAILS_MAX_ITEMS,
	TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS,
} from "@danypops/papyrus";
import type { ArtifactListToolDetails, ArtifactToolDetails, TransitionToolDetails } from "./artifact.ts";
import { type DiscussionToolDetails, isDiscussionRoundSummary } from "./discussion.ts";
import { type ExecutionPlanToolDetails, isExecution, isExecutionPlanNode, isLayers } from "./execution-plan.ts";
import { type GateRunToolDetails, isGateRow } from "./gate-run.ts";
import { type GraphToolDetails, isGraphEdge } from "./graph.ts";
import type { LeaseToolDetails } from "./lease.ts";
import type { ErrorToolDetails, NoFocusToolDetails, PreviewToolDetails } from "./misc.ts";
import type { InvocationToolDetails, PlaybookInvocationToolDetails, PlaybookMissingArgumentsToolDetails } from "./playbook.ts";
import {
	isArtifactSummary,
	isBoundedArray,
	isBoundedString,
	isCompleteness,
	isFocusAnnotation,
	isRecord,
	isStringArray,
	isToolArtifact,
	PAPYRUS_TOOL_DETAILS_SCHEMA,
} from "./shared.ts";
import {
	isTaskBlockageSummary,
	isTaskChecklistReviewSummary,
	isTaskGateResultSummary,
	type TaskCompletionToolDetails,
} from "./task-completion.ts";

export type PapyrusToolDetails =
	| ArtifactToolDetails
	| ArtifactListToolDetails
	| TransitionToolDetails
	| GraphToolDetails
	| GateRunToolDetails
	| InvocationToolDetails
	| PreviewToolDetails
	| ErrorToolDetails
	| ExecutionPlanToolDetails
	| PlaybookInvocationToolDetails
	| PlaybookMissingArgumentsToolDetails
	| DiscussionToolDetails
	| TaskCompletionToolDetails
	| NoFocusToolDetails
	| LeaseToolDetails;

/** Validate renderer details restored from session history before using them as typed presentation state. */
export function parsePapyrusToolDetails(value: unknown): PapyrusToolDetails | undefined {
	let serializedLength: number;
	try {
		serializedLength = JSON.stringify(value).length;
	} catch {
		return undefined;
	}
	if (
		serializedLength > TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS ||
		!isRecord(value) ||
		value.schemaVersion !== PAPYRUS_TOOL_DETAILS_SCHEMA ||
		!isBoundedString(value.operation) ||
		!isBoundedString(value.kind)
	)
		return undefined;

	switch (value.kind) {
		case "artifact":
			return isToolArtifact(value.artifact) &&
				isCompleteness(value.completeness) &&
				(value.focus === undefined || isFocusAnnotation(value.focus))
				? (value as unknown as ArtifactToolDetails)
				: undefined;
		case "artifact-list":
			return isBoundedArray(value.rows, TOOL_DETAILS_MAX_ITEMS, isArtifactSummary) &&
				Number.isSafeInteger(value.total) &&
				Number(value.total) >= value.rows.length &&
				isCompleteness(value.completeness)
				? (value as unknown as ArtifactListToolDetails)
				: undefined;
		case "transition":
			return isArtifactSummary(value.artifact) && isBoundedString(value.fromStatus) && isBoundedString(value.toStatus)
				? (value as unknown as TransitionToolDetails)
				: undefined;
		case "graph":
			return isBoundedArray(value.nodes, TOOL_DETAILS_MAX_ITEMS, isArtifactSummary) &&
				isBoundedArray(value.edges, TOOL_DETAILS_MAX_EDGES, isGraphEdge) &&
				isCompleteness(value.nodeCompleteness) &&
				isCompleteness(value.edgeCompleteness)
				? (value as unknown as GraphToolDetails)
				: undefined;
		case "gate-run":
			return isBoundedString(value.artifactId) &&
				isBoundedString(value.artifactTitle) &&
				isBoundedArray(value.gates, TOOL_DETAILS_MAX_ITEMS, isGateRow) &&
				isCompleteness(value.completeness)
				? (value as unknown as GateRunToolDetails)
				: undefined;
		case "invocation": {
			if (!isRecord(value.created)) return undefined;
			return isBoundedString(value.runId) &&
				isStringArray(value.created.tasks) &&
				isStringArray(value.created.docs) &&
				isStringArray(value.created.rules) &&
				isStringArray(value.created.roots) &&
				isCompleteness(value.completeness)
				? (value as unknown as InvocationToolDetails)
				: undefined;
		}
		case "preview":
			return isBoundedString(value.title) &&
				isBoundedString(value.content, TOOL_DETAILS_BODY_MAX_CHARACTERS) &&
				isCompleteness(value.completeness)
				? (value as unknown as PreviewToolDetails)
				: undefined;
		case "error":
			return isBoundedString(value.code) && isBoundedString(value.message, TOOL_DETAILS_BODY_MAX_CHARACTERS)
				? (value as unknown as ErrorToolDetails)
				: undefined;
		case "execution-plan":
			return isBoundedArray(value.nodes, TOOL_DETAILS_MAX_ITEMS, isExecutionPlanNode) &&
				isLayers(value.layers) &&
				isStringArray(value.cycleIds) &&
				isCompleteness(value.completeness)
				? (value as unknown as ExecutionPlanToolDetails)
				: undefined;
		case "playbook-invocation": {
			if (!isRecord(value.created)) return undefined;
			return isBoundedString(value.playbookId) &&
				isBoundedString(value.runId) &&
				isStringArray(value.created.docs) &&
				isStringArray(value.created.rules) &&
				isStringArray(value.created.tasks) &&
				isStringArray(value.rootTaskIds) &&
				isBoundedString(value.entryTaskId) &&
				isExecution(value.execution) &&
				isCompleteness(value.completeness)
				? (value as unknown as PlaybookInvocationToolDetails)
				: undefined;
		}
		case "playbook-missing-arguments":
			return isBoundedString(value.playbookId) && isStringArray(value.missingArguments)
				? (value as unknown as PlaybookMissingArgumentsToolDetails)
				: undefined;
		case "discussion":
			return (value.discussion === undefined || isArtifactSummary(value.discussion)) &&
				isBoundedArray(value.rounds, TOOL_DETAILS_MAX_ITEMS, isDiscussionRoundSummary) &&
				isCompleteness(value.completeness)
				? (value as unknown as DiscussionToolDetails)
				: undefined;
		case "task-completion":
			return isArtifactSummary(value.artifact) &&
				isBoundedArray(value.gates, TOOL_DETAILS_MAX_ITEMS, isTaskGateResultSummary) &&
				isBoundedArray(value.checklist, TOOL_DETAILS_MAX_ITEMS, isTaskChecklistReviewSummary) &&
				typeof value.completed === "boolean" &&
				(value.focused === undefined || isArtifactSummary(value.focused)) &&
				isBoundedArray(value.blocked, TOOL_DETAILS_MAX_ITEMS, isTaskBlockageSummary) &&
				isCompleteness(value.completeness)
				? (value as unknown as TaskCompletionToolDetails)
				: undefined;
		case "no-focus":
			return value as unknown as NoFocusToolDetails;
		case "lease":
			return isBoundedString(value.taskName) &&
				isBoundedString(value.taskTitle) &&
				isBoundedString(value.owner) &&
				isBoundedString(value.claimedAt) &&
				isBoundedString(value.leaseExpiresAt) &&
				(value.heartbeatAt === undefined || isBoundedString(value.heartbeatAt)) &&
				(value.note === undefined || isBoundedString(value.note))
				? (value as unknown as LeaseToolDetails)
				: undefined;
		default:
			return undefined;
	}
}

export {
	type ArtifactListToolDetails,
	type ArtifactToolDetails,
	createArtifactDetails,
	createArtifactListDetails,
	createTransitionDetails,
	type TransitionToolDetails,
} from "./artifact.ts";
export { createDiscussionDetails, type DiscussionRoundSummary, type DiscussionToolDetails } from "./discussion.ts";
export { createExecutionPlanDetails, type ExecutionPlanNode, type ExecutionPlanToolDetails } from "./execution-plan.ts";
export { createGateRunDetails, type GateRunToolDetails, type ToolGateRow } from "./gate-run.ts";
export { createGraphDetails, type GraphToolDetails, type ToolGraphEdge } from "./graph.ts";
export { createLeaseDetails, type LeaseToolDetails } from "./lease.ts";
export {
	createErrorDetails,
	createNoFocusDetails,
	createPreviewDetails,
	type ErrorToolDetails,
	type NoFocusToolDetails,
	type PreviewToolDetails,
} from "./misc.ts";
export {
	createInvocationDetails,
	createPlaybookInvocationDetails,
	createPlaybookMissingArgumentsDetails,
	type InvocationToolDetails,
	type PlaybookInvocationCreated,
	type PlaybookInvocationToolDetails,
	type PlaybookMissingArgumentsToolDetails,
	type ToolInvocationCreated,
} from "./playbook.ts";
export {
	type ArtifactFocusAnnotation,
	createModelContent,
	type ModelContent,
	PAPYRUS_TOOL_DETAILS_SCHEMA,
	type ResultCompleteness,
	type ToolArtifact,
	type ToolArtifactSummary,
} from "./shared.ts";
export {
	createTaskCompletionDetails,
	type TaskBlockageSummary,
	type TaskChecklistReviewSummary,
	type TaskCompletionToolDetails,
	type TaskGateResultSummary,
} from "./task-completion.ts";
