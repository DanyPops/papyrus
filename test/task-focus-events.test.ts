import { describe, expect, it, afterEach } from "bun:test";
import {
	buildTaskFocusEvent,
	emitTaskFocusEvent,
	resetTaskFocusEventBusForTests,
	setTaskFocusEventBus,
} from "../extension/src/task-focus-events.ts";
import { PAPYRUS_TASK_FOCUS_CHANNEL, PAPYRUS_TASK_FOCUS_SCHEMA } from "../src/constants.ts";

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
		expect(() => buildTaskFocusEvent({ taskId: null, status: "focused", observedAt: 1_000 })).toThrow('requires a taskId');
		expect(() => buildTaskFocusEvent({ taskId: null, status: "paused", observedAt: 1_000 })).toThrow('requires a taskId');
		expect(() => buildTaskFocusEvent({ taskId: null, status: "unpaused", observedAt: 1_000 })).toThrow('requires a taskId');
	});

	it("defaults observedAt to now when omitted", () => {
		const before = Date.now();
		const event = buildTaskFocusEvent({ taskId: "t1", status: "focused" });
		expect(event.observedAt).toBeGreaterThanOrEqual(before);
	});

	it("emits on the shared bus once a host is registered, and is a safe no-op before one is", () => {
		expect(() => emitTaskFocusEvent({ taskId: "t1", status: "focused" })).not.toThrow();
		const emitted: Array<{ channel: string; payload: unknown }> = [];
		setTaskFocusEventBus({ events: { emit: (channel: string, payload: unknown) => emitted.push({ channel, payload }) } as any });
		emitTaskFocusEvent({ taskId: "t1", sessionId: "s1", status: "focused", observedAt: 2_000 });
		expect(emitted).toEqual([{
			channel: PAPYRUS_TASK_FOCUS_CHANNEL,
			payload: { schema: PAPYRUS_TASK_FOCUS_SCHEMA, taskId: "t1", sessionId: "s1", status: "focused", observedAt: 2_000 },
		}]);
	});
});
