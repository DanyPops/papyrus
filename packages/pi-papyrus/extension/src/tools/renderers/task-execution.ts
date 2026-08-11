import { TOOL_COLLAPSED_ROW_LIMIT } from "@danypops/papyrus";
import { expandHint } from "@danypops/vehicle-client-pi/expand-hint";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type DagEdge, type DagNode, DagView } from "malevich-tui-components";
import { statusColor, statusGlyph } from "../../tool-rendering/artifact-card.ts";

/** tasks.plan's own TaskExecutionPlan shape (projectTaskExecution) -- a
 * genuinely structured topological-execution view, never artifact-shaped,
 * detected the same name-independent way as the others in this directory. */
export interface TaskExecutionNodeOutput {
	id: string;
	title: string;
	status: string;
	active: boolean;
	state: string;
	layer: number | null;
	prerequisiteIds: string[];
	successorIds: string[];
}

export interface TaskExecutionPlanOutput {
	nodes: TaskExecutionNodeOutput[];
	layers: string[][];
	cycleIds: string[];
}

export function isTaskExecutionNode(value: unknown): value is TaskExecutionNodeOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.title === "string" &&
		typeof row.status === "string" &&
		typeof row.active === "boolean" &&
		typeof row.state === "string" &&
		(row.layer === null || typeof row.layer === "number") &&
		Array.isArray(row.prerequisiteIds) &&
		Array.isArray(row.successorIds)
	);
}

export function isTaskExecutionPlan(value: unknown): value is TaskExecutionPlanOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		Array.isArray(row.nodes) &&
		row.nodes.every(isTaskExecutionNode) &&
		Array.isArray(row.layers) &&
		row.layers.every((layer) => Array.isArray(layer) && layer.every((id) => typeof id === "string")) &&
		Array.isArray(row.cycleIds) &&
		row.cycleIds.every((id) => typeof id === "string")
	);
}

export function dagViewFromExecutionPlan(plan: TaskExecutionPlanOutput, theme: Theme, expanded: boolean): DagView {
	const nodes: DagNode[] = plan.nodes.map((node) => ({
		id: node.id,
		label: `${theme.fg(statusColor(node.state), statusGlyph(node.state))} ${theme.fg("text", node.title)}`,
	}));
	const edges: DagEdge[] = plan.nodes.flatMap((node) => node.prerequisiteIds.map((from) => ({ from, to: node.id })));
	return new DagView({
		layers: plan.layers,
		nodes,
		edges,
		cycleIds: plan.cycleIds,
		defaultStyle: (s) => theme.fg("text", s),
		edgeStyle: (s) => theme.fg("dim", s),
		layerHeaderStyle: (s) => theme.fg("toolTitle", theme.bold(s)),
		cycleHeaderStyle: (s) => theme.fg("error", theme.bold(s)),
		expanded,
		visibleNodeCount: TOOL_COLLAPSED_ROW_LIMIT,
		moreLine: (hiddenCount) => theme.fg("dim", `${hiddenCount} more · ${expandHint()}`),
	});
}

export function renderTaskExecutionPlan(plan: TaskExecutionPlanOutput, theme: Theme, expanded: boolean): Component {
	return dagViewFromExecutionPlan(plan, theme, expanded);
}
