import { DEFAULT_GRAPH_DEPTH, DEFAULT_GRAPH_MAX_NODES, MAX_GRAPH_DEPTH, MAX_GRAPH_NODES } from "../constants.ts";
import type { Db } from "../db.ts";
import type { Artifact, ArtifactEdge, ArtifactGraphOptions } from "./artifact.ts";

const MAX_EXAMINED_EDGES = 4096;
const MAX_RETURNED_EDGES = 1000;
const MAX_EDGE_BYTES = 65536;
const EDGE_COLUMNS = `substr(from_id, 1, 1024) AS "from", substr(relation, 1, 1024) AS relation, substr(to_id, 1, 1024) AS "to",
(length(from_id) > 1024 OR length(relation) > 1024 OR length(to_id) > 1024) AS oversized`;
type GraphRow = ArtifactEdge & { oversized: number };

/** Reads indexed incident edges within explicit traversal, scan and serialized-output bounds. */
export function artifactGraph(db: Db, id: string, options: ArtifactGraphOptions): Pick<Artifact, "edges" | "graphCompleteness"> {
	const depth = options.depth ?? DEFAULT_GRAPH_DEPTH;
	const maxNodes = options.maxNodes ?? DEFAULT_GRAPH_MAX_NODES;
	if (
		!Number.isInteger(depth) ||
		depth < 0 ||
		depth > MAX_GRAPH_DEPTH ||
		!Number.isInteger(maxNodes) ||
		maxNodes < 1 ||
		maxNodes > MAX_GRAPH_NODES
	)
		throw new Error("invalid artifact graph bounds");
	const forward = db.prepare(`SELECT ${EDGE_COLUMNS} FROM edges WHERE from_id = ? ORDER BY edges.relation, to_id LIMIT ?`);
	const reverse = db.prepare(`SELECT ${EDGE_COLUMNS} FROM edges WHERE to_id = ? ORDER BY rowid LIMIT ?`);
	const visited = new Set([id]);
	const queue = [{ id, depth: 0 }];
	const edges = new Map<string, ArtifactEdge>();
	let examinedEdges = 0;
	let bytes = 2;
	let truncated = false;
	outer: for (let cursor = 0; cursor < queue.length; cursor++) {
		const current = queue[cursor]!;
		if (current.depth >= depth) continue;
		for (const query of [forward, reverse]) {
			const remaining = MAX_EXAMINED_EDGES - examinedEdges;
			if (remaining <= 0) {
				truncated = true;
				break outer;
			}
			const rows = query.all(current.id, remaining) as GraphRow[];
			examinedEdges += rows.length;
			if (rows.length === remaining) truncated = true;
			for (const row of rows) {
				if (row.oversized) {
					truncated = true;
					continue;
				}
				const edge: ArtifactEdge = { from: row.from, relation: row.relation, to: row.to };
				const other = edge.from === current.id ? edge.to : edge.from;
				if (!visited.has(other) && visited.size >= maxNodes) {
					truncated = true;
					continue;
				}
				const key = JSON.stringify(edge);
				if (edges.has(key)) continue;
				const size = Buffer.byteLength(key) + 1;
				if (edges.size >= MAX_RETURNED_EDGES || bytes + size > MAX_EDGE_BYTES) {
					truncated = true;
					break outer;
				}
				bytes += size;
				edges.set(key, edge);
				if (!visited.has(other)) {
					visited.add(other);
					queue.push({ id: other, depth: current.depth + 1 });
				}
			}
		}
	}
	return {
		edges: [...edges.values()].sort(
			(a, b) => a.from.localeCompare(b.from) || a.relation.localeCompare(b.relation) || a.to.localeCompare(b.to),
		),
		graphCompleteness: { truncated, visitedNodes: visited.size, examinedEdges },
	};
}
