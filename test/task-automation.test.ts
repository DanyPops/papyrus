import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteTaskEventStore } from "../src/adapters/sqlite-task-event-store.ts";
import { SQLiteTaskFocusStore } from "../src/adapters/sqlite-task-focus-store.ts";
import { TaskAutomationReconciler, scheduleTaskAutomation, taskAutomationSettings, type TaskAutomationSettings } from "../src/task-automation.ts";
import { openDb } from "../src/db.ts";
import type { GateResult } from "../src/domain/gate.ts";
import type { GateRunner } from "../src/ports/gate-runner.ts";
import { Tasks } from "../src/task-service.ts";

const enabled: TaskAutomationSettings = {
	enabled: true,
	intervalMs: 60_000,
	maxTasksPerSweep: 10,
	gateConcurrency: 1,
	maxRuntimeMs: 120_000,
};

function fixture(results: (id: string) => GateResult[] = () => []) {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const events = new SQLiteTaskEventStore(db);
	const gates: GateRunner = { run: results, runAsync: async (id) => results(id) };
	const tasks = new Tasks(artifacts, gates, new SQLiteTaskFocusStore(db), events);
	return { db, tasks };
}

function review(tasks: Tasks, title: string, automation = true) {
	const task = tasks.create({ title, extra: { automation: { enabled: automation } } });
	tasks.transition(task.id, "start");
	tasks.transition(task.id, "submit");
	return task;
}

describe("supervised task graph reconciliation", () => {
	it("parses a secure default and rejects invalid or unbounded daemon settings", () => {
		expect(taskAutomationSettings({})).toMatchObject({ enabled: false, maxTasksPerSweep: 10, gateConcurrency: 1 });
		expect(taskAutomationSettings({ PAPYRUS_AUTOMATION_ENABLED: "1", PAPYRUS_AUTOMATION_MAX_TASKS: "2" })).toMatchObject({ enabled: true, maxTasksPerSweep: 2 });
		expect(() => taskAutomationSettings({ PAPYRUS_AUTOMATION_ENABLED: "true" })).toThrow("must be 0 or 1");
		expect(() => taskAutomationSettings({ PAPYRUS_AUTOMATION_MAX_TASKS: "101" })).toThrow("between 1 and 100");
	});

	it("schedules bounded periodic sweeps only when globally enabled", async () => {
		let callback: (() => void) | undefined;
		let cleared = false;
		let sweeps = 0;
		const scheduler = {
			setInterval(next: () => void, intervalMs: number) { callback = next; expect(intervalMs).toBe(enabled.intervalMs); return "timer"; },
			clearInterval(handle: unknown) { expect(handle).toBe("timer"); cleared = true; },
		};
		const stopDisabled = scheduleTaskAutomation({ ...enabled, enabled: false }, async () => { sweeps += 1; }, () => {}, scheduler);
		expect(callback).toBeUndefined();
		stopDisabled();
		const stop = scheduleTaskAutomation(enabled, async () => { sweeps += 1; }, () => {}, scheduler);
		callback?.();
		await Promise.resolve();
		expect(sweeps).toBe(1);
		stop();
		expect(cleared).toBe(true);
	});

	it("is globally off by default and ignores tasks without per-task opt-in", async () => {
		const { tasks } = fixture();
		const optedIn = review(tasks, "Opted in");
		const disabled = new TaskAutomationReconciler(tasks, { ...enabled, enabled: false });
		expect(await disabled.reconcile()).toMatchObject({ skipped: "disabled", examined: 0 });
		expect(tasks.show(optedIn.id).status).toBe("review");

		const manual = review(tasks, "Manual", false);
		expect(await new TaskAutomationReconciler(tasks, enabled).reconcile()).toMatchObject({ completed: 1 });
		expect(tasks.show(manual.id).status).toBe("review");
	});

	it("completes opted-in review tasks and starts newly ready opted-in successors", async () => {
		const { tasks } = fixture();
		const prerequisite = review(tasks, "Prerequisite");
		const successor = tasks.create({
			title: "Successor",
			extra: { automation: { enabled: true } },
			dependsOn: [prerequisite.id],
		});

		const result = await new TaskAutomationReconciler(tasks, enabled).reconcile();

		expect(result).toMatchObject({ examined: 1, completed: 1, rejected: 0, started: 1 });
		expect(tasks.show(prerequisite.id).status).toBe("done");
		expect(tasks.show(successor.id).status).toBe("in-progress");
		const history = tasks.history(successor.id, { direction: "asc" }).events;
		expect(history.at(-1)).toMatchObject({ type: "started", actor: "daemon", source: "automation-reconciler" });
	});

	it("bounds tasks per sweep and records failed gate review evidence", async () => {
		const { tasks } = fixture(() => [{ gate: { type: "command", target: "false" }, passed: false, output: "failed" }]);
		const first = review(tasks, "First");
		const second = review(tasks, "Second");
		const result = await new TaskAutomationReconciler(tasks, { ...enabled, maxTasksPerSweep: 1 }).reconcile();
		expect(result.examined).toBe(1);
		const changed = [first, second].find((task) => tasks.show(task.id).status === "rejected")!;
		expect([tasks.show(first.id).status, tasks.show(second.id).status].sort()).toEqual(["rejected", "review"]);
		expect(tasks.history(changed.id).events[0]).toMatchObject({ type: "review_rejected", source: "automation-reconciler" });
	});

	it("prevents overlapping sweeps", async () => {
		let release!: () => void;
		const wait = new Promise<void>((resolve) => { release = resolve; });
		const { tasks } = fixture();
		const original = tasks.completeAsync.bind(tasks);
		tasks.completeAsync = async (...args) => { await wait; return original(...args); };
		review(tasks, "Slow");
		const reconciler = new TaskAutomationReconciler(tasks, enabled);
		const first = reconciler.reconcile();
		await Promise.resolve();
		expect(await reconciler.reconcile()).toMatchObject({ skipped: "in-flight", examined: 0 });
		release();
		await first;
	});
});
