/**
 * Public surface for @danypops/pi-papyrus (and any other real npm consumer): every type or
 * value the Pi extension package needs across the package boundary, named explicitly rather
 * than a blanket `export *` on service-heavy modules -- matches ports-and-adapters practice of a
 * purposeful API, not "everything happens to be reachable."
 */
export * from "./constants.ts";

export type { Artifact, ArtifactEdge } from "./domain/artifact.ts";
export { PROOF_TYPES, checklistEntries, type ProofReference } from "./domain/checklist.ts";
export { DISCUSSION_SUBTYPE, readDiscussionExtra, type DiscussionRound } from "./domain/discussion.ts";
export type { DisplayGraph, DisplayGraphEdge, DisplayGraphNode, RenderedGraph } from "./domain/display-graph.ts";
export type { GateResult } from "./domain/gate.ts";
export type { NoteHistoryPage } from "./domain/note-event.ts";
export type { TaskEvent, TaskHistoryPage } from "./domain/task-event.ts";
export type { TaskLease } from "./domain/task-lease.ts";
export type { TaskViewSelection } from "./domain/task-scope.ts";

export type { ArtifactStore } from "./ports/artifact-store.ts";
export type { GraphRenderer } from "./ports/graph-renderer.ts";

export { connectPapyrusClient, resolvePushChannelTarget, type PapyrusClient, type PushChannelTarget } from "./client.ts";
export type { DiscussionAndRounds } from "./discussion-service.ts";
export { NOTE_DISPOSITIONS } from "./note-service.ts";
export type { OperationName, SchemaState } from "./service.ts";
export type { WorkflowRunResult } from "./workflow-execution.ts";
export { projectArtifactRelationships } from "./artifact-relationship-view.ts";
export { taskContext } from "./task-context.ts";
export { projectTaskExecution, type TaskExecutionPlan, type TaskExecutionState } from "./task-execution.ts";
export { projectTaskGraph, type TaskGraphView } from "./task-graph-view.ts";
export { fallbackLabel, projectTaskRelationships } from "./task-relationship-view.ts";
export type { TaskCompletion, TaskGraph, TaskNode, TaskStatus } from "./task-service.ts";
