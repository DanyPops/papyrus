import { describe, expect, it } from "bun:test";
import { TaskDriver, type ActiveTaskMarker } from "../extension/src/task-driver.ts";

const active = (updatedAt = "2026-01-01T00:00:00.000Z"): ActiveTaskMarker[] => [
	{ id: "task-1", title: "Implement workflow", updated_at: updatedAt },
];

describe("Papyrus task driver", () => {
	it("continues one next turn only when active tasks remain and Pi is settled", () => {
		const driver = new TaskDriver({ maxTurns: 10, maxUnchangedTurns: 4 });

		expect(driver.evaluate(active(), { idle: false, pendingMessages: false }).action).toBe("wait");
		expect(driver.evaluate(active(), { idle: true, pendingMessages: true }).action).toBe("wait");
		const continuation = driver.evaluate(active(), { idle: true, pendingMessages: false });
		expect(continuation.action).toBe("continue");
		expect(continuation.prompt).toContain("Implement workflow");
		expect(driver.evaluate(active(), { idle: true, pendingMessages: false }).reason).toBe("continuation already queued");
		driver.onAgentStart();
		expect(driver.evaluate([], { idle: true, pendingMessages: false }).reason).toBe("no active tasks");
	});

	it("pauses after bounded unchanged turns and resumes when task progress changes", () => {
		const driver = new TaskDriver({ maxTurns: 10, maxUnchangedTurns: 2 });

		expect(driver.evaluate(active(), { idle: true, pendingMessages: false }).action).toBe("continue");
		driver.onAgentStart();
		expect(driver.evaluate(active(), { idle: true, pendingMessages: false }).action).toBe("continue");
		driver.onAgentStart();
		expect(driver.evaluate(active(), { idle: true, pendingMessages: false }).action).toBe("pause");
		expect(driver.status().pausedReason).toContain("no task progress");

		expect(driver.evaluate(active("2026-01-01T00:01:00.000Z"), { idle: true, pendingMessages: false }).action).toBe("continue");
		expect(driver.status().pausedReason).toBeUndefined();
	});

	it("caps consecutive turns and lets human input reset or disable driving", () => {
		const driver = new TaskDriver({ maxTurns: 2, maxUnchangedTurns: 10 });
		for (let attempt = 0; attempt < 2; attempt++) {
			expect(driver.evaluate(active(`2026-01-01T00:0${attempt}:00.000Z`), { idle: true, pendingMessages: false }).action).toBe("continue");
			driver.onAgentStart();
		}
		expect(driver.evaluate(active("2026-01-01T00:02:00.000Z"), { idle: true, pendingMessages: false }).action).toBe("pause");

		driver.onHumanInput();
		expect(driver.evaluate(active("2026-01-01T00:02:00.000Z"), { idle: true, pendingMessages: false }).action).toBe("continue");
		driver.setEnabled(false);
		driver.onAgentStart();
		expect(driver.evaluate(active(), { idle: true, pendingMessages: false }).reason).toBe("disabled");
		expect(driver.status().enabled).toBe(false);
	});
});
