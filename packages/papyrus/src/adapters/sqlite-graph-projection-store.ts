import type { Db } from "../db.ts";
import { inTransaction } from "../db.ts";
import type { ProjectionCheckpoint } from "../domain/graph-projection.ts";
import type { GraphProjectionStore } from "../ports/graph-projection-store.ts";

export class SQLiteGraphProjectionStore implements GraphProjectionStore {
	constructor(private readonly db: Db) {}

	getCheckpoint(producerId: string): ProjectionCheckpoint | null {
		const row = this.db.prepare("SELECT producer_id, last_sequence, last_batch_id, applied_at FROM graph_projection_checkpoints WHERE producer_id = ?").get(producerId) as
			| { producer_id: string; last_sequence: number; last_batch_id: string; applied_at: string }
			| null;
		if (row == null) return null;
		return { producerId: row.producer_id, lastSequence: row.last_sequence, lastBatchId: row.last_batch_id, appliedAt: row.applied_at };
	}

	resolveIdentity(producerId: string, externalId: string): string | undefined {
		const row = this.db.prepare("SELECT artifact_id FROM graph_projection_identities WHERE producer_id = ? AND external_id = ?").get(producerId, externalId) as
			| { artifact_id: string }
			| null;
		return row?.artifact_id;
	}

	recordIdentity(producerId: string, externalId: string, artifactId: string): void {
		inTransaction(this.db, () => {
			this.db.prepare(`
				INSERT INTO graph_projection_identities (producer_id, external_id, artifact_id) VALUES (?, ?, ?)
				ON CONFLICT(producer_id, external_id) DO UPDATE SET artifact_id = excluded.artifact_id
			`).run(producerId, externalId, artifactId);
		});
	}

	commitCheckpoint(checkpoint: ProjectionCheckpoint): void {
		inTransaction(this.db, () => {
			this.db.prepare(`
				INSERT INTO graph_projection_checkpoints (producer_id, last_sequence, last_batch_id, applied_at) VALUES (?, ?, ?, ?)
				ON CONFLICT(producer_id) DO UPDATE SET last_sequence = excluded.last_sequence, last_batch_id = excluded.last_batch_id, applied_at = excluded.applied_at
			`).run(checkpoint.producerId, checkpoint.lastSequence, checkpoint.lastBatchId, checkpoint.appliedAt);
		});
	}
}
