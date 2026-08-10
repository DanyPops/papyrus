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
import { TOOL_COLLAPSED_ROW_LIMIT, TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS } from "@danypops/papyrus";
import type { PiVehicleInvocationRequest, PiVehiclePresentationContract, VehicleToolRenderers } from "@danypops/vehicle-client-pi";
import { expandHint } from "@danypops/vehicle-client-pi/expand-hint";
import { renderVehicleCall, renderVehicleResult } from "@danypops/vehicle-client-pi/vehicle-render";
import type { JsonValue, VehicleOperationDescriptor } from "@danypops/vehicle-core";
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
import { ArtifactCard, detailViewTheme, measure, statusColor, statusGlyph } from "../tool-rendering/artifact-card.ts";
import { ArtifactListCard } from "../tool-rendering/artifact-list.ts";
import {
	type ArtifactFocusAnnotation,
	createArtifactDetails,
	createArtifactListDetails,
	createDiscussionDetails,
	createExecutionPlanDetails,
	createLeaseDetails,
	createNoFocusDetails,
	createPlaybookInvocationDetails,
	createPlaybookMissingArgumentsDetails,
	createPreviewDetails,
	createTaskCompletionDetails,
	parsePapyrusToolDetails,
} from "../tool-rendering/render-model.ts";
import { recordRenderDiagnostic, shapeFingerprint } from "./render-diagnostics.ts";

/** Every field an Artifact and its lean list-default ArtifactSummary (tasks.list/docs.list/
 * rules.list/playbooks.list without full:true -- see summarizeArtifact()) both always carry. */
function hasArtifactCoreFields(value: unknown): value is Omit<Artifact, "body" | "extra"> {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.id === "string" &&
		typeof row.kind === "string" &&
		typeof row.title === "string" &&
		typeof row.status === "string" &&
		typeof row.subtype === "string" &&
		Array.isArray(row.labels) &&
		typeof row.created_at === "string" &&
		typeof row.updated_at === "string"
	);
}

function isArtifact(value: unknown): value is Artifact {
	return hasArtifactCoreFields(value) && typeof (value as Record<string, unknown>).body === "string";
}

/**
 * Regression (real, live-observed): tasks.list's own documented default ("Returns a lean
 * summary (no body/extra) unless full: true is passed") returns ArtifactSummary rows, which
 * omit body entirely. createArtifactListDetails/artifactSummary (render-model.ts) never read
 * .body for list rendering -- only single-artifact createArtifactDetails does -- so requiring
 * body here (matching isArtifact) silently fell every default (lean, the common case) list
 * call for tasks.list/docs.list/rules.list/playbooks.list through to the generic raw Vehicle
 * table renderer instead of the curated ArtifactListCard.
 */
