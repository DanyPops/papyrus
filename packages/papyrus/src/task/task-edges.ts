import type { Artifact, ArtifactEdge } from "../artifact/artifact.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { TASK_EXECUTION_MAX_DEGREE } from "../constants.ts";
import type { AppendTaskEvent, TaskEventContext } from "../domain/task-event.ts";
import type { TaskEventStore } from "../stores/task-event-store.ts";
import { assertDependencyEdgeAllowed, TaskExecutionBoundExceededError } from "./task-execution.ts";
// Type-only import: erased entirely at compile time, so this does not create a real runtime
// circular dependency even though task-service.ts also imports TaskEdges (a real value) from
// this file -- only one direction of this pair carries an actual runtime import.
import type { TaskGraph } from "./task-service.ts";

/**
 * Task dependency/containment edge mutations (depend/undepend/contain/uncontain), split out of
 * the Tasks god class as part of a SOLID-audit-driven decomposition (see task b51419a0 and the
 * "TaskEdges" child of "Epic: Modularize papyrus/pi-papyrus god-files into building-block
 * modules"), mirroring the TaskLeaseCoordinator/TaskMutationCoordinator/TaskFocusCoordinator/
 * TaskProjectScope precedent in this same directory.
 *
 * Unlike those simpler extractions, this one only owns the mutation side of edges -- it reads the
 * graph/relationships it needs through injected callbacks (dependencyCheckGraph/dependencyIds/
 * relationships) rather than duplicating that graph-construction machinery, since those reads are
 * shared with concerns that stay on Tasks (list/graph/buildGraph, progress propagation, blockage
 * checks in transition/complete).
 */
export class TaskEdges {
	constructor(
		private readonly artifacts: Pick<ArtifactStore, "link" | "unlink">,
		private readonly events: TaskEventStore,
		/** Delegates to Tasks.require() so edge methods get the identical not-found/wrong-kind checks every other Tasks method already enforces, without duplicating that logic here. */
		private readonly requireTask: (id: string) => Artifact,
		/** Delegates to Tasks.show() -- every edge mutation returns the affected task's own current (post-mutation) view. */
		private readonly showTask: (id: string) => Artifact,
		/** Delegates to Tasks' own actor/source/sessionId/reason defaulting so every event this collaborator appends looks identical to one Tasks itself would have appended. */
		private readonly appendEvent: (event: Omit<AppendTaskEvent, "actor" | "source">, context: TaskEventContext) => void,
		/** Delegates to Tasks' own private dependencyCheckGraph() -- project-scoped cycle-check graph construction, which itself composes list()/graph()/buildGraph(), all of which stay on Tasks. */
		private readonly dependencyCheckGraph: (id: string, dependencyId: string) => TaskGraph,
		/** Delegates to Tasks' own private dependencyIds() -- bounded prerequisite lookup, also used outside edge mutations (transition's blockage check). */
		private readonly dependencyIds: (id: string) => string[],
		/** Delegates to Tasks' own private relationships() -- bounded relationship lookup, also used outside edge mutations (parentIds/progress propagation). */
		private readonly relationships: (id: string) => ArtifactEdge[],
	) {}

	depend(id: string, dependencyId: string, context: TaskEventContext = {}): Artifact {
		return this.events.atomic(() => {
			this.requireTask(id);
			this.requireTask(dependencyId);
			const graph = this.dependencyCheckGraph(id, dependencyId);
			assertDependencyEdgeAllowed(graph, id, dependencyId);
			const node = graph.nodes.find((entry) => entry.task.id === id)!;
			if (node.dependencyIds.includes(dependencyId)) return this.showTask(id);
			if (node.dependencyIds.length >= TASK_EXECUTION_MAX_DEGREE) {
				throw new TaskExecutionBoundExceededError(`task "${id}" cannot exceed ${TASK_EXECUTION_MAX_DEGREE} prerequisites`);
			}
			const successorCount = graph.nodes.filter((entry) => entry.dependencyIds.includes(dependencyId)).length;
			if (successorCount >= TASK_EXECUTION_MAX_DEGREE) {
				throw new TaskExecutionBoundExceededError(`task "${dependencyId}" cannot exceed ${TASK_EXECUTION_MAX_DEGREE} successors`);
			}
			this.artifacts.link({ from: id, relation: "depends_on", to: dependencyId }, context);
			this.appendEvent({ taskId: id, type: "dependency_added", reason: context.reason }, context);
			return this.showTask(id);
		});
	}

	/** Idempotent: undepending an already-absent dependency is a no-op. Never starts, completes, or focuses work — only removes the edge. */
	undepend(id: string, dependencyId: string, context: TaskEventContext = {}): Artifact {
		return this.events.atomic(() => {
			const task = this.requireTask(id);
			const dependency = this.requireTask(dependencyId);
			const removed = this.artifacts.unlink({ from: id, relation: "depends_on", to: dependencyId }, context);
			if (removed) this.appendEvent({ taskId: id, type: "dependency_removed", reason: context.reason }, context);
			// Only meaningful if the removed edge was itself unmet -- removing an already-satisfied
			// dependency, or removing one from a task that was already unblocked, changes nothing.
			if (removed && task.status === "todo" && dependency.status !== "done") {
				const stillBlocking = this.dependencyIds(id).filter((remainingId) => this.requireTask(remainingId).status !== "done");
				if (stillBlocking.length === 0) this.appendEvent({ taskId: id, type: "became_ready" }, context);
			}
			return this.showTask(id);
		});
	}

	contain(parentId: string, childId: string, context: TaskEventContext = {}): Artifact {
		return this.events.atomic(() => {
			this.requireTask(parentId);
			this.requireTask(childId);
			const alreadyContained = this.relationships(parentId).some(
				(edge) => edge.relation === "contains" && edge.from === parentId && edge.to === childId,
			);
			this.artifacts.link({ from: parentId, relation: "contains", to: childId }, context);
			this.artifacts.link({ from: childId, relation: "part_of", to: parentId }, context);
			if (!alreadyContained) this.appendEvent({ taskId: parentId, type: "containment_added", reason: context.reason }, context);
			return this.showTask(parentId);
		});
	}

	/** Idempotent: removing an already-absent containment is a no-op. Both contains/part_of edges are removed atomically. */
	uncontain(parentId: string, childId: string, context: TaskEventContext = {}): Artifact {
		return this.events.atomic(() => {
			this.requireTask(parentId);
			this.requireTask(childId);
			const removedContains = this.artifacts.unlink({ from: parentId, relation: "contains", to: childId }, context);
			this.artifacts.unlink({ from: childId, relation: "part_of", to: parentId }, context);
			if (removedContains) this.appendEvent({ taskId: parentId, type: "containment_removed", reason: context.reason }, context);
			return this.showTask(parentId);
		});
	}
}
