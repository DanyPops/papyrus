import { describe, expect, it } from "bun:test";
import { openDb } from "../src/db.ts";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteGraphProjectionStore } from "../src/adapters/sqlite-graph-projection-store.ts";
import { AuthorityRegistry } from "../src/authority-registry.ts";
import { GRAPH_PROJECTION_SCHEMA_VERSION, type GraphProjectionBatch } from "../src/domain/graph-projection.ts";
import { GraphProjection } from "../src/graph-projection-service.ts";
import { NOTE_SUBTYPE } from "../src/note-service.ts";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const store = new SQLiteGraphProjectionStore(db);
	const authority = new AuthorityRegistry();
	authority.claim({
		owner: "notes",
		matchesArtifact: (kind, subtype) => kind === "doc" && subtype === NOTE_SUBTYPE,
		denyMessage: () => "note creation requires notes.capture",
	});
	const projection = new GraphProjection(artifacts, store, authority);
	return { db, artifacts, store, authority, projection };
}

function batch(overrides: Partial<GraphProjectionBatch>): GraphProjectionBatch {
	return {
		schemaVersion: GRAPH_PROJECTION_SCHEMA_VERSION,
		producerId: "web-spider",
		batchId: "batch-1",
		sequence: 1,
		artifacts: [],
		edges: [],
		...overrides,
	};
}

describe("GraphProjection: bounded, sequenced, idempotent ingestion for external bounded contexts", () => {
	it("creates artifacts and edges from a first batch and commits a checkpoint", () => {
		const { projection, store } = fixture();
		const result = projection.apply(batch({
			artifacts: [
				{ externalId: "page-1", kind: "doc", subtype: "web-spider:web", title: "Page one", body: "Content" },
				{ externalId: "page-2", kind: "doc", subtype: "web-spider:web", title: "Page two" },
			],
			edges: [{ from: "page-1", relation: "references", to: "page-2" }],
		}));

		expect(result).toEqual({
			producerId: "web-spider", batchId: "batch-1", sequence: 1,
			artifactsUpserted: 2, artifactsCreated: 2, edgesUpserted: 1, alreadyApplied: false,
		});
		expect(store.getCheckpoint("web-spider")).toMatchObject({ producerId: "web-spider", lastSequence: 1, lastBatchId: "batch-1" });
		const page1Id = store.resolveIdentity("web-spider", "page-1")!;
		const page2Id = store.resolveIdentity("web-spider", "page-2")!;
		expect(page1Id).not.toBe("page-1"); // internal id is opaque, not the producer's externalId
		expect(page2Id).toBeDefined();
	});

	it("upserts an existing projected artifact by externalId instead of duplicating it, across sequential batches", () => {
		const { projection, artifacts, store } = fixture();
		projection.apply(batch({ artifacts: [{ externalId: "page-1", kind: "doc", title: "Original title" }] }));
		const firstInternalId = store.resolveIdentity("web-spider", "page-1")!;

		const result = projection.apply(batch({
			batchId: "batch-2", sequence: 2,
			artifacts: [{ externalId: "page-1", kind: "doc", title: "Updated title" }],
		}));

		expect(result.artifactsCreated).toBe(0);
		expect(result.artifactsUpserted).toBe(1);
		expect(store.resolveIdentity("web-spider", "page-1")).toBe(firstInternalId); // same internal identity, not a new artifact
		expect(artifacts.get(firstInternalId)?.title).toBe("Updated title");
		expect(artifacts.query({ kind: "doc" })).toHaveLength(1); // no duplicate created
	});

	it("links a new batch's artifact to one projected by an earlier batch", () => {
		const { projection, artifacts, store } = fixture();
		projection.apply(batch({ artifacts: [{ externalId: "thread-1", kind: "doc", title: "Thread" }] }));
		projection.apply(batch({
			batchId: "batch-2", sequence: 2,
			artifacts: [{ externalId: "message-1", kind: "doc", title: "Message" }],
			edges: [{ from: "message-1", relation: "part_of", to: "thread-1" }],
		}));
		const threadId = store.resolveIdentity("web-spider", "thread-1")!;
		const messageId = store.resolveIdentity("web-spider", "message-1")!;
		expect(artifacts.relationships({ artifactIds: [threadId, messageId] })).toEqual([
			{ from: messageId, relation: "part_of", to: threadId },
		]);
	});

	it("is a safe no-op replay of the exact same already-applied batch", () => {
		const { projection, artifacts } = fixture();
		const projected = batch({ artifacts: [{ externalId: "page-1", kind: "doc", title: "Page" }] });
		projection.apply(projected);
		const replay = projection.apply(projected);
		expect(replay.alreadyApplied).toBe(true);
		expect(replay.artifactsCreated).toBe(0);
		expect(artifacts.query({ kind: "doc" })).toHaveLength(1);
	});

	it("rejects a stale batch whose sequence is at or behind the checkpoint under a different batch id", () => {
		const { projection } = fixture();
		projection.apply(batch({ artifacts: [{ externalId: "page-1", kind: "doc", title: "Page" }] }));
		expect(() => projection.apply(batch({ batchId: "stale-retry", sequence: 1, artifacts: [] })))
			.toThrow(/stale/);
	});

	it("rejects a sequence gap rather than silently accepting incomplete projection", () => {
		const { projection } = fixture();
		projection.apply(batch({ artifacts: [] }));
		expect(() => projection.apply(batch({ batchId: "batch-3", sequence: 3, artifacts: [] })))
			.toThrow(/gap/);
	});

	it("rejects a first batch that does not start at sequence 1", () => {
		const { projection } = fixture();
		expect(() => projection.apply(batch({ sequence: 2 }))).toThrow(/sequence 1/);
	});

	it("rejects a batch exceeding the bounded artifact/edge counts", () => {
		const { projection } = fixture();
		const tooMany = Array.from({ length: 501 }, (_, index) => ({ externalId: `p${index}`, kind: "doc", title: `P${index}` }));
		expect(() => projection.apply(batch({ artifacts: tooMany }))).toThrow(/bounded/);
	});

	it("rejects an edge referencing an externalId no batch has ever projected", () => {
		const { projection } = fixture();
		expect(() => projection.apply(batch({
			artifacts: [{ externalId: "page-1", kind: "doc", title: "Page" }],
			edges: [{ from: "page-1", relation: "references", to: "unknown-page" }],
		}))).toThrow(/unknown externalId/);
	});

	it("rejects projecting into a subtype another module already owns", () => {
		const { projection } = fixture();
		expect(() => projection.apply(batch({
			artifacts: [{ externalId: "sneaky", kind: "doc", subtype: NOTE_SUBTYPE, title: "Not a real note" }],
		}))).toThrow("note creation requires notes.capture");
	});

	it("rejects an unrecognized schema version", () => {
		const { projection } = fixture();
		expect(() => projection.apply({ ...batch({}), schemaVersion: "papyrus.graph-projection/v2" as typeof GRAPH_PROJECTION_SCHEMA_VERSION }))
			.toThrow(/schema version/);
	});

	it("reports no checkpoint for a producer that has never projected", () => {
		const { store } = fixture();
		expect(store.getCheckpoint("never-seen")).toBeNull();
	});
});
