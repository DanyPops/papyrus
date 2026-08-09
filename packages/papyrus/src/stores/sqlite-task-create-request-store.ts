import type { Db } from "../db.ts";
import type { TaskCreateRequestRecord, TaskCreateRequestStore } from "./task-create-request-store.ts";

export class SQLiteTaskCreateRequestStore implements TaskCreateRequestStore {
	constructor(private readonly db: Db) {}

	get(scope: string, key: string, now: string): TaskCreateRequestRecord | undefined {
		const row = this.db
			.prepare(`
				SELECT request_scope, idempotency_key, request_hash, response_json, created_at, expires_at
				FROM task_create_requests
				WHERE request_scope = ? AND idempotency_key = ? AND expires_at > ?
			`)
			.get(scope, key, now) as {
			request_scope: string;
			idempotency_key: string;
			request_hash: string;
			response_json: string;
			created_at: string;
			expires_at: string;
		} | null;
		return row
			? {
					scope: row.request_scope,
					key: row.idempotency_key,
					requestHash: row.request_hash,
					responseJson: row.response_json,
					createdAt: row.created_at,
					expiresAt: row.expires_at,
				}
			: undefined;
	}

	put(record: TaskCreateRequestRecord): void {
		this.db
			.prepare(`
				INSERT INTO task_create_requests
					(request_scope, idempotency_key, request_hash, response_json, created_at, expires_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`)
			.run(record.scope, record.key, record.requestHash, record.responseJson, record.createdAt, record.expiresAt);
	}

	prune(now: string): number {
		return this.db.prepare("DELETE FROM task_create_requests WHERE expires_at <= ?").run(now).changes;
	}
}
