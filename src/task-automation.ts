import {
	TASK_AUTOMATION_ERROR_ID_MAX_LENGTH,
	TASK_AUTOMATION_ERROR_MESSAGE_MAX_LENGTH,
	TASK_AUTOMATION_GATE_CONCURRENCY,
	TASK_AUTOMATION_HARD_MAX_RUNTIME_MS,
	TASK_AUTOMATION_HARD_MAX_TASKS_PER_SWEEP,
	TASK_AUTOMATION_INTERVAL_MS,
	TASK_AUTOMATION_MAX_CANDIDATE_SCAN,
	TASK_AUTOMATION_MAX_GATE_CONCURRENCY,
	TASK_AUTOMATION_MAX_INTERVAL_MS,
	TASK_AUTOMATION_MAX_RUNTIME_MS,
	TASK_AUTOMATION_MAX_TASKS_PER_SWEEP,
	TASK_AUTOMATION_MIN_INTERVAL_MS,
} from "./constants.ts";
import type { Artifact } from "./domain/artifact.ts";
import { projectTaskExecution } from "./task-execution.ts";
import type { Tasks } from "./task-service.ts";

export interface TaskAutomationSettings {
	enabled: boolean;
	intervalMs: number;
	maxTasksPerSweep: number;
	gateConcurrency: number;
	maxRuntimeMs: number;
}

export interface TaskAutomationResult {
	skipped?: "disabled" | "in-flight";
	examined: number;
	completed: number;
	rejected: number;
	started: number;
	errors: Array<{ taskId: string; message: string }>;
	timedOut: boolean;
}

function boundedInteger(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const source = env[name];
	if (source === undefined || source === "") return fallback;
	const value = Number(source);
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
	}
	return value;
}

export function taskAutomationSettings(env: Record<string, string | undefined> = process.env): TaskAutomationSettings {
	const enabled = env["PAPYRUS_AUTOMATION_ENABLED"] === "1";
	if (env["PAPYRUS_AUTOMATION_ENABLED"] !== undefined && env["PAPYRUS_AUTOMATION_ENABLED"] !== "0" && !enabled) {
		throw new Error("PAPYRUS_AUTOMATION_ENABLED must be 0 or 1");
	}
	return {
		enabled,
		intervalMs: boundedInteger(env, "PAPYRUS_AUTOMATION_INTERVAL_MS", TASK_AUTOMATION_INTERVAL_MS, TASK_AUTOMATION_MIN_INTERVAL_MS, TASK_AUTOMATION_MAX_INTERVAL_MS),
		maxTasksPerSweep: boundedInteger(env, "PAPYRUS_AUTOMATION_MAX_TASKS", TASK_AUTOMATION_MAX_TASKS_PER_SWEEP, 1, TASK_AUTOMATION_HARD_MAX_TASKS_PER_SWEEP),
		gateConcurrency: boundedInteger(env, "PAPYRUS_AUTOMATION_GATE_CONCURRENCY", TASK_AUTOMATION_GATE_CONCURRENCY, 1, TASK_AUTOMATION_MAX_GATE_CONCURRENCY),
		maxRuntimeMs: boundedInteger(env, "PAPYRUS_AUTOMATION_MAX_RUNTIME_MS", TASK_AUTOMATION_MAX_RUNTIME_MS, 1, TASK_AUTOMATION_HARD_MAX_RUNTIME_MS),
	};
}

function automationEnabled(task: Artifact): boolean {
	const automation = task.extra["automation"];
	return typeof automation === "object"
		&& automation !== null
		&& !Array.isArray(automation)
		&& (automation as Record<string, unknown>)["enabled"] === true;
}

function emptyResult(skipped?: TaskAutomationResult["skipped"]): TaskAutomationResult {
	return { ...(skipped ? { skipped } : {}), examined: 0, completed: 0, rejected: 0, started: 0, errors: [], timedOut: false };
}

