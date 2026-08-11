import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { dagViewFromExecutionPlan, isTaskExecutionPlan, type TaskExecutionPlanOutput } from "./task-execution.ts";

/** playbooks.invoke's own PlaybookInvocationResult shape -- a materialized execution plan
 * (same shape tasks.plan renders) plus which docs/rules/tasks were created and which one to
 * focus. Detected the same name-independent, shape-based way as the others in this directory. */
export interface PlaybookInvocationResultOutput {
	playbookId: string;
	runId: string;
	created: { docs: string[]; rules: string[]; tasks: string[] };
	rootTaskIds: string[];
	entryTaskId: string;
	execution: TaskExecutionPlanOutput;
}

export interface PlaybookMissingArgumentsOutput {
	playbookId: string;
	missingArguments: string[];
}

export function isPlaybookInvocationResult(value: unknown): value is PlaybookInvocationResultOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.playbookId === "string" &&
		typeof row.runId === "string" &&
		typeof row.entryTaskId === "string" &&
		Array.isArray(row.rootTaskIds) &&
		typeof row.created === "object" &&
		row.created !== null &&
		Array.isArray((row.created as Record<string, unknown>).docs) &&
		Array.isArray((row.created as Record<string, unknown>).rules) &&
		Array.isArray((row.created as Record<string, unknown>).tasks) &&
		isTaskExecutionPlan(row.execution)
	);
}

export function isPlaybookMissingArguments(value: unknown): value is PlaybookMissingArgumentsOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.playbookId === "string" &&
		Array.isArray(row.missingArguments) &&
		row.missingArguments.every((entry) => typeof entry === "string")
	);
}

export function renderPlaybookInvocationResult(result: PlaybookInvocationResultOutput, theme: Theme, expanded: boolean): Component {
	const dag = dagViewFromExecutionPlan(result.execution, theme, expanded);
	const counts = [
		["task", result.created.tasks.length],
		["rule", result.created.rules.length],
		["doc", result.created.docs.length],
	] as const;
	const summary = counts
		.filter(([, count]) => count > 0)
		.map(([noun, count]) => `${count} ${noun}${count === 1 ? "" : "s"}`)
		.join(", ");
	return {
		render: (width: number) => [...dag.render(width), truncateToWidth(theme.fg("dim", summary || "Nothing created."), width)],
		invalidate: () => dag.invalidate(),
	};
}

export function renderPlaybookMissingArguments(result: PlaybookMissingArgumentsOutput, theme: Theme): Component {
	const line = theme.fg("warning", `Missing required argument(s): ${result.missingArguments.join(", ")}`);
	return new Text(line, 0, 0);
}
