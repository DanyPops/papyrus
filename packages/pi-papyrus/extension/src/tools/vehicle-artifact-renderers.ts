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
import { TOOL_COLLAPSED_ROW_LIMIT } from "@danypops/papyrus";
import type { VehicleToolRenderers } from "@danypops/vehicle-client-pi";
import { renderVehicleResult } from "@danypops/vehicle-client-pi/vehicle-render";
import type { VehicleOperationDescriptor } from "@danypops/vehicle-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	buildDetailLines,
	type DagEdge,
	type DagNode,
	DagView,
	type DetailField,
	type DetailSection,
	statelessComponent,
} from "malevich-tui-components";
import { ArtifactCard, detailViewTheme, expandHint, measure, statusColor, statusGlyph } from "../tool-rendering/artifact-card.ts";
import { ArtifactListCard } from "../tool-rendering/artifact-list.ts";
import { type ArtifactFocusAnnotation, createArtifactDetails, createArtifactListDetails } from "../tool-rendering/render-model.ts";

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

/** tasks.focused/tasks.pause/tasks.unpause's own wrapper shape -- an Artifact
 * plus Task Focus's separate active/paused dimension. Detected the same
 * name-independent, shape-based way as isArtifact/isArtifactArray above. */
interface TaskFocusOutput {
	artifact: Artifact;
	status: string;
	updatedAt: string;
	pauseReason?: string;
}

function isTaskFocus(value: unknown): value is TaskFocusOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		isArtifact(row.artifact) &&
		typeof row.status === "string" &&
		typeof row.updatedAt === "string" &&
		(row.pauseReason === undefined || typeof row.pauseReason === "string")
	);
}

function focusAnnotation(output: TaskFocusOutput): ArtifactFocusAnnotation {
	return { status: output.status, updatedAt: output.updatedAt, ...(output.pauseReason ? { pauseReason: output.pauseReason } : {}) };
}

function renderNoFocusedTask(theme: Theme): Component {
	return new Text(theme.fg("dim", "No focused task."), 0, 0);
}

/** tasks.plan's own TaskExecutionPlan shape (projectTaskExecution) -- a
 * genuinely structured topological-execution view, never artifact-shaped,
 * detected the same name-independent way as the others in this file. */
interface TaskExecutionNodeOutput {
	id: string;
	title: string;
	status: string;
	active: boolean;
	state: string;
	layer: number | null;
	prerequisiteIds: string[];
	successorIds: string[];
}

interface TaskExecutionPlanOutput {
	nodes: TaskExecutionNodeOutput[];
	layers: string[][];
	cycleIds: string[];
}