function boundedError(taskId: string, error: unknown): TaskAutomationResult["errors"][number] {
	const message = error instanceof Error ? error.message : String(error);
	return {
		taskId: taskId.slice(0, TASK_AUTOMATION_ERROR_ID_MAX_LENGTH),
		message: message.slice(0, TASK_AUTOMATION_ERROR_MESSAGE_MAX_LENGTH),
	};
}

export interface TaskAutomationScheduler {
	setInterval(callback: () => void, intervalMs: number): unknown;
	clearInterval(handle: unknown): void;
}

const SYSTEM_SCHEDULER: TaskAutomationScheduler = {
	setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
	clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function scheduleTaskAutomation(
	settings: TaskAutomationSettings,
	sweep: () => Promise<unknown>,
	onError: (error: unknown) => void,
	scheduler: TaskAutomationScheduler = SYSTEM_SCHEDULER,
): () => void {
	if (!settings.enabled) return () => {};
	const handle = scheduler.setInterval(() => { void sweep().catch(onError); }, settings.intervalMs);
	return () => scheduler.clearInterval(handle);
}

export class TaskAutomationReconciler {
	private inFlight = false;

	constructor(
		private readonly tasks: Tasks,
		private readonly settings: TaskAutomationSettings,
		private readonly now: () => number = () => Date.now(),
	) {}

	status(): TaskAutomationSettings & { inFlight: boolean } {
		return { ...this.settings, inFlight: this.inFlight };
	}

	async reconcile(): Promise<TaskAutomationResult> {
		if (!this.settings.enabled) return emptyResult("disabled");
		if (this.inFlight) return emptyResult("in-flight");
		this.inFlight = true;
		try { return await this.runSweep(); }
		finally { this.inFlight = false; }
	}

	private async runSweep(): Promise<TaskAutomationResult> {
		const result = emptyResult();
		const deadline = this.now() + this.settings.maxRuntimeMs;
		const candidates = this.tasks.list({ status: "review", limit: TASK_AUTOMATION_MAX_CANDIDATE_SCAN })
			.filter(automationEnabled)
			.sort((left, right) => left.id.localeCompare(right.id))
			.slice(0, this.settings.maxTasksPerSweep);
		const completedIds = new Set<string>();

		for (let offset = 0; offset < candidates.length; offset += this.settings.gateConcurrency) {
			if (this.now() >= deadline) { result.timedOut = true; break; }
			const batch = candidates.slice(offset, offset + this.settings.gateConcurrency);
			await Promise.all(batch.map(async (task) => {
				result.examined += 1;
				try {
					const completion = await this.tasks.completeAsync(task.id, {
						actor: "daemon",
						source: "automation-reconciler",
						reason: "automation-enabled review reconciliation",
					}, { focusSuccessor: false, gateDeadlineMs: deadline });
					if (completion.completed) {
						result.completed += 1;
						completedIds.add(task.id);
					} else result.rejected += 1;
				} catch (error) {
					result.errors.push(boundedError(task.id, error));
				}
			}));
		}

		let remaining = Math.max(0, this.settings.maxTasksPerSweep - result.examined);
		if (remaining > 0 && completedIds.size > 0 && this.now() < deadline) {
			let graph: ReturnType<Tasks["graph"]>;
			try { graph = this.tasks.graph(); }
			catch (error) {
				result.errors.push(boundedError("graph", error));
				return result;
			}
			const stateById = new Map(projectTaskExecution(graph).nodes.map((node) => [node.id, node.state]));
			for (const node of [...graph.nodes].sort((left, right) => left.task.id.localeCompare(right.task.id))) {
				if (remaining === 0 || this.now() >= deadline) break;
				if (node.task.status !== "todo" || !automationEnabled(node.task) || stateById.get(node.task.id) !== "ready") continue;
				if (!node.dependencyIds.some((id) => completedIds.has(id))) continue;
				try {
					this.tasks.transition(node.task.id, "start", {
						actor: "daemon",
						source: "automation-reconciler",
						reason: "automation-enabled successor became ready",
					});
					result.started += 1;
					remaining -= 1;
				} catch (error) {
					result.errors.push(boundedError(node.task.id, error));
				}
			}
		}
		if (this.now() >= deadline) result.timedOut = true;
		return result;
	}
}
