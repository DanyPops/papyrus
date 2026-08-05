import { describe, expect, it } from "bun:test";
import { projectArtifactRelationships } from "../src/artifact/artifact-relationship-view.ts";
import type { Artifact } from "../src/domain/artifact.ts";

function doc(id: string, title: string, overrides: Partial<Artifact> = {}): Artifact {
	return {
		id,
		kind: "doc",
		title,
		status: "active",
		subtype: "",
		body: "",
		labels: [],
		extra: {},
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		alias: id,
		...overrides,
	};
}

describe("artifact relationship graph projection", () => {
	it("resolves the center artifact's own real title, and falls back to a readable label for an unresolved neighbor id", () => {
		const artifact = doc("doc-1234", "Architecture notes", {
			edges: [{ from: "doc-1234", relation: "references", to: "task-5678" }],
		});
		const display = projectArtifactRelationships(artifact);
		expect(display.nodes).toEqual([
			{ id: "doc-1234", label: "Architecture notes", status: "active" },
			{ id: "task-5678", label: "task" },
		]);
		expect(display.edges).toEqual([{ from: "doc-1234", to: "task-5678", label: "references" }]);
	});

	it("keeps a relation's real name as the edge label, unlike Task's own containment-specific remapping", () => {
		const artifact = doc("a", "A", { edges: [{ from: "a", relation: "documents", to: "b" }] });
		expect(projectArtifactRelationships(artifact).edges).toEqual([{ from: "a", to: "b", label: "documents" }]);
	});

	it("returns an empty graph for an artifact with no edges", () => {
		const display = projectArtifactRelationships(doc("solo", "Solo"));
		expect(display.nodes).toEqual([]);
		expect(display.edges).toEqual([]);
	});

	it("deduplicates a neighbor referenced by more than one edge into one node", () => {
		const artifact = doc("a", "A", {
			edges: [
				{ from: "a", relation: "references", to: "b" },
				{ from: "b", relation: "blocks", to: "a" },
			],
		});
		const display = projectArtifactRelationships(artifact);
		expect(display.nodes).toHaveLength(2);
		expect(display.edges).toHaveLength(2);
	});
});
