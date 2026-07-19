export type TaskFocusStatus = "active" | "paused";

export interface TaskFocusState {
	taskId: string;
	status: TaskFocusStatus;
	updatedAt: string;
	pauseReason?: string;
}

export interface TaskFocusStore {
	get(): TaskFocusState | undefined;
	set(taskId: string): TaskFocusState;
	pause(taskId: string, reason?: string): TaskFocusState;
	unpause(taskId: string): TaskFocusState;
	clear(taskId?: string): void;
}

export class InMemoryTaskFocusStore implements TaskFocusStore {
	private state: TaskFocusState | undefined;

	get(): TaskFocusState | undefined { return this.state; }

	set(taskId: string): TaskFocusState {
		this.state = { taskId, status: "active", updatedAt: new Date().toISOString() };
		return this.state;
	}

	pause(taskId: string, reason?: string): TaskFocusState {
		if (this.state?.taskId !== taskId) throw new Error(`task "${taskId}" is not focused`);
		this.state = { ...this.state, status: "paused", updatedAt: new Date().toISOString(), ...(reason ? { pauseReason: reason } : {}) };
		return this.state;
	}

	unpause(taskId: string): TaskFocusState {
		if (this.state?.taskId !== taskId) throw new Error(`task "${taskId}" is not focused`);
		this.state = { taskId, status: "active", updatedAt: new Date().toISOString() };
		return this.state;
	}

	clear(taskId?: string): void {
		if (taskId === undefined || this.state?.taskId === taskId) this.state = undefined;
	}
}
