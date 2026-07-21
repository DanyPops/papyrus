/**
 * modules/graph-projection.ts — the generic graph projection protocol as a registered
 * Papyrus-native module (step 6 of the incremental refactor in
 * reducing-papyrus-consumer-change-amplification-with-modules--pvdo). See
 * src/domain/graph-projection.ts and src/graph-projection-service.ts for the protocol
 * itself; this file only parses/validates raw operation input into that typed shape.
 */
import type { AuthorityRegistry } from "../authority-registry.ts";
import { GRAPH_PROJECTION_SCHEMA_VERSION, type GraphProjectionBatch, type ProjectedArtifact, type ProjectedEdge } from "../domain/graph-projection.ts";
import { GraphProjection } from "../graph-projection-service.ts";
import type { OperationDefinition } from "../module-registry.ts";
import type { ArtifactStore } from "../ports/artifact-store.ts";
import type { GraphProjectionStore } from "../ports/graph-projection-store.ts";

const MODULE_ID = "graph_projection";

type OperationInput = Record<string, unknown>;

function string(input: OperationInput, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
	return value;
}

function number(input: OperationInput, key: string): number {
	const value = input[key];
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} is required and must be a number`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArtifact(raw: unknown, index: number): ProjectedArtifact {
	if (!isRecord(raw)) throw new Error(`artifacts[${index}] must be an object`);
	return {
		externalId: string(raw, "external_id"),
		kind: string(raw, "kind"),
		...(typeof raw["subtype"] === "string" ? { subtype: raw["subtype"] } : {}),
		title: string(raw, "title"),
		...(typeof raw["body"] === "string" ? { body: raw["body"] } : {}),
		...(Array.isArray(raw["labels"]) ? { labels: raw["labels"] as string[] } : {}),
		...(isRecord(raw["extra"]) ? { extra: raw["extra"] } : {}),
	};
}

function parseEdge(raw: unknown, index: number): ProjectedEdge {
	if (!isRecord(raw)) throw new Error(`edges[${index}] must be an object`);
	return { from: string(raw, "from"), relation: string(raw, "relation"), to: string(raw, "to") };
}

function parseBatch(input: OperationInput): GraphProjectionBatch {
	const schemaVersion = string(input, "schema_version");
	const rawArtifacts = input["artifacts"];
	const rawEdges = input["edges"] ?? [];
	if (!Array.isArray(rawArtifacts)) throw new Error("artifacts must be an array");
	if (!Array.isArray(rawEdges)) throw new Error("edges must be an array");
	return {
		schemaVersion: schemaVersion as typeof GRAPH_PROJECTION_SCHEMA_VERSION,
		producerId: string(input, "producer_id"),
		batchId: string(input, "batch_id"),
		sequence: number(input, "sequence"),
		artifacts: rawArtifacts.map(parseArtifact),
		edges: rawEdges.map(parseEdge),
	};
}

/** Registers graph_projection.apply and graph_projection.checkpoint against one GraphProjection instance. */
/** This module's own operation names, the single source of truth src/service.ts's EXPECTED_OPERATION_NAMES spreads in rather than re-listing by hand. */
export const GRAPH_PROJECTION_OPERATION_NAMES = ["graph_projection.apply", "graph_projection.checkpoint"] as const;

export function graphProjectionOperations(artifacts: ArtifactStore, store: GraphProjectionStore, authority: AuthorityRegistry): OperationDefinition[] {
	const projection = new GraphProjection(artifacts, store, authority);
	const define = <Input, Output>(name: string, execute: (input: Input) => Output): OperationDefinition<Input, Output> => ({
		name, moduleId: MODULE_ID, execute,
	});
	return [
		define("graph_projection.apply", (input: OperationInput) => projection.apply(parseBatch(input))),
		define("graph_projection.checkpoint", (input: OperationInput) => projection.checkpoint(string(input, "producer_id"))),
	];
}
