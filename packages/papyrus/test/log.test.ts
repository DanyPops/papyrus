import { describe, expect, it } from "bun:test";
import { logEvent, vehicleLogger } from "../src/log.ts";

describe("Papyrus daemon logging", () => {
	it("emits credential-free structured continuation events", () => {
		const lines: string[] = [];
		const original = console.error;
		console.error = (line?: unknown) => {
			lines.push(String(line));
		};
		try {
			logEvent("info", "task_continuation_paused", { taskId: "task-1", reason: "turn-limit" });
		} finally {
			console.error = original;
		}
		const event = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(event).toMatchObject({
			level: "info",
			component: "papyrus-daemon",
			event: "task_continuation_paused",
			taskId: "task-1",
			reason: "turn-limit",
		});
		expect(lines[0]).not.toContain("token");
	});
});

describe("vehicleLogger", () => {
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

	it("routes info/warn/error through logEvent's own structured sink, tagged component papyrus-daemon", () => {
		const logger = vehicleLogger();
		const lines = captureStderr(() => {
			logger.info("vehicle invoke failed: tasks.complete@1", { operationId: "op-1", code: "handler-failed" });
		});
		const event = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(event).toMatchObject({
			level: "info",
			component: "papyrus-daemon",
			event: "vehicle invoke failed: tasks.complete@1",
			operationId: "op-1",
			code: "handler-failed",
		});
	});

	it("routes error() the same way, at the error level", () => {
		const logger = vehicleLogger();
		const lines = captureStderr(() => {
			logger.error("vehicle invoke failed: tasks.complete@1", { message: "boom" });
		});
		const event = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(event).toMatchObject({ level: "error", event: "vehicle invoke failed: tasks.complete@1", message: "boom" });
	});

	it("debug() is a no-op -- this daemon's structured log has no debug level", () => {
		const logger = vehicleLogger();
		const lines = captureStderr(() => {
			logger.debug("should not appear");
		});
		expect(lines).toHaveLength(0);
	});
});
