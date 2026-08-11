import { describe, expect, it } from "bun:test";
import { logEvent, logger } from "../src/log/log.ts";

function captureStderr(run: () => void): string[] {
	const lines: string[] = [];
	const original = console.error;
	console.error = (line?: unknown) => {
		lines.push(String(line));
	};
	try {
		run();
	} finally {
		console.error = original;
	}
	return lines;
}

describe("Papyrus daemon logging", () => {
	it("emits credential-free structured continuation events", () => {
		const lines = captureStderr(() => {
			logEvent("info", "task_continuation_paused", { taskId: "task-1", reason: "turn-limit" });
		});
		const event = JSON.parse(lines[0]!) as Record<string, unknown>;
		// One deliberate, disclosed shape change from the old hand-rolled logEvent, matching
		// jittor/src/log.ts's own already-migrated convention: the event name is pino's `msg`
		// field now, not a separate `event` field. component/level and every other field are
		// unchanged.
		expect(event).toMatchObject({
			level: "info",
			component: "papyrus-daemon",
			msg: "task_continuation_paused",
			taskId: "task-1",
			reason: "turn-limit",
		});
		expect(lines[0]).not.toContain("token");
	});
});

describe("logger (the real @danypops/vehicle-server/logging Logger this daemon passes to createVehicleHttpApp)", () => {
	it("routes info/warn/error through the same structured sink, tagged component papyrus-daemon", () => {
		const lines = captureStderr(() => {
			logger.info("vehicle invoke failed: tasks.complete@1", { operationId: "op-1", code: "handler-failed" });
		});
		const event = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(event).toMatchObject({
			level: "info",
			component: "papyrus-daemon",
			msg: "vehicle invoke failed: tasks.complete@1",
			operationId: "op-1",
			code: "handler-failed",
		});
	});

	it("routes error() the same way, at the error level", () => {
		const lines = captureStderr(() => {
			logger.error("vehicle invoke failed: tasks.complete@1", { message: "boom" });
		});
		const event = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(event).toMatchObject({ level: "error", msg: "vehicle invoke failed: tasks.complete@1", message: "boom" });
	});

	it("debug() is a real level now (unlike the old hand-rolled logEvent, which had none) but stays silent at the default 'info' minimum level", () => {
		const lines = captureStderr(() => {
			logger.debug("should not appear at the default level");
		});
		expect(lines).toHaveLength(0);
	});
});
