import { describe, expect, it } from "bun:test";
import { logEvent } from "../src/log.ts";

describe("Papyrus daemon logging", () => {
	it("emits credential-free structured continuation events", () => {
		const lines: string[] = [];
		const original = console.error;
		console.error = (line?: unknown) => { lines.push(String(line)); };
		try {
			logEvent("info", "task_continuation_paused", { taskId: "task-1", reason: "turn-limit" });
		} finally {
			console.error = original;
		}
		const event = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(event).toMatchObject({ level: "info", component: "papyrus-daemon", event: "task_continuation_paused", taskId: "task-1", reason: "turn-limit" });
		expect(lines[0]).not.toContain("token");
	});
});
