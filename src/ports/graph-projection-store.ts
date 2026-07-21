import type { ProjectionCheckpoint } from "../domain/graph-projection.ts";

/**
 * Producer-scoped state a graph projection consumer needs beyond the generic ArtifactStore:
 * the (producerId, externalId) -> Papyrus artifact id identity map, and the per-producer
 * checkpoint. This is projection-specific bookkeeping, not Context Mesh content itself, so
 * it is its own small port rather than bloating ArtifactStore.
 */
export interface GraphProjectionStore {
	getCheckpoint(producerId: string): ProjectionCheckpoint | null;
	resolveIdentity(producerId: string, externalId: string): string | undefined;
	/** Idempotent: recording the same (producerId, externalId) -> artifactId mapping twice is a no-op. */
	recordIdentity(producerId: string, externalId: string, artifactId: string): void;
	commitCheckpoint(checkpoint: ProjectionCheckpoint): void;
}
