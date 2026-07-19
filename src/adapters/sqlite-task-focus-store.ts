import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import type { TaskFocusState, TaskFocusStatus, TaskFocusStore } from "../ports/task-focus-store.ts";

export class SQLiteTaskFocusStore implements TaskFocusStore {
	constructor(private readonly db: Db) {}

	get(): TaskFocusState | undefined {
		const row = this.db.prepare("SELECT task_id, status, pause_reason, updated_at FROM task_focus WHERE scope = 'global'").get() as
			| { task_id: string; status: TaskFocusStatus; pause_reason: string | null; updated_at: string }
			| null;
		return row ? { taskId: row.task_id, status: row.status, updatedAt: row.updated_at, ...(row.pause_reason ? { pauseReason: row.pause_reason } : {}) } : undefined;
	}

	set(taskId: string): TaskFocusState { return this.write(taskId, "active"); }
	pause(taskId: string, reason?: string): TaskFocusState { return this.transition(taskId, "active", "paused", reason); }
	unpause(taskId: string): TaskFocusState { return this.transition(taskId, "paused", "active"); }

	clear(taskId?: string): void {
		inTransaction(this.db, () => {
			if (taskId === undefined) this.db.prepare("DELETE FROM task_focus WHERE scope = 'global'").run();
			else this.db.prepare("DELETE FROM task_focus WHERE scope = 'global' AND task_id = ?").run(taskId);
		});
	}

	private transition(taskId: string, expected: TaskFocusStatus, status: TaskFocusStatus, reason?: string): TaskFocusState {
		const current = this.get();
		if (current?.taskId !== taskId) throw new Error(`task "${taskId}" is not focused`);
		if (current.status !== expected) throw new Error(`focus is ${current.status}, expected ${expected}`);
		return this.write(taskId, status, reason);
	}

	private write(taskId: string, status: TaskFocusStatus, pauseReason?: string): TaskFocusState {
		const updatedAt = new Date().toISOString();
		inTransaction(this.db, () => {
			this.db.prepare(`
				INSERT INTO task_focus (scope, task_id, status, pause_reason, updated_at)
				VALUES ('global', ?, ?, ?, ?)
				ON CONFLICT(scope) DO UPDATE SET task_id = excluded.task_id, status = excluded.status, pause_reason = excluded.pause_reason, updated_at = excluded.updated_at
			`).run(taskId, status, pauseReason ?? null, updatedAt);
		});
		return { taskId, status, updatedAt, ...(pauseReason ? { pauseReason } : {}) };
	}
}
