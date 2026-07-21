import { describe, expect, it } from "bun:test";
import { SQLiteArtifactStore } from "../src/adapters/sqlite-artifact-store.ts";
import { SQLiteGraphProjectionStore } from "../src/adapters/sqlite-graph-projection-store.ts";
import { AuthorityRegistry } from "../src/authority-registry.ts";
import { openDb } from "../src/db.ts";
import { GRAPH_PROJECTION_SCHEMA_VERSION } from "../src/domain/graph-projection.ts";
import { OperationRegistry } from "../src/module-registry.ts";
import { graphProjectionOperations, GRAPH_PROJECTION_OPERATION_NAMES } from "../src/modules/graph-projection.ts";

function fixture() {
	const db = openDb(":memory:");
	const artifacts = new SQLiteArtifactStore(db);
	const store = new SQLiteGraphProjectionStore(db);
	const authority = new AuthorityRegistry();
	const registry = new OperationRegistry();
	registry.registerAll(graphProjectionOperations(artifacts, store, authority));
	return { db, registry };
}

describe("graph_projection module: registration and snake_case operation input parsing", () => {
	it("registers exactly the graph_projection.* operations EXPECTED_OPERATION_NAMES declares, no more, no fewer", () => {
		const { registry } = fixture();
		expect(registry.list().filter((name) => name.startsWith("graph_projection."))).toEqual([...GRAPH_PROJECTION_OPERATION_NAMES].sort());
	});

	it("parses a raw snake_case batch and applies it", () => {
		const { registry } = fixture();
		const result = registry.get("graph_projection.apply")!.execute({
			schema_version: GRAPH_PROJECTION_SCHEMA_VERSION,
			producer_id: "web-spider",
			batch_id: "b1",
			sequence: 1,
			artifacts: [{ external_id: "page-1", kind: "doc", subtype: "web-spider:web", title: "Page", body: "Body", labels: ["source:web-spider"], extra: { url: "https://example.com" } }],
			edges: [],
		}) as { artifactsCreated: number };
		expect(result.artifactsCreated).toBe(1);
	});

	it("reports the checkpoint through the read operation", () => {
		const { registry } = fixture();
		expect(registry.get("graph_projection.checkpoint")!.execute({ producer_id: "unseen" })).toBeNull();
		registry.get("graph_projection.apply")!.execute({
			schema_version: GRAPH_PROJECTION_SCHEMA_VERSION, producer_id: "web-spider", batch_id: "b1", sequence: 1, artifacts: [], edges: [],
		});
		expect(registry.get("graph_projection.checkpoint")!.execute({ producer_id: "web-spider" })).toMatchObject({ lastSequence: 1, lastBatchId: "b1" });
	});
});
