import type { Db } from "../db.ts";
import { TaskMutationPendingError, type TaskMutationRequestRecord, type TaskMutationRequestStore } from "../task-mutation-request/task-mutation-request-store.ts";

interface TaskMutationRequestRow {
	request_scope: string;
	idempotency_key: string;
	receipt_id: string;
	task_id: string | null;
	operation: string;
	request_hash: string;
	state: "pending" | "completed";
	response_json: string | null;
	created_at: string;
	updated_at: string;
	expires_at: string;
}

function mapRow(row: TaskMutationRequestRow): TaskMutationRequestRecord {
	return {
		scope: row.request_scope,
		key: row.idempotency_key,
		receiptId: row.receipt_id,
		...(row.task_id === null ? {} : { taskId: row.task_id }),
		operation: row.operation,
		requestHash: row.request_hash,
		state: row.state,
		...(row.response_json === null ? {} : { responseJson: row.response_json }),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		expiresAt: row.expires_at,
	};
}

export class SQLiteTaskMutationRequestStore implements TaskMutationRequestStore {
	constructor(private readonly db: Db) {}

	get(scope: string, key: string, now: string): TaskMutationRequestRecord | undefined {
		const row = this.db
			.prepare("SELECT * FROM task_mutation_requests WHERE request_scope = ? AND idempotency_key = ? AND expires_at > ?")
			.get(scope, key, now) as TaskMutationRequestRow | null;
		return row ? mapRow(row) : undefined;
	}

	findPending(taskId: string, operation: string, now: string): TaskMutationRequestRecord | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM task_mutation_requests WHERE task_id = ? AND operation = ? AND state = 'pending' AND expires_at > ? ORDER BY created_at LIMIT 1",
			)
			.get(taskId, operation, now) as TaskMutationRequestRow | null;
		return row ? mapRow(row) : undefined;
	}

	put(record: TaskMutationRequestRecord): void {
		try {
			this.db
				.prepare(`
					INSERT INTO task_mutation_requests (
						request_scope, idempotency_key, receipt_id, task_id, operation, request_hash,
						state, response_json, created_at, updated_at, expires_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`)
				.run(
					record.scope,
					record.key,
					record.receiptId,
					record.taskId ?? null,
					record.operation,
					record.requestHash,
					record.state,
					record.responseJson ?? null,
					record.createdAt,
					record.updatedAt,
					record.expiresAt,
				);
		} catch (error) {
			const pending = record.taskId ? this.findPending(record.taskId, record.operation, record.createdAt) : undefined;
			if (pending) {
				throw new TaskMutationPendingError(`an earlier ${record.operation} outcome is still pending`, pending.receiptId, pending.operation);
			}
			throw error;
		}
	}

	complete(scope: string, key: string, responseJson: string, updatedAt: string): void {
		const result = this.db
			.prepare(`
				UPDATE task_mutation_requests
				SET state = 'completed', response_json = ?, updated_at = ?
				WHERE request_scope = ? AND idempotency_key = ?
			`)
			.run(responseJson, updatedAt, scope, key);
		if (result.changes !== 1) throw new Error("task mutation receipt not found");
	}

	prune(now: string): number {
		return this.db.prepare("DELETE FROM task_mutation_requests WHERE expires_at <= ?").run(now).changes;
	}
}
