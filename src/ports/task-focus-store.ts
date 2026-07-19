export interface TaskFocusStore {
	get(): string | undefined;
	set(taskId: string): void;
	clear(taskId?: string): void;
}

export class InMemoryTaskFocusStore implements TaskFocusStore {
	private taskId: string | undefined;

	get(): string | undefined {
		return this.taskId;
	}

	set(taskId: string): void {
		this.taskId = taskId;
	}

	clear(taskId?: string): void {
		if (taskId === undefined || taskId === this.taskId) this.taskId = undefined;
	}
}