function isArtifactArray(value: unknown): value is Artifact[] {
	return Array.isArray(value) && value.every(hasArtifactCoreFields);
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

/** What renderDiscussionAndRounds actually reads -- satisfied by both a raw Artifact (the live duck-typed output path) and the leaner projected ToolArtifactSummary (the typed-DTO path), with no cast needed at either call site. */
interface RenderableDiscussionParent {
	title: string;
	status: string;
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

function renderDiscussionAndRounds(
	output: { discussion: RenderableDiscussionParent; rounds: readonly DiscussionRoundOutput[] },
	theme: Theme,
	expanded: boolean,
): Component {
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

/** What renderTaskCompletion actually reads -- satisfied by both the raw duck-typed TaskCompletionOutput and the leaner projected TaskCompletionToolDetails. */
interface RenderableTaskCompletion {
	artifact: RenderableDiscussionParent;
	gates: readonly { passed: boolean; output: string }[];
	checklist: readonly TaskChecklistReviewOutput[];
	completed: boolean;
	focused?: RenderableDiscussionParent | null;
	blocked: readonly { artifact: RenderableDiscussionParent; dependencyIds: readonly string[] }[];
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

function renderTaskCompletion(result: RenderableTaskCompletion, theme: Theme, expanded: boolean): Component {
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

/** tasks.claim/heartbeat_lease/release_lease/lease's own name-first view. Detected the same
 * name-independent, shape-based way as the others in this file. */
interface TaskLeaseViewOutput {
	taskName: string;
	taskTitle: string;
	owner: string;
	token: string;
	claimedAt: string;
	leaseExpiresAt: string;
	heartbeatAt?: string;
	note?: string;
}

function isTaskLeaseView(value: unknown): value is TaskLeaseViewOutput {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row.taskName === "string" &&
		typeof row.taskTitle === "string" &&
		typeof row.owner === "string" &&
		typeof row.token === "string" &&
		typeof row.claimedAt === "string" &&
		typeof row.leaseExpiresAt === "string" &&
		(row.heartbeatAt === undefined || typeof row.heartbeatAt === "string") &&
		(row.note === undefined || typeof row.note === "string")
	);
}

/** Renders a lease's own safe fields -- never the raw token, which the model channel (not this persisted, human-facing one) carries for a later heartbeat/release call. */
function renderLease(
	lease: {
		taskName: string;
		taskTitle: string;
		owner: string;
		claimedAt: string;
		leaseExpiresAt: string;
		heartbeatAt?: string;
		note?: string;
	},
	theme: Theme,
): Component {
	return statelessComponent((width) => {
		const fields: DetailField[] = [
			{ label: "Task", value: `${lease.taskName} \u2014 ${lease.taskTitle}` },
			{ label: "Owner", value: lease.owner },
			{ label: "Expires", value: lease.leaseExpiresAt },
			...(lease.heartbeatAt ? [{ label: "Last heartbeat", value: lease.heartbeatAt }] : []),
			...(lease.note ? [{ label: "Note", value: lease.note }] : []),
		];
		return buildDetailLines(Math.max(1, width), { fields, alignFields: true, theme: detailViewTheme(theme), measure });
	});
}

/** Deliberately does not catch: a value JSON.stringify can't serialize (e.g. a circular
 * reference) has no safe textual fallback, so this propagates and the projector's own caller
 * (invokeVehicleOperation) fails the whole call closed rather than persisting a placeholder --
 * the same "never silently substitute raw/unsafe output" contract every other projection
 * failure already carries. */
function boundedJsonPreview(value: unknown): string {
	const text = JSON.stringify(value, null, 2);
	return typeof text === "string" ? text : String(value);
}

export function papyrusVehicleRenderers(descriptor: VehicleOperationDescriptor): VehicleToolRenderers {
	return {
		// Pure pass-through to the generic renderer -- the only reason this exists at all is
		// the /reload investigation (papyrus task 4930cd9b): its absence from the diagnostic
		// log for a real invocation (see onInvoked in vehicle-notes-client.ts) is itself
		// evidence Pi never found ANY renderer -- ours or vehicle-client-pi's generic default
		// -- for that specific tool call, distinct from this renderer running and choosing
		// the generic path internally (which DOES show up here).
		renderCall(args, theme, context) {
			recordRenderDiagnostic({ event: "render-call-invoked", operation: descriptor.name });
			return renderVehicleCall(descriptor, args, theme, context);
		},
		renderResult(result, options, theme, context) {
			if (!options.isPartial && !context.isError) {
				const output = (result.details as { output?: unknown } | undefined)?.output;
				// /reload rendering-fallback investigation (papyrus task 4930cd9b) -- correlates
				// against vehicle-notes-client.ts's onInvoked/vehicle-ready diagnostics by
				// descriptor.name and wall-clock time.
				recordRenderDiagnostic({
					event: "render-result-dispatch",
					operation: descriptor.name,
					isArtifact: isArtifact(output),
					isArtifactArray: isArtifactArray(output),
					output: shapeFingerprint(output),
				});
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
				recordRenderDiagnostic({ event: "render-result-fell-through-to-generic", operation: descriptor.name });
			}
			return renderVehicleResult(descriptor, result, options, theme, context);
		},
	};
}

/**
 * Projects a raw Papyrus operation output into a bounded, versioned PapyrusToolDetails DTO
 * before Pi ever persists it -- the seam papyrusVehicleRenderers' own renderResult never had
 * (it only converts shape at render time, from whatever the legacy {vehicle, output} path
 * already persisted verbatim, lease tokens and all). Every branch here mirrors the same
 * shape-detection papyrusVehicleRenderers's own renderResult uses, so the two stay in lockstep;
 * anything genuinely unmatched still becomes a real, bounded PreviewToolDetails rather than an
 * unprojected raw passthrough -- the one requirement this whole seam exists to satisfy.
 */
function projectPapyrusPresentation(descriptor: VehicleOperationDescriptor, output: unknown): JsonValue {
	if (isArtifactArray(output)) return createArtifactListDetails(descriptor.name, output) as unknown as JsonValue;
	if (isArtifact(output)) return createArtifactDetails(descriptor.name, output) as unknown as JsonValue;
	if (isTaskFocus(output)) return createArtifactDetails(descriptor.name, output.artifact, focusAnnotation(output)) as unknown as JsonValue;
	if (output === null && descriptor.name === "tasks.focused") return createNoFocusDetails(descriptor.name) as unknown as JsonValue;
	if (isTaskExecutionPlan(output))
		return createExecutionPlanDetails(descriptor.name, output.nodes, output.layers, output.cycleIds) as unknown as JsonValue;
	if (isPlaybookInvocationResult(output)) {
		return createPlaybookInvocationDetails(descriptor.name, {
			playbookId: output.playbookId,
			runId: output.runId,
			created: output.created,
			rootTaskIds: output.rootTaskIds,
			entryTaskId: output.entryTaskId,
			execution: output.execution,
		}) as unknown as JsonValue;
	}
	if (isPlaybookMissingArguments(output)) {
		return createPlaybookMissingArgumentsDetails(descriptor.name, output.playbookId, output.missingArguments) as unknown as JsonValue;
	}
	if (isDiscussionAndRounds(output))
		return createDiscussionDetails(descriptor.name, output.rounds, output.discussion) as unknown as JsonValue;
	if (isDiscussionRoundsOnly(output)) return createDiscussionDetails(descriptor.name, output.rounds) as unknown as JsonValue;
	if (isDiscussionListOutput(output)) return createArtifactListDetails(descriptor.name, output.discussions) as unknown as JsonValue;
	if (isTaskCompletion(output)) return createTaskCompletionDetails(descriptor.name, output) as unknown as JsonValue;
	if (isTaskLeaseView(output)) return createLeaseDetails(descriptor.name, output) as unknown as JsonValue;
	return createPreviewDetails(descriptor.name, descriptor.name, boundedJsonPreview(output)) as unknown as JsonValue;
}

function renderFromPapyrusPresentation(
	presentation: NonNullable<ReturnType<typeof parsePapyrusToolDetails>>,
	theme: Theme,
	expanded: boolean,
): Component {
	switch (presentation.kind) {
		case "artifact-list":
			return new ArtifactListCard(presentation, theme, expanded);
		case "artifact":
			return new ArtifactCard(presentation, theme, expanded);
		case "no-focus":
			return renderNoFocusedTask(theme);
		case "execution-plan":
			return renderTaskExecutionPlan(presentation, theme, expanded);
		case "playbook-invocation":
			return renderPlaybookInvocationResult(presentation, theme, expanded);
		case "playbook-missing-arguments":
			return renderPlaybookMissingArguments(presentation, theme);
		case "discussion":
			return presentation.discussion
				? renderDiscussionAndRounds({ discussion: presentation.discussion, rounds: presentation.rounds }, theme, expanded)
				: renderDiscussionRoundsOnly(presentation, theme);
		case "task-completion":
			return renderTaskCompletion(presentation, theme, expanded);
		case "lease":
			return renderLease(presentation, theme);
		case "preview":
			return new Text(theme.fg("toolOutput", presentation.content), 0, 0);
		case "transition":
		case "graph":
		case "gate-run":
		case "invocation":
		case "error":
			// Reachable only if a future caller starts producing these kinds through this seam
			// (today's Papyrus Vehicle outputs never do) -- a bounded JSON preview is still a
			// real, safe rendering rather than a crash.
			return new Text(theme.fg("toolOutput", boundedJsonPreview(presentation)), 0, 0);
	}
}

/**
 * Pairs the projector above with a renderResult that reads the already-projected,
 * already-bounded `details.presentation` DTO instead of raw `details.output` -- the seam
 * pi-papyrus task "project typed bounded render details before Vehicle persists" exists for.
 * Falls back to papyrusVehicleRenderers' own renderResult (which still reads `details.output`)
 * for a partial/progress update, an error result, or a historical session row persisted before
 * this seam existed -- both keep working exactly as before, unchanged.
 */
export function papyrusVehiclePresentations(descriptor: VehicleOperationDescriptor): PiVehiclePresentationContract {
	return {
		projector: {
			maxBytes: TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS,
			project: (output: unknown, _request: PiVehicleInvocationRequest) => projectPapyrusPresentation(descriptor, output),
		},
		renderResult(result, options, theme, context) {
			if (!options.isPartial && !context.isError) {
				const presentation = parsePapyrusToolDetails((result.details as { presentation?: unknown } | undefined)?.presentation);
				if (presentation) return renderFromPapyrusPresentation(presentation, theme, options.expanded);
			}
			return papyrusVehicleRenderers(descriptor).renderResult!(result, options, theme, context);
		},
	};
}
