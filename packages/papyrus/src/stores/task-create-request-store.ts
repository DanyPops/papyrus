export interface TaskCreateRequestRecord {
	scope: string;
	key: string;
	requestHash: string;
	responseJson: string;
	createdAt: string;
	expiresAt: string;
}

export interface TaskCreateRequestStore {
	get(scope: string, key: string, now: string): TaskCreateRequestRecord | undefined;
	put(record: TaskCreateRequestRecord): void;
	prune(now: string): number;
}

export class TaskCreateIdempotencyConflictError extends Error {}

export class InMemoryTaskCreateRequestStore implements TaskCreateRequestStore {
	private readonly records = new Map<string, TaskCreateRequestRecord>();

	private recordKey(scope: string, key: string): string {
		return `${scope}\u0000${key}`;
	}

	get(scope: string, key: string, now: string): TaskCreateRequestRecord | undefined {
		const record = this.records.get(this.recordKey(scope, key));
		if (!record || record.expiresAt <= now) return undefined;
		return record;
	}

	put(record: TaskCreateRequestRecord): void {
		this.records.set(this.recordKey(record.scope, record.key), record);
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
