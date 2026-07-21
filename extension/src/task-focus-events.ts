import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PAPYRUS_TASK_FOCUS_CHANNEL, PAPYRUS_TASK_FOCUS_SCHEMA } from "../../src/constants.ts";

export type TaskFocusStatus = "focused" | "paused" | "unpaused" | "cleared";

export interface TaskFocusEvent {
	schema: typeof PAPYRUS_TASK_FOCUS_SCHEMA;
	taskId: string | null;
	sessionId?: string;
	status: TaskFocusStatus;
	observedAt: number;
}

export interface TaskFocusEventInput {
	taskId: string | null;
	sessionId?: string;
	status: TaskFocusStatus;
	observedAt?: number;
}

/**
 * Pure event builder, mirroring buildContextInjection's shape: no task title, body, or any other
 * artifact content -- only the id, session, lifecycle status, and timestamp, which are already
 * public metadata a caller with the id could look up directly. This is the payload emitted on
 * papyrus.task-focus.v1, the analogue of papyrus.context-injection.v1, so extensions such as a
 * token-cost router can correlate their own telemetry with the currently focused task without
 * Papyrus depending on them.
 */
export function buildTaskFocusEvent(input: TaskFocusEventInput): TaskFocusEvent {
	if (input.status !== "cleared" && input.taskId === null) throw new Error(`task-focus event of status "${input.status}" requires a taskId`);
	return {
		schema: PAPYRUS_TASK_FOCUS_SCHEMA,
		taskId: input.taskId,
		status: input.status,
		observedAt: input.observedAt ?? Date.now(),
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
	};
}

type EventBusHost = Pick<ExtensionAPI, "events">;

let bus: EventBusHost | undefined;

/** Call once from the extension entry point so call sites that only receive `ctx` (not `pi`) can still emit. */
export function setTaskFocusEventBus(host: EventBusHost): void {
	bus = host;
}

export function resetTaskFocusEventBusForTests(): void {
	bus = undefined;
}

/** Best-effort broadcast: never throws, since a missing bus (e.g. an uninitialized test harness) must not break the focus operation it accompanies. */
export function emitTaskFocusEvent(input: TaskFocusEventInput): void {
	if (!bus) return;
	bus.events.emit(PAPYRUS_TASK_FOCUS_CHANNEL, buildTaskFocusEvent(input));
}
