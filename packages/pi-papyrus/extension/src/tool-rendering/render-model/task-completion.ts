import { type Artifact, TOOL_DETAILS_MAX_ITEMS, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS } from "@danypops/papyrus";
import {
	artifactSummary,
	boundedStringArray,
	completeness,
	isArtifactSummary,
	isBoundedString,
	isRecord,
	isStringArray,
	PAPYRUS_TOOL_DETAILS_SCHEMA,
	type ResultCompleteness,
	type ToolArtifactSummary,
	type ToolDetailsBase,
} from "./shared.ts";

export interface TaskGateResultSummary {
	passed: boolean;
	output: string;
}

export interface TaskChecklistReviewSummary {
	item: string;
	accepted: boolean;
	reason?: string;
}

export interface TaskBlockageSummary {
	artifact: ToolArtifactSummary;
	dependencyIds: string[];
}

export interface TaskCompletionToolDetails extends ToolDetailsBase {
	kind: "task-completion";
	artifact: ToolArtifactSummary;
	gates: TaskGateResultSummary[];
	checklist: TaskChecklistReviewSummary[];
	completed: boolean;
	focused?: ToolArtifactSummary;
	blocked: TaskBlockageSummary[];
	completeness: ResultCompleteness;
}

export function createTaskCompletionDetails(
	operation: string,
	fields: {
		artifact: Artifact;
		gates: readonly TaskGateResultSummary[];
		checklist: readonly TaskChecklistReviewSummary[];
		completed: boolean;
		focused: Artifact | null;
		blocked: readonly { artifact: Artifact; dependencyIds: readonly string[] }[];
	},
): TaskCompletionToolDetails {
	const boundedGates = fields.gates.slice(0, TOOL_DETAILS_MAX_ITEMS).map((gate) => ({
		...gate,
		output: gate.output.slice(0, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS),
	}));
	const boundedChecklist = fields.checklist.slice(0, TOOL_DETAILS_MAX_ITEMS);
	const boundedBlocked = fields.blocked.slice(0, TOOL_DETAILS_MAX_ITEMS).map((entry) => ({
		artifact: artifactSummary(entry.artifact),
		dependencyIds: boundedStringArray(entry.dependencyIds),
	}));
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "task-completion",
		operation,
		artifact: artifactSummary(fields.artifact),
		gates: boundedGates,
		checklist: boundedChecklist,
		completed: fields.completed,
		...(fields.focused ? { focused: artifactSummary(fields.focused) } : {}),
		blocked: boundedBlocked,
		completeness: completeness(fields.blocked.length, boundedBlocked.length),
	};
}

export function isTaskGateResultSummary(value: unknown): value is TaskGateResultSummary {
	return isRecord(value) && typeof value.passed === "boolean" && isBoundedString(value.output, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS);
}

export function isTaskChecklistReviewSummary(value: unknown): value is TaskChecklistReviewSummary {
	return (
		isRecord(value) &&
		isBoundedString(value.item) &&
		typeof value.accepted === "boolean" &&
		(value.reason === undefined || isBoundedString(value.reason))
	);
}

export function isTaskBlockageSummary(value: unknown): value is TaskBlockageSummary {
	return isRecord(value) && isArtifactSummary(value.artifact) && isStringArray(value.dependencyIds);
}
