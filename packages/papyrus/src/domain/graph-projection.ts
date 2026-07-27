/**
 * domain/graph-projection.ts — the generic graph projection protocol for external bounded
 * contexts (step 6 of the incremental refactor in
 * reducing-papyrus-consumer-change-amplification-with-modules--pvdo), sketched in
 * papyrus-full-context-mesh-and-domain-storage-ownership-bound-qhzp.
 *
 * An external bounded context owns its own operational state and command authority. It
 * never becomes a Papyrus-native module just to appear in the graph. Instead it publishes
 * bounded, sequenced batches of the context-bearing identities and edges it wants durably
 * materialized in the Context Mesh. Papyrus is an idempotent materialized read model for
 * that producer's data, not its command database.
 *
 * Deliberately out of scope for this walking skeleton, each a separate follow-up:
 * - Producer identity is a request field (`producerId`), not yet derived from scoped
 *   authentication -- the decision doc's constraint that "producer identity comes from
 *   scoped authentication, not request payloads" is not yet met, since Papyrus's daemon
 *   auth model today is one shared bearer token, not per-caller identity. Tracked as a
 *   known gap, not silently assumed solved.
 * - Edges reference other artifacts only via an externalId already projected by the SAME
 *   producer in this batch or a prior one. Linking a projected artifact to an existing
 *   Papyrus-native artifact (e.g. "this Discourse thread discusses this Task") is not yet
 *   supported here -- a real, needed capability, but a second batch shape / edge kind, not
 *   assumed away.
 * - "Lag" is reported as Papyrus's own last-applied checkpoint; Papyrus has no way to know
 *   a producer's true current sequence, so relative lag must be computed by the caller
 *   (who does know its own latest sequence) by diffing against this checkpoint.
 */

export const GRAPH_PROJECTION_SCHEMA_VERSION = "papyrus.graph-projection/v1";

export interface ProjectedArtifact {
	/** The producer's own stable identity for this entity -- never a Papyrus artifact id. */
	readonly externalId: string;
	readonly kind: string;
	readonly subtype?: string;
	readonly title: string;
	readonly body?: string;
	readonly labels?: readonly string[];
	readonly extra?: Record<string, unknown>;
}

export interface ProjectedEdge {
	readonly from: string; // externalId, resolved against this producer's identity map
	readonly relation: string;
	readonly to: string; // externalId, resolved against this producer's identity map
}

export interface GraphProjectionBatch {
	readonly schemaVersion: typeof GRAPH_PROJECTION_SCHEMA_VERSION;
	readonly producerId: string;
	readonly batchId: string;
	/** Monotonic per-producer sequence, starting at 1. Enforced gapless -- see GraphProjection.apply. */
	readonly sequence: number;
	readonly artifacts: readonly ProjectedArtifact[];
	readonly edges: readonly ProjectedEdge[];
}

export interface ProjectionCheckpoint {
	readonly producerId: string;
	readonly lastSequence: number;
	readonly lastBatchId: string;
	readonly appliedAt: string;
}

export interface GraphProjectionResult {
	readonly producerId: string;
	readonly batchId: string;
	readonly sequence: number;
	readonly artifactsUpserted: number;
	readonly artifactsCreated: number;
	readonly edgesUpserted: number;
	/** True only when this exact batch was already applied and this call was a safe no-op replay. */
	readonly alreadyApplied: boolean;
}
