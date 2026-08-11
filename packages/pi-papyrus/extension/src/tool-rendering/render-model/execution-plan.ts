import { TOOL_DETAILS_MAX_ITEMS } from "@danypops/papyrus";
import {
	boundedStringArray,
	completeness,
	isBoundedArray,
	isBoundedString,
	isRecord,
	isStringArray,
	PAPYRUS_TOOL_DETAILS_SCHEMA,
	type ResultCompleteness,
	type ToolDetailsBase,
} from "./shared.ts";

export interface ExecutionPlanNode {
	id: string;
	title: string;
	status: string;
	active: boolean;
	state: string;
	layer: number | null;
	prerequisiteIds: string[];
	successorIds: string[];
}

export interface ExecutionPlanToolDetails extends ToolDetailsBase {
	kind: "execution-plan";
	nodes: ExecutionPlanNode[];
	layers: string[][];
	cycleIds: string[];
	completeness: ResultCompleteness;
}

export function boundedExecutionPlanNodes(nodes: readonly ExecutionPlanNode[]): ExecutionPlanNode[] {
	return nodes.slice(0, TOOL_DETAILS_MAX_ITEMS).map((node) => ({
		...node,
		prerequisiteIds: boundedStringArray(node.prerequisiteIds),
		successorIds: boundedStringArray(node.successorIds),
	}));
}

export function boundedLayers(layers: readonly (readonly string[])[]): string[][] {
	return layers.slice(0, TOOL_DETAILS_MAX_ITEMS).map((layer) => boundedStringArray(layer));
}

export function createExecutionPlanDetails(
	operation: string,
	nodes: readonly ExecutionPlanNode[],
	layers: readonly (readonly string[])[],
	cycleIds: readonly string[],
): ExecutionPlanToolDetails {
	const boundedNodes = boundedExecutionPlanNodes(nodes);
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "execution-plan",
		operation,
		nodes: boundedNodes,
		layers: boundedLayers(layers),
		cycleIds: boundedStringArray(cycleIds),
		completeness: completeness(nodes.length, boundedNodes.length),
	};
}

export function isExecutionPlanNode(value: unknown): value is ExecutionPlanNode {
	return (
		isRecord(value) &&
		isBoundedString(value.id) &&
		isBoundedString(value.title) &&
		isBoundedString(value.status) &&
		typeof value.active === "boolean" &&
		isBoundedString(value.state) &&
		(value.layer === null || Number.isSafeInteger(value.layer)) &&
		isStringArray(value.prerequisiteIds) &&
		isStringArray(value.successorIds)
	);
}

export function isLayers(value: unknown): value is string[][] {
	return isBoundedArray(value, TOOL_DETAILS_MAX_ITEMS, (entry): entry is string[] => isStringArray(entry));
}

export function isExecution(value: unknown): value is { nodes: ExecutionPlanNode[]; layers: string[][]; cycleIds: string[] } {
	return (
		isRecord(value) &&
		isBoundedArray(value.nodes, TOOL_DETAILS_MAX_ITEMS, isExecutionPlanNode) &&
		isLayers(value.layers) &&
		isStringArray(value.cycleIds)
	);
}
