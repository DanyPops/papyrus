/**
 * Public surface for @danypops/pi-papyrus (and any other real npm consumer): every type or
 * value the Pi extension package needs across the package boundary, named explicitly rather
 * than a blanket `export *` on service-heavy modules -- matches ports-and-adapters practice of a
 * purposeful API, not "everything happens to be reachable."
 */

export type { Artifact, ArtifactEdge } from "./artifact/artifact.ts";
export { projectArtifactRelationships } from "./artifact/artifact-relationship-view.ts";
export type { ArtifactStore } from "./artifact/artifact-store.ts";
export {
	connectPapyrusClient,
	type PapyrusClient,
	type PushChannelTarget,
	resolvePushChannelTarget,
	resolveVehicleClientTarget,
	type VehicleClientTarget,
} from "./client.ts";
export * from "./constants.ts";
export type { DiscussionAndRounds } from "./discussion/discussion-service.ts";
export { checklistEntries, PROOF_TYPES, type ProofReference } from "./domain/checklist.ts";
export { DISCUSSION_SUBTYPE, type DiscussionRound, readDiscussionExtra } from "./domain/discussion.ts";
export type { DisplayGraph, DisplayGraphEdge, DisplayGraphNode, RenderedGraph } from "./domain/display-graph.ts";
export type { GateResult } from "./domain/gate.ts";
export type { NoteHistoryPage } from "./domain/note-event.ts";
export type { TaskEvent, TaskHistoryPage } from "./domain/task-event.ts";
export type { TaskLease, TaskLeaseView } from "./domain/task-lease.ts";
export type { TaskViewSelection } from "./domain/task-scope.ts";
export { NOTE_DISPOSITIONS } from "./note/note-service.ts";
export type { PlaybookInvocationResult, PlaybookMissingArguments } from "./playbook/playbook-execution.ts";
export type { WorkflowRunResult } from "./playbook/workflow-execution.ts";
export type { OperationName, SchemaState } from "./service.ts";
export type { GraphRenderer } from "./stores/graph-renderer.ts";
export { taskContext } from "./task/task-context.ts";
export { projectTaskExecution, type TaskExecutionPlan, type TaskExecutionState } from "./task/task-execution.ts";
export { projectTaskGraph, type TaskGraphView } from "./task/task-graph-view.ts";
export { fallbackLabel, projectTaskRelationships } from "./task/task-relationship-view.ts";
export type {
	TaskCompletion,
	TaskGraph,
	TaskLifecycleMutationResult,
	TaskMutationReceiptView,
	TaskNode,
	TaskStatus,
} from "./task/task-service.ts";
export { TaskInvalidTransitionError, TaskMutationReceiptNotFoundError } from "./task/task-service.ts";
