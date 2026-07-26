import { TASK_LEASE_MAX_TTL_MS, TASK_LEASE_MIN_TTL_MS, TASK_LEASE_NOTE_MAX_LENGTH, TASK_LEASE_OWNER_MAX_LENGTH } from "../constants.ts";

/**
 * A bounded work reservation on a Task, independent of both the Task's own lifecycle status
 * and of per-scope Task Focus -- expresses "I intend to work this" for concurrent workers
 * coordinating over the same Task graph, without claiming the Task actually started or that
 * any particular session is looking at it.
 */
export interface TaskLease {
	taskId: string;
	owner: string;
	token: string;
	claimedAt: string;
	leaseExpiresAt: string;
	heartbeatAt?: string;
	note?: string;
}

export function validateLeaseOwner(owner: string): string {
	if (owner.length === 0 || owner.length > TASK_LEASE_OWNER_MAX_LENGTH) {
		throw new Error(`lease owner must be between 1 and ${TASK_LEASE_OWNER_MAX_LENGTH} characters`);
	}
	return owner;
}

export function validateLeaseNote(note: string | undefined): string | undefined {
	if (note !== undefined && note.length > TASK_LEASE_NOTE_MAX_LENGTH) {
		throw new Error(`lease note cannot exceed ${TASK_LEASE_NOTE_MAX_LENGTH} characters`);
	}
	return note;
}

export function validateLeaseTtlMs(ttlMs: number): number {
	if (!Number.isFinite(ttlMs) || ttlMs < TASK_LEASE_MIN_TTL_MS || ttlMs > TASK_LEASE_MAX_TTL_MS) {
		throw new Error(`lease ttl_ms must be between ${TASK_LEASE_MIN_TTL_MS} and ${TASK_LEASE_MAX_TTL_MS}`);
	}
	return ttlMs;
}

export function isLeaseExpired(lease: Pick<TaskLease, "leaseExpiresAt">, now: string): boolean {
	return lease.leaseExpiresAt <= now;
}
