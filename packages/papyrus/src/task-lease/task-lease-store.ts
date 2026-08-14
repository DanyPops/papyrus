import { TASK_LEASE_DEFAULT_TTL_MS } from "../constants.ts";
import { isLeaseExpired, type TaskLease, validateLeaseNote, validateLeaseOwner, validateLeaseTtlMs } from "../task-lease/task-lease.ts";

export interface TaskLeaseStore {
	/**
	 * Creates a new lease, or renews the caller's own live lease in place (same token, extended
	 * expiry). Throws if a *different* owner already holds a live (non-expired) lease.
	 */
	claim(taskId: string, owner: string, ttlMs?: number, note?: string): TaskLease;
	/** Extends an existing live lease's expiry. Throws if no live lease exists, or owner/token do not match the current holder -- a stale or forged renewal must never silently succeed. */
	heartbeat(taskId: string, owner: string, token: string, ttlMs?: number): TaskLease;
	/** No-op (released: false) if no live lease exists. Throws if a live lease exists but owner/token do not match -- releasing a claim you don't hold is a real conflict, not a benign no-op. */
	release(taskId: string, owner: string, token: string): { released: boolean };
	/** The current live lease, or undefined if none exists or it has expired (an expired row reads as absent even before a reap sweep runs). */
	get(taskId: string): TaskLease | undefined;
	/** Deletes every lease row whose leaseExpiresAt is strictly before olderThanIso. Returns how many were removed. */
	reapExpired(olderThanIso: string): number;
}

function newToken(): string {
	return crypto.randomUUID();
}

export class InMemoryTaskLeaseStore implements TaskLeaseStore {
	private readonly leases = new Map<string, TaskLease>();

	claim(taskId: string, owner: string, ttlMs: number = TASK_LEASE_DEFAULT_TTL_MS, note?: string): TaskLease {
		validateLeaseOwner(owner);
		validateLeaseNote(note);
		validateLeaseTtlMs(ttlMs);
		const now = new Date();
		const nowIso = now.toISOString();
		const current = this.leases.get(taskId);
		if (current && !isLeaseExpired(current, nowIso) && current.owner !== owner) {
			throw new Error(`task "${taskId}" is already leased by "${current.owner}" until ${current.leaseExpiresAt}`);
		}
		const lease: TaskLease = {
			taskId,
			owner,
			token: current && !isLeaseExpired(current, nowIso) && current.owner === owner ? current.token : newToken(),
			claimedAt: current && !isLeaseExpired(current, nowIso) && current.owner === owner ? current.claimedAt : nowIso,
			leaseExpiresAt: new Date(now.getTime() + ttlMs).toISOString(),
			...(note !== undefined ? { note } : {}),
		};
		this.leases.set(taskId, lease);
		return lease;
	}

	heartbeat(taskId: string, owner: string, token: string, ttlMs: number = TASK_LEASE_DEFAULT_TTL_MS): TaskLease {
		validateLeaseTtlMs(ttlMs);
		const nowIso = new Date().toISOString();
		const current = this.leases.get(taskId);
		if (!current || isLeaseExpired(current, nowIso)) throw new Error(`task "${taskId}" has no live lease to renew`);
		if (current.owner !== owner || current.token !== token)
			throw new Error(`lease for task "${taskId}" is held by a different owner/token`);
		const renewed: TaskLease = { ...current, leaseExpiresAt: new Date(Date.now() + ttlMs).toISOString(), heartbeatAt: nowIso };
		this.leases.set(taskId, renewed);
		return renewed;
	}

	release(taskId: string, owner: string, token: string): { released: boolean } {
		const nowIso = new Date().toISOString();
		const current = this.leases.get(taskId);
		if (!current || isLeaseExpired(current, nowIso)) return { released: false };
		if (current.owner !== owner || current.token !== token)
			throw new Error(`lease for task "${taskId}" is held by a different owner/token`);
		this.leases.delete(taskId);
		return { released: true };
	}

	get(taskId: string): TaskLease | undefined {
		const current = this.leases.get(taskId);
		if (!current || isLeaseExpired(current, new Date().toISOString())) return undefined;
		return current;
	}

	reapExpired(olderThanIso: string): number {
		let removed = 0;
		for (const [taskId, lease] of this.leases) {
			if (lease.leaseExpiresAt < olderThanIso) {
				this.leases.delete(taskId);
				removed++;
			}
		}
		return removed;
	}
}
