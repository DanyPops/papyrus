import { TASK_LEASE_DEFAULT_TTL_MS } from "../../constants.ts";
import type { Db } from "../../db.ts";
import { inTransaction } from "../../db.ts";
import { isLeaseExpired, type TaskLease, validateLeaseNote, validateLeaseOwner, validateLeaseTtlMs } from "./task-lease.ts";
import type { TaskLeaseStore } from "./task-lease-store.ts";

interface TaskLeaseRow {
	task_id: string;
	owner: string;
	token: string;
	claimed_at: string;
	lease_expires_at: string;
	heartbeat_at: string | null;
	note: string | null;
}

function fromRow(row: TaskLeaseRow): TaskLease {
	return {
		taskId: row.task_id,
		owner: row.owner,
		token: row.token,
		claimedAt: row.claimed_at,
		leaseExpiresAt: row.lease_expires_at,
		...(row.heartbeat_at ? { heartbeatAt: row.heartbeat_at } : {}),
		...(row.note ? { note: row.note } : {}),
	};
}

export class SQLiteTaskLeaseStore implements TaskLeaseStore {
	constructor(private readonly db: Db) {}

	private row(taskId: string): TaskLeaseRow | undefined {
		return (this.db.prepare("SELECT * FROM task_leases WHERE task_id = ?").get(taskId) as TaskLeaseRow | null) ?? undefined;
	}

	claim(taskId: string, owner: string, ttlMs: number = TASK_LEASE_DEFAULT_TTL_MS, note?: string): TaskLease {
		validateLeaseOwner(owner);
		validateLeaseNote(note);
		validateLeaseTtlMs(ttlMs);
		return inTransaction(this.db, () => {
			const now = new Date();
			const nowIso = now.toISOString();
			const existing = this.row(taskId);
			const current = existing ? fromRow(existing) : undefined;
			if (current && !isLeaseExpired(current, nowIso) && current.owner !== owner) {
				throw new Error(`task "${taskId}" is already leased by "${current.owner}" until ${current.leaseExpiresAt}`);
			}
			const renewingSameOwner = current !== undefined && !isLeaseExpired(current, nowIso) && current.owner === owner;
			const token = renewingSameOwner ? current!.token : crypto.randomUUID();
			const claimedAt = renewingSameOwner ? current!.claimedAt : nowIso;
			const leaseExpiresAt = new Date(now.getTime() + ttlMs).toISOString();
			this.db
				.prepare(`
				INSERT INTO task_leases (task_id, owner, token, claimed_at, lease_expires_at, heartbeat_at, note)
				VALUES (?, ?, ?, ?, ?, NULL, ?)
				ON CONFLICT(task_id) DO UPDATE SET owner = excluded.owner, token = excluded.token, claimed_at = excluded.claimed_at,
					lease_expires_at = excluded.lease_expires_at, heartbeat_at = NULL, note = excluded.note
			`)
				.run(taskId, owner, token, claimedAt, leaseExpiresAt, note ?? null);
			return fromRow(this.row(taskId)!);
		});
	}

	heartbeat(taskId: string, owner: string, token: string, ttlMs: number = TASK_LEASE_DEFAULT_TTL_MS): TaskLease {
		validateLeaseTtlMs(ttlMs);
		return inTransaction(this.db, () => {
			const nowIso = new Date().toISOString();
			const existing = this.row(taskId);
			const current = existing ? fromRow(existing) : undefined;
			if (!current || isLeaseExpired(current, nowIso)) throw new Error(`task "${taskId}" has no live lease to renew`);
			if (current.owner !== owner || current.token !== token)
				throw new Error(`lease for task "${taskId}" is held by a different owner/token`);
			const leaseExpiresAt = new Date(Date.now() + ttlMs).toISOString();
			this.db
				.prepare("UPDATE task_leases SET lease_expires_at = ?, heartbeat_at = ? WHERE task_id = ?")
				.run(leaseExpiresAt, nowIso, taskId);
			return fromRow(this.row(taskId)!);
		});
	}

	release(taskId: string, owner: string, token: string): { released: boolean } {
		return inTransaction(this.db, () => {
			const nowIso = new Date().toISOString();
			const existing = this.row(taskId);
			const current = existing ? fromRow(existing) : undefined;
			if (!current || isLeaseExpired(current, nowIso)) return { released: false };
			if (current.owner !== owner || current.token !== token)
				throw new Error(`lease for task "${taskId}" is held by a different owner/token`);
			this.db.prepare("DELETE FROM task_leases WHERE task_id = ?").run(taskId);
			return { released: true };
		});
	}

	get(taskId: string): TaskLease | undefined {
		const existing = this.row(taskId);
		if (!existing) return undefined;
		const lease = fromRow(existing);
		return isLeaseExpired(lease, new Date().toISOString()) ? undefined : lease;
	}

	reapExpired(olderThanIso: string): number {
		return this.db.prepare("DELETE FROM task_leases WHERE lease_expires_at < ?").run(olderThanIso).changes;
	}
}