function isTaskExecutionNode(value: unknown): value is TaskExecutionNodeOutput {
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

function isTaskExecutionPlan(value: unknown): value is TaskExecutionPlanOutput {
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

function dagViewFromExecutionPlan(plan: TaskExecutionPlanOutput, theme: Theme, expanded: boolean): DagView {
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

function renderTaskExecutionPlan(plan: TaskExecutionPlanOutput, theme: Theme, expanded: boolean): Component {
	return dagViewFromExecutionPlan(plan, theme, expanded);
}

/** playbooks.invoke's own PlaybookInvocationResult shape -- a materialized execution plan
 * (same shape tasks.plan renders) plus which docs/rules/tasks were created and which one to
 * focus. Detected the same name-independent, shape-based way as the others in this file. */
interface PlaybookInvocationResultOutput {
	playbookId: string;
	runId: string;
	created: { docs: string[]; rules: string[]; tasks: string[] };
	rootTaskIds: string[];
	entryTaskId: string;
	execution: TaskExecutionPlanOutput;
}

interface PlaybookMissingArgumentsOutput {
	playbookId: string;
	missingArguments: string[];
}

function isPlaybookInvocationResult(value: unknown): value is PlaybookInvocationResultOutput {
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

function isPlaybookMissingArguments(value: unknown): value is PlaybookMissingArgumentsOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.playbookId === "string" &&
		Array.isArray(row.missingArguments) &&
		row.missingArguments.every((entry) => typeof entry === "string")
	);
}

function renderPlaybookInvocationResult(result: PlaybookInvocationResultOutput, theme: Theme, expanded: boolean): Component {
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

function renderPlaybookMissingArguments(result: PlaybookMissingArgumentsOutput, theme: Theme): Component {
	const line = theme.fg("warning", `Missing required argument(s): ${result.missingArguments.join(", ")}`);
	return new Text(line, 0, 0);
}

/** A Discussion round -- discuss.open/reply/show/rounds' own transcript entry. Detected the
 * same name-independent, shape-based way as the others in this file. */
interface DiscussionRoundOutput {
	roundNumber: number;
	actor: string;
	content: string;
}

function isDiscussionRound(value: unknown): value is DiscussionRoundOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return typeof row.roundNumber === "number" && typeof row.actor === "string" && typeof row.content === "string";
}

function isDiscussionRoundArray(value: unknown): value is DiscussionRoundOutput[] {
	return Array.isArray(value) && value.every(isDiscussionRound);
}

interface DiscussionAndRoundsOutput {
	discussion: Artifact;
	rounds: DiscussionRoundOutput[];
}

function isDiscussionAndRounds(value: unknown): value is DiscussionAndRoundsOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return isArtifact(row.discussion) && isDiscussionRoundArray(row.rounds);
}

interface DiscussionRoundsOnlyOutput {
	rounds: DiscussionRoundOutput[];
}

function isDiscussionRoundsOnly(value: unknown): value is DiscussionRoundsOnlyOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return row.discussion === undefined && isDiscussionRoundArray(row.rounds);
}

interface DiscussionListOutput {
	discussions: Artifact[];
}

function isDiscussionListOutput(value: unknown): value is DiscussionListOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return isArtifactArray(row.discussions);
}

function roundsSection(rounds: readonly DiscussionRoundOutput[]): DetailSection {
	return {
		heading: `Rounds (${rounds.length}):`,
		items: rounds.map((round) => ({ byline: `${round.actor} · round ${round.roundNumber}`, body: round.content })),
	};
}

function renderDiscussionAndRounds(output: DiscussionAndRoundsOutput, theme: Theme, expanded: boolean): Component {
	const discussion = output.discussion;
	return statelessComponent((width) => {
		const safeWidth = Math.max(1, width);
		const fields: DetailField[] = [
			{ label: "Title", value: discussion.title },
			{ label: "Status", value: theme.fg(statusColor(discussion.status), `${statusGlyph(discussion.status)} ${discussion.status}`) },
		];
		const sections: DetailSection[] = expanded && output.rounds.length > 0 ? [roundsSection(output.rounds)] : [];
		const lines = buildDetailLines(safeWidth, { fields, sections, alignFields: true, theme: detailViewTheme(theme), measure });
		if (!expanded && output.rounds.length > 0) {
			const count = output.rounds.length;
			lines.push(truncateToWidth(theme.fg("dim", `${count} round${count === 1 ? "" : "s"} · ${expandHint()}`), safeWidth));
		}
		return lines;
	});
}

function renderDiscussionRoundsOnly(output: DiscussionRoundsOnlyOutput, theme: Theme): Component {
	return statelessComponent((width) => {
		const sections: DetailSection[] = output.rounds.length > 0 ? [roundsSection(output.rounds)] : [{ lines: ["No rounds."] }];
		return buildDetailLines(Math.max(1, width), { sections, theme: detailViewTheme(theme), measure });
	});
}

/** tasks.complete's own TaskCompletion shape -- a completed (or rejected) task plus its own
 * gate/checklist proof run and any dependents still left blocked. Detected the same
 * name-independent, shape-based way as the others in this file. */
interface TaskGateResultOutput {
	gate: unknown;
	passed: boolean;
	output: string;
}

