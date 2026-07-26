import type { ArtifactEventContext } from "../domain/artifact-event.ts";
import type { ArtifactTrashRecord } from "../domain/artifact-trash.ts";

/** Trash lifecycle for artifacts -- split out of ArtifactStore since only the composition root
 * (daemon.ts, service.ts) needs it; every domain-service module depends on core CRUD/graph only. */
export interface ArtifactTrashStore {
	/** See domain/artifact-trash.ts. Moves an artifact to the trash; throws if it does not exist or is the live Task Focus in any scope. */
	trash(id: string, options?: { reason?: string; context?: ArtifactEventContext }): ArtifactTrashRecord;
	/** Idempotent: restoring an artifact that is not currently trashed is a real no-op. */
	restore(id: string, context?: ArtifactEventContext): { restored: boolean };
	trashStatus(id: string): ArtifactTrashRecord | null;
	listTrash(): ArtifactTrashRecord[];
	/** Real, cascading, irreversible deletion of every artifact past its purge deadline; returns how many were purged. */
	purgeDueTrash(): number;
}
