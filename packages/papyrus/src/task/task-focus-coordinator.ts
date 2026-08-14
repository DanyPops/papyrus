import type { Artifact } from "../artifact/artifact.ts";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { TASK_FOCUS_STALE_AFTER_MS } from "../constants.ts";
import { type AppendTaskEvent, type TaskEventContext, validateEventContext } from "../task-event/task-event.ts";
import type { TaskEventStore } from "../task-event/task-event-store.ts";
import type { TaskFocusStatus, TaskFocusStore } from "../task-focus/task-focus-store.ts";
import { TaskInvalidTransitionError } from "./task-lifecycle-errors.ts";
import type { TaskMutationCoordinator, TaskMutationRequestContext } from "./task-mutation-coordinator.ts";
// Type-only import: erased entirely at compile time, so this does not create a real runtime
// circular dependency even though task-service.ts also imports TaskFocusCoordinator (a real
// value) from this file -- only one direction of this pair carries an actual runtime import.
import type { TaskFilter, TaskMutationMetadata } from "./task-service.ts";

export interface TaskFocus {
	artifact: Artifact;
	status: TaskFocusStatus;
	updatedAt: string;
	pauseReason?: string;
}

export type TaskFocusMutationResult = TaskFocus & TaskMutationMetadata;

/**
 * Task Focus (the single active/paused task per session scope), split out of the Tasks god class
 * as part of a SOLID-audit-driven decomposition (see task b51419a0 and the "TaskFocusCoordinator"
 * child of "Epic: Modularize papyrus/pi-papyrus god-files into building-block modules"), mirroring
 * the existing TaskLeaseCoordinator/TaskMutationCoordinator precedent in this same directory.
 *
 * Focus is orthogonal to lifecycle and lease: focusing a task does not start it, and does not
 * claim its lease -- so this concern has nothing to do with status transitions or worker
 * exclusivity, the other concerns that were previously interleaved with it in one class.
 */
export class TaskFocusCoordinator {
	constructor(
		private readonly artifacts: Pick<ArtifactStore, "get">,
		private readonly focusStore: TaskFocusStore,
		private readonly events: TaskEventStore,
		private readonly mutationCoordinator: TaskMutationCoordinator,
		/** Delegates to Tasks.require() so Focus methods get the identical not-found/wrong-kind checks every other Tasks method already enforces, without duplicating that logic here. */
		private readonly requireTask: (id: string) => Artifact,
		/** Delegates to Tasks.list() for the projectRoot-membership check in focused() -- list() is itself part of the project-scope concern, not duplicated here. */
		private readonly listTasks: (filter?: TaskFilter) => Artifact[],
		/** Delegates to Tasks' own actor/source/sessionId/reason defaulting so every event this coordinator appends looks identical to one Tasks itself would have appended. */
		private readonly appendEvent: (event: Omit<AppendTaskEvent, "actor" | "source">, context: TaskEventContext) => void,
	) {}

	focused(filter?: TaskFilter): TaskFocus | null {
		const focus = this.focusStore.get(filter?.sessionId);
		if (!focus) return null;
		const task = this.artifacts.get(focus.taskId);
		if (task?.kind !== "task" || task.status === "done" || task.status === "canceled") {
			this.focusStore.clear(focus.taskId, filter?.sessionId);
			return null;
		}
		if (filter?.projectRoot && !this.listTasks(filter).some((candidate) => candidate.id === task.id)) return null;
		return {
			artifact: task,
			status: focus.status,
			updatedAt: focus.updatedAt,
			...(focus.pauseReason ? { pauseReason: focus.pauseReason } : {}),
		};
	}

	active(filter?: TaskFilter): Artifact | null {
		const focus = this.focused(filter);
		return focus?.status === "active" ? focus.artifact : null;
	}

	focus(id: string, context: TaskEventContext = {}): Artifact {
		return this.events.atomic(() => {
			const task = this.requireTask(id);
			if (task.status === "done" || task.status === "canceled") throw new Error(`cannot focus task from ${task.status}`);
			this.focusStore.set(id, context.sessionId);
			this.appendEvent({ taskId: id, type: "focus_set" }, context);
			return task;
		});
	}

