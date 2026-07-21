import { TASK_FOCUS_MAX_SCOPES } from "../constants.ts";
import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import { normalizeFocusScope, type TaskFocusState, type TaskFocusStatus, type TaskFocusStore } from "../ports/task-focus-store.ts";

export class SQLiteTaskFocusStore implements TaskFocusStore {
	constructor(private readonly db: Db) {}

	get(scope?: string): TaskFocusState | undefined {
		const row = this.db.prepare("SELECT task_id, status, pause_reason, updated_at FROM task_focus WHERE scope = ?").get(normalizeFocusScope(scope)) as
			| { task_id: string; status: TaskFocusStatus; pause_reason: string | null; updated_at: string }
			| null;
		return row ? { taskId: row.task_id, status: row.status, updatedAt: row.updated_at, ...(row.pause_reason ? { pauseReason: row.pause_reason } : {}) } : undefined;
	}

	set(taskId: string, scope?: string): TaskFocusState { return this.write(taskId, "active", scope); }
	pause(taskId: string, reason?: string, scope?: string): TaskFocusState { return this.transition(taskId, "active", "paused", reason, scope); }
	unpause(taskId: string, scope?: string): TaskFocusState { return this.transition(taskId, "paused", "active", undefined, scope); }

	clear(taskId?: string, scope?: string): void {
		const key = normalizeFocusScope(scope);
		inTransaction(this.db, () => {
			if (taskId === undefined) this.db.prepare("DELETE FROM task_focus WHERE scope = ?").run(key);
			else this.db.prepare("DELETE FROM task_focus WHERE scope = ? AND task_id = ?").run(key, taskId);
		});
	}

	clearEverywhere(taskId: string): void {
		inTransaction(this.db, () => {
			this.db.prepare("DELETE FROM task_focus WHERE task_id = ?").run(taskId);
		});
	}

	private transition(taskId: string, expected: TaskFocusStatus, status: TaskFocusStatus, reason: string | undefined, scope: string | undefined): TaskFocusState {
		const current = this.get(scope);
		if (current?.taskId !== taskId) throw new Error(`task "${taskId}" is not focused`);
		if (current.status !== expected) throw new Error(`focus is ${current.status}, expected ${expected}`);
		return this.write(taskId, status, scope, reason);
	}

	/** Bounds distinct concurrent focus scopes (sessions); evicts the least-recently-updated scope beyond the cap. */
	private evictOldestBeyondCap(key: string): void {
		const exists = this.db.prepare("SELECT 1 FROM task_focus WHERE scope = ?").get(key);
		if (exists) return;
		const count = (this.db.prepare("SELECT COUNT(*) AS count FROM task_focus").get() as { count: number }).count;
		if (count < TASK_FOCUS_MAX_SCOPES) return;
		this.db.exec("DELETE FROM task_focus WHERE scope = (SELECT scope FROM task_focus ORDER BY updated_at ASC LIMIT 1)");
	}

	private write(taskId: string, status: TaskFocusStatus, scope: string | undefined, pauseReason?: string): TaskFocusState {
		const key = normalizeFocusScope(scope);
		const updatedAt = new Date().toISOString();
		inTransaction(this.db, () => {
			this.evictOldestBeyondCap(key);
			this.db.prepare(`
				INSERT INTO task_focus (scope, task_id, status, pause_reason, updated_at)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(scope) DO UPDATE SET task_id = excluded.task_id, status = excluded.status, pause_reason = excluded.pause_reason, updated_at = excluded.updated_at
			`).run(key, taskId, status, pauseReason ?? null, updatedAt);
		});
		return { taskId, status, updatedAt, ...(pauseReason ? { pauseReason } : {}) };
	}
}
