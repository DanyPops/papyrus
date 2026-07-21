/**
 * graph-projection-service.ts — the generic graph projection protocol for external bounded
 * contexts. See src/domain/graph-projection.ts for the batch/checkpoint shapes and the
 * documented, deliberate scope limits of this first walking-skeleton slice.
 */
import { GRAPH_PROJECTION_ID_MAX_LENGTH, GRAPH_PROJECTION_MAX_ARTIFACTS_PER_BATCH, GRAPH_PROJECTION_MAX_EDGES_PER_BATCH } from "./constants.ts";
import { GRAPH_PROJECTION_SCHEMA_VERSION, type GraphProjectionBatch, type GraphProjectionResult } from "./domain/graph-projection.ts";
import type { ArtifactStore } from "./ports/artifact-store.ts";
import { requireAtomicArtifactStore } from "./ports/atomic-artifact-store.ts";
import type { GraphProjectionStore } from "./ports/graph-projection-store.ts";
import type { AuthorityRegistry } from "./authority-registry.ts";

function boundedId(value: string, label: string): string {
	if (!value || value.length === 0) throw new Error(`${label} is required`);
	if (value.length > GRAPH_PROJECTION_ID_MAX_LENGTH) throw new Error(`${label} exceeds ${GRAPH_PROJECTION_ID_MAX_LENGTH} characters`);
	return value;
}

export class GraphProjection {
	constructor(
		private readonly artifacts: ArtifactStore,
		private readonly store: GraphProjectionStore,
		private readonly authority: AuthorityRegistry,
	) {}

	checkpoint(producerId: string) {
		return this.store.getCheckpoint(boundedId(producerId, "producer_id"));
	}

	apply(batch: GraphProjectionBatch): GraphProjectionResult {
		if (batch.schemaVersion !== GRAPH_PROJECTION_SCHEMA_VERSION) {
			throw new Error(`unsupported graph projection schema version "${batch.schemaVersion}", expected "${GRAPH_PROJECTION_SCHEMA_VERSION}"`);
		}
		const producerId = boundedId(batch.producerId, "producer_id");
		const batchId = boundedId(batch.batchId, "batch_id");
		if (!Number.isInteger(batch.sequence) || batch.sequence < 1) throw new Error("sequence must be a positive integer");
		if (batch.artifacts.length > GRAPH_PROJECTION_MAX_ARTIFACTS_PER_BATCH) {
			throw new Error(`batch is bounded to ${GRAPH_PROJECTION_MAX_ARTIFACTS_PER_BATCH} artifacts; got ${batch.artifacts.length}`);
		}
		if (batch.edges.length > GRAPH_PROJECTION_MAX_EDGES_PER_BATCH) {
			throw new Error(`batch is bounded to ${GRAPH_PROJECTION_MAX_EDGES_PER_BATCH} edges; got ${batch.edges.length}`);
		}
		for (const artifact of batch.artifacts) boundedId(artifact.externalId, "artifact externalId");
		for (const edge of batch.edges) { boundedId(edge.from, "edge from"); boundedId(edge.to, "edge to"); }

		const existingCheckpoint = this.store.getCheckpoint(producerId);
		if (existingCheckpoint?.lastBatchId === batchId && existingCheckpoint.lastSequence === batch.sequence) {
			return { producerId, batchId, sequence: batch.sequence, artifactsUpserted: 0, artifactsCreated: 0, edgesUpserted: 0, alreadyApplied: true };
		}
		if (existingCheckpoint === null) {
			if (batch.sequence !== 1) throw new Error(`first batch for producer "${producerId}" must have sequence 1, got ${batch.sequence}`);
		} else {
			if (batch.sequence <= existingCheckpoint.lastSequence) {
				throw new Error(`stale batch: sequence ${batch.sequence} is not after checkpoint sequence ${existingCheckpoint.lastSequence} for producer "${producerId}"`);
			}
			if (batch.sequence > existingCheckpoint.lastSequence + 1) {
				throw new Error(`sequence gap for producer "${producerId}": expected ${existingCheckpoint.lastSequence + 1}, got ${batch.sequence}`);
			}
		}

		// Authority up front, before any write: a producer that doesn't own a subtype/relation
		// it's trying to project into must fail closed, not partially apply then fail midway.
		for (const artifact of batch.artifacts) this.authority.requireArtifactAllowed(artifact.kind, artifact.subtype, "create", producerId);
		for (const edge of batch.edges) this.authority.requireRelationAllowed(edge.relation, "link", producerId);

		const atomic = requireAtomicArtifactStore(this.artifacts);
		let artifactsCreated = 0;
		let artifactsUpserted = 0;
		let edgesUpserted = 0;
		atomic.atomic(() => {
			for (const projected of batch.artifacts) {
				const existingId = this.store.resolveIdentity(producerId, projected.externalId);
				if (existingId) {
					this.artifacts.updateContent(existingId, { title: projected.title, body: projected.body, labels: projected.labels ? [...projected.labels] : undefined });
					if (projected.extra !== undefined) this.artifacts.setExtra(existingId, projected.extra);
				} else {
					const created = this.artifacts.create({
						kind: projected.kind,
						subtype: projected.subtype,
						title: projected.title,
						body: projected.body,
						labels: projected.labels ? [...projected.labels] : undefined,
						extra: projected.extra,
					});
					this.store.recordIdentity(producerId, projected.externalId, created.id);
					artifactsCreated++;
				}
				artifactsUpserted++;
			}
			for (const edge of batch.edges) {
				const fromId = this.store.resolveIdentity(producerId, edge.from);
				if (!fromId) throw new Error(`edge references unknown externalId "${edge.from}" for producer "${producerId}"`);
				const toId = this.store.resolveIdentity(producerId, edge.to);
				if (!toId) throw new Error(`edge references unknown externalId "${edge.to}" for producer "${producerId}"`);
				this.artifacts.link({ from: fromId, relation: edge.relation, to: toId });
				edgesUpserted++;
			}
			this.store.commitCheckpoint({ producerId, lastSequence: batch.sequence, lastBatchId: batchId, appliedAt: new Date().toISOString() });
		});

		return { producerId, batchId, sequence: batch.sequence, artifactsUpserted, artifactsCreated, edgesUpserted, alreadyApplied: false };
	}
}