	pauseFocus(context: TaskEventContext = {}, request: TaskMutationRequestContext = {}): TaskFocusMutationResult {
		const inspection = this.mutationCoordinator.prepare<TaskFocusMutationResult>("pause", undefined, context, request, false);
		if (inspection.replay) return inspection.replay;
		const focus = this.focused({ sessionId: context.sessionId });
		if (!focus) {
			throw new TaskInvalidTransitionError(
				"pause",
				"none",
				"paused",
				["focus"],
				"Focus a non-terminal task before pausing; do not blindly retry pause.",
			);
		}
		const prepared = inspection.pending
			? inspection
			: this.mutationCoordinator.prepare<TaskFocusMutationResult>("pause", undefined, context, request, true, () =>
					validateEventContext(context),
				);
		if (focus.status === "paused") {
			return this.mutationCoordinator.complete(prepared.record, {
				...focus,
				changed: false,
				operation: "pause",
				currentStatus: "paused",
				intendedStatus: "paused",
				...(prepared.record ? { receiptId: prepared.record.receiptId } : {}),
			});
		}
		return this.events.atomic(() => {
			const state = this.focusStore.pause(focus.artifact.id, context.reason, context.sessionId);
			this.appendEvent({ taskId: focus.artifact.id, type: "focus_paused" }, context);
			return this.mutationCoordinator.complete(prepared.record, {
				artifact: focus.artifact,
				status: state.status,
				updatedAt: state.updatedAt,
				...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
				changed: true,
				operation: "pause",
				currentStatus: "paused",
				intendedStatus: "paused",
				...(prepared.record ? { receiptId: prepared.record.receiptId } : {}),
			});
		});
	}

	unpauseFocus(context: TaskEventContext = {}, request: TaskMutationRequestContext = {}): TaskFocusMutationResult {
		const inspection = this.mutationCoordinator.prepare<TaskFocusMutationResult>("unpause", undefined, context, request, false);
		if (inspection.replay) return inspection.replay;
		const focus = this.focused({ sessionId: context.sessionId });
		if (!focus) {
			throw new TaskInvalidTransitionError(
				"unpause",
				"none",
				"active",
				["focus"],
				"Focus a non-terminal task before resuming; do not blindly retry unpause.",
			);
		}
		const prepared = inspection.pending
			? inspection
			: this.mutationCoordinator.prepare<TaskFocusMutationResult>("unpause", undefined, context, request, true, () =>
					validateEventContext(context),
				);
		if (focus.status === "active") {
			return this.mutationCoordinator.complete(prepared.record, {
				...focus,
				changed: false,
				operation: "unpause",
				currentStatus: "active",
				intendedStatus: "active",
				...(prepared.record ? { receiptId: prepared.record.receiptId } : {}),
			});
		}
		return this.events.atomic(() => {
			const state = this.focusStore.unpause(focus.artifact.id, context.sessionId);
			this.appendEvent({ taskId: focus.artifact.id, type: "focus_unpaused" }, context);
			return this.mutationCoordinator.complete(prepared.record, {
				artifact: focus.artifact,
				status: state.status,
				updatedAt: state.updatedAt,
				changed: true,
				operation: "unpause",
				currentStatus: "active",
				intendedStatus: "active",
				...(prepared.record ? { receiptId: prepared.record.receiptId } : {}),
			});
		});
	}

	clearFocus(context: TaskEventContext = {}): { cleared: boolean } {
		return this.events.atomic(() => {
			const focus = this.focusStore.get(context.sessionId);
			if (focus) this.appendEvent({ taskId: focus.taskId, type: "focus_cleared" }, context);
			this.focusStore.clear(undefined, context.sessionId);
			return { cleared: focus !== undefined };
		});
	}

	/**
	 * Time-based reclamation of Focus scopes nobody has touched in TASK_FOCUS_STALE_AFTER_MS,
	 * independent of and in addition to the TASK_FOCUS_MAX_SCOPES hard cap -- see
	 * clean-up-stale-per-session-task-focus-rows-on-real-session-l-9i7s and constants.ts's
	 * comment on why this is deliberately not driven by session_start/session_shutdown.
	 * No task-lifecycle event is appended: this is daemon housekeeping, not a caller-driven
	 * mutation, and there is no longer a specific session/actor to attribute it to.
	 */
	reapStaleFocus(now: () => string = () => new Date().toISOString()): number {
		const cutoff = new Date(new Date(now()).getTime() - TASK_FOCUS_STALE_AFTER_MS).toISOString();
		return this.focusStore.reapStale(cutoff);
	}
}
