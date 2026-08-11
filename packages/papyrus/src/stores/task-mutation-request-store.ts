export type TaskMutationRequestState = "pending" | "completed";

export interface TaskMutationRequestRecord {
	scope: string;
	key: string;
	receiptId: string;
	taskId?: string;
	operation: string;
	requestHash: string;
	state: TaskMutationRequestState;
	responseJson?: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
}

export interface TaskMutationRequestStore {
	get(scope: string, key: string, now: string): TaskMutationRequestRecord | undefined;
	findPending(taskId: string, operation: string, now: string): TaskMutationRequestRecord | undefined;
	put(record: TaskMutationRequestRecord): void;
	complete(scope: string, key: string, responseJson: string, updatedAt: string): void;
	prune(now: string): number;
}

export class TaskMutationIdempotencyConflictError extends Error {}

export class TaskMutationPendingError extends Error {
	constructor(
		message: string,
		readonly receiptId: string,
		readonly operation: string,
	) {
		super(message);
	}
}

export class InMemoryTaskMutationRequestStore implements TaskMutationRequestStore {
	private readonly records = new Map<string, TaskMutationRequestRecord>();

	private recordKey(scope: string, key: string): string {
		return `${scope}\u0000${key}`;
	}

	get(scope: string, key: string, now: string): TaskMutationRequestRecord | undefined {
		const record = this.records.get(this.recordKey(scope, key));
		return !record || record.expiresAt <= now ? undefined : { ...record };
	}

	findPending(taskId: string, operation: string, now: string): TaskMutationRequestRecord | undefined {
		for (const record of this.records.values()) {
			if (record.taskId === taskId && record.operation === operation && record.state === "pending" && record.expiresAt > now) {
				return { ...record };
			}
		}
		return undefined;
	}

	put(record: TaskMutationRequestRecord): void {
		// Checked in the same order sqlite-task-mutation-request-store.ts's own catch-and-reclassify
		// does: a still-pending (taskId, operation) always becomes the more specific
		// TaskMutationPendingError first, regardless of which underlying constraint actually
		// collided (SQLite's partial unique pending index, or the PRIMARY KEY check below).
		if (record.state === "pending" && record.taskId) {
			const existing = this.findPending(record.taskId, record.operation, record.createdAt);
			if (existing) {
				throw new TaskMutationPendingError(
					`an earlier ${record.operation} outcome is still pending`,
					existing.receiptId,
					existing.operation,
				);
			}
		}
		// Mirror SQLite's own PRIMARY KEY (request_scope, idempotency_key): a genuine duplicate
		// (scope, key) is always rejected, never silently overwritten -- SQLite throws on any such
		// collision regardless of whether the colliding row's other columns match, so this does too,
		// rather than only checking receiptId. Every real write path already dedupes via
		// mutationRequests.get() before ever calling put() twice for the same (scope, key)
		// (task-service.ts's prepareMutation()), so this is unreachable through normal application
		// flow today -- it only guards a caller that talks to the store interface directly.
		const recordKey = this.recordKey(record.scope, record.key);
		if (this.records.has(recordKey)) {
			throw new Error(`task mutation request already exists for scope "${record.scope}" key "${record.key}"`);
		}
		this.records.set(recordKey, { ...record });
	}

	complete(scope: string, key: string, responseJson: string, updatedAt: string): void {
		const recordKey = this.recordKey(scope, key);
		const record = this.records.get(recordKey);
		if (!record) throw new Error("task mutation receipt not found");
		this.records.set(recordKey, { ...record, state: "completed", responseJson, updatedAt });
	}

	prune(now: string): number {
		let removed = 0;
		for (const [key, record] of this.records) {
			if (record.expiresAt <= now) {
				this.records.delete(key);
				removed += 1;
			}
		}
		return removed;
	}
}
