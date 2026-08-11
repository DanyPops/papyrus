import { TOOL_DETAILS_MAX_ITEMS } from "@danypops/papyrus";
import { boundedExecutionPlanNodes, boundedLayers, type ExecutionPlanNode } from "./execution-plan.ts";
import { boundedStringArray, completeness, PAPYRUS_TOOL_DETAILS_SCHEMA, type ResultCompleteness, type ToolDetailsBase } from "./shared.ts";

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

export function createInvocationDetails(operation: string, runId: string, created: ToolInvocationCreated): InvocationToolDetails {
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

export interface PlaybookInvocationCreated {
	docs: string[];
	rules: string[];
	tasks: string[];
}

export interface PlaybookInvocationToolDetails extends ToolDetailsBase {
	kind: "playbook-invocation";
	playbookId: string;
	runId: string;
	created: PlaybookInvocationCreated;
	rootTaskIds: string[];
	entryTaskId: string;
	execution: { nodes: ExecutionPlanNode[]; layers: string[][]; cycleIds: string[] };
	completeness: ResultCompleteness;
}

export function createPlaybookInvocationDetails(
	operation: string,
	fields: {
		playbookId: string;
		runId: string;
		created: PlaybookInvocationCreated;
		rootTaskIds: readonly string[];
		entryTaskId: string;
		execution: { nodes: readonly ExecutionPlanNode[]; layers: readonly (readonly string[])[]; cycleIds: readonly string[] };
	},
): PlaybookInvocationToolDetails {
	const boundedNodes = boundedExecutionPlanNodes(fields.execution.nodes);
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "playbook-invocation",
		operation,
		playbookId: fields.playbookId,
		runId: fields.runId,
		created: {
			docs: boundedStringArray(fields.created.docs),
			rules: boundedStringArray(fields.created.rules),
			tasks: boundedStringArray(fields.created.tasks),
		},
		rootTaskIds: boundedStringArray(fields.rootTaskIds),
		entryTaskId: fields.entryTaskId,
		execution: {
			nodes: boundedNodes,
			layers: boundedLayers(fields.execution.layers),
			cycleIds: boundedStringArray(fields.execution.cycleIds),
		},
		completeness: completeness(fields.execution.nodes.length, boundedNodes.length),
	};
}

export interface PlaybookMissingArgumentsToolDetails extends ToolDetailsBase {
	kind: "playbook-missing-arguments";
	playbookId: string;
	missingArguments: string[];
}

export function createPlaybookMissingArgumentsDetails(
	operation: string,
	playbookId: string,
	missingArguments: readonly string[],
): PlaybookMissingArgumentsToolDetails {
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "playbook-missing-arguments",
		operation,
		playbookId,
		missingArguments: boundedStringArray(missingArguments),
	};
}
