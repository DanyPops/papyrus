import type { Artifact } from "../artifact/artifact.ts";
import type { TaskLease, TaskLeaseView } from "./lease/task-lease.ts";
import type { TaskLeaseStore } from "./lease/task-lease-store.ts";

/**
 * Task lease management (claim/heartbeat/release/get/reap) -- a single active worker per task,
 * TTL-based. Orthogonal to lifecycle and Focus: claiming a task does not start it or require it
 * to be Focused.
 */
export class TaskLeaseCoordinator {
	constructor(
		private readonly leases: TaskLeaseStore,
		/** Delegates to Tasks.require() so lease methods get the identical not-found/wrong-kind checks every other Tasks method already enforces, without duplicating that logic here. */
		private readonly requireTask: (id: string) => Artifact,
	) {}

	private present(lease: TaskLease): TaskLeaseView {
		const task = this.requireTask(lease.taskId);
		const { taskId: _taskId, ...details } = lease;
		return { taskName: task.alias, taskTitle: task.title, ...details };
	}

	/** A lease is orthogonal to lifecycle and Focus: claiming a task does not start it, and does not require it to be Focused. */
	claim(id: string, owner: string, ttlMs?: number, note?: string): TaskLeaseView {
		this.requireTask(id);
		return this.present(this.leases.claim(id, owner, ttlMs, note));
	}

	heartbeat(id: string, owner: string, token: string, ttlMs?: number): TaskLeaseView {
		this.requireTask(id);
		return this.present(this.leases.heartbeat(id, owner, token, ttlMs));
	}

	/** Idempotent for an already-absent or already-expired lease, matching undepend/uncontain's precedent -- never throws merely because there was nothing left to release. */
	release(id: string, owner: string, token: string): { released: boolean } {
		this.requireTask(id);
		return this.leases.release(id, owner, token);
	}

	get(id: string): TaskLeaseView | undefined {
		this.requireTask(id);
		const lease = this.leases.get(id);
		return lease ? this.present(lease) : undefined;
	}

	reapStale(now: () => string = () => new Date().toISOString()): number {
		return this.leases.reapExpired(now());
	}
}
