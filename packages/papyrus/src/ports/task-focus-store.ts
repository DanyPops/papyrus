import { TASK_FOCUS_DEFAULT_SCOPE, TASK_FOCUS_MAX_SCOPES, TASK_FOCUS_SCOPE_MAX_LENGTH } from "../constants.ts";

export type TaskFocusStatus = "active" | "paused";

export interface TaskFocusState {
	taskId: string;
	status: TaskFocusStatus;
	updatedAt: string;
	pauseReason?: string;
}

export function normalizeFocusScope(scope: string | undefined): string {
	const value = scope ?? TASK_FOCUS_DEFAULT_SCOPE;
	if (value.length === 0 || value.length > TASK_FOCUS_SCOPE_MAX_LENGTH) {
		throw new Error(`task focus scope must be between 1 and ${TASK_FOCUS_SCOPE_MAX_LENGTH} characters`);
	}
	return value;
}

/**
 * One Task Focus per scope. A scope defaults to "global" for callers that don't supply
 * a session id (CLI, legacy behavior) but is normally the requesting agent's session id,
 * so concurrent agents each get their own Focus instead of clobbering a shared singleton.
 */
export interface TaskFocusStore {
	get(scope?: string): TaskFocusState | undefined;
	set(taskId: string, scope?: string): TaskFocusState;
	pause(taskId: string, reason?: string, scope?: string): TaskFocusState;
	unpause(taskId: string, scope?: string): TaskFocusState;
	clear(taskId?: string, scope?: string): void;
	/** Clears this task's Focus in every scope (session), not just one — for lifecycle events (e.g. cancel) that are not scoped to a single caller. */
	clearEverywhere(taskId: string): void;
	/** Deletes every Focus row whose updatedAt is strictly before olderThanIso (see TASK_FOCUS_STALE_AFTER_MS). Returns how many rows were removed. */
	reapStale(olderThanIso: string): number;
}

export class InMemoryTaskFocusStore implements TaskFocusStore {
	private readonly state = new Map<string, TaskFocusState>();

	get(scope?: string): TaskFocusState | undefined { return this.state.get(normalizeFocusScope(scope)); }

	set(taskId: string, scope?: string): TaskFocusState {
		const key = normalizeFocusScope(scope);
		if (!this.state.has(key) && this.state.size >= TASK_FOCUS_MAX_SCOPES) this.evictOldest();
		const focus: TaskFocusState = { taskId, status: "active", updatedAt: new Date().toISOString() };
		this.state.set(key, focus);
		return focus;
	}

	pause(taskId: string, reason?: string, scope?: string): TaskFocusState {
		const key = normalizeFocusScope(scope);
		const current = this.state.get(key);
		if (current?.taskId !== taskId) throw new Error(`task "${taskId}" is not focused`);
		const focus: TaskFocusState = { ...current, status: "paused", updatedAt: new Date().toISOString(), ...(reason ? { pauseReason: reason } : {}) };
		this.state.set(key, focus);
		return focus;
	}

	unpause(taskId: string, scope?: string): TaskFocusState {
		const key = normalizeFocusScope(scope);
		const current = this.state.get(key);
		if (current?.taskId !== taskId) throw new Error(`task "${taskId}" is not focused`);
		const focus: TaskFocusState = { taskId, status: "active", updatedAt: new Date().toISOString() };
		this.state.set(key, focus);
		return focus;
	}

	clear(taskId?: string, scope?: string): void {
		const key = normalizeFocusScope(scope);
		if (taskId === undefined || this.state.get(key)?.taskId === taskId) this.state.delete(key);
	}

	clearEverywhere(taskId: string): void {
		for (const [key, focus] of this.state) {
			if (focus.taskId === taskId) this.state.delete(key);
		}
	}

	reapStale(olderThanIso: string): number {
		let removed = 0;
		for (const [key, focus] of this.state) {
			if (focus.updatedAt < olderThanIso) { this.state.delete(key); removed++; }
		}
		return removed;
	}

	private evictOldest(): void {
		let oldestKey: string | undefined;
		let oldestAt: string | undefined;
		for (const [key, focus] of this.state) {
			if (oldestAt === undefined || focus.updatedAt < oldestAt) { oldestKey = key; oldestAt = focus.updatedAt; }
		}
		if (oldestKey !== undefined) this.state.delete(oldestKey);
	}
}
