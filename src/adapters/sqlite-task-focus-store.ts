import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import type { TaskFocusStore } from "../ports/task-focus-store.ts";

export class SQLiteTaskFocusStore implements TaskFocusStore {
	constructor(private readonly db: Db) {}

	get(): string | undefined {
		const row = this.db.prepare("SELECT task_id FROM task_focus WHERE scope = 'global'").get() as
			| { task_id: string }
			| null;
		return row?.task_id;
	}

	set(taskId: string): void {
		inTransaction(this.db, () => {
			this.db.prepare(`
				INSERT INTO task_focus (scope, task_id, updated_at)
				VALUES ('global', ?, ?)
				ON CONFLICT(scope) DO UPDATE SET task_id = excluded.task_id, updated_at = excluded.updated_at
			`).run(taskId, new Date().toISOString());
		});
	}

	clear(taskId?: string): void {
		inTransaction(this.db, () => {
			if (taskId === undefined) this.db.prepare("DELETE FROM task_focus WHERE scope = 'global'").run();
			else this.db.prepare("DELETE FROM task_focus WHERE scope = 'global' AND task_id = ?").run(taskId);
		});
	}
}