interface TaskChecklistReviewOutput {
	item: string;
	accepted: boolean;
	reason?: string;
}

interface TaskBlockageOutput {
	artifact: Artifact;
	dependencyIds: string[];
}

interface TaskCompletionOutput {
	artifact: Artifact;
	gates: TaskGateResultOutput[];
	checklist: TaskChecklistReviewOutput[];
	completed: boolean;
	focused: Artifact | null;
	blocked: TaskBlockageOutput[];
}

function isTaskCompletion(value: unknown): value is TaskCompletionOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		isArtifact(row.artifact) &&
		Array.isArray(row.gates) &&
		Array.isArray(row.checklist) &&
		typeof row.completed === "boolean" &&
		(row.focused === null || isArtifact(row.focused)) &&
		Array.isArray(row.blocked)
	);
}

function renderTaskCompletion(result: TaskCompletionOutput, theme: Theme, expanded: boolean): Component {
	const task = result.artifact;
	return statelessComponent((width) => {
		const safeWidth = Math.max(1, width);
		const fields: DetailField[] = [
			{ label: "Title", value: task.title },
			{ label: "Status", value: theme.fg(statusColor(task.status), `${statusGlyph(task.status)} ${task.status}`) },
		];
		const sections: DetailSection[] = [];
		if (result.gates.length > 0) {
			sections.push({
				heading: "Gates:",
				lines: result.gates.map((gate) => theme.fg(gate.passed ? "success" : "error", `${gate.passed ? "✓" : "✗"} ${gate.output}`)),
			});
		}
		if (result.checklist.length > 0) {
			sections.push({
				heading: "Checklist:",
				lines: result.checklist.map((entry) =>
					theme.fg(
						entry.accepted ? "success" : "error",
						`${entry.accepted ? "✓" : "✗"} ${entry.item}${entry.reason ? ` — ${entry.reason}` : ""}`,
					),
				),
			});
		}
		if (result.blocked.length > 0) {
			sections.push({
				heading: "Still blocked:",
				lines: result.blocked.map((entry) => theme.fg("warning", `◼ ${entry.artifact.title}`)),
			});
		}
		const lines = buildDetailLines(safeWidth, { fields, sections, alignFields: true, theme: detailViewTheme(theme), measure });
		if (result.focused && expanded) {
			lines.push(truncateToWidth(theme.fg("accent", `▶ focus ${result.focused.title}`), safeWidth));
		}
		return lines;
	});
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
				if (isTaskFocus(output)) {
					return new ArtifactCard(
						createArtifactDetails(descriptor.name, output.artifact, focusAnnotation(output)),
						theme,
						options.expanded,
					);
				}
				// tasks.focused specifically returns null for "nothing focused" --
				// scoped to this one operation so an unrelated null-output operation
				// (e.g. a not-found lookup) is never mislabeled as a focus state.
				if (output === null && descriptor.name === "tasks.focused") {
					return renderNoFocusedTask(theme);
				}
				if (isTaskExecutionPlan(output)) {
					return renderTaskExecutionPlan(output, theme, options.expanded);
				}
				if (isPlaybookInvocationResult(output)) {
					return renderPlaybookInvocationResult(output, theme, options.expanded);
				}
				if (isPlaybookMissingArguments(output)) {
					return renderPlaybookMissingArguments(output, theme);
				}
				if (isDiscussionAndRounds(output)) {
					return renderDiscussionAndRounds(output, theme, options.expanded);
				}
				if (isDiscussionRoundsOnly(output)) {
					return renderDiscussionRoundsOnly(output, theme);
				}
				if (isDiscussionListOutput(output)) {
					return new ArtifactListCard(createArtifactListDetails(descriptor.name, output.discussions), theme, options.expanded);
				}
				if (isTaskCompletion(output)) {
					return renderTaskCompletion(output, theme, options.expanded);
				}
			}
			return renderVehicleResult(descriptor, result, options, theme, context);
		},
	};
}
