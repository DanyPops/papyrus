import { afterEach, describe, expect, it } from "bun:test";
import { PAPYRUS_TASK_FOCUS_CHANNEL, PAPYRUS_TASK_FOCUS_SCHEMA } from "@danypops/papyrus";
import {
	buildTaskFocusEvent,
	emitTaskFocusEvent,
	extractDeclaredEffort,
	resetTaskFocusEventBusForTests,
	setTaskFocusEventBus,
} from "../extension/src/task/task-focus-events.ts";

afterEach(() => resetTaskFocusEventBusForTests());

describe("Papyrus task-focus event", () => {
	it("builds a content-free payload: id, session, status, and timestamp only", () => {
		const event = buildTaskFocusEvent({ taskId: "ship-feature-x", sessionId: "session-1", status: "focused", observedAt: 1_000 });
		expect(event).toEqual({
			schema: PAPYRUS_TASK_FOCUS_SCHEMA,
			taskId: "ship-feature-x",
			sessionId: "session-1",
			status: "focused",
			observedAt: 1_000,
		});
	});

	it("omits sessionId entirely when unknown, rather than emitting null or empty string", () => {
		const event = buildTaskFocusEvent({ taskId: "ship-feature-x", status: "focused", observedAt: 1_000 });
		expect(event).not.toHaveProperty("sessionId");
	});

	it("allows a null taskId only for cleared, since clearing does not require knowing which task was focused", () => {
		expect(buildTaskFocusEvent({ taskId: null, status: "cleared", observedAt: 1_000 })).toMatchObject({ taskId: null, status: "cleared" });
		expect(() => buildTaskFocusEvent({ taskId: null, status: "focused", observedAt: 1_000 })).toThrow("requires a taskId");
		expect(() => buildTaskFocusEvent({ taskId: null, status: "paused", observedAt: 1_000 })).toThrow("requires a taskId");
		expect(() => buildTaskFocusEvent({ taskId: null, status: "unpaused", observedAt: 1_000 })).toThrow("requires a taskId");
	});

	it("defaults observedAt to now when omitted", () => {
		const before = Date.now();
		const event = buildTaskFocusEvent({ taskId: "t1", status: "focused" });
		expect(event.observedAt).toBeGreaterThanOrEqual(before);
	});

	it("carries the focused task's own declared effort when given one", () => {
		const event = buildTaskFocusEvent({ taskId: "t1", status: "focused", observedAt: 1_000, effort: "high" });
		expect(event.effort).toBe("high");
	});

	it("omits effort entirely when the task declares none, rather than emitting null", () => {
		const event = buildTaskFocusEvent({ taskId: "t1", status: "focused", observedAt: 1_000 });
		expect(event).not.toHaveProperty("effort");
	});

	it("emits on the shared bus once a host is registered, and is a safe no-op before one is", () => {
		expect(() => emitTaskFocusEvent({ taskId: "t1", status: "focused" })).not.toThrow();
		const emitted: Array<{ channel: string; payload: unknown }> = [];
		setTaskFocusEventBus({ events: { emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }) } as any });
		emitTaskFocusEvent({ taskId: "t1", sessionId: "s1", status: "focused", observedAt: 2_000 });
		expect(emitted).toEqual([
			{
				channel: PAPYRUS_TASK_FOCUS_CHANNEL,
				payload: { schema: PAPYRUS_TASK_FOCUS_SCHEMA, taskId: "t1", sessionId: "s1", status: "focused", observedAt: 2_000 },
			},
		]);
	});

	it("forwards the focused task's own declared effort onto the emitted payload", () => {
		const emitted: Array<{ channel: string; payload: unknown }> = [];
		setTaskFocusEventBus({ events: { emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }) } as any });
		emitTaskFocusEvent({ taskId: "t1", status: "focused", observedAt: 2_000, effort: "high" });
		expect(emitted[0]!.payload).toMatchObject({ effort: "high" });
	});
});

describe("extractDeclaredEffort", () => {
	it("reads a recognized extra.effort value", () => {
		expect(extractDeclaredEffort({ effort: "low" })).toBe("low");
		expect(extractDeclaredEffort({ effort: "medium" })).toBe("medium");
		expect(extractDeclaredEffort({ effort: "high" })).toBe("high");
	});

	it("returns undefined for a missing, malformed, or unrecognized value, never guessing", () => {
		expect(extractDeclaredEffort(undefined)).toBeUndefined();
		expect(extractDeclaredEffort({})).toBeUndefined();
		expect(extractDeclaredEffort({ effort: "extreme" })).toBeUndefined();
		expect(extractDeclaredEffort({ effort: 3 })).toBeUndefined();
		expect(extractDeclaredEffort({ effort: null })).toBeUndefined();
	});
});
