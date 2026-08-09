import {
	type Artifact,
	TOOL_DETAILS_BODY_MAX_CHARACTERS,
	TOOL_DETAILS_FIELD_MAX_CHARACTERS,
	TOOL_DETAILS_MAX_EDGES,
	TOOL_DETAILS_MAX_ITEMS,
	TOOL_DETAILS_MAX_SERIALIZED_CHARACTERS,
	TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS,
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

interface ToolDetailsBase {
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

export interface ArtifactToolDetails extends ToolDetailsBase {
	kind: "artifact";
	artifact: ToolArtifact;
	completeness: ResultCompleteness;
	focus?: ArtifactFocusAnnotation;
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

export interface PlaybookMissingArgumentsToolDetails extends ToolDetailsBase {
	kind: "playbook-missing-arguments";
	playbookId: string;
	missingArguments: string[];
}

export interface DiscussionRoundSummary {
	roundNumber: number;
	actor: string;
	content: string;
}

export interface DiscussionToolDetails extends ToolDetailsBase {
	kind: "discussion";
	/** Absent for discuss.rounds, which returns rounds with no parent discussion in its own output. */
	discussion?: ToolArtifactSummary;
	rounds: DiscussionRoundSummary[];
	completeness: ResultCompleteness;
}

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

export interface NoFocusToolDetails extends ToolDetailsBase {
	kind: "no-focus";
}

/** tasks.claim/heartbeat_lease/release_lease/lease's own name-first view -- deliberately never carries the raw lease token; the model channel (which needs the real token for a later heartbeat/release call) is a separate, independent channel from this persisted, human-facing one. */
export interface LeaseToolDetails extends ToolDetailsBase {
	kind: "lease";
	taskName: string;
	taskTitle: string;
	owner: string;
	claimedAt: string;
	leaseExpiresAt: string;
	heartbeatAt?: string;
	note?: string;
}

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

type ArtifactSummarySource = Pick<Artifact, "id" | "kind" | "title" | "status" | "subtype" | "labels"> & { alias?: string };

function artifactSummary(artifact: ArtifactSummarySource): ToolArtifactSummary {
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

export function createArtifactDetails(operation: string, artifact: Artifact, focus?: ArtifactFocusAnnotation): ArtifactToolDetails {
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
		...(focus ? { focus } : {}),
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

export function createGraphDetails(operation: string, artifacts: readonly Artifact[], edges: readonly ToolGraphEdge[]): GraphToolDetails {
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

function boundedStringArray(values: readonly string[]): string[] {
	return values.slice(0, TOOL_DETAILS_MAX_ITEMS);
}

function boundedExecutionPlanNodes(nodes: readonly ExecutionPlanNode[]): ExecutionPlanNode[] {
	return nodes.slice(0, TOOL_DETAILS_MAX_ITEMS).map((node) => ({
		...node,
		prerequisiteIds: boundedStringArray(node.prerequisiteIds),
		successorIds: boundedStringArray(node.successorIds),
	}));
}

function boundedLayers(layers: readonly (readonly string[])[]): string[][] {
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

export function createDiscussionDetails(
	operation: string,
	rounds: readonly DiscussionRoundSummary[],
	discussion?: ArtifactSummarySource,
): DiscussionToolDetails {
	const boundedRounds = rounds.slice(0, TOOL_DETAILS_MAX_ITEMS).map((round) => ({
		...round,
		content: round.content.slice(0, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS),
	}));
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "discussion",
		operation,
		...(discussion ? { discussion: artifactSummary(discussion) } : {}),
		rounds: boundedRounds,
		completeness: completeness(rounds.length, boundedRounds.length),
	};
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

export function createNoFocusDetails(operation: string): NoFocusToolDetails {
	return { schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA, kind: "no-focus", operation };
}

export function createLeaseDetails(
	operation: string,
	lease: {
		taskName: string;
		taskTitle: string;
		owner: string;
		claimedAt: string;
		leaseExpiresAt: string;
		heartbeatAt?: string;
		note?: string;
	},
): LeaseToolDetails {
	return {
		schemaVersion: PAPYRUS_TOOL_DETAILS_SCHEMA,
		kind: "lease",
		operation,
		taskName: lease.taskName,
		taskTitle: lease.taskTitle,
		owner: lease.owner,
		claimedAt: lease.claimedAt,
		leaseExpiresAt: lease.leaseExpiresAt,
		...(lease.heartbeatAt ? { heartbeatAt: lease.heartbeatAt } : {}),
		...(lease.note ? { note: lease.note.slice(0, TOOL_DETAILS_FIELD_MAX_CHARACTERS) } : {}),
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

function isToolArtifact(value: unknown): value is ToolArtifact {
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

function isFocusAnnotation(value: unknown): value is ArtifactFocusAnnotation {
	return (
		isRecord(value) &&
		isBoundedString(value.status) &&
		isBoundedString(value.updatedAt) &&
		(value.pauseReason === undefined || isBoundedString(value.pauseReason))
	);
}

function isGraphEdge(value: unknown): value is ToolGraphEdge {
	return isRecord(value) && isBoundedString(value.from) && isBoundedString(value.relation) && isBoundedString(value.to);
}

function isGateRow(value: unknown): value is ToolGateRow {
	return (
		isRecord(value) &&
		typeof value.passed === "boolean" &&
		isBoundedString(value.type) &&
		isBoundedString(value.target) &&
		isBoundedString(value.output, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS)
	);
}

function isBoundedArray<T>(value: unknown, maximum: number, predicate: (entry: unknown) => entry is T): value is T[] {
	return Array.isArray(value) && value.length <= maximum && value.every(predicate);
}

function isExecutionPlanNode(value: unknown): value is ExecutionPlanNode {
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

function isLayers(value: unknown): value is string[][] {
	return isBoundedArray(value, TOOL_DETAILS_MAX_ITEMS, (entry): entry is string[] => isStringArray(entry));
}

function isExecution(value: unknown): value is { nodes: ExecutionPlanNode[]; layers: string[][]; cycleIds: string[] } {
	return (
		isRecord(value) &&
		isBoundedArray(value.nodes, TOOL_DETAILS_MAX_ITEMS, isExecutionPlanNode) &&
		isLayers(value.layers) &&
		isStringArray(value.cycleIds)
	);
}

function isDiscussionRoundSummary(value: unknown): value is DiscussionRoundSummary {
	return isRecord(value) && Number.isSafeInteger(value.roundNumber) && isBoundedString(value.actor) && isBoundedString(value.content);
}

function isTaskGateResultSummary(value: unknown): value is TaskGateResultSummary {
	return isRecord(value) && typeof value.passed === "boolean" && isBoundedString(value.output, TOOL_DETAILS_ROW_OUTPUT_MAX_CHARACTERS);
}

function isTaskChecklistReviewSummary(value: unknown): value is TaskChecklistReviewSummary {
	return (
		isRecord(value) &&
		isBoundedString(value.item) &&
		typeof value.accepted === "boolean" &&
		(value.reason === undefined || isBoundedString(value.reason))
	);
}

function isTaskBlockageSummary(value: unknown): value is TaskBlockageSummary {
	return isRecord(value) && isArtifactSummary(value.artifact) && isStringArray(value.dependencyIds);
}

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
