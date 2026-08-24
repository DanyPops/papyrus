import { PAPYRUS_TASK_FOCUS_CHANNEL, PAPYRUS_TASK_FOCUS_SCHEMA } from "@danypops/papyrus";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type TaskFocusStatus = "focused" | "paused" | "unpaused" | "cleared";

/**
 * A Task's own declared effort convention (`extra.effort`) -- Papyrus's core schema and
 * validation know nothing about this value; it is genuine free-form `extra` JSON, the same
 * mechanism `gates`/`checklist` already use. This module only reads it, opaquely, to relay it
 * on the task-focus broadcast when present; Papyrus never assigns or requires it.
 */
export const TASK_DECLARED_EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type TaskDeclaredEffort = (typeof TASK_DECLARED_EFFORT_LEVELS)[number];

/** Returns the task's own declared `extra.effort` when it is one of the recognized values, or undefined otherwise -- an absent or malformed value is silently omitted, never guessed or defaulted. */
export function extractDeclaredEffort(extra: Record<string, unknown> | undefined): TaskDeclaredEffort | undefined {
	const value = extra?.effort;
	return typeof value === "string" && (TASK_DECLARED_EFFORT_LEVELS as readonly string[]).includes(value)
		? (value as TaskDeclaredEffort)
		: undefined;
}

export interface TaskFocusEvent {
	schema: typeof PAPYRUS_TASK_FOCUS_SCHEMA;
	taskId: string | null;
	sessionId?: string;
	status: TaskFocusStatus;
	observedAt: number;
	/** The focused task's own declared `extra.effort`, when it has one -- omitted (never null) otherwise, matching this payload's existing minimalism. */
	effort?: TaskDeclaredEffort;
}

export interface TaskFocusEventInput {
	taskId: string | null;
	sessionId?: string;
	status: TaskFocusStatus;
	observedAt?: number;
	effort?: TaskDeclaredEffort;
}

/**
 * Pure event builder, mirroring buildContextInjection's shape: no task title, body, or any other
 * artifact content -- only the id, session, lifecycle status, timestamp, and (when the task
 * declares one) its own bounded effort enum, which are already public metadata a caller with the
 * id could look up directly. This is the payload emitted on papyrus.task-focus.v1, the analogue
 * of papyrus.context-injection.v1, so extensions such as a token-cost router can correlate their
 * own telemetry with the currently focused task -- and now its declared effort -- without
 * Papyrus depending on them.
 */
export function buildTaskFocusEvent(input: TaskFocusEventInput): TaskFocusEvent {
	if (input.status !== "cleared" && input.taskId === null)
		throw new Error(`task-focus event of status "${input.status}" requires a taskId`);
	return {
		schema: PAPYRUS_TASK_FOCUS_SCHEMA,
		taskId: input.taskId,
		status: input.status,
		observedAt: input.observedAt ?? Date.now(),
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
		...(input.effort === undefined ? {} : { effort: input.effort }),
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
