import { createHash } from "node:crypto";
import type { ArtifactStore } from "../artifact/artifact-store.ts";
import { TASK_MUTATION_IDEMPOTENCY_KEY_MAX_LENGTH, TASK_MUTATION_IDEMPOTENCY_RETENTION_MS } from "../constants.ts";
import {
	TaskMutationIdempotencyConflictError,
	TaskMutationPendingError,
	type TaskMutationRequestRecord,
	type TaskMutationRequestStore,
} from "./mutation-request/task-mutation-request-store.ts";

export class TaskMutationReceiptNotFoundError extends Error {}

export interface TaskMutationRequestContext {
	key?: string;
	caller?: string;
}

export interface TaskMutationReceiptView {
	receiptId: string;
	operation: string;
	state: "pending" | "completed";
	taskName?: string;
	taskTitle?: string;
	taskStatus?: string;
	result?: unknown;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/**
 * Idempotency-key-backed mutation receipt plumbing: reserves a "pending" receipt before a real
 * mutation runs, replays an already-completed one, rejects a different payload reused under the
 * same key, and rejects a new attempt against a task+operation that already has one in flight.
 *
 * `validate`, when passed to prepare(), runs before the existing/replay lookup, so a
 * caller-supplied validation failure can never leave a receipt reserved with no way to complete
 * it -- a stuck pending receipt blocks every later attempt on that task+operation, under any key,
 * until its retention window expires, with no self-service recovery. Any caller that can
 * determine its own event-context validity up front should pass `validate` here rather than
 * validating only once real mutation work is underway.
 */
export class TaskMutationCoordinator {
	constructor(
		private readonly mutationRequests: TaskMutationRequestStore,
		private readonly artifacts: ArtifactStore,
	) {}

	prepare<Result>(
		operation: string,
		taskId: string | undefined,
		payload: unknown,
		request: TaskMutationRequestContext,
		reserve = true,
		validate?: () => void,
	): { record?: TaskMutationRequestRecord; replay?: Result; pending?: boolean } {
		validate?.();
		const key = request.key?.trim();
		if (request.key !== undefined && (!key || key.length > TASK_MUTATION_IDEMPOTENCY_KEY_MAX_LENGTH)) {
			throw new Error(`idempotency key must be between 1 and ${TASK_MUTATION_IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
		}
		if (!key) return {};
		const now = new Date().toISOString();
		const scope = request.caller?.trim() || "anonymous";
		const requestHash = createHash("sha256").update(canonicalJson({ operation, taskId, payload })).digest("hex");
		this.mutationRequests.prune(now);
		const existing = this.mutationRequests.get(scope, key, now);
		if (existing) {
			if (existing.requestHash !== requestHash) {
				throw new TaskMutationIdempotencyConflictError(`idempotency key "${key}" was already used with a different mutation payload`);
			}
			if (existing.state === "completed" && existing.responseJson !== undefined) {
				const replay = JSON.parse(existing.responseJson) as Result;
				return {
					record: existing,
					replay:
						typeof replay === "object" && replay !== null && "changed" in replay
							? ({ ...replay, changed: false, replayed: true } as Result)
							: replay,
				};
			}
			return { record: existing, pending: true };
		}
		if (!reserve) return {};
		const record: TaskMutationRequestRecord = {
			scope,
			key,
			receiptId: crypto.randomUUID(),
			...(taskId === undefined ? {} : { taskId }),
			operation,
			requestHash,
			state: "pending",
			createdAt: now,
			updatedAt: now,
			expiresAt: new Date(Date.parse(now) + TASK_MUTATION_IDEMPOTENCY_RETENTION_MS).toISOString(),
		};
		this.mutationRequests.put(record);
		return { record };
	}

	rejectDifferentPending(taskId: string, operation: string, inspectionPending: boolean): void {
		if (inspectionPending) return;
		const pending = this.mutationRequests.findPending(taskId, operation, new Date().toISOString());
		if (!pending) return;
		throw new TaskMutationPendingError(
			`an earlier ${operation} outcome is still pending; inspect tasks.mutation_status with its original idempotency_key before retrying`,
			pending.receiptId,
			pending.operation,
		);
	}

	complete<Result>(record: TaskMutationRequestRecord | undefined, result: Result): Result {
		if (!record) return result;
		this.mutationRequests.complete(record.scope, record.key, JSON.stringify(result), new Date().toISOString());
		return result;
	}

	status(keyInput: string, caller?: string): TaskMutationReceiptView {
		const key = keyInput.trim();
		if (!key || key.length > TASK_MUTATION_IDEMPOTENCY_KEY_MAX_LENGTH) {
			throw new Error(`idempotency key must be between 1 and ${TASK_MUTATION_IDEMPOTENCY_KEY_MAX_LENGTH} characters`);
		}
		const now = new Date().toISOString();
		const record = this.mutationRequests.get(caller?.trim() || "anonymous", key, now);
		if (!record) throw new TaskMutationReceiptNotFoundError("no retained task mutation receipt exists for this idempotency key");
		const task = record.taskId ? this.artifacts.get(record.taskId) : null;
		return {
			receiptId: record.receiptId,
			operation: record.operation,
			state: record.state,
			...(task?.kind === "task" ? { taskName: task.alias, taskTitle: task.title, taskStatus: task.status } : {}),
			...(record.responseJson === undefined ? {} : { result: JSON.parse(record.responseJson) as unknown }),
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			expiresAt: record.expiresAt,
		};
	}
}
