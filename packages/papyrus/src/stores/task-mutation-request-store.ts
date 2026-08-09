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
		this.records.set(this.recordKey(record.scope, record.key), { ...record });
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
